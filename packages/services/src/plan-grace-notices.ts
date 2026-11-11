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
  GRACE_NOTICE_MARK_WAITS,
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
  type GraceNoticeRecord,
  graceNoticeCheck,
  logEvent,
  planGraceNotices,
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
import { cursorRead, resumeAt, type ScanCaps, savedCursorSql } from "./maintenance-cursors.ts";
import type { JobOutcome } from "./outbox.ts";
import { ownerOfRegion } from "./shapes.ts";

/** Plan rows one page of the scan reads, per region. */
export const GRACE_NOTICE_OWNERS_PER_RUN = 100;

/** How long a `three_days` email refused for capacity waits before it is tried again. */
export const GRACE_NOTICE_CAPACITY_RETRY_MS = 60 * 60_000;

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
  // A covered mark (no email: the hold's end lets nothing go) counts as everything told while the
  // grace stores as many holds as when it was decided, and as nothing told once that changes.
  const covered = sql`json_extract("mark"."value", '$.covered')`;
  const rank = sql`(case when ${covered} is null then ${rankOf(sql`json_extract("mark"."value", '$.moment')`)} when ${covered} = json_array_length(${p.grace}) then 3 else -1 end)`;
  const told = sql`coalesce((select max(${rank}) from json_each(${marks}) as "mark" where json_extract("mark"."value", '$.from') = json_extract("held"."value", '$.from') and json_extract("mark"."value", '$.until') = ${until}), -1)`;
  return sql`(${p.grace} is not null and json_valid(${p.grace}) and json_type(${p.grace}) = 'array' and exists (select 1 from json_each(${p.grace}) as "held" where json_type("held"."value") = 'object' and ${until} > ${now} and ${reached} > ${told}))`;
}

export interface GraceNoticeScanResult {
  /** Owners whose email was scheduled. */
  scheduled: number;
}

/**
 * Plan rows the scan reads per run and region: three pages of `GRACE_NOTICE_OWNERS_PER_RUN`, then
 * it resumes from `maintenance_cursors`, so rows it cannot announce (a grace the SQL reads but the
 * domain refuses, a hold another covers) never keep later owners waiting.
 */
export const GRACE_NOTICE_CAPS: ScanCaps = { pageSize: GRACE_NOTICE_OWNERS_PER_RUN, maxPages: 3 };

/**
 * Schedules this run's grace emails for the owners of `region`: at most one per owner, reading at
 * most `caps` and resuming where the last run stopped. One call when nothing is due (the saved
 * cursor and the first page in one batch).
 *
 * At most once (decision 0022, "At most once"): every job carries a token of its own, and the
 * owner's mark for the hold records the token of the job that may send. With one database the
 * job and the mark go in one batch, both on the row as read. With a separate regional database
 * (no batch spans both) the job goes first, then the mark with its token on the row as read: a
 * crash in between leaves a job whose token no mark holds, which is moot when it runs, and the
 * next scan schedules it again; of two concurrent scans one mark lands, and the other job is
 * withdrawn (or moot).
 */
export async function scheduleGraceNotices(
  db: RegionalDb,
  now: number,
  region: Region = DEFAULT_REGION,
  caps: ScanCaps = GRACE_NOTICE_CAPS,
): Promise<GraceNoticeScanResult> {
  const global = db.global;
  const name = `plan_grace_notices:${region}`;
  const page = (after: SQL) =>
    global
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
      .where(and(sql`${p.ownerId} > ${after}`, dueSql(now), ownerOfRegion(p.ownerId, region)))
      .orderBy(asc(p.ownerId))
      .limit(caps.pageSize);
  let scheduled = 0;
  let cursor: string | null = null;
  let started = "";
  let ended = false;
  for (let pages = 0; pages < caps.maxPages; pages += 1) {
    let rows: Awaited<ReturnType<typeof page>>;
    if (cursor === null) {
      const [saved, first] = await global.batch([
        cursorRead(global, name),
        page(savedCursorSql(name)),
      ]);
      started = saved[0]?.cursor ?? "";
      rows = first;
    } else {
      rows = await page(sql`${cursor}`);
    }
    if (rows.length > 0) cursor = rows.at(-1)?.ownerId ?? cursor;
    else cursor ??= started;
    for (const row of rows) {
      if (await scheduleOne(db, row, now)) scheduled += 1;
    }
    if (rows.length < caps.pageSize) {
      ended = true;
      break;
    }
  }
  await resumeAt(global, name, started, ended ? null : cursor, now);
  return { scheduled };
}

