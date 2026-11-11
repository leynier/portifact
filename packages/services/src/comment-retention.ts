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
 * When a thread's version stopped being current, in SQL: its own `superseded_at`, or, when that
 * is unknown (a version pruned since, or one replaced before the column existed), the moment the
 * artifact's current version was committed, which is never earlier than the true one.
 */
const LEFT_CURRENT = sql`coalesce((select "tv"."superseded_at" from "versions" as "tv" where "tv"."id" = ${th.versionId}), (select "cv"."committed_at" from "versions" as "cv" where "cv"."id" = ${a.currentVersionId}), ${th.updatedAt})`;

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
// Its invariant (decision 0023, "Restores"): every value the global epoch takes reaches each
// region's bucket before that region's scan deletes again, and every change that could make a
// restored policy delete more than the current one (a removal, a lengthening, a plan lapse) and
// every deleting run moves the epoch; so after a restore of the global database to any point
// before the latest such change, the global epoch is behind the bucket and nothing is deleted
// until `apply-policies` re-arms it.

const EPOCH = "comment_retention_epoch";
/** Where the high-water mark lives in each region's bucket: R2 is never rewound by D1. */
export const COMMENT_RETENTION_EPOCH_KEY = "system/comment-retention-epoch";

/**
 * The restore guard's statement for a global batch: moves the epoch to at least `now` (and past
 * its current value), so a later restore of the global database leaves it behind the buckets'.
 */
export function bumpEpochStatement(global: Db, now: number) {
  return global
    .insert(c)
    .values({ name: EPOCH, cursor: String(now), passStartedAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: c.name,
      set: {
        cursor: sql`cast(max(cast(${c.cursor} as integer) + 1, cast(${now} as integer)) as text)`,
        updatedAt: now,
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

/** The bucket's high-water mark: 0 without an object, thrown when one exists but is unreadable. */
async function bucketEpoch(bucket: R2Bucket): Promise<number> {
  const object = await bucket.get(COMMENT_RETENTION_EPOCH_KEY);
  return object ? epochValue(await object.text()) : 0;
}

/**
 * Raises a bucket's high-water mark to `epoch`, never lowers it. Throws when the bucket cannot be
 * read or written, or holds a mark it cannot read (never overwritten: it may be the one that
 * says a restore happened).
 */
export async function syncBucketEpoch(bucket: R2Bucket, epoch: number): Promise<void> {
  if ((await bucketEpoch(bucket)) < epoch)
    await bucket.put(COMMENT_RETENTION_EPOCH_KEY, String(epoch));
}

/**
 * After a write that moved the global epoch (a removal or lengthening saved, a lapse recorded):
 * raises the region's bucket to it now rather than at the next scan. Best effort and logged; the
 * next scan raises it before anything else, and deletes nothing in that region until it has.
 */
export async function raiseBucketEpoch(
  global: GlobalDb,
  bucket: R2Bucket | undefined,
): Promise<void> {
  try {
    if (!bucket) return;
    const [row] = await epochRead(global);
    await syncBucketEpoch(bucket, epochValue(row?.cursor));
  } catch (error) {
    logEvent("error", "comment_retention_epoch_sync_failed", { error: errorLabel(error) });
  }
}

/**
 * Re-arms comment retention after a restore (run by `apply-policies`, once the policies are back).
 * Epochs are wall-clock times (each bump is at least the time it happened), so moving the global
 * epoch to `now` puts it ahead of every bucket's last bump without reading them: the scans raise
 * the buckets to it and run again under the policies now in force. Returns the new epoch.
 */
export async function armCommentRetention(global: GlobalDb, now: number): Promise<number> {
  const [row] = await epochRead(global);
  const epoch = Math.max(Number(row?.cursor ?? 0) || 0, now);
  await global
    .insert(c)
    .values({ name: EPOCH, cursor: String(epoch), passStartedAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: c.name, set: { cursor: String(epoch), updatedAt: now } });
  return epoch;
}

/**
 * The guard at the start of a run: `allowed` only when the bucket was read, holds no mark ahead
 * of the global epoch (a restore of the global database) and, when behind it, was raised to it.
 * Anything else, a thrown error included, is `paused` for the whole run.
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
    const held = await bucketEpoch(bucket);
    if (database < held) {
      logEvent("error", "comment_retention_paused");
      return "paused";
    }
    if (database > held) await bucket.put(COMMENT_RETENTION_EPOCH_KEY, String(database));
    return "allowed";
  } catch (error) {
    logEvent("error", "comment_retention_guard_failed", { error: errorLabel(error) });
    return "paused";
  }
}

/**
 * Before a run's first deletion: the epoch moves forward, global first, then the bucket, so a
 * restore to before this run pauses the next one. False (and the run deletes nothing) when either
 * write fails; a global epoch left ahead of the bucket is raised by the next run's `openGuard`.
 */
async function advanceGuard(global: GlobalDb, bucket: R2Bucket, now: number): Promise<boolean> {
  try {
    await bumpEpochStatement(global, now);
    const [row] = await epochRead(global);
    await syncBucketEpoch(bucket, epochValue(row?.cursor));
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
    let guard = await openGuard(bucket, epochRows[0]?.cursor);
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
        if (await suspendForPlan(global, bucket, row, policy, now)) run.suspended += 1;
        continue;
      }
      const read: InForce = { revision: row.revision, planUpdatedAt: plan.updatedAt };
      try {
        await decideSecondNotice(db, row, rule, now);
        if (rule.from > now || guard !== "allowed" || !bucket) continue;
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
 * `plan_lapsed`), and the epoch moves (raised in the bucket right after, and by the next scan
 * otherwise), so a restore to before it pauses deletions. Nothing is deleted meanwhile, and an
 * admin sets it again (with a new notice and confirmation) once the plan is back. Returns whether
 * it changed the row.
 */
async function suspendForPlan(
  global: GlobalDb,
  bucket: R2Bucket | undefined,
  row: RuleRow,
  policy: WorkspacePolicy,
  now: number,
): Promise<boolean> {
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
    bumpEpochStatement(global, now),
    global
      .update(w)
      .set({ policy: storedPolicy(next), policyRevision: row.revision + 1, updatedAt: now })
      .where(and(eq(w.id, row.id), eq(w.policyRevision, row.revision)))
      .returning({ id: w.id }),
  ]);
  await raiseBucketEpoch(global, bucket);
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
