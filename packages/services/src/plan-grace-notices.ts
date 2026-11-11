// The grace emails (decision 0022, third delivery; rules in packages/domain/src/
// plan-grace-notices.ts). The maintenance of every region finds its owners whose stored grace has
// a hold due an email (its start, 14 days left, 3 days left), and for each writes one
// `plan_grace_notice` job in the owner's region and marks the hold on the plan row
// (`owner_plans.grace_notices`), both only while the row's grace and marks are the ones it read, so
// two scans announce a moment once. The queue consumer sends it.
//
// Sending is at most once: the job claims its row by deleting it before sending, and checks again
// that the grace still holds that hold, that it still ends on that date and that the moment is
// still the one due; anything else makes the email moot. They are service notices about the
// deletion of the recipient's data: no setting turns them off and they carry no unsubscribe link.
import {
  DEFAULT_REGION,
  GRACE_NOTICE_LEAD_MS,
  type GraceForecastKind,
  type GraceNoticeMoment,
  GraceNoticePayload,
  isWorkspaceId,
  type PlanName,
} from "@portifact/contracts";
import type { LocaleCode } from "@portifact/contracts/locales";
import {
  type AccessDb,
  bothSides,
  type Db,
  type GlobalDb,
  type Region,
  type RegionalDb,
  schema,
} from "@portifact/db";
import {
  checkNoticeCapacity,
  graceNoticeDue,
  graceNoticeStillDue,
  logEvent,
} from "@portifact/domain";
import { and, asc, eq, type SQL, sql } from "drizzle-orm";
import { loadSettings } from "./account-settings.ts";
import {
  emailsSentInCycle,
  isEmailSuppressed,
  RecipientSuppressedError,
  recordEmailsSent,
  suppressEmail,
} from "./email.ts";
import { graceForecastKinds } from "./grace-forecast.ts";
import type { JobOutcome } from "./outbox.ts";
import { ownerPlanRecord } from "./plans.ts";
import { ownerOfRegion } from "./shapes.ts";

/** Owners one run of the scan schedules at most, per region. */
export const GRACE_NOTICE_OWNERS_PER_RUN = 100;

/** One kind of held data the email lists: how many items go, and from when. */
export interface GraceNoticeKind {
  kind: GraceForecastKind;
  count: number;
  from: number;
}

/**
 * Builds and sends the email (the jobs Worker renders it with packages/emails, deciding with the
 * job's region what it may name). It throws `RecipientSuppressedError` when the provider refuses
 * the address, and an error without the address or the message for any other failure.
 */
export interface GraceNotifier {
  send(notice: {
    to: string;
    /** The recipient's language (account settings); null when they chose none. */
    locale: LocaleCode | null;
    moment: GraceNoticeMoment;
    /** When the hold ends. */
    until: number;
    /** The plan the hold keeps what it kept; offered for a request. */
    plan: PlanName;
    kinds: GraceNoticeKind[];
    /** The workspace (slug and name), null for a personal space. */
    space: { slug: string; name: string } | null;
  }): Promise<void>;
}

const p = schema.ownerPlans;

/** The rank of a stored moment, -1 for anything else (`graceNoticeRank` in SQL). */
const rankOf = (value: SQL) =>
  sql`(case ${value} when 'start' then 0 when 'two_weeks' then 1 when 'three_days' then 2 else -1 end)`;

/**
 * The plan rows with a live stored hold due an email at `now`: the most urgent moment it reached
 * is later than its mark (`graceNoticeDue`, in SQL so the read returns only due rows).
 */
function dueSql(now: number): SQL {
  const marks = sql`(case when ${p.graceNotices} is not null and json_valid(${p.graceNotices}) and json_type(${p.graceNotices}) = 'array' then ${p.graceNotices} else '[]' end)`;
  const until = sql`json_extract("held"."value", '$.until')`;
  const reached = sql`(case when ${until} - ${now} <= ${GRACE_NOTICE_LEAD_MS.three_days} then 2 when ${until} - ${now} <= ${GRACE_NOTICE_LEAD_MS.two_weeks} then 1 else 0 end)`;
  const told = sql`coalesce((select max(${rankOf(sql`json_extract("mark"."value", '$.moment')`)}) from json_each(${marks}) as "mark" where json_extract("mark"."value", '$.from') = json_extract("held"."value", '$.from') and json_extract("mark"."value", '$.until') = ${until}), -1)`;
  return sql`(${p.grace} is not null and json_valid(${p.grace}) and json_type(${p.grace}) = 'array' and exists (select 1 from json_each(${p.grace}) as "held" where json_type("held"."value") = 'object' and ${until} > ${now} and ${reached} > ${told}))`;
}