/** How long a job written with a separate regional database waits before it may run. */
export const GRACE_NOTICE_MARK_DELAY_MS = 2 * 60_000;

/** How long a job whose mark has not landed waits before it runs again. */
export const GRACE_NOTICE_MARK_WAIT_MS = 5 * 60_000;

async function scheduleOne(
  db: RegionalDb,
  row: GraceNoticeRecord & { ownerId: string; grace: string | null; graceNotices: string | null },
  now: number,
): Promise<boolean> {
  const claim = crypto.randomUUID();
  const plan = planGraceNotices(row, now, claim);
  // The SQL only narrows: a grace that cannot be read is never announced, and the cursor moves
  // past it; a hold whose end lets nothing go is only marked covered, so it is not read again.
  if (!plan.changed) return false;
  // The exact row read: the raw grace and marks (no re-serialization).
  const same = sql`exists (select 1 from ${p} where ${p.ownerId} = ${row.ownerId} and ${p.grace} is ${row.grace} and ${p.graceNotices} is ${row.graceNotices})`;
  const mark = (w: Db) =>
    w
      .update(p)
      .set({ graceNotices: sql`${JSON.stringify(plan.marks)}` })
      .where(and(eq(p.ownerId, row.ownerId), same))
      .returning({ ownerId: p.ownerId });
  const both = bothSides(db);
  if (plan.notice === null) {
    // Covered holds only: no email, just the marks.
    await mark(both ?? db.global);
    return false;
  }
  const payload = GraceNoticePayload.parse({
    from: plan.notice.slot.from,
    until: plan.notice.slot.until,
    moment: plan.notice.moment,
    claim,
  });
  if (both) {
    // One database: the job before the mark, on the same condition, as expiry notices do.
    const [, marked] = await both.batch([
      noticeJob(both, row.ownerId, payload, same, now),
      mark(both),
    ]);
    return marked.length > 0;
  }
  // A separate regional database: the job first, then the mark that names its token. The job is
  // relayed only a little later, so it normally runs after its mark; one that still runs first
  // waits for it (`graceNoticeCheck`).
  const [job] = await db
    .insert(schema.outbox)
    .values({
      topic: "plan_grace_notice",
      payload,
      availableAt: now + GRACE_NOTICE_MARK_DELAY_MS,
      createdAt: now,
      subject: row.ownerId,
    })
    .returning({ id: schema.outbox.id });
  const marked = await mark(db.global);
  if (marked.length > 0) return true;
  // Another scan or an operator's change came first: this job's token is in no mark, so it would
  // be moot; withdraw it now rather than let it run for nothing.
  if (job) await db.delete(schema.outbox).where(eq(schema.outbox.id, job.id));
  return false;
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
  logEvent("log", "plan_grace_notice_skipped", { reason, moment });
  return "stale";
}

/** The owner's plan row with the marks of its grace emails, in one read. */
async function planWithMarks(global: GlobalDb, ownerId: string): Promise<GraceNoticeRecord | null> {
  const [row] = await global
    .select({
      plan: p.plan,
      seats: p.seats,
      validUntil: p.validUntil,
      overrides: p.overrides,
      grace: p.grace,
      graceNotices: p.graceNotices,
    })
    .from(p)
    .where(eq(p.ownerId, ownerId))
    .limit(1);
  return row ?? null;
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
): Promise<{
  recipients: (Recipient & { userId: string })[];
  space: { slug: string; name: string } | null;
}> {
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
  const recipients: (Recipient & { userId: string })[] = [];
  for (const person of people) {
    const settings = await loadSettings(global, person.userId);
    recipients.push({ userId: person.userId, email: person.email, locale: settings.locale });
  }
  return { recipients, space };
}

