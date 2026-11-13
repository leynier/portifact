// Comment retention (decision 0023, "Comment retention"; a workspace policy, feature `policies`):
// whole threads, with every message, are deleted for good once their last activity is older than
// the workspace's period, except open threads on the artifact's current version. The rules are in
// packages/domain/src/workspace-policies.ts (`threadDeadline`, `threadDeletable`); this module is
// their SQL side, the preview's counts, the deletion and the scan that runs it.
//
// Nothing here can be undone, so four things hold for every deletion:
// - It happens only in the scan, in bounded batches, never in a request or a save's job.
// - Its statements are held to the rule still being in force: with the workspace and its
//   artifacts in one database, each statement checks the workspace's policy revision and its plan
//   row as the scan read them; with a separate regional database both are read again right before
//   each batch (the window is one round trip and one batch of at most 50 threads).
// - It happens only while the policy and the workspace's guard record in R2 agree on the rule's
//   token (the restore guard): a D1 Time Travel restore can bring back a rule an admin had
//   removed or lengthened, and its token no longer agrees with R2's.
// - It fails closed: any error while deciding whether deletion is allowed (the guard record, the
//   rule, the plan) means nothing is deleted in that run for that workspace.
//
// Every statement selects its own rows and binds a fixed number of parameters (D1 allows 100).
import {
  type CommentRetentionNoticePayload,
  CommentTombstonesPayload,
  type TombstoneMarker,
  WORKSPACE_POLICIES,
  WorkspaceId,
  type WorkspacePolicy,
} from "@portifact/contracts";
import {
  bothSides,
  type Db,
  type GlobalDb,
  type Region,
  type RegionalDb,
  schema,
} from "@portifact/db";
import {
  type CommentRetention,
  commentRetentionOf,
  entitlements,
  errorLabel,
  hasFeature,
  logEvent,
  policyOf,
  storedPolicy,
} from "@portifact/domain";
import { and, asc, eq, gt, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { auditEvent } from "./audit.ts";
import { cursorRead, resumeAt, savedCursorSql } from "./maintenance-cursors.ts";

const DAY_MS = 86_400_000;
const th = schema.annotationThreads;
const a = schema.artifacts;
const w = schema.workspaces;
const p = schema.ownerPlans;
const c = schema.maintenanceCursors;

/**
 * When a thread's version stopped being current, in SQL: its own `superseded_at`; when that is
 * unknown (a version pruned since, or one replaced before the column existed), the first publish
 * or rollback of the artifact after the thread's creation (strictly: a thread is created after its
 * own version's publish, so that one never counts) (`lifecycle_events`, never pruned,
 * through `lifecycle_events_artifact_at_idx`), which is when a thread created on the current
 * version stopped being on it, never earlier and stable whatever is published or pruned later;
 * and only for data older than both, the current version's commit (never earlier either).
 */
const LEFT_CURRENT = sql`coalesce((select "tv"."superseded_at" from "versions" as "tv" where "tv"."id" = ${th.versionId}), (select min("le"."at") from "lifecycle_events" as "le" where "le"."artifact_id" = ${th.artifactId} and "le"."at" > ${th.createdAt} and "le"."event" in ('published', 'rolled_back')), (select "cv"."committed_at" from "versions" as "cv" where "cv"."id" = ${a.currentVersionId}), ${th.updatedAt})`;

/**
 * `threadClock` in SQL: a resolved thread's last activity, an open one's last activity or the
 * moment its version stopped being current, whichever is later. Never before `updated_at`.
 */
const CLOCK = sql<number>`(case when ${th.state} = 'open' then max(${th.updatedAt}, ${LEFT_CURRENT}) else ${th.updatedAt} end)`;

/**
 * `threadDeadline` in SQL over a thread (`th`) joined to its artifact (`a`): the later of the
 * rule's effective date, the move notice after the artifact's `life_started_at` (a move into the
 * workspace, or a restore), and the thread's clock plus the days. Binds 3 parameters.
 */
export function threadDeadlineSql(rule: CommentRetention): SQL<number> {
  return sql<number>`max(${rule.from}, coalesce(${a.lifeStartedAt} + ${WORKSPACE_POLICIES.commentMoveNoticeDays * DAY_MS}, 0), ${CLOCK} + ${rule.days * DAY_MS})`;
}

/**
 * The threads comment retention may ever delete: the workspace's, on an artifact it still owns
 * that is active or archived, and not open on the current version. Binds 1 parameter.
 */
function eligible(workspaceId: string): SQL {
  return sql`${th.ownerId} = ${workspaceId} and ${th.state} in ('open', 'resolved') and ${a.ownerId} = ${th.ownerId} and ${a.state} in ('active', 'archived') and (${th.state} = 'resolved' or ${a.currentVersionId} is null or ${th.versionId} <> ${a.currentVersionId})`;
}

/**
 * The threads comment retention may delete at `now` (`threadDeletable` in SQL): eligible and
 * past their deadline. The one definition the scan, the preview, the confirmation and the notices
 * count with. The range on `updated_at` lets `annotation_threads_owner_state_updated_idx` bound
 * the read: a deadline is never earlier than the last activity plus the days (the clock is never
 * before `updated_at`), so every thread past its deadline is inside it. Binds 8 parameters.
 */
function deletable(workspaceId: string, rule: CommentRetention, now: number): SQL {
  return sql`${eligible(workspaceId)} and ${th.updatedAt} <= ${now - rule.days * DAY_MS} and ${threadDeadlineSql(rule)} <= ${now}`;
}

/**
 * The threads one batch deletes: the oldest activity first, at most `limit`. Binds 9 parameters.
 * Through `annotation_threads_owner_state_updated_idx` (`owner_id=? AND state=? AND
 * updated_at<?`), one workspace's threads old enough to be due.
 */
export function dueThreadIds(
  workspaceId: string,
  rule: CommentRetention,
  now: number,
  limit: number,
): SQL {
  return sql`select ${th.id} from ${th} join ${a} on ${a.id} = ${th.artifactId} where ${deletable(workspaceId, rule, now)} order by ${th.updatedAt}, ${th.id} limit ${limit}`;
}

/** An aggregate without `group by`: SQLite returns exactly one row, with null sums over none. */
async function aggregate<T>(db: Db, query: SQL): Promise<T> {
  return (await db.all<T>(query))[0] as T;
}

async function one(db: Db, query: SQL): Promise<{ threads: number; messages: number }> {
  const row = await aggregate<{ threads: number; messages: number | null }>(db, query);
  return { threads: Number(row.threads), messages: Number(row.messages) };
}

/**
 * What a new or shorter comment retention deletes, for the preview and the confirmation: the
 * threads (and the messages in them) deleted the day it takes effect, and the threads deleted
 * within `retentionHorizonDays` after it. As the threads are now: a reply before then keeps one.
 */
export async function commentRetentionImpact(
  db: Db,
  workspaceId: string,
  rule: CommentRetention,
): Promise<{ threadsAtStart: number; messagesAtStart: number; threadsSoon: number }> {
  const atStart = await one(
    db,
    sql`select count(*) as threads, sum(${th.messageCount}) as messages from ${th} join ${a} on ${a.id} = ${th.artifactId} where ${deletable(workspaceId, rule, rule.from)}`,
  );
  const horizon = rule.from + WORKSPACE_POLICIES.retentionHorizonDays * DAY_MS;
  const soon = await one(
    db,
    sql`select count(*) as threads, 0 as messages from ${th} join ${a} on ${a.id} = ${th.artifactId} where ${deletable(workspaceId, rule, horizon)} and ${threadDeadlineSql(rule)} > ${rule.from}`,
  );
  return {
    threadsAtStart: atStart.threads,
    messagesAtStart: atStart.messages,
    threadsSoon: soon.threads,
  };
}

/** The workspace's policy revision and plan row as the scan read them: the rule in force. */
export interface InForce {
  revision: number;
  /** The plan row's `updated_at`: deleting needs `policies`, so a plan row the scan read. */
  planUpdatedAt: number;
}

/**
 * The rule still in force, as SQL over the global tables: the workspace's policy revision and
 * its plan row unchanged since the scan read them. Only usable where the workspace and its
 * artifacts share a database. Binds at most 4 parameters.
 */
export function inForceSql(workspaceId: string, read: InForce): SQL {
  return sql`exists (select 1 from ${w} where ${w.id} = ${workspaceId} and ${w.policyRevision} = ${read.revision}) and exists (select 1 from ${p} where ${p.ownerId} = ${workspaceId} and ${p.updatedAt} = ${read.planUpdatedAt})`;
}

/**
 * One batch of comment retention for a workspace. Every statement selects the same threads
 * itself (`dueThreadIds`, the oldest first), each held to `inForce`:
 * - `policy.enforced` by the system, with the threads and messages it deletes as counts;
 * - a `thread_deleted` event per thread, so clients drop it on their next refresh, as for a
 *   moderator's deletion;
 * - a `comment_thread` tombstone per thread, so a restore never brings it back: in the batch with
 *   one database; with a separate regional database a `comment_tombstones` job in the regional
 *   batch, on the same selection, which writes them in the global database (the outbox retries
 *   it until it is done);
 * - the threads themselves. Their messages, comment notices and issue requests go with them by
 *   foreign key, and the `annotation_usage` triggers give the owner's quota back.
 * Returns the IDs deleted.
 */
export async function deleteDueThreads(
  db: RegionalDb,
  input: {
    workspaceId: string;
    rule: CommentRetention;
    now: number;
    limit: number;
    read: InForce;
  },
): Promise<string[]> {
  const shared = bothSides(db);
  const x: Db = shared ?? db;
  if (!shared) {
    // No batch spans the two databases: the policy revision and the plan row are read again just
    // before the batch, so a removal, a change or a plan change saved since the scan's read stops
    // it (the window is this round trip).
    const [row] = await db.global
      .select({ revision: w.policyRevision, planUpdatedAt: p.updatedAt })
      .from(w)
      .leftJoin(p, eq(p.ownerId, w.id))
      .where(eq(w.id, input.workspaceId))
      .limit(1);
    if (
      !row ||
      row.revision !== input.read.revision ||
      row.planUpdatedAt !== input.read.planUpdatedAt
    ) {
      return [];
    }
  }
  const inForce = shared ? inForceSql(input.workspaceId, input.read) : sql`1`;
  const ids = dueThreadIds(input.workspaceId, input.rule, input.now, input.limit);
  const threads = sql<number>`(select count(*) from (${ids}))`;
  const messages = sql<number>`coalesce((select sum(${th.messageCount}) from ${th} where ${th.id} in (${ids})), 0)`;
  const statements: BatchItem<"sqlite">[] = [
    auditEvent(
      x,
      {
        ownerId: input.workspaceId,
        kind: "policy.enforced",
        actor: { type: "system" },
        targetId: input.workspaceId,
        detail: {
          artifactsNarrowed: 0,
          readersRemoved: 0,
          linksRevoked: 0,
          sessionsEnded: 0,
          threadsDeleted: 0,
          messagesDeleted: 0,
        },
        computed: { threadsDeleted: threads, messagesDeleted: messages },
        now: input.now,
      },
      sql`${threads} > 0 and ${inForce}`,
    ),
    // Columns in schema order: id, artifact, thread, message, actor, write id, kind, at.
    x
      .insert(schema.annotationEvents)
      .select(
        sql`select null, ${th.artifactId}, ${th.id}, null, 'system', 'retention_' || lower(hex(randomblob(16))), 'thread_deleted', ${input.now} from ${th} where ${th.id} in (${ids}) and ${inForce}`,
      ),
    shared
      ? // Columns in schema order: kind, id, deleted at.
        x
          .insert(schema.tombstones)
          .select(
            sql`select 'comment_thread', ${th.id}, ${input.now} from ${th} where ${th.id} in (${ids}) and ${inForce}`,
          )
          .onConflictDoNothing()
      : // Columns in schema order: id, topic, payload, available, dispatched, attempts, created,
        // subject, generation. Nothing when nothing is deleted (`having`).
        x
          .insert(schema.outbox)
          .select(
            sql`select null, 'comment_tombstones', json_object('ids', json_group_array(${th.id}), 'at', ${input.now}), ${input.now}, null, 0, ${input.now}, ${input.workspaceId}, null from ${th} where ${th.id} in (${ids}) having count(*) > 0`,
          ),
    x.delete(th).where(sql`${th.id} in (${ids}) and ${inForce}`).returning({ id: th.id }),
  ];
  const results = (await x.batch(
    statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]],
  )) as unknown[];
  return (results.at(-1) as { id: string }[]).map((row) => row.id);
}