export interface GraceNoticeScanResult {
  /** Owners whose email was scheduled. */
  scheduled: number;
}

/**
 * Schedules this run's grace emails for the owners of `region`: at most one per owner, for up to
 * `GRACE_NOTICE_OWNERS_PER_RUN` owners. One read when nothing is due.
 */
export async function scheduleGraceNotices(
  db: RegionalDb,
  now: number,
  region: Region = DEFAULT_REGION,
): Promise<GraceNoticeScanResult> {
  const rows = await db.global
    .select({
      ownerId: p.ownerId,
      plan: p.plan,
      seats: p.seats,
      validUntil: p.validUntil,
      overrides: p.overrides,
      grace: sql<string | null>`${p.grace}`,
      graceNotices: sql<string | null>`${p.graceNotices}`,
    })
    .from(p)
    .where(and(dueSql(now), ownerOfRegion(p.ownerId, region)))
    .orderBy(asc(p.ownerId))
    .limit(GRACE_NOTICE_OWNERS_PER_RUN);
  const both = bothSides(db);
  let scheduled = 0;
  for (const row of rows) {
    const due = graceNoticeDue(row, now);
    // The SQL matches the rule; a grace that cannot be read is never announced.
    if (due === null) continue;
    // The exact row read: the raw grace and marks (no re-serialization).
    const same = sql`exists (select 1 from ${p} where ${p.ownerId} = ${row.ownerId} and ${p.grace} is ${row.grace} and ${p.graceNotices} is ${row.graceNotices})`;
    const payload = GraceNoticePayload.parse({
      from: due.slot.from,
      until: due.slot.until,
      moment: due.moment,
    });
    const mark = (w: Db) =>
      w
        .update(p)
        .set({ graceNotices: sql`${JSON.stringify(due.marks)}` })
        .where(and(eq(p.ownerId, row.ownerId), same))
        .returning({ ownerId: p.ownerId });
    if (both) {
      // One database: the job before the mark, on the same condition, as expiry notices do.
      const [, marked] = await both.batch([
        noticeJob(both, row.ownerId, payload, same, now),
        mark(both),
      ]);
      if (marked.length > 0) scheduled += 1;
      continue;
    }
    // A separate regional database: the mark first; only the scan whose mark landed writes the
    // job, so two scans write one. A failure in between loses this email, never sends two.
    const marked = await mark(db.global);
    if (marked.length === 0) continue;
    await db.batch([noticeJob(db, row.ownerId, payload, sql`1`, now)]);
    scheduled += 1;
  }
  return { scheduled };
}

function noticeJob(
  w: Db,
  ownerId: string,
  payload: GraceNoticePayload,
  condition: SQL,
  now: number,
) {
  // Columns in schema order: id, topic, payload, available, dispatched, attempts, created,
  // subject, generation.
  return w
    .insert(schema.outbox)
    .select(
      sql`select null, 'plan_grace_notice', ${JSON.stringify(payload)}, ${now}, null, 0, ${now}, ${ownerId}, null where ${condition}`,
    );
}

type Skip = "malformed" | "moot" | "no_account" | "suppressed" | "capacity";

function skipped(reason: Skip, moment: GraceNoticeMoment | "unknown"): JobOutcome {
  // Only the reason and the moment: never the owner's people, names or counts of their data.
  logEvent("log", "plan_grace_notice_skipped", { reason, type: moment });
  return "stale";
}

interface Recipient {
  email: string;
  locale: LocaleCode | null;
}

/**
 * Who gets an owner's grace emails: the account of a personal space, or each admin of a workspace
 * (`ownerRecipients`), with the workspace's slug and name read in the same query.
 */
