// The downgrade notice for custom domains (decision 0006, section 7; rule `domainNotice` in
// packages/domain/src/custom-domains.ts). When an owner's plan ended and the plan they have now
// allows fewer custom domains, the newest keep serving for `downgradeGraceDays` and then the
// scheduled check detaches them. The same check schedules one `domain_notice` job per owner and
// detach time, marking the domains (`notice_for`) in the same batch, so each detach time is told
// once; the queue consumer sends the email.
//
// Like expiry notices, the job claims its row by deleting it before sending, so nobody gets it
// twice; a send that fails before anyone got it puts the row back. It is a service email about
// losing part of a paid plan, so there is no opt-out; suppressed addresses and the cycle's email
// capacity are respected, and every email sent is counted.
import { DomainNoticePayload } from "@portifact/contracts";
import type { LocaleCode } from "@portifact/contracts/locales";
import { type Db, type RegionalDb, schema } from "@portifact/db";
import {
  checkNoticeCapacity,
  domainLimit,
  domainLimitAt,
  domainNotice,
  entitlements,
} from "@portifact/domain";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { loadSettings } from "./account-settings.ts";
import { ownerRecipients } from "./actors.ts";
import {
  emailsSentInCycle,
  isEmailSuppressed,
  RecipientSuppressedError,
  recordEmailsSent,
  suppressEmail,
} from "./email.ts";
import type { JobOutcome } from "./outbox.ts";

const c = schema.customDomains;

/** Sends the email; renders it with packages/emails in the jobs Worker. */
export interface DomainNotifier {
  send(notice: {
    to: string;
    hostnames: string[];
    detachAt: number;
    limit: number;
    locale: LocaleCode | null;
  }): Promise<void>;
}

async function planRow(global: Db, ownerId: string) {
  const [row] = await global
    .select({
      plan: schema.ownerPlans.plan,
      seats: schema.ownerPlans.seats,
      validUntil: schema.ownerPlans.validUntil,
      overrides: schema.ownerPlans.overrides,
    })
    .from(schema.ownerPlans)
    .where(eq(schema.ownerPlans.ownerId, ownerId))
    .limit(1);
  return row ?? null;
}

/** The owner's domains that count, and what the plan allows now and as the grace reads it. */
async function exposure(global: Db, ownerId: string, now: number) {
  const plan = await planRow(global, ownerId);
  const domains = await global
    .select({ hostname: c.hostname, verifiedAt: c.verifiedAt, noticeFor: c.noticeFor })
    .from(c)
    .where(and(eq(c.ownerId, ownerId), ne(c.state, "detaching")));
  return {
    domains,
    limitNow: domainLimit(entitlements(plan, now)),
    limitInGrace: domainLimit(entitlements(plan, domainLimitAt(now))),
    validUntil: plan?.validUntil ?? null,
  };
}

/**
 * Schedules the notices this run: for every owner in the grace with domains at risk, one job and
 * the marks in one batch, both conditioned on a domain still unmarked for this detach time, so
 * overlapping runs schedule it once. Returns how many owners were scheduled.
 */
export async function scheduleDomainNotices(global: Db, now: number): Promise<number> {
  const owners = await global
    .selectDistinct({ ownerId: c.ownerId })
    .from(c)
    .innerJoin(schema.ownerPlans, eq(schema.ownerPlans.ownerId, c.ownerId))
    .where(and(ne(c.state, "detaching"), sql`${schema.ownerPlans.validUntil} <= ${now}`));
  let scheduled = 0;
  for (const { ownerId } of owners) {
    const notice = domainNotice(await exposure(global, ownerId, now));
    if (!notice) continue;
    const unmarked = and(
      eq(c.ownerId, ownerId),
      inArray(c.hostname, notice.hostnames),
      ne(c.state, "detaching"),
      or(isNull(c.noticeFor), ne(c.noticeFor, notice.detachAt)),
    );
    const payload = JSON.stringify({ hostnames: notice.hostnames, detachAt: notice.detachAt });
    await global.batch([
      // Columns in schema order: id, topic, payload, available, dispatched, attempts, created,
      // subject, generation.
      global
        .insert(schema.outbox)
        .select(
          sql`select null, 'domain_notice', ${payload}, ${now}, null, 0, ${now}, ${ownerId}, null where exists (select 1 from ${c} where ${unmarked})`,
        ),
      global.update(c).set({ noticeFor: notice.detachAt }).where(unmarked),
    ]);
    scheduled += 1;
  }
  return scheduled;
}

type Skip = "no_account" | "renewed" | "suppressed" | "capacity";

function skipped(reason: Skip): JobOutcome {
  // Only the reason: never the address or the hostnames.
  console.log(JSON.stringify({ event: "domain_notice_skipped", reason }));
  return "stale";
}

/**
 * Runs a `domain_notice` job: claims it, checks the domains are still at risk (a renewed plan or
 * domains removed meanwhile make it moot) and emails the owner, or each admin of a workspace.
 */
export async function sendDomainNotice(
  db: RegionalDb,
  row: typeof schema.outbox.$inferSelect,
  now: number,
  notifier: DomainNotifier,
): Promise<JobOutcome> {
  const claimed = await db
    .delete(schema.outbox)
    .where(eq(schema.outbox.id, row.id))
    .returning({ id: schema.outbox.id });
  if (claimed.length === 0) return "done";
  const ownerId = row.subject ?? "";
  const parsed = DomainNoticePayload.safeParse(
    typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
  );
  if (!parsed.success) return skipped("renewed");
  const current = await exposure(db.global, ownerId, now);
  const still = current.domains
    .map((domain) => domain.hostname)
    .filter((hostname) => parsed.data.hostnames.includes(hostname));
  if (still.length === 0 || current.limitNow >= current.domains.length) return skipped("renewed");
  const recipients: { email: string; locale: LocaleCode | null }[] = [];
  for (const userId of await ownerRecipients(db.global, ownerId)) {
    const [user] = await db.global
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    if (user) {
      recipients.push({
        email: user.email,
        locale: (await loadSettings(db.global, userId)).locale,
      });
    }
  }
  if (recipients.length === 0) return skipped("no_account");
  let sent = 0;
  let skip: Skip = "suppressed";
  for (const recipient of recipients) {
    if (await isEmailSuppressed(db.global, recipient.email, now)) continue;
    if (!checkNoticeCapacity(await emailsSentInCycle(db.global, now)).ok) {
      skip = "capacity";
      break;
    }
    try {
      await notifier.send({
        to: recipient.email,
        hostnames: still,
        detachAt: parsed.data.detachAt,
        limit: current.limitNow,
        locale: recipient.locale,
      });
    } catch (error) {
      if (error instanceof RecipientSuppressedError) {
        await suppressEmail(db.global, { email: recipient.email, reason: "provider", now });
        continue;
      }
      if (sent > 0) continue;
      await db.insert(schema.outbox).values({
        topic: "domain_notice",
        payload: parsed.data,
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
  return sent > 0 ? "done" : skipped(skip);
}
