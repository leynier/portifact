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
// - It pauses after a D1 Time Travel restore of the global database (the restore guard): a
//   restore can bring back a rule an admin had removed, and nothing may be deleted by it before the
//   operator re-applies the policies.
// - It fails closed: any error while deciding whether deletion is allowed (the guard, the rule,
//   the plan) means nothing is deleted in that run, or for that workspace.
//
// Every statement selects its own rows and binds a fixed number of parameters (D1 allows 100).
import {
  type CommentRetentionNoticePayload,
  CommentTombstonesPayload,
  WORKSPACE_POLICIES,
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
 * Runs a `comment_tombstones` job: the `comment_thread` tombstones of threads a regional batch
 * deleted, in the global database. Idempotent (`on conflict do nothing`); the outbox runs it again
 * until it is done, so a crash after the deletion never leaves a thread a restore could bring back.
 */
export async function writeCommentTombstones(
  db: RegionalDb,
  row: typeof schema.outbox.$inferSelect,
): Promise<"done" | "stale"> {
  let payload: unknown = row.payload;
  try {
    if (typeof payload === "string") payload = JSON.parse(payload);
  } catch {
    payload = null;
  }
  const parsed = CommentTombstonesPayload.safeParse(payload);
  if (!parsed.success) {
    logEvent("error", "comment_tombstones_unreadable");
    return "stale";
  }
  await db.global
    .insert(schema.tombstones)
    .select(
      // `where 1`: SQLite reads `on conflict` after a bare `from` as part of the join.
      sql`select 'comment_thread', value, ${parsed.data.at} from json_each(${JSON.stringify(parsed.data.ids)}) where 1`,
    )
    .onConflictDoNothing();
  return "done";
}

// The restore guard
//
// Its invariant (decision 0023, "Restores", with its state table): the bucket's mark is
// raise-only, and every change that could make a restored policy delete more than the current one
// (a removal or lengthening saved or applied, a plan lapse recorded by the scan or caused by the
// operator) raises the mark of the workspace's region to the epoch it is about to write before
// writing it; every deleting run moves the epoch, global first, then the mark, before deleting;
// and a scan deletes only while the global epoch is not behind the mark. So a restore of the
// global database to before any of them leaves the epoch behind the mark, and nothing is deleted
// until `apply-policies` re-arms it. A raise that fails is retried by every scan before it does
// anything else; the change goes through anyway (removing is never blocked), so the one window
// left is a restore made while the region's R2 cannot be written.

const EPOCH = "comment_retention_epoch";
/** Where the high-water mark lives in each region's bucket: R2 is never rewound by D1. */
export const COMMENT_RETENTION_EPOCH_KEY = "system/comment-retention-epoch";

/**
 * The restore guard's statement for a global batch: moves the epoch to at least `at` (and past
 * its current value), so a later restore of the global database leaves it behind the marks.
 */
export function bumpEpochStatement(global: Db, at: number) {
  return global
    .insert(c)
    .values({ name: EPOCH, cursor: String(at), passStartedAt: at, updatedAt: at })
    .onConflictDoUpdate({
      target: c.name,
      set: {
        cursor: sql`cast(max(cast(${c.cursor} as integer) + 1, cast(${at} as integer)) as text)`,
        updatedAt: at,
      },
    });
}

/** The epoch the global database holds (no row: none ever moved it). */
export function epochRead(global: Db) {
  return global.select({ cursor: c.cursor }).from(c).where(eq(c.name, EPOCH));
}

/**
 * An epoch as stored: a non-negative integer (SQLite may have written it as `123.0`), or the
 * guard cannot be decided (thrown).
 */
function epochValue(text: string | null | undefined): number {
  if (text === null || text === undefined) return 0;
  const value = Number(text);
  if (!/^\d+(\.0+)?$/.test(text) || !Number.isSafeInteger(value)) {
    throw new Error("unreadable comment retention epoch");
  }
  return value;
}

type PlanRowRead = Parameters<typeof entitlements>[0];

/** The mark as stored: its value, and the etag a conditional write must match (none: absent). */
async function readMark(
  bucket: R2Bucket,
  key: string,
): Promise<{ value: number; etag: string | null }> {
  const object = await bucket.get(key);
  if (!object) return { value: 0, etag: null };
  // Thrown when unreadable: never overwritten, it may be the one that says a restore happened.
  return { value: epochValue(await object.text()), etag: object.etag };
}

/** How many times a raise reads again after another writer changed the mark first. */
const RAISE_ATTEMPTS = 5;

/**
 * Raises a region's mark to `epoch`, never lowers it, whoever else writes it meanwhile: each write
 * is conditional on the object read (`onlyIf` on its etag, or on its absence), so a writer that
 * read an older mark fails its precondition, reads again and stops once the mark is at least its
 * epoch. Throws when the bucket cannot be read or written, or holds a mark it cannot read.
 */
export async function raiseMarkAt(bucket: R2Bucket, key: string, epoch: number): Promise<void> {
  for (let attempt = 0; attempt < RAISE_ATTEMPTS; attempt += 1) {
    const mark = await readMark(bucket, key);
    if (mark.value >= epoch) return;
    const written = await bucket.put(key, String(epoch), {
      onlyIf: mark.etag === null ? { etagDoesNotMatch: "*" } : { etagMatches: mark.etag },
    });
    if (written !== null) return;
  }
  throw new Error("comment retention mark kept changing");
}

/** `raiseMarkAt` for the restore guard's own key. */
export function raiseBucketMark(bucket: R2Bucket, epoch: number): Promise<void> {
  return raiseMarkAt(bucket, COMMENT_RETENTION_EPOCH_KEY, epoch);
}

/**
 * Before a write that loosens or removes a rule (a save, a lapse, an operator's plan change, an
 * applied policy): the epoch it will write, `max(global epoch + 1, now)`, raised in the region's
 * mark first. The write then puts the epoch at `max(epoch + 1, it)` in its own batch
 * (`bumpEpochStatement`). If the batch fails after the raise, the mark is ahead and the scans
 * pause until `apply-policies`: closed. If the raise fails, the write still goes through
 * (removing is never blocked) and every scan raises it before anything else; `raised` says which.
 */
export async function raiseBeforeLoosening(
  global: Db,
  bucket: R2Bucket | undefined,
  now: number,
): Promise<{ epoch: number; raised: boolean }> {
  const [row] = await epochRead(global);
  const epoch = Math.max((Number(row?.cursor ?? 0) || 0) + 1, now);
  if (!bucket) return { epoch, raised: false };
  try {
    await raiseBucketMark(bucket, epoch);
    return { epoch, raised: true };
  } catch (error) {
    logEvent("error", "comment_retention_epoch_sync_failed", { error: errorLabel(error) });
    return { epoch, raised: false };
  }
}

export type ArmResult =
  | { armed: true; epoch: number }
  | { armed: false; reason: "no_bucket" | "unreadable" };

/**
 * Re-arms comment retention after a restore (run by `apply-policies`, once the policies are back
 * and none is stricter than the file's). The new epoch comes from the stored values, never a
 * clock: one more than the highest of the global epoch and every region's mark, written to every
 * mark first (raise-only), then to the global database. Not armed when a region's bucket is
 * missing or its mark cannot be read: the scans stay paused and the operator is told.
 */
export async function armCommentRetention(
  global: GlobalDb,
  buckets: readonly (R2Bucket | undefined)[],
  now: number,
): Promise<ArmResult> {
  if (buckets.length === 0 || buckets.some((bucket) => bucket === undefined)) {
    return { armed: false, reason: "no_bucket" };
  }
  try {
    const [row] = await epochRead(global);
    const marks = await Promise.all(
      buckets.map(
        async (bucket) => (await readMark(bucket as R2Bucket, COMMENT_RETENTION_EPOCH_KEY)).value,
      ),
    );
    const epoch = Math.max(Number(row?.cursor ?? 0) || 0, ...marks) + 1;
    for (const bucket of buckets) await raiseBucketMark(bucket as R2Bucket, epoch);
    await global
      .insert(c)
      .values({ name: EPOCH, cursor: String(epoch), passStartedAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: c.name, set: { cursor: String(epoch), updatedAt: now } });
    return { armed: true, epoch };
  } catch (error) {
    logEvent("error", "comment_retention_arm_failed", { error: errorLabel(error) });
    return { armed: false, reason: "unreadable" };
  }
}

/**
 * The last global epoch this isolate saw the mark of a bucket at or above: with no rule in the
 * region and the epoch unchanged since, the run has nothing to raise and nothing to delete, so it
 * skips reading R2. The mark is raise-only, so it is still at least that value.
 */
const confirmed = new WeakMap<R2Bucket, number>();

/**
 * The guard at the start of a run: `allowed` only when the mark was read, is not ahead of the
 * global epoch (a restore of the global database) and, when behind it, was raised to it. Anything
 * else, a thrown error included, is `paused` for the whole run.
 */
async function openGuard(
  bucket: R2Bucket | undefined,
  read: string | undefined,
): Promise<"allowed" | "paused"> {
  if (!bucket) {
    logEvent("error", "comment_retention_no_bucket");
    return "paused";
  }
  try {
    const database = epochValue(read);
    const held = (await readMark(bucket, COMMENT_RETENTION_EPOCH_KEY)).value;
    if (database < held) {
      logEvent("error", "comment_retention_paused");
      return "paused";
    }
    if (database > held) await raiseBucketMark(bucket, database);
    confirmed.set(bucket, database);
    return "allowed";
  } catch (error) {
    logEvent("error", "comment_retention_guard_failed", { error: errorLabel(error) });
    return "paused";
  }
}

/**
 * Before a run's first deletion: the epoch moves forward, global first, then the mark, so a
 * restore to before this run pauses the next one. False (and the run deletes nothing) when either
 * write fails; a global epoch left ahead of the mark is raised by the next run's `openGuard`. The
 * mark after the epoch here, unlike a loosening's: a run moves the epoch only to date its own
 * deletions, and a mark ahead of a batch that failed would pause the region for nothing.
 */
async function advanceGuard(global: GlobalDb, bucket: R2Bucket, now: number): Promise<boolean> {
  try {
    await bumpEpochStatement(global, now);
    const [row] = await epochRead(global);
    const epoch = epochValue(row?.cursor);
    await raiseBucketMark(bucket, epoch);
    confirmed.set(bucket, epoch);
    return true;
  } catch (error) {
    logEvent("error", "comment_retention_guard_failed", { error: errorLabel(error) });
    return false;
  }
}

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
  /** True when the restore guard held the run back (a restore, or the guard undecidable). */
  paused: boolean;
  failed: number;
}