/**
 * The markers a `comment_tombstones` job's payload stands for: its deleted threads and messages
 * and edit suggestions' restore markers, at the job's time; null when the payload cannot be read.
 * One reading for the job and for `exportTombstones`, which carries the markers of jobs that have
 * not run yet (a restore of the region would lose them with the job).
 */
export function commentTombstoneMarkers(payload: unknown): TombstoneMarker[] | null {
  let value = payload;
  try {
    if (typeof value === "string") value = JSON.parse(value);
  } catch {
    return null;
  }
  const parsed = CommentTombstonesPayload.safeParse(value);
  if (!parsed.success) return null;
  const { ids, messages = [], markers = [], at } = parsed.data;
  return [
    ...ids.map((id) => ({ kind: "comment_thread" as const, id, deletedAt: at })),
    ...messages.map((id) => ({ kind: "comment_message" as const, id, deletedAt: at })),
    ...markers.map(({ kind, id }) => ({ kind, id, deletedAt: at })),
  ];
}

/**
 * Runs a `comment_tombstones` job: the tombstones of what a regional batch deleted or decided, in
 * the global database. Idempotent (`on conflict do nothing`); the outbox runs it again until it is
 * done, so a crash after the change never leaves something a restore could bring back.
 */
export async function writeCommentTombstones(
  db: RegionalDb,
  row: typeof schema.outbox.$inferSelect,
): Promise<"done" | "stale"> {
  const markers = commentTombstoneMarkers(row.payload);
  if (markers === null) {
    logEvent("error", "comment_tombstones_unreadable");
    return "stale";
  }
  for (let i = 0; i < markers.length; i += 25) {
    await db.global
      .insert(schema.tombstones)
      .values(markers.slice(i, i + 25))
      .onConflictDoNothing();
  }
  return "done";
}

