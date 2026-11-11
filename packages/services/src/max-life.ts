// A workspace's maximum life of artifacts (decision 0023, a workspace policy, feature
// `policies`): the SQL side of the rules in packages/domain/src/workspace-policies.ts
// (`maxLifeDeadline`, `policyExpiry`). The maximum only ever caps `artifacts.expires_at`; an
// artifact that reaches it is archived by the usual expiry scan (`archiveExpired`), so archiving
// by policy is never a path of its own and nothing here deletes anything.
//
// A cap is never left without the rule that set it: whenever the maximum brings an expiry
// forward, the plan's expiry is kept in `uncapped_expires_at`, and the job and the scan give it
// back (to the plan's expiry, or to the current maximum's deadline if that is earlier) whenever
// the policy now allows later than the stored cap. So any sequence of saves (set, shorten,
// lengthen, remove) ends with every artifact at `min(plan's expiry, current deadline)`, never
// before the current policy's effective date, and at the plan's expiry once there is none.
//
// Every statement selects the rows it changes itself and binds a fixed number of parameters
// (D1 allows at most 100): never a list of IDs that grows with the batch.
import { LIMITS, WORKSPACE_POLICIES, type WorkspacePolicy } from "@portifact/contracts";
import { type Db, schema } from "@portifact/db";
import { type MaxLife, maxLifeOf } from "@portifact/domain";
import { type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

const DAY_MS = 86_400_000;
const a = schema.artifacts;

/**
 * Where an artifact's life starts, as SQL over the `artifacts` row in scope: the later of its
 * current version's commit (a publish or a rollback; its creation for a version committed before
 * the column was filled) and `life_started_at` (its last restore or move into another space).
 * The artifact's own creation when it has no version. Column names are written out so the
 * expression binds to the outer row inside a subquery, an update or a select alike.
 */
export const lifeStartSql = sql<number>`max(coalesce((select coalesce("lv"."committed_at", "lv"."created_at") from "versions" "lv" where "lv"."id" = "artifacts"."current_version_id"), "artifacts"."created_at"), coalesce("artifacts"."life_started_at", 0))`;

/** `maxLifeDeadline` in SQL: never before the maximum takes effect. Binds 2 parameters. */
export function maxLifeDeadlineSql(life: MaxLife, lifeStart: SQL = lifeStartSql): SQL<number> {
  return sql<number>`max(${life.from}, ${lifeStart} + ${life.days * DAY_MS})`;
}

/** The deadline as a cap writes it: never before `now` (`policyExpiry`). Binds 3 parameters. */
function floorSql(life: MaxLife, now: number): SQL<number> {
  return sql<number>`max(${maxLifeDeadlineSql(life)}, ${now})`;
}

/**
 * `policyExpiry` in SQL, over the row's own life start (renewals and unpins, which keep the life
 * where it is): the plan's expiry capped by the maximum life, never before `now`. Without a
 * maximum, the plan's expiry.
 */
export function cappedExpirySql(
  policy: WorkspacePolicy | undefined,
  planExpiry: number,
  now: number,
): SQL<number> {
  const life = maxLifeOf(policy);
  return life === null
    ? sql<number>`${planExpiry}`
    : sql<number>`min(${planExpiry}, ${floorSql(life, now)})`;
}

/** `uncappedExpiry` in SQL, beside `cappedExpirySql`: the plan's expiry when the cap bound. */
export function uncappedExpirySql(
  policy: WorkspacePolicy | undefined,
  planExpiry: number,
  now: number,
): SQL<number | null> {
  return sql<
    number | null
  >`case when ${cappedExpirySql(policy, planExpiry, now)} < ${planExpiry} then ${planExpiry} else null end`;
}

/** Active and not already past its expiry: a cap or a give-back never touches anything else. */
const live = (workspaceId: string, now: number) =>
  sql`${a.ownerId} = ${workspaceId} and ${a.state} = 'active' and (${a.expiresAt} is null or ${a.expiresAt} > ${now})`;
const owned = (workspaceId: string) => sql`${a.ownerId} = ${workspaceId} and ${a.state} = 'active'`;

async function count(db: Db, query: SQL): Promise<number> {
  const [row] = await db.all<{ n: number }>(sql`select (${query}) as n`);
  return Number(row?.n ?? 0);
}

/**
 * What a new or shorter maximum life does to the workspace's active artifacts, for the preview
 * and the confirmation (decision 0023): those archived on the day it takes effect (`from`), those
 * archived within `retentionHorizonDays` after it earlier than their expiry would have, and the
 * pinned ones it unpins. Only for a change that sets or shortens it; anything else changes no
 * artifact earlier, so it counts nothing.
 */
export async function maxLifeImpact(
  db: Db,
  workspaceId: string,
  life: MaxLife,
): Promise<{ artifactsAtStart: number; artifactsSoon: number; pinsLifted: number }> {
  const deadline = maxLifeDeadlineSql(life);
  const horizon = life.from + WORKSPACE_POLICIES.retentionHorizonDays * DAY_MS;
  // Pinned, or expiring later than the deadline by its plan (an earlier cap is given back first,
  // so it is the plan's expiry that counts): the maximum is what archives it.
  const later = sql`(${a.pinned} = 1 or ${a.expiresAt} is null or coalesce(${a.uncappedExpiresAt}, ${a.expiresAt}) > ${deadline})`;
  return {
    artifactsAtStart: await count(
      db,
      sql`select count(*) from ${a} where ${owned(workspaceId)} and ${later} and ${deadline} <= ${life.from}`,
    ),
    artifactsSoon: await count(
      db,
      sql`select count(*) from ${a} where ${owned(workspaceId)} and ${later} and ${deadline} > ${life.from} and ${deadline} <= ${horizon}`,
    ),
    pinsLifted: await count(
      db,
      sql`select count(*) from ${a} where ${owned(workspaceId)} and ${a.pinned} = 1`,
    ),
  };
}

/**
 * The active artifacts of a workspace whose expiry the maximum life must cap: pinned ones, and
 * those expiring later than their deadline (never before now). At most `limit`, by ID. Binds 7
 * parameters.
 */
export function overMaxLifeIds(
  workspaceId: string,
  life: MaxLife,
  now: number,
  limit: number,
): SQL {
  return sql`select ${a.id} from ${a} where ${live(workspaceId, now)} and (${a.pinned} = 1 or ${a.expiresAt} is null or ${a.expiresAt} > ${floorSql(life, now)}) order by ${a.id} limit ${limit}`;
}

/**
 * Caps the selected artifacts' expiry at their deadline (never before now) and unpins them,
 * keeping the expiry the plan gave them (a pinned one's is a renewal's, 30 days) in
 * `uncapped_expires_at`, and moving their lifecycle generation (a racing renewal answers
 * `version_conflict`). Recomputed from each row as it is now, so an artifact published or
 * restored since the selection keeps its later deadline. `condition` holds the policy to the
 * revision that was read when the workspace and its artifacts share a database.
 */
export function capStatements(
  db: Db,
  ids: SQL,
  life: MaxLife,
  now: number,
  condition: SQL,
): BatchItem<"sqlite">[] {
  const target = floorSql(life, now);
  // What the plan gives the row: a pinned artifact gets a renewal's 30 days, like any unpin.
  const base = sql`case when ${a.pinned} = 1 or ${a.expiresAt} is null then ${now + LIMITS.activeDays * DAY_MS} else ${a.expiresAt} end`;
  const unpinned = sql`${a.id} in (${ids}) and ${a.pinned} = 1 and ${condition}`;
  return [
    // The trail of a manual unpin, by the system and naming the policy (before the update).
    db
      .insert(schema.auditEvents)
      .select(
        sql`select 'ae_' || lower(hex(randomblob(12))), ${a.ownerId}, ${now}, 'artifact.unpinned', 'system', null, ${a.id}, ${a.id}, json_object('policy', 'artifactMaxDays'), ${schema.recordedNow} from ${a} where ${unpinned}`,
      ),
    db
      .insert(schema.lifecycleEvents)
      .select(
        sql`select null, ${a.id}, null, 'system', 'unpinned', json_object('policy', 'artifactMaxDays'), ${now} from ${a} where ${unpinned}`,
      ),
    db
      .update(a)
      .set({
        pinned: false,
        expiresAt: sql`min(${base}, ${target})`,
        // Every assignment reads the row as it was: the plan's expiry before this cap, unless an
        // earlier cap already kept it.
        uncappedExpiresAt: sql`case when ${base} > ${target} then coalesce(${a.uncappedExpiresAt}, ${base}) else ${a.uncappedExpiresAt} end`,
        lifecycleGeneration: sql`${a.lifecycleGeneration} + 1`,
        updatedAt: now,
      })
      .where(
        sql`${a.id} in (${ids}) and (${a.expiresAt} is null or ${a.expiresAt} > ${now}) and (${a.pinned} = 1 or ${a.expiresAt} is null or ${a.expiresAt} > ${target}) and ${condition}`,
      )
      .returning({ id: a.id }),
  ];
}

/**
 * What a capped artifact may expire at under `policy`: the plan's expiry it kept, or the current
 * maximum's deadline (never before now) when that is earlier. Without a maximum, the plan's.
 */
export function giveBackTarget(policy: WorkspacePolicy | undefined, now: number): SQL<number> {
  const life = maxLifeOf(policy);
  return life === null
    ? sql<number>`${a.uncappedExpiresAt}`
    : sql<number>`min(${a.uncappedExpiresAt}, ${floorSql(life, now)})`;
}

/**
 * The capped artifacts the current policy allows later than their cap (decision 0023, "Any
 * sequence of saves"): active, not pinned, not already past their expiry, with a kept plan's
 * expiry, and an expiry earlier than their target or a target that is the plan's own. At most
 * `limit` by ID; binds at most 10 parameters.
 */
export function giveBackIds(
  workspaceId: string,
  policy: WorkspacePolicy | undefined,
  now: number,
  limit: number,
): SQL {
  const target = giveBackTarget(policy, now);
  return sql`select ${a.id} from ${a} where ${live(workspaceId, now)} and ${a.pinned} = 0 and ${a.uncappedExpiresAt} is not null and (${a.expiresAt} < ${target} or ${target} >= ${a.uncappedExpiresAt}) order by ${a.id} limit ${limit}`;
}

/**
 * Gives the selected artifacts the later of their expiry and their target, never earlier than
 * they were, and forgets the plan's expiry once nothing caps it any more.
 */
export function giveBackStatement(
  db: Db,
  ids: SQL,
  policy: WorkspacePolicy | undefined,
  now: number,
  condition: SQL,
) {
  const target = giveBackTarget(policy, now);
  return db
    .update(a)
    .set({
      expiresAt: sql`max(${a.expiresAt}, ${target})`,
      uncappedExpiresAt: sql`case when ${target} >= ${a.uncappedExpiresAt} then null else ${a.uncappedExpiresAt} end`,
      lifecycleGeneration: sql`${a.lifecycleGeneration} + 1`,
      updatedAt: now,
    })
    .where(sql`${a.id} in (${ids}) and ${condition}`)
    .returning({ id: a.id });
}
