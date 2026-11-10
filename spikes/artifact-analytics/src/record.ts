// Writing, pruning and erasing the daily view counters in the access database.
import type { ViewDelta } from "./meter.ts";
import { DAY_MS } from "./views.ts";

/** Statements per D1 batch, well under the 1,000 queries a Worker invocation may send. */
export const RECORD_CHUNK = 200;
/** Rows one prune or erase statement deletes, so no statement runs long (as ACCESS_DELETE_BATCH). */
export const DELETE_BATCH = 1_000;

/** The row of a day is kept for the whole retention after that day ends. */
export function viewsExpireAt(day: number, retentionDays: number): number {
  return day + (retentionDays + 1) * DAY_MS;
}

/**
 * Adds each delta to its artifact's row for the day, one upsert per delta, so batches from other
 * isolates and retried batches add up instead of overwriting each other. The conflict only adds to
 * the counters: no indexed column changes, so an update writes one row. The expiry is set when the
 * row is first written; a plan change moves it with `setOwnerRetention`, not here.
 *
 * It reads nothing from the control database: a batch held in an isolate across a purge can
 * recreate a row for the purged artifact after its erase job ran. That row holds only counts, is
 * never shown (the artifact is gone and its ID is tombstoned) and expires with its retention.
 */
export async function recordViews(access: D1Database, deltas: readonly ViewDelta[]): Promise<void> {
  const statements = deltas
    .filter((delta) => delta.views > 0)
    .map((delta) =>
      access
        .prepare(
          `insert into artifact_views (artifact_id, day, owner_id, views, signed_in_views, expires_at)
           values (?, ?, ?, ?, ?, ?)
           on conflict (artifact_id, day) do update set
             views = views + excluded.views,
             signed_in_views = signed_in_views + excluded.signed_in_views`,
        )
        .bind(
          delta.artifactId,
          delta.day,
          delta.ownerId,
          delta.views,
          delta.signedInViews,
          viewsExpireAt(delta.day, delta.retentionDays),
        ),
    );
  for (let start = 0; start < statements.length; start += RECORD_CHUNK) {
    await access.batch(statements.slice(start, start + RECORD_CHUNK));
  }
}

/**
 * Deletes view rows and openings past their expiry, at most `rounds` bounded statements per table
 * per run; the next scheduled run goes on where it stopped. Returns how many rows it deleted.
 */
export async function pruneExpired(access: D1Database, now: number, rounds = 10): Promise<number> {
  let pruned = 0;
  for (const [table, key] of [
    ["artifact_views", "artifact_id, day"],
    ["access_events", "artifact_id, window_start, user_id"],
  ] as const) {
    for (let round = 0; round < rounds; round += 1) {
      const result = await access
        .prepare(
          `delete from ${table} where (${key}) in
             (select ${key} from ${table} where expires_at <= ? limit ${DELETE_BATCH})`,
        )
        .bind(now)
        .run();
      pruned += result.meta.changes;
      if (result.meta.changes < DELETE_BATCH) break;
    }
  }
  return pruned;
}

/**
 * Moves the expiry of every row of an owner to its new retention, after a plan change (an
 * `owner_retention` outbox job written with the plan change). A downgrade shortens rows that the
 * old plan kept longer, so nothing outlives what the Privacy Policy promises for the current plan;
 * an upgrade extends the rows still kept. Rows already pruned do not come back.
 */
export async function setOwnerRetention(
  access: D1Database,
  ownerId: string,
  retentionDays: number,
): Promise<void> {
  await access.batch([
    access
      .prepare("update artifact_views set expires_at = day + ? where owner_id = ?")
      .bind((retentionDays + 1) * DAY_MS, ownerId),
    access
      .prepare("update access_events set expires_at = opened_at + ? where owner_id = ?")
      .bind(retentionDays * DAY_MS, ownerId),
  ]);
}

/**
 * The counters part of today's `erase_access_events` job for an artifact (written in the batch
 * that purges it). Bounded like the other deletes; "pending" asks the job to run again.
 */
export async function eraseArtifactViews(
  access: D1Database,
  artifactId: string,
  rounds = 10,
): Promise<"done" | "pending"> {
  for (let round = 0; round < rounds; round += 1) {
    const result = await access
      .prepare(
        `delete from artifact_views where artifact_id = ? and day in
           (select day from artifact_views where artifact_id = ? limit ${DELETE_BATCH})`,
      )
      .bind(artifactId, artifactId)
      .run();
    if (result.meta.changes < DELETE_BATCH) return "done";
  }
  return "pending";
}
