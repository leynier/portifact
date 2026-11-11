// Comment retention (decision 0023, "Comment retention"; a workspace policy, feature `policies`):
// whole threads, with every message, are deleted for good once their last activity is older than
// the workspace's period, except open threads on the artifact's current version. The rules are in
// packages/domain/src/workspace-policies.ts (`threadDeadline`, `threadDeletable`); this module is
// their SQL side, the preview's counts, the deletion and the scan that runs it.
//
// Nothing here can be undone, so three things hold for every deletion:
// - It happens only in the scan, in bounded batches, never in a request or a save's job.
// - Its statements are held to the rule still being in force: with the workspace and its
//   artifacts in one database, each statement checks the workspace's policy revision and its plan
//   row as the scan read them; with a separate regional database the revision is read again right
//   before each batch (the window is one round trip and one batch of at most 50 threads).
// - It pauses after a D1 Time Travel restore of the global database (the restore guard): a
//   restore can bring back a rule an admin had removed, and nothing may be deleted by it before the
//   operator re-applies the policies.
//
// Every statement selects its own rows and binds a fixed number of parameters (D1 allows 100).
import {
  type CommentRetentionNoticePayload,
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
 * `threadDeadline` in SQL over a thread (`th`) joined to its artifact (`a`): the later of the
 * rule's effective date, the move notice after the artifact's `life_started_at` (a move into the
 * workspace, or a restore), and the thread's last activity plus the days. Binds 3 parameters.
 */
export function threadDeadlineSql(rule: CommentRetention): SQL<number> {
  return sql<number>`max(${rule.from}, coalesce(${a.lifeStartedAt} + ${WORKSPACE_POLICIES.commentMoveNoticeDays * DAY_MS}, 0), ${th.updatedAt} + ${rule.days * DAY_MS})`;
}

/**
 * The threads comment retention may delete at `now` (`threadDeletable` in SQL): the workspace's,
 * on an artifact it still owns that is active or archived, not open on the current version, past
 * their deadline. Binds 6 parameters.
 */
function deletable(workspaceId: string, rule: CommentRetention, now: number): SQL {
  return sql`${th.ownerId} = ${workspaceId} and ${a.ownerId} = ${th.ownerId} and ${a.state} in ('active', 'archived') and (${th.state} = 'resolved' or ${a.currentVersionId} is null or ${th.versionId} <> ${a.currentVersionId}) and ${threadDeadlineSql(rule)} <= ${now}`;
}

/**
 * The threads one batch deletes: the oldest activity first, at most `limit`. Binds 7 parameters.
 * Through `annotation_threads_owner_state_updated_idx` (`owner_id=?`), one workspace's threads.
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
 * - with one database, a `comment_thread` tombstone per thread, so a restore never brings it back;
 * - the threads themselves. Their messages, comment notices and issue requests go with them by
 *   foreign key, and the `annotation_usage` triggers give the owner's quota back.
 * Returns the IDs deleted (the tombstones of a separate regional database are written from them,
 * on the global database, after the batch).
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
    // No batch spans the two databases: the policy is read again just before the batch, so a
    // removal or a change saved since the scan's read stops it (the window is this round trip).
    const [row] = await db.global
      .select({ revision: w.policyRevision })
      .from(w)
      .where(eq(w.id, input.workspaceId))
      .limit(1);
    if (!row || row.revision !== input.read.revision) return [];
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
    ...(shared
      ? [
          // Columns in schema order: kind, id, deleted at.
          x
            .insert(schema.tombstones)
            .select(
              sql`select 'comment_thread', ${th.id}, ${input.now} from ${th} where ${th.id} in (${ids}) and ${inForce}`,
            )
            .onConflictDoNothing(),
        ]
      : []),
    x.delete(th).where(sql`${th.id} in (${ids}) and ${inForce}`).returning({ id: th.id }),
  ];
  const results = (await x.batch(
    statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]],
  )) as unknown[];
  const deleted = (results.at(-1) as { id: string }[]).map((row) => row.id);
  if (!shared && deleted.length > 0) {
    // After the deletion, never before: a tombstone for a thread that was not deleted would
    // delete it after a restore. A crash in between leaves deleted threads without tombstones,
    // which a restore could bring back (decision 0023, "Restores").
    await db.global
      .insert(schema.tombstones)
      .select(
        // `where 1`: SQLite reads `on conflict` after a bare `from` as part of the join.
        sql`select 'comment_thread', value, ${input.now} from json_each(${JSON.stringify(deleted)}) where 1`,
      )
      .onConflictDoNothing();
  }
  return deleted;
}

// The restore guard

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
        cursor: sql`cast(max(cast(${c.cursor} as integer) + 1, ${now}) as text)`,
        updatedAt: now,
      },
    });
}

/** The epoch the global database holds (0 without one). */
export function epochRead(global: Db) {
  return global.select({ cursor: c.cursor }).from(c).where(eq(c.name, EPOCH));
}

type PlanRowRead = Parameters<typeof entitlements>[0];

async function bucketEpoch(bucket: R2Bucket): Promise<number> {
  const object = await bucket.get(COMMENT_RETENTION_EPOCH_KEY);
  return object ? Number(await object.text()) || 0 : 0;
}

/**
 * Raises a bucket's high-water mark to the database's epoch, never lowers it. Called by the scan
 * every run it reads the guard, and by a save that removes or lengthens comment retention.
 */
export async function syncBucketEpoch(bucket: R2Bucket, epoch: number): Promise<void> {
  if ((await bucketEpoch(bucket)) < epoch)
    await bucket.put(COMMENT_RETENTION_EPOCH_KEY, String(epoch));
}

/**
 * Re-arms comment retention after a restore (run by `apply-policies`, once the policies are back).
 * Epochs are wall-clock times (each bump is at least the time it happened), so moving the global
 * epoch to `now` puts it ahead of every bucket's last bump without reading them: the scans run
 * again under the policies now in force, and raise the buckets to it. Returns the new epoch.
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
  /** True when the restore guard held the run back. */
  paused: boolean;
  failed: number;
}