// The restore guard (decision 0023, "Restores")
//
// Agreement between two stores on a random token per save, per workspace, with no shared
// counter: the token in the stored policy, next to the rule (D1, which a Time Travel restore
// rewinds), and the workspace's guard record in its region's R2 bucket (which no D1 restore
// rewinds). The scan deletes for a workspace only when, in this run, right before its batch, it
// read that record and its token equals the one in the policy the batch is held to. A restore
// cannot make them agree unless D1's rule is the very rule of the last save that wrote R2: tokens
// are random per save and R2 holds only the last one. Nothing about other workspaces, other
// regions or the operator's commands enters a workspace's agreement, so there is nothing to arm.
//
// Only synchronous paths write the record, each in the order that fails closed: a save that sets
// or shortens the rule writes D1, then R2; a save that lengthens or removes it, a lapse the scan
// records and the operator's plan commands that take `policies` away write R2 first, then D1.
// Never the scan for a deletion and never an outbox job: a restore rewinds the outbox together
// with the rule, so a job retried after a restore would re-arm exactly what the guard must stop.
// The scan's sweep (`sweepGuardRecords`) only ever deletes a record no stored rule vouches for.

/** Where a workspace's guard record lives in its region's bucket. */
export function guardKey(workspaceId: string): string {
  return `system/comment-retention/${workspaceId}`;
}