/**
 * Runs a `plan_grace_notice` job: claims it, checks the email is still due (the hold still held,
 * ending on that date, at that moment), then sends it to the owner, or to each admin of a
 * workspace, past suppressions and the notices' capacity. A failed send puts the job back only
 * when nobody got it yet, so nobody gets it twice. A capacity refusal drops `start` and
 * `two_weeks`, as expiry notices do; the `three_days` email is the last warning before the data
 * goes, so it waits (`GRACE_NOTICE_CAPACITY_RETRY_MS`) and is tried again while it is still due,
 * which ends at the hold's end, for the recipients not told yet (decision 0022, "Capacity"). A job
 * that runs before its mark has landed (separate regional database) waits for it a bounded number
 * of times (`GRACE_NOTICE_MARK_WAITS`) instead of being dropped.
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
  const putBack = (payload: GraceNoticePayload, availableAt: number) =>
    db.insert(schema.outbox).values({
      topic: "plan_grace_notice",
      payload,
      availableAt,
      createdAt: row.createdAt,
      subject: ownerId,
      attempts: row.attempts,
    });
  const check = graceNoticeCheck(await planWithMarks(db.global, ownerId), notice, now);
  if (check.status === "wait") {
    // Its mark is written right after it: give it a few minutes, a bounded number of times. If
    // the scan really crashed, the next scan writes another token and this job is then moot.
    const waits = (notice.waits ?? 0) + 1;
    if (waits > GRACE_NOTICE_MARK_WAITS) return skipped("moot", notice.moment);
    await putBack({ ...notice, waits }, now + GRACE_NOTICE_MARK_WAIT_MS);
    logEvent("log", "plan_grace_notice_waiting", { reason: "mark", moment: notice.moment });
    return "kept";
  }
  if (check.status === "moot") return skipped("moot", notice.moment);
  const held = check.slot;

  const everyone = await graceRecipients(db.global, ownerId);
  const { space } = everyone;
  // A put-back last warning names the accounts still to be told: only those still recipients.
  const recipients = notice.recipients
    ? everyone.recipients.filter((person) => notice.recipients?.includes(person.userId))
    : everyone.recipients;
  if (recipients.length === 0) return skipped("no_account", notice.moment);
  const { kinds } = await graceForecastKinds(db, access, ownerId, now);
  // A hold is announced only when a forecast step falls on its end, so the list is never empty.
  if (kinds.length === 0) return skipped("moot", notice.moment);

  let sent = 0;
  let skip: Skip = "suppressed";
  let untold: string[] = [];
  for (const [index, recipient] of recipients.entries()) {
    if (await isEmailSuppressed(db.global, recipient.email, now)) {
      skip = "suppressed";
      continue;
    }
    if (!checkNoticeCapacity(await emailsSentInCycle(db.global, now)).ok) {
      skip = "capacity";
      untold = recipients.slice(index).map((person) => person.userId);
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
        logEvent("log", "plan_grace_notice_failed", { moment: notice.moment });
        continue;
      }
      // Back in the outbox for the next delivery, which checks everything again.
      await putBack(notice, now);
      throw error;
    }
    await recordEmailsSent(db.global, now);
    sent += 1;
  }
  if (untold.length > 0 && notice.moment === "three_days") {
    // The last warning waits for capacity instead of being dropped: back in the outbox for later,
    // for the accounts not told yet when someone already was. Each try checks again that it is
    // still due, so it stops at the hold's end at the latest.
    await putBack(
      sent > 0 ? { ...notice, recipients: untold } : notice,
      now + GRACE_NOTICE_CAPACITY_RETRY_MS,
    );
    logEvent("warn", "plan_grace_notice_waiting", { reason: "capacity", moment: notice.moment });
    return sent > 0 ? "done" : "kept";
  }
  return sent > 0 ? "done" : skipped(skip, notice.moment);
}