/**
 * The comment retention scan, per run and region (decision 0023, "Comment retention"):
 * - One global batch reads the saved cursor, up to 100 workspaces of this region with a comment
 *   retention after it (with their plan rows and whether their second notice went out), and the
 *   restore guard's epoch. With no rule anywhere that is the only call.
 * - A workspace whose plan no longer includes `policies` has its rule removed by the system
 *   (`policy.changed`, reason `plan_lapsed`): its comments are kept until an admin sets it again,
 *   with a new notice and confirmation.
 * - Before the first deletion of a run, the guard: if the global epoch is behind this region's
 *   bucket, the global database was rewound (a D1 Time Travel restore), so nothing is deleted
 *   until `apply-policies` re-arms it; otherwise the epoch moves forward in both.
 * - Then one batch per workspace (at most 50 threads), until the run's 200, in turn from the
 *   cursor, so a large workspace never starves the others; and the second notice of a workspace
 *   whose first deletion is close.
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
            sql`json_extract(${w.policy}, '$.commentRetentionDays') is not null`,
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
    if (list.length === 0) {
      await resumeAt(global, name, started, null, now);
      return run;
    }
    let budget: number = WORKSPACE_POLICIES.commentDeleteRun;
    let guardChecked = false;
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
        if (await suspendForPlan(global, row, policy, now)) run.suspended += 1;
        continue;
      }
      const read: InForce = { revision: row.revision, planUpdatedAt: plan.updatedAt };
      try {
        await maybeWarn(db, row, rule, now);
        if (rule.from > now) continue;
        if (!guardChecked) {
          guardChecked = true;
          if (!(await guardAllows(global, bucket, epochRows[0]?.cursor, now))) {
            run.paused = true;
            break;
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
 * The restore guard, checked once per run before its first deletion: the global epoch must not be
 * behind this region's bucket. When it is, the global database was rewound since a deletion or a
 * removal recorded it, and the run deletes nothing (logged) until the operator re-applies the
 * policies. Otherwise the epoch moves forward (global first, then the bucket), so this run's
 * deletions are recorded before they happen. Without a bucket (a Worker that does not bind it),
 * nothing is deleted.
 */