/** What the scan, the notices and the Policies page learn from the record. */
export type GuardAgreement = "agrees" | "missing" | "different" | "unreadable" | "unavailable";

/** The rule a guard record vouches for: its token, and the days and date it was saved with. */
export interface GuardedRule {
  token?: string | null | undefined;
  days: number;
  from: number;
}

/** The record as stored: `{ token, days, from }`, or null when it cannot be read as one. */
function guardRecordOf(text: string): { token: string; days: number; from: number } | null {
  let stored: unknown;
  try {
    stored = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof stored !== "object" || stored === null) return null;
  const { token, days, from } = stored as Record<string, unknown>;
  if (typeof token !== "string" || token.length === 0) return null;
  if (typeof days !== "number" || typeof from !== "number") return null;
  return { token, days, from };
}

/**
 * Whether the workspace's guard record vouches for `rule`: the same token, days and date, read
 * now, never cached, so a token can never vouch for another rule (a file edited by hand, say).
 * Anything but `agrees` (no record, another rule, an unreadable record, no bucket, an R2 error)
 * means the rule is not in force.
 */
export async function guardAgreement(
  bucket: R2Bucket | undefined,
  workspaceId: string,
  rule: GuardedRule,
): Promise<GuardAgreement> {
  if (!bucket) return "unavailable";
  let text: string;
  try {
    const object = await bucket.get(guardKey(workspaceId));
    if (!object) return "missing";
    text = await object.text();
  } catch {
    return "unavailable";
  }
  const held = guardRecordOf(text);
  if (held === null) return "unreadable";
  return typeof rule.token === "string" &&
    held.token === rule.token &&
    held.days === rule.days &&
    held.from === rule.from
    ? "agrees"
    : "different";
}

