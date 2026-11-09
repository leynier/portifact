// Expiry notices (plan section 10; rules in packages/domain/src/expiry-notices.ts). The scheduled
// run finds active artifacts about to expire, groups them per owner and, in one batch per owner,
// writes an `expiry_notice` outbox job and marks each artifact with the expiry it was notified for,
// so no later run notifies the same expiry again. The queue consumer sends the email.
//
// Sending is at most once: the job claims its row by deleting it before sending, so a duplicate
// or concurrent delivery finds nothing to do and never emails the owner twice. A send that fails
// puts the row back for the next run; only a Worker dying between the claim and the send loses a
// notice, which is safer than a second copy and costs nothing but the reminder.
import { ExpiryNoticePayload } from "@portifact/contracts";
import { type Db, schema } from "@portifact/db";
import {
  checkNoticeCapacity,
  EXPIRY_NOTICE,
  groupNotices,
  noticeWindowEnd,
  stillExpiring,
} from "@portifact/domain";
import { and, eq, gt, inArray, isNull, lte, ne, or, type SQL, sql } from "drizzle-orm";
import { loadSettings } from "./account-settings.ts";
import {
  emailsSentInCycle,
  isEmailSuppressed,
  RecipientSuppressedError,
  recordEmailsSent,
  suppressEmail,
} from "./email.ts";
import type { JobOutcome } from "./outbox.ts";

/** One artifact as the notice lists it. */
export interface ExpiringArtifact {
  id: string;
  name: string;
  expiresAt: number;
}

/**
 * Builds and sends the email (the jobs Worker renders it with packages/emails). It throws
 * `RecipientSuppressedError` when the provider refuses the address, and an error without the
 * address or the message for any other failure.
 */
export interface ExpiryNotifier {
  send(notice: { to: string; artifacts: ExpiringArtifact[] }): Promise<void>;
}

const a = schema.artifacts;

/** Active, expiring inside the window and not yet notified for this expiry (`noticeDue`). */
function dueCondition(now: number): SQL {
  return and(
    eq(a.state, "active"),
    gt(a.expiresAt, now),
    lte(a.expiresAt, noticeWindowEnd(now)),
    or(isNull(a.expiryNoticeFor), ne(a.expiryNoticeFor, a.expiresAt)),
  ) as SQL;
}

/** The owner did not turn notices off (no settings row means on). */
const optedIn = sql`not exists (select 1 from "account_settings" where "account_settings"."user_id" = "artifacts"."owner_id" and "account_settings"."expiry_notices" = 0)`;

/** The owner got no notice within the cooldown (`ownerInCooldown`). */
const notCooling = (now: number) =>
  sql`not exists (select 1 from "artifacts" as "noticed" where "noticed"."owner_id" = "artifacts"."owner_id" and "noticed"."expiry_notice_at" > ${now - EXPIRY_NOTICE.ownerCooldownMs})`;

export interface ScheduleResult {
  owners: number;
  artifacts: number;
}

/**
 * Schedules this run's expiry notices: at most one per owner, for up to `ownersPerRun` owners.
 * Each owner's job and marks go in one batch, and both are conditioned on the artifacts still
 * being due, so overlapping runs schedule each expiry once.
 */
export async function scheduleExpiryNotices(db: Db, now: number): Promise<ScheduleResult> {
  const due = dueCondition(now);
  const owners = (
    await db
      .selectDistinct({ ownerId: a.ownerId })
      .from(a)
      .where(and(due, optedIn, notCooling(now)))
      .limit(EXPIRY_NOTICE.ownersPerRun)
  ).map((row) => row.ownerId);
  if (owners.length === 0) return { owners: 0, artifacts: 0 };

  const candidates = await db
    .select({ ownerId: a.ownerId, id: a.id, expiresAt: sql<number>`${a.expiresAt}` })
    .from(a)
    .where(and(due, inArray(a.ownerId, owners)));
  const groups = groupNotices(candidates);

  const statements = [...groups].flatMap(([ownerId, entries]) => {
    const where = and(
      inArray(
        a.id,
        entries.map((entry) => entry.id),
      ),
      eq(a.ownerId, ownerId),
      due,
    );
    return [
      // Before the marks and on the same old state: the job exists exactly when they happen.
      db
        .insert(schema.outbox)
        .select(
          sql`select null, 'expiry_notice', json_object('artifacts', json("list")), ${now}, null, 0, ${now}, ${ownerId}, null from (select json_group_array(json_object('id', "id", 'expiresAt', "expires_at")) as "list", count(*) as "n" from ${a} where ${where}) where "n" > 0`,
        ),
      db
        .update(a)
        .set({ expiryNoticeFor: sql`${a.expiresAt}`, expiryNoticeAt: now })
        .where(where),
    ];
  });
  const [first, ...rest] = statements;
  if (first) await db.batch([first, ...rest]);
  return {
    owners: groups.size,
    artifacts: [...groups.values()].reduce((total, entries) => total + entries.length, 0),
  };
}