async function guardAllows(
  global: GlobalDb,
  bucket: R2Bucket | undefined,
  read: string | undefined,
  now: number,
): Promise<boolean> {
  if (!bucket) {
    logEvent("error", "comment_retention_no_bucket");
    return false;
  }
  const database = Number(read ?? 0) || 0;
  if (database < (await bucketEpoch(bucket))) {
    logEvent("error", "comment_retention_paused");
    return false;
  }
  await bumpEpochStatement(global, now);
  const [row] = await epochRead(global);
  await syncBucketEpoch(bucket, Number(row?.cursor ?? now));
  return true;
}

/**
 * A workspace whose plan no longer includes `policies`: its comment retention is removed by the
 * system, in one global batch on the revision read, with `policy.changed` (reason
 * `plan_lapsed`). Nothing is deleted meanwhile, and an admin sets it again (with a new notice and
 * confirmation) once the plan is back. Returns whether it changed the row.
 */
async function suspendForPlan(
  global: GlobalDb,
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
  return (results.at(-1) as unknown[]).length > 0;
}

/**
 * The second notice to admins (decision 0023): once per policy revision, when the first deletion
 * is at most `commentWarnDays` away and comes at least `commentWarnAfterDays` after the save that
 * set the rule (otherwise the first notice was recent enough). One regional read for the earliest
 * deadline, only for a workspace not yet warned for this revision; the job and the mark in one
 * global batch, conditioned on the revision.
 */
async function maybeWarn(
  db: RegionalDb,
  row: RuleRow,
  rule: CommentRetention,
  now: number,
): Promise<void> {
  if (row.warned === String(row.revision)) return;
  const savedAt = rule.from - WORKSPACE_POLICIES.retentionNoticeDays * DAY_MS;
  const window = now + WORKSPACE_POLICIES.commentWarnDays * DAY_MS;
  // Too early to know, or the save itself was close enough to the first deletion.
  if (window < savedAt + WORKSPACE_POLICIES.commentWarnAfterDays * DAY_MS) return;
  const first = await aggregate<{ at: number | null; threads: number; messages: number | null }>(
    db,
    sql`select min(${threadDeadlineSql(rule)}) as at, count(*) as threads, sum(${th.messageCount}) as messages from ${th} join ${a} on ${a.id} = ${th.artifactId} where ${deletable(row.id, rule, window)}`,
  );
  const at = first.at === null ? null : Number(first.at);
  if (at === null || at - savedAt < WORKSPACE_POLICIES.commentWarnAfterDays * DAY_MS) return;
  const payload: CommentRetentionNoticePayload = {
    kind: "soon",
    days: rule.days,
    from: rule.from,
    at,
    threads: Number(first.threads),
    messages: Number(first.messages),
    revision: row.revision,
  };
  const global = db.global;
  const condition = sql`exists (select 1 from ${w} where ${w.id} = ${row.id} and ${w.policyRevision} = ${row.revision})`;
  await global.batch([
    commentRetentionNoticeJob(global, { workspaceId: row.id, payload, condition, now }),
    // The mark of the revision read: if the policy changed meanwhile, the job above did not go
    // out and the next revision is warned on its own.
    global
      .insert(c)
      .values({
        name: `${WARNED}${row.id}`,
        cursor: String(row.revision),
        passStartedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: c.name,
        set: { cursor: String(row.revision), updatedAt: now },
      }),
  ]);
}

/** The `comment_retention_notice` job, in a global batch on `condition`. */
export function commentRetentionNoticeJob(
  db: Db,
  input: {
    workspaceId: string;
    payload: CommentRetentionNoticePayload;
    condition: SQL;
    now: number;
  },
): BatchItem<"sqlite"> {
  const payload = JSON.stringify(input.payload);
  // Columns in schema order: id, topic, payload, available, dispatched, attempts, created,
  // subject, generation.
  return db
    .insert(schema.outbox)
    .select(
      sql`select null, 'comment_retention_notice', ${payload}, ${input.now}, null, 0, ${input.now}, ${input.workspaceId}, null where ${input.condition}`,
    );
}