/**
 * The comment retention scan, per run and region (decision 0023, "Comment retention"):
 * - One global batch reads the saved cursor, up to 100 workspaces of this region with a comment
 *   retention after it (with their plan rows and whether their second notice was decided), and
 *   the restore guard's epoch. With no rule and no epoch anywhere that is the only call.
 * - The guard (`openGuard`), every run with an epoch or a rule: paused when the global epoch is
 *   behind this region's bucket (a D1 Time Travel restore) or anything about it fails; the bucket
 *   raised to the epoch when behind it.
 * - A workspace whose plan no longer includes `policies` has its rule removed by the system
 *   (`policy.changed`, reason `plan_lapsed`): its comments are kept until an admin sets it again,
 *   with a new notice and confirmation.
 * - The second notice is decided once per effective date (`decideSecondNotice`).
 * - Then, unless paused, the epoch moves forward before the first deletion (`advanceGuard`), and
 *   one batch per workspace (at most 50 threads), until the run's 200, in turn from the cursor,
 *   so a large workspace never starves the others.
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
    failed: 0,
  };
  const global = db.global;
  const name = `${SCAN}:${region}`;
  try {
    const [saved, rows, epochRows] = await global.batch([
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
      epochRead(global),
    ]);
    const started = saved[0]?.cursor ?? "";
    const list = rows as RuleRow[];
    run.checked = list.length;
    if (list.length === 0 && epochRows.length === 0) {
      await resumeAt(global, name, started, null, now);
      return run;
    }
    const database = epochRows[0]?.cursor;
    if (
      list.length === 0 &&
      bucket !== undefined &&
      database !== undefined &&
      confirmed.get(bucket) === Number(database)
    ) {
      // No rule in the region and the epoch as this isolate last saw the mark hold it: nothing
      // to raise, nothing to delete (decision 0023, "What it costs").
      await resumeAt(global, name, started, null, now);
      return run;
    }
    let guard = await openGuard(bucket, database);
    let advanced = false;
    run.paused = guard === "paused";
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
        if (lapse.changed) run.suspended += 1;
        if (!lapse.raised) {
          // The mark is behind the epoch the lapse wrote: nothing more this run.
          guard = "paused";
          run.paused = true;
        }
        continue;
      }
      const read: InForce = { revision: row.revision, planUpdatedAt: plan.updatedAt };
      try {
        // Nothing is announced or deleted while paused.
        if (guard !== "allowed" || !bucket) continue;
        await decideSecondNotice(db, row, rule, now);
        if (rule.from > now) continue;
        if (!advanced) {
          advanced = true;
          if (!(await advanceGuard(global, bucket, now))) {
            guard = "paused";
            run.paused = true;
            continue;
          }
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
  } catch (error) {
    run.failed += 1;
    logEvent("error", "comment_retention_scan_failed", { error: errorLabel(error) });
  }
  return run;
}

/**
 * A workspace whose plan no longer includes `policies`: its comment retention is removed by the
 * system, in one global batch on the revision read, with `policy.changed` (reason
 * `plan_lapsed`), and the epoch moves, raised in the region's mark first
 * (`raiseBeforeLoosening`), so a restore to before it pauses deletions. Nothing is deleted
 * meanwhile, and an admin sets it again (with a new notice and confirmation) once the plan is
 * back. Returns whether it changed the row, and whether the mark was raised.
 */
async function suspendForPlan(
  global: GlobalDb,
  bucket: R2Bucket | undefined,
  row: RuleRow,
  policy: WorkspacePolicy,
  now: number,
): Promise<{ changed: boolean; raised: boolean }> {
  const { epoch, raised } = await raiseBeforeLoosening(global, bucket, now);
  const next = { ...policy, commentRetentionDays: null, commentRetentionFrom: null };
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
    bumpEpochStatement(global, epoch),
    global
      .update(w)
      .set({ policy: storedPolicy(next), policyRevision: row.revision + 1, updatedAt: now })
      .where(and(eq(w.id, row.id), eq(w.policyRevision, row.revision)))
      .returning({ id: w.id }),
  ]);
  return { changed: (results.at(-1) as unknown[]).length > 0, raised };
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