/** A fresh token for a save that sets or changes the rule. */
export function newGuardToken(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

/**
 * Writes the workspace's guard record (a save of the rule, only). False when there is no bucket
 * or R2 refused it: the caller decides what that means for its order.
 */
export async function writeGuardRecord(
  bucket: R2Bucket | undefined,
  workspaceId: string,
  rule: { token: string; days: number; from: number },
): Promise<boolean> {
  if (!bucket) return false;
  try {
    await bucket.put(
      guardKey(workspaceId),
      JSON.stringify({ token: rule.token, days: rule.days, from: rule.from }),
    );
    return true;
  } catch (error) {
    logEvent("error", "comment_retention_guard_write_failed", { error: errorLabel(error) });
    return false;
  }
}

/**
 * After a new or shorter rule's R2 write (decision 0023, "Concurrent saves"): the policy is read
 * again, and when it no longer holds this save's token (a removal or another save landed after
 * this save's D1 write), the record is deleted if it still holds that token, so a late write can
 * never arm a rule a later save replaced. Deleting can only pause.
 */
export async function confirmGuardRecord(
  global: Db,
  bucket: R2Bucket | undefined,
  workspaceId: string,
  token: string,
): Promise<void> {
  try {
    const [row] = await global
      .select({ policy: sql<string | null>`${w.policy}` })
      .from(w)
      .where(eq(w.id, workspaceId))
      .limit(1);
    let held: string | null = null;
    try {
      held = row ? policyOf(row.policy).commentRetentionToken : null;
    } catch {
      held = null;
    }
    if (held === token || !bucket) return;
    const object = await bucket.get(guardKey(workspaceId));
    const record = object ? guardRecordOf(await object.text()) : null;
    if (record?.token === token) await bucket.delete(guardKey(workspaceId));
  } catch (error) {
    // After the save's D1 write: never fail the save for it, and leave a trace for the operator
    // (docs/operations.md, "Comment retention": a record whose rule is gone is deleted by hand).
    logEvent("error", "comment_retention_guard_write_failed", { error: errorLabel(error) });
  }
}

/** Deletes the workspace's guard record (a removal, a lapse, a deleted workspace). */
export async function deleteGuardRecord(
  bucket: R2Bucket | undefined,
  workspaceId: string,
): Promise<boolean> {
  if (!bucket) return false;
  try {
    await bucket.delete(guardKey(workspaceId));
    return true;
  } catch (error) {
    logEvent("error", "comment_retention_guard_write_failed", { error: errorLabel(error) });
    return false;
  }
}

// The sweep of guard records (decision 0023, "Restores", "The sweep")
//
// A record the stored policy does not vouch for (no workspace, another region, no rule, or a rule
// with another token, days or date) is what a later restore of the global database could agree
// with. Every write that should remove one already does, but each can fail; the sweep deletes
// what is left within one pass. It only ever deletes, so at worst it pauses a rule, and it
// decides on what it read in this run:
// - one R2 `list` of the prefix per run and region, from a cursor in `maintenance_cursors`;
// - records younger than `GUARD_SWEEP.minAgeMs` by R2's own clock, and workspaces whose row
//   changed within it by D1's, are skipped, so a save between its two writes is not swept unless
//   it stalls longer than that between them (consecutive calls of one request) or lands in the
//   one call between the re-read and the delete below; either way its rule is only paused;
// - one global read per page, for the page's workspaces, by their IDs in one JSON parameter;
// - each record is read again right before its delete, and kept unless it is still the object
//   the list returned (same etag) and still disagrees;
// - any error keeps the record and is logged with an enum reason; a failed list or policy read
//   also keeps the cursor, while a failed read or delete of one record waits for the next pass.

/** The prefix every guard record lives under. */
export const GUARD_PREFIX = guardKey("");

/** How the sweep pages and how old a record (and its workspace's row) must be to be swept. */
export const GUARD_SWEEP = { page: 100, minAgeMs: 10 * 60_000 } as const;

const SWEEP = "comment_retention_guard";
const FOREIGN = "comment_retention_guard_foreign:";

/** What one run of the sweep did in a region. */
export interface GuardSweepRun {
  /** Records the list returned. */
  listed: number;
  deleted: number;
  /** Kept because the record or its workspace's row changed too recently, or since the list. */
  young: number;
  /** Keys under the prefix that name no workspace: left alone, logged once each. */
  foreign: number;
  failed: number;
}

type SweepFailure = "list" | "read" | "policy" | "get" | "delete" | "marker" | "cursor";

function sweepFailed(run: GuardSweepRun, reason: SweepFailure, error?: unknown): void {
  run.failed += 1;
  if (error === undefined) logEvent("error", "comment_retention_guard_sweep_failed", { reason });
  else {
    logEvent("error", "comment_retention_guard_sweep_failed", { reason, error: errorLabel(error) });
  }
}

interface SweptRow {
  id: string;
  region: string;
  policy: unknown;
  updatedAt: number;
}

/** Whether the stored row vouches for the record: this region, a rule, the same token and rule. */
function vouches(
  row: SweptRow | undefined,
  region: Region,
  text: string,
): "agrees" | "stale" | "unreadable" {
  if (!row || row.region !== region) return "stale";
  let policy: WorkspacePolicy;
  try {
    policy = policyOf(row.policy);
  } catch {
    return "unreadable";
  }
  const rule = commentRetentionOf(policy);
  const record = guardRecordOf(text);
  if (rule === null || record === null) return "stale";
  return record.token === policy.commentRetentionToken &&
    record.days === rule.days &&
    record.from === rule.from
    ? "agrees"
    : "stale";
}

/**
 * One run of the sweep in a region, from `started` (the cursor read with the scan's first batch).
 * `wall` is R2's clock for the records' age; `now` is the run's clock for the rows' age and the
 * cursor. Never writes a record.
 */
export async function sweepGuardRecords(
  global: GlobalDb,
  bucket: R2Bucket | undefined,
  now: number,
  region: Region,
  started: string,
  wall: number = Date.now(),
): Promise<GuardSweepRun> {
  const run: GuardSweepRun = { listed: 0, deleted: 0, young: 0, foreign: 0, failed: 0 };
  if (!bucket) return run;
  const name = `${SWEEP}:${region}`;
  let listing: R2Objects;
  try {
    listing = await bucket.list({
      prefix: GUARD_PREFIX,
      limit: GUARD_SWEEP.page,
      ...(started ? { startAfter: started } : {}),
    });
  } catch (error) {
    sweepFailed(run, "list", error);
    return run;
  }
  run.listed = listing.objects.length;
  const old: { object: R2Object; id: string }[] = [];
  const foreign: string[] = [];
  for (const object of listing.objects) {
    const id = object.key.slice(GUARD_PREFIX.length);
    if (!WorkspaceId.safeParse(id).success) {
      run.foreign += 1;
      foreign.push(`${FOREIGN}${region}:${id}`);
    } else if (wall - object.uploaded.getTime() < GUARD_SWEEP.minAgeMs) run.young += 1;
    else old.push({ object, id });
  }
  const last = listing.objects.at(-1)?.key ?? null;
  const next = listing.truncated ? last : null;
  if (old.length === 0 && foreign.length === 0) {
    await saveSweepCursor(global, run, name, started, next, now);
    return run;
  }
  let rows: SweptRow[];
  let known: Set<string>;
  try {
    const ids = JSON.stringify(old.map((entry) => entry.id));
    const [found, marked] = await global.batch([
      global
        // The policy as stored text: one malformed row never fails the page's read.
        .select({
          id: w.id,
          region: w.region,
          policy: sql<string | null>`${w.policy}`,
          updatedAt: w.updatedAt,
        })
        .from(w)
        .where(sql`${w.id} in (select value from json_each(${ids}))`),
      global
        .select({ name: c.name })
        .from(c)
        .where(sql`${c.name} in (select value from json_each(${JSON.stringify(foreign)}))`),
    ]);
    rows = found as SweptRow[];
    known = new Set(marked.map((row) => row.name));
  } catch (error) {
    // Nothing is decided without the rows: the page is read again next run.
    sweepFailed(run, "read", error);
    return run;
  }
  const fresh = foreign.filter((marker) => !known.has(marker));
  if (fresh.length > 0) {
    try {
      await global
        .insert(c)
        .values(
          fresh.map((marker) => ({ name: marker, cursor: "", passStartedAt: now, updatedAt: now })),
        )
        .onConflictDoNothing();
      for (let index = 0; index < fresh.length; index += 1) {
        logEvent("error", "comment_retention_guard_foreign", { region });
      }
    } catch (error) {
      sweepFailed(run, "marker", error);
    }
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const { object, id } of old) {
    const row = byId.get(id);
    if (row && now - row.updatedAt < GUARD_SWEEP.minAgeMs) {
      run.young += 1;
      continue;
    }
    let text: string;
    try {
      const current = await bucket.get(object.key);
      if (!current) continue;
      if (current.etag !== object.etag) {
        run.young += 1;
        continue;
      }
      text = await current.text();
    } catch (error) {
      sweepFailed(run, "get", error);
      continue;
    }
    const verdict = vouches(row, region, text);
    if (verdict === "agrees") continue;
    if (verdict === "unreadable") {
      sweepFailed(run, "policy");
      continue;
    }
    try {
      await bucket.delete(object.key);
      run.deleted += 1;
    } catch (error) {
      sweepFailed(run, "delete", error);
    }
  }
  await saveSweepCursor(global, run, name, started, next, now);
  return run;
}

async function saveSweepCursor(
  global: GlobalDb,
  run: GuardSweepRun,
  name: string,
  started: string,
  next: string | null,
  now: number,
): Promise<void> {
  try {
    await resumeAt(global, name, started, next, now);
  } catch (error) {
    sweepFailed(run, "cursor", error);
  }
}

type PlanRowRead = Parameters<typeof entitlements>[0];

// The scan

const SCAN = "comment_retention";
const WARNED = "comment_retention_warned:";

interface RuleRow {
  id: string;
  policy: unknown;
  revision: number;
  plan: {
    plan: string | null;
    seats: number | null;
    validUntil: number | null;
    overrides: unknown;
    grace: string | null;
    updatedAt: number | null;
  } | null;
  warned: string | null;
}

export interface CommentRetentionRun {
  /** Workspaces with a rule the run read. */
  checked: number;
  threads: number;
  /** Rules suspended because the plan no longer includes `policies`. */
  suspended: number;
  /** True when the restore guard held at least one workspace back this run. */
  paused: boolean;
  /** Workspaces with threads due whose policy and guard record did not agree this run. */
  heldBack: number;
  failed: number;
  /** The sweep of guard records no stored rule vouches for (`sweepGuardRecords`). */
  guardSweep: GuardSweepRun;
}

/**
 * The comment retention scan, per run and region (decision 0023, "Comment retention"):
 * - One global batch reads the saved cursor and up to 100 workspaces of this region with a comment
 *   retention after it (with their plan rows and whether their second notice was decided), and the
 *   sweep's cursor. With no rule in the region and no old guard record that is the only D1 call.
 * - A workspace whose plan no longer includes `policies` has its rule removed by the system
 *   (`policy.changed`, reason `plan_lapsed`), its guard record deleted first: its comments are
 *   kept until an admin sets it again, with a new notice and confirmation.
 * - The second notice is decided once per effective date (`decideSecondNotice`).
 * - Then, for a workspace with threads due, its guard record is read and compared with the token
 *   of the policy the batch is held to (`guardAgreement`); only when they agree does one batch
 *   (at most 50 threads) run, until the run's 200, in turn from the cursor, so a large workspace
 *   never starves the others. Nothing here writes the record.
 * - Last, the sweep (`sweepGuardRecords`): one R2 list of the guard records' prefix from its own
 *   cursor (read in the first batch), deleting records no stored rule vouches for.
 */
export async function enforceCommentRetention(
  db: RegionalDb,
  bucket: R2Bucket | undefined,
  now: number,
  region: Region,
): Promise<CommentRetentionRun> {
  const run: CommentRetentionRun = {
    checked: 0,
    threads: 0,
    suspended: 0,
    paused: false,
    heldBack: 0,
    failed: 0,
    guardSweep: { listed: 0, deleted: 0, young: 0, foreign: 0, failed: 0 },
  };
  const global = db.global;
  const name = `${SCAN}:${region}`;
  try {
    const [swept, saved, rows] = await global.batch([
      // The sweep's cursor rides the scan's first batch, so it adds no call.
      cursorRead(global, `${SWEEP}:${region}`),
      cursorRead(global, name),
      global
        .select({
          id: w.id,
          policy: w.policy,
          revision: w.policyRevision,
          plan: {
            plan: p.plan,
            seats: p.seats,
            validUntil: p.validUntil,
            overrides: p.overrides,
            grace: p.grace,
            updatedAt: p.updatedAt,
          },
          warned: sql<
            string | null
          >`(select ${c.cursor} from ${c} where ${c.name} = ${WARNED} || ${w.id})`,
        })
        .from(w)
        .leftJoin(p, eq(p.ownerId, w.id))
        .where(
          and(
            // `json_valid` first: one malformed policy never fails the statement for the region.
            sql`json_valid(${w.policy}) and json_extract(${w.policy}, '$.commentRetentionDays') is not null`,
            eq(w.region, region),
            gt(w.id, savedCursorSql(name)),
          ),
        )
        .orderBy(asc(w.id))
        .limit(100),
    ]);
    const started = saved[0]?.cursor ?? "";
    const list = rows as RuleRow[];
    run.checked = list.length;
    const sweep = async () => {
      run.guardSweep = await sweepGuardRecords(global, bucket, now, region, swept[0]?.cursor ?? "");
    };
    if (list.length === 0) {
      await resumeAt(global, name, started, null, now);
      await sweep();
      return run;
    }
    let budget: number = WORKSPACE_POLICIES.commentDeleteRun;
    let resume: string | null = started;
    let ended = list.length < 100;
    for (const row of list) {
      if (budget <= 0) {
        ended = false;
        break;
      }
      resume = row.id;
      let policy: WorkspacePolicy;
      try {
        policy = policyOf(row.policy);
      } catch {
        run.failed += 1;
        logEvent("error", "workspace_policy_unreadable");
        continue;
      }
      const rule = commentRetentionOf(policy);
      if (!rule) continue;
      // A workspace without a plan row reads as `plan: null` from the left join: the free plan.
      const plan =
        row.plan?.updatedAt == null ? null : { ...row.plan, updatedAt: row.plan.updatedAt };
      if (plan === null || !hasFeature(entitlements(plan as PlanRowRead, now), "policies")) {
        const lapse = await suspendForPlan(global, bucket, row, policy, now);
        if (lapse) run.suspended += 1;
        continue;
      }
      const read: InForce = { revision: row.revision, planUpdatedAt: plan.updatedAt };
      try {
        await decideSecondNotice(db, row, rule, now);
        if (rule.from > now) continue;
        // R2 is read only for a workspace with something to delete in this run.
        if ((await db.all(dueThreadIds(row.id, rule, now, 1))).length === 0) continue;
        const reason = await guardAgreement(bucket, row.id, rule);
        if (reason !== "agrees") {
          run.paused = true;
          run.heldBack += 1;
          logEvent("log", "comment_retention_held", { reason });
          continue;
        }
        const deleted = await deleteDueThreads(db, {
          workspaceId: row.id,
          rule,
          now,
          limit: Math.min(WORKSPACE_POLICIES.commentDeleteBatch, budget),
          read,
        });
        budget -= deleted.length;
        run.threads += deleted.length;
      } catch (error) {
        run.failed += 1;
        logEvent("error", "comment_retention_failed", { error: errorLabel(error) });
      }
    }
    await resumeAt(global, name, started, ended ? null : resume, now);
    await sweep();
  } catch (error) {
    run.failed += 1;
    logEvent("error", "comment_retention_scan_failed", { error: errorLabel(error) });
  }
  return run;
}

/**
 * A workspace whose plan no longer includes `policies`: its comment retention is removed by the
 * system, in one global batch on the revision read, with `policy.changed` (reason `plan_lapsed`).
 * The guard record goes first (decision 0023, "Restores": a loosening writes R2 before D1), so a
 * restore to before the lapse brings back a rule that no longer agrees with R2. When R2 cannot be
 * written the lapse waits for the next run; nothing is deleted meanwhile, since the plan lacks
 * `policies`. An admin sets the rule again (with a new notice and confirmation) once the plan is
 * back. Returns whether it changed the row.
 */
async function suspendForPlan(
  global: GlobalDb,
  bucket: R2Bucket | undefined,
  row: RuleRow,
  policy: WorkspacePolicy,
  now: number,
): Promise<boolean> {
  if (!(await deleteGuardRecord(bucket, row.id))) {
    logEvent("error", "comment_retention_lapse_deferred");
    return false;
  }
  const next = {
    ...policy,
    commentRetentionDays: null,
    commentRetentionFrom: null,
    commentRetentionToken: null,
  };
  const condition = sql`exists (select 1 from ${w} where ${w.id} = ${row.id} and ${w.policyRevision} = ${row.revision})`;
  const results = await global.batch([
    auditEvent(
      global,
      {
        ownerId: row.id,
        kind: "policy.changed",
        actor: { type: "system" },
        targetId: row.id,
        detail: {
          fields: ["commentRetentionDays"],
          commentRetentionDays: null,
          commentRetentionFrom: null,
          reason: "plan_lapsed",
          confirmed: false,
        },
        now,
      },
      condition,
    ),
    global
      .update(w)
      .set({ policy: storedPolicy(next), policyRevision: row.revision + 1, updatedAt: now })
      .where(and(eq(w.id, row.id), eq(w.policyRevision, row.revision)))
      .returning({ id: w.id }),
  ]);
  return (results.at(-1) as unknown[]).length > 0;
}

/**
 * The second notice to admins (decision 0023), decided once per effective date and marked
 * whatever the decision: a lengthening keeps the date and its decision (the job recounts at send
 * time and drops itself when nothing is due then); a new or shorter rule has a new date and its
 * own first notice. The first deletion is `max(from, the earliest deadline)` of the threads
 * comment retention may ever delete, read once per date. When it comes at least
 * `commentWarnAfterDays` after the save and is still ahead, the job is written to go out
 * `commentWarnDays` before it; otherwise the first notice was recent enough, or deletions started.
 * The job and the mark in one global batch, both conditioned on the revision read.
 */
async function decideSecondNotice(
  db: RegionalDb,
  row: RuleRow,
  rule: CommentRetention,
  now: number,
): Promise<void> {
  if (row.warned === String(rule.from)) return;
  const savedAt = rule.from - WORKSPACE_POLICIES.retentionNoticeDays * DAY_MS;
  const earliest = await aggregate<{ at: number | null }>(
    db,
    sql`select min(${threadDeadlineSql(rule)}) as at from ${th} join ${a} on ${a.id} = ${th.artifactId} where ${eligible(row.id)}`,
  );
  const first = earliest.at === null ? null : Number(earliest.at);
  const global = db.global;
  const condition = sql`exists (select 1 from ${w} where ${w.id} = ${row.id} and ${w.policyRevision} = ${row.revision})`;
  const statements: BatchItem<"sqlite">[] = [];
  if (
    first !== null &&
    first > now &&
    first - savedAt >= WORKSPACE_POLICIES.commentWarnAfterDays * DAY_MS
  ) {
    const counts = await one(
      db,
      sql`select count(*) as threads, sum(${th.messageCount}) as messages from ${th} join ${a} on ${a.id} = ${th.artifactId} where ${deletable(row.id, rule, first)}`,
    );
    statements.push(
      commentRetentionNoticeJob(global, {
        workspaceId: row.id,
        payload: {
          kind: "soon",
          days: rule.days,
          from: rule.from,
          at: first,
          threads: counts.threads,
          messages: counts.messages,
          revision: row.revision,
        },
        condition,
        now,
        availableAt: Math.max(now, first - WORKSPACE_POLICIES.commentWarnDays * DAY_MS),
      }),
    );
  }
  // Columns in schema order: name, cursor, pass started, updated.
  statements.push(
    global
      .insert(c)
      .select(
        sql`select ${`${WARNED}${row.id}`}, ${String(rule.from)}, ${now}, ${now} where ${condition}`,
      )
      .onConflictDoUpdate({ target: c.name, set: { cursor: String(rule.from), updatedAt: now } }),
  );
  await global.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}

/** The `comment_retention_notice` job, in a global batch on `condition`. */
export function commentRetentionNoticeJob(
  db: Db,
  input: {
    workspaceId: string;
    payload: CommentRetentionNoticePayload;
    condition: SQL;
    now: number;
    /** When it goes out; now by default. */
    availableAt?: number;
  },
): BatchItem<"sqlite"> {
  const payload = JSON.stringify(input.payload);
  // Columns in schema order: id, topic, payload, available, dispatched, attempts, created,
  // subject, generation.
  return db
    .insert(schema.outbox)
    .select(
      sql`select null, 'comment_retention_notice', ${payload}, ${input.availableAt ?? input.now}, null, 0, ${input.now}, ${input.workspaceId}, null where ${input.condition}`,
    );
}

/**
 * The threads and messages comment retention may delete at `at`, for a notice's counts: the same
 * definition the scan deletes with.
 */
export function commentRetentionDueAt(
  db: Db,
  workspaceId: string,
  rule: CommentRetention,
  at: number,
): Promise<{ threads: number; messages: number }> {
  return one(
    db,
    sql`select count(*) as threads, sum(${th.messageCount}) as messages from ${th} join ${a} on ${a.id} = ${th.artifactId} where ${deletable(workspaceId, rule, at)}`,
  );
}