type Skip = "no_account" | "opted_out" | "nothing_due" | "suppressed" | "capacity";

function skipped(reason: Skip, artifacts: number): JobOutcome {
  // Only the reason and a count: never the address or the artifacts' names.
  console.log(JSON.stringify({ event: "expiry_notice_skipped", reason, artifacts }));
  return "stale";
}

/**
 * Runs an `expiry_notice` job: claims it, rechecks what changed since it was scheduled (the
 * account, the opt-out, renewals, the suppression list and the cycle's email capacity) and sends
 * one email listing the artifacts still about to expire.
 */
export async function sendExpiryNotice(
  db: Db,
  row: typeof schema.outbox.$inferSelect,
  now: number,
  notifier: ExpiryNotifier,
): Promise<JobOutcome> {
  const claimed = await db
    .delete(schema.outbox)
    .where(eq(schema.outbox.id, row.id))
    .returning({ id: schema.outbox.id });
  // Another delivery of the same message claimed it first.
  if (claimed.length === 0) return "done";

  const ownerId = row.subject ?? "";
  const payload = ExpiryNoticePayload.safeParse(row.payload);
  if (!payload.success) return skipped("nothing_due", 0);
  const scheduled = payload.data.artifacts;

  const [owner] = await db
    .select({ email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, ownerId))
    .limit(1);
  if (!owner) return skipped("no_account", scheduled.length);
  if (!(await loadSettings(db, ownerId)).expiryNotices) {
    return skipped("opted_out", scheduled.length);
  }

  const current = new Map(
    (
      await db
        .select({
          id: a.id,
          name: a.name,
          ownerId: a.ownerId,
          state: a.state,
          expiresAt: a.expiresAt,
        })
        .from(a)
        .where(
          inArray(
            a.id,
            scheduled.map((entry) => entry.id),
          ),
        )
    ).map((artifact) => [artifact.id, artifact]),
  );
  const artifacts = scheduled
    .filter((entry) => stillExpiring(entry, current.get(entry.id), ownerId, now))
    .map((entry) => ({
      id: entry.id,
      name: current.get(entry.id)?.name ?? "",
      expiresAt: entry.expiresAt,
    }))
    .sort((x, y) => x.expiresAt - y.expiresAt || (x.id < y.id ? -1 : 1));
  if (artifacts.length === 0) return skipped("nothing_due", scheduled.length);

  if (await isEmailSuppressed(db, owner.email, now)) {
    return skipped("suppressed", artifacts.length);
  }
  if (!checkNoticeCapacity(await emailsSentInCycle(db, now)).ok) {
    return skipped("capacity", artifacts.length);
  }

  try {
    await notifier.send({ to: owner.email, artifacts });
  } catch (error) {
    if (error instanceof RecipientSuppressedError) {
      await suppressEmail(db, { email: owner.email, reason: "provider", now });
      return skipped("suppressed", artifacts.length);
    }
    // Back in the outbox for the next run, as it was scheduled; the artifacts' marks stay, so
    // no new notice is scheduled for them meanwhile.
    await db.insert(schema.outbox).values({
      topic: "expiry_notice",
      payload: payload.data,
      availableAt: now,
      createdAt: row.createdAt,
      subject: ownerId,
      attempts: row.attempts,
    });
    throw error;
  }
  await recordEmailsSent(db, now);
  return "done";
}
