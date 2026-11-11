// A workspace's maximum life of artifacts (decision 0023, a workspace policy, feature
// `policies`): the SQL side of the rules in packages/domain/src/workspace-policies.ts
// (`maxLifeDeadline`, `policyExpiry`). The maximum only ever caps `artifacts.expires_at`; an
// artifact that reaches it is archived by the usual expiry scan (`archiveExpired`), so archiving
// by policy is never a path of its own and nothing here deletes anything.
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
 * the column was filled) and its last restore. The artifact's own creation when it has no
 * version. Column names are written out so the expression binds to the outer row inside a
 * subquery, an update or a select alike.
 */
export const lifeStartSql = sql<number>`max(coalesce((select coalesce("lv"."committed_at", "lv"."created_at") from "versions" "lv" where "lv"."id" = "artifacts"."current_version_id"), "artifacts"."created_at"), coalesce("artifacts"."restored_at", 0))`;

/** `maxLifeDeadline` in SQL: never before the maximum takes effect. Binds 2 parameters. */
export function maxLifeDeadlineSql(life: MaxLife, lifeStart: SQL = lifeStartSql): SQL<number> {
  return sql<number>`max(${life.from}, ${lifeStart} + ${life.days * DAY_MS})`;
}

/**
 * The expiry a write sets under the owner's policy, as SQL: the plan's expiry capped by the
 * maximum life counted from the row's own life start (renewals and unpins, which keep the life
 * where it is). Without a maximum, the plan's expiry.
 */
export function cappedExpirySql(
  policy: WorkspacePolicy | undefined,
  planExpiry: number,
): SQL<number> {
  const life = maxLifeOf(policy);
  return life === null
    ? sql<number>`${planExpiry}`
    : sql<number>`min(${planExpiry}, ${maxLifeDeadlineSql(life)})`;
}

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
  // Pinned, or expiring later than the deadline: the maximum is what archives it.
  const later = sql`(${a.pinned} = 1 or ${a.expiresAt} is null or ${a.expiresAt} > ${deadline})`;
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
 * those expiring later than their deadline. At most `limit`, by ID. Binds 4 parameters.
 */
export function overMaxLifeIds(workspaceId: string, life: MaxLife, limit: number): SQL {
  return sql`select ${a.id} from ${a} where ${owned(workspaceId)} and (${a.pinned} = 1 or ${a.expiresAt} is null or ${a.expiresAt} > ${maxLifeDeadlineSql(life)}) order by ${a.id} limit ${limit}`;
}

/**
 * Caps the selected artifacts' expiry at their deadline and unpins them, moving their lifecycle
 * generation (a racing renewal answers `version_conflict`). Recomputed from each row as it is
 * now, so an artifact published or restored since the selection keeps its later deadline, and an
 * expiry already earlier is kept. `condition` holds the policy to the revision that was read when
 * the workspace and its artifacts share a database.
 */
export function capStatements(
  db: Db,
  ids: SQL,
  life: MaxLife,
  now: number,
  condition: SQL,
): BatchItem<"sqlite">[] {
  const deadline = maxLifeDeadlineSql(life);
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
        expiresAt: sql`min(coalesce(${a.expiresAt}, ${deadline}), ${deadline})`,
        lifecycleGeneration: sql`${a.lifecycleGeneration} + 1`,
        updatedAt: now,
      })
      .where(
        sql`${a.id} in (${ids}) and (${a.pinned} = 1 or ${a.expiresAt} is null or ${a.expiresAt} > ${deadline}) and ${condition}`,
      )
      .returning({ id: a.id }),
  ];
}

/**
 * The artifacts a lengthened or removed maximum life gives time back to (decision 0023,
 * "Loosening"): active, not pinned, expiring in the future at exactly the deadline `replaced`
 * gave them (the cap, not an expiry of their own). At most `limit` by ID; binds 5 parameters.
 */
export function giveBackIds(
  workspaceId: string,
  replaced: MaxLife,
  now: number,
  limit: number,
): SQL {
  return sql`select ${a.id} from ${a} where ${owned(workspaceId)} and ${a.pinned} = 0 and ${a.expiresAt} > ${now} and ${a.expiresAt} = ${maxLifeDeadlineSql(replaced)} order by ${a.id} limit ${limit}`;
}

/**
 * Gives the selected artifacts the later of their expiry and `min(new deadline, now +
 * activeDays)`, the most a renewal could give them: never earlier than they were.
 */
export function giveBackStatement(
  db: Db,
  ids: SQL,
  policy: WorkspacePolicy,
  now: number,
  condition: SQL,
) {
  const life = maxLifeOf(policy);
  const renewal = now + LIMITS.activeDays * DAY_MS;
  const target =
    life === null
      ? sql<number>`${renewal}`
      : sql<number>`min(${renewal}, ${maxLifeDeadlineSql(life)})`;
  return db
    .update(a)
    .set({
      expiresAt: sql`max(${a.expiresAt}, ${target})`,
      lifecycleGeneration: sql`${a.lifecycleGeneration} + 1`,
      updatedAt: now,
    })
    .where(sql`${a.id} in (${ids}) and ${a.expiresAt} < ${target} and ${condition}`)
    .returning({ id: a.id });
}

/**
 * Whether an artifact archived by the expiry scan reached its owner's maximum life rather than
 * its own expiry: its expiry is exactly its deadline. For the audit event's cause.
 */
export function atMaxLifeSql(life: MaxLife): SQL {
  return sql`${a.expiresAt} = ${maxLifeDeadlineSql(life)}`;
}