async function graceRecipients(
  global: GlobalDb,
  ownerId: string,
): Promise<{ recipients: Recipient[]; space: { slug: string; name: string } | null }> {
  const u = schema.users;
  let people: { userId: string; email: string }[];
  let space: { slug: string; name: string } | null = null;
  if (isWorkspaceId(ownerId)) {
    const m = schema.workspaceMembers;
    const w = schema.workspaces;
    const rows = await global
      .select({ userId: m.userId, email: u.email, slug: w.slug, name: w.name })
      .from(m)
      .innerJoin(w, eq(w.id, m.workspaceId))
      .innerJoin(u, eq(u.id, m.userId))
      .where(and(eq(m.workspaceId, ownerId), eq(m.role, "admin")))
      .orderBy(m.userId);
    people = rows;
    const first = rows[0];
    if (first) space = { slug: first.slug, name: first.name };
  } else {
    people = await global
      .select({ userId: u.id, email: u.email })
      .from(u)
      .where(eq(u.id, ownerId))
      .limit(1);
  }
  const recipients: Recipient[] = [];
  for (const person of people) {
    const settings = await loadSettings(global, person.userId);
    recipients.push({ email: person.email, locale: settings.locale });
  }
  return { recipients, space };
}

/**
 * Runs a `plan_grace_notice` job: claims it, checks the email is still due (the hold still held,
 * ending on that date, at that moment), then sends it to the owner, or to each admin of a
 * workspace, past suppressions and the notices' capacity. A failed send puts the job back only
 * when nobody got it yet, so nobody gets it twice; a capacity refusal drops it, as expiry notices
 * do (decision 0022, "Capacity").
 */
export async function sendGraceNotice(
  db: RegionalDb,
  access: AccessDb,
  row: typeof schema.outbox.$inferSelect,
  now: number,
  notifier: GraceNotifier,
): Promise<JobOutcome> {
  const claimed = await db
    .delete(schema.outbox)
    .where(eq(schema.outbox.id, row.id))
    .returning({ id: schema.outbox.id });
  // Another delivery of the same message claimed it first.
  if (claimed.length === 0) return "done";

  const parsed = GraceNoticePayload.safeParse(row.payload);
  if (!parsed.success) return skipped("malformed", "unknown");
  const notice = parsed.data;
  const ownerId = row.subject ?? "";
  const held = graceNoticeStillDue(await ownerPlanRecord(db.global, ownerId), notice, now);
  if (held === null) return skipped("moot", notice.moment);

  const { recipients, space } = await graceRecipients(db.global, ownerId);
  if (recipients.length === 0) return skipped("no_account", notice.moment);
  const { kinds } = await graceForecastKinds(db, access, ownerId, now);

  let sent = 0;
  let skip: Skip = "suppressed";
  for (const recipient of recipients) {
    if (await isEmailSuppressed(db.global, recipient.email, now)) {
      skip = "suppressed";
      continue;
    }
    if (!checkNoticeCapacity(await emailsSentInCycle(db.global, now)).ok) {
      skip = "capacity";
      break;
    }
    try {
      await notifier.send({
        to: recipient.email,
        locale: recipient.locale,
        moment: notice.moment,
        until: held.until,
        plan: held.plan,
        kinds,
        space,
      });
    } catch (error) {
      if (error instanceof RecipientSuppressedError) {
        await suppressEmail(db.global, { email: recipient.email, reason: "provider", now });
        skip = "suppressed";
        continue;
      }
      if (sent > 0) {
        // Others already got it: a retry would send them a second copy, so this one is lost.
        logEvent("log", "plan_grace_notice_failed", { type: notice.moment });
        continue;
      }
      // Back in the outbox for the next delivery, which checks everything again.
      await db.insert(schema.outbox).values({
        topic: "plan_grace_notice",
        payload: notice,
        availableAt: now,
        createdAt: row.createdAt,
        subject: ownerId,
        attempts: row.attempts,
      });
      throw error;
    }
    await recordEmailsSent(db.global, now);
    sent += 1;
  }
  return sent > 0 ? "done" : skipped(skip, notice.moment);
}
