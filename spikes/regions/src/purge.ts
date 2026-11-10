// Purging an artifact and re-applying tombstones after a restore, with the tombstone global and
// the artifact regional. The purge job reads the regional claim, writes the global tombstone
// first (a `purging` artifact never comes back, so writing it early is safe) and only then
// deletes the objects and rows. A crash in between leaves a tombstone and an artifact still
// `purging`, which the redelivered job finishes; it never leaves deleted data without a tombstone.
import type { Directory } from "./directory.ts";
import type { Region, Regions } from "./regions.ts";

export type JobOutcome = "done" | "stale" | "pending";

export async function purgeArtifact(
  regions: Regions,
  directory: Directory,
  input: { id: string; generation: number; now: number },
): Promise<JobOutcome> {
  const region = await directory.regionOf(input.id);
  if (!region) return "stale";
  const { db, bucket } = regions.get(region);
  const claimed = await db
    .prepare(
      "select 1 as one from artifacts where id = ? and state = 'purging' and lifecycle_generation = ?",
    )
    .bind(input.id, input.generation)
    .first();
  if (!claimed) {
    const exists = await db
      .prepare("select 1 as one from artifacts where id = ?")
      .bind(input.id)
      .first();
    // Gone already: a redelivery after the work was done.
    return exists ? "stale" : "done";
  }
  await regions.global
    .prepare(
      "insert into tombstones (kind, id, deleted_at) values ('artifact', ?, ?) on conflict do nothing",
    )
    .bind(input.id, input.now)
    .run();
  const listed = await bucket.list({ prefix: `objects/${input.id}/` });
  if (listed.objects.length > 0) await bucket.delete(listed.objects.map((o) => o.key));
  await db.batch([
    db.prepare("delete from access_events where artifact_id = ?").bind(input.id),
    db
      .prepare(
        "delete from artifacts where id = ? and state = 'purging' and lifecycle_generation = ?",
      )
      .bind(input.id, input.generation),
  ]);
  return "done";
}

/**
 * Re-applies the global tombstones to one region after a D1 Time Travel restore of that region
 * (or of the global database, by re-running it everywhere): artifacts with a tombstone are
 * deleted again and deleted accounts are fenced and their artifacts claimed for purging.
 */
export async function applyTombstones(
  regions: Regions,
  region: Region,
  now: number,
): Promise<{ artifacts: number; accounts: number }> {
  const { db } = regions.get(region);
  const { results } = await regions.global
    .prepare("select kind, id from tombstones order by kind, id")
    .all<{ kind: "artifact" | "account"; id: string }>();
  const artifactIds = results.filter((t) => t.kind === "artifact").map((t) => t.id);
  const accountIds = results.filter((t) => t.kind === "account").map((t) => t.id);
  const statements: D1PreparedStatement[] = [];
  for (const id of artifactIds) {
    statements.push(db.prepare("delete from access_events where artifact_id = ?").bind(id));
    statements.push(db.prepare("delete from artifacts where id = ?").bind(id));
  }
  for (const id of accountIds) statements.push(...fenceStatements(db, id, now));
  if (statements.length > 0) await db.batch(statements);
  return { artifacts: artifactIds.length, accounts: accountIds.length };
}

/**
 * Fences an owner in one region and claims what it still owns there, in one regional batch: the
 * fence, a purge job per claimable artifact written before the claim on the same old state, the
 * claim, and the owner's read sessions and openings as a visitor. After this batch the triggers
 * refuse any new artifact or comment of the owner in the region, so a later count is final.
 */
export function fenceStatements(
  db: D1Database,
  ownerId: string,
  now: number,
): D1PreparedStatement[] {
  const claimable = "owner_id = ?1 and state in ('draft', 'active', 'archived', 'suspended')";
  return [
    db
      .prepare(
        "insert into owner_fences (owner_id, fenced_at) values (?, ?) on conflict do nothing",
      )
      .bind(ownerId, now),
    db
      .prepare(
        `insert into outbox (topic, subject, generation, available_at)
         select 'purge_artifact', id, lifecycle_generation + 1, ?2 from artifacts where ${claimable}`,
      )
      .bind(ownerId, now),
    db
      .prepare(
        `update artifacts set state = 'purging', lifecycle_generation = lifecycle_generation + 1
         where ${claimable}`,
      )
      .bind(ownerId),
    db.prepare("delete from read_sessions where user_id = ?").bind(ownerId),
    db.prepare("delete from access_events where user_id = ?").bind(ownerId),
  ];
}
