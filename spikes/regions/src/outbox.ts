// One outbox per database, relayed per database. A message names the database its row lives in
// (`scope`), so the consumer reads and deletes the row there. When the default region shares the
// control database (production's layout), the global outbox and the default region's outbox are
// the same table: relaying per region would send each row twice, so scopes are per database.
import { advanceAccountDeletion } from "./deletion.ts";
import type { Directory } from "./directory.ts";
import { type JobOutcome, purgeArtifact } from "./purge.ts";
import type { Region, Regions } from "./regions.ts";

export type Scope = "global" | Region;

export interface JobMessage {
  scope: Scope;
  id: number;
  topic: string;
}

export interface JobQueue {
  sendBatch(messages: { body: JobMessage }[]): Promise<void>;
}

/** Every database once, with the scope its messages carry. */
export function outboxScopes(regions: Regions): { scope: Scope; db: D1Database }[] {
  const scopes: { scope: Scope; db: D1Database }[] = [{ scope: "global", db: regions.global }];
  for (const handles of regions.all()) {
    if (handles.db !== regions.global) scopes.push({ scope: handles.region, db: handles.db });
  }
  return scopes;
}

function scopeDb(regions: Regions, scope: Scope): D1Database {
  return scope === "global" ? regions.global : regions.get(scope).db;
}

export async function relayOutbox(regions: Regions, queue: JobQueue, now: number): Promise<number> {
  let relayed = 0;
  for (const { scope, db } of outboxScopes(regions)) {
    const { results } = await db
      .prepare(
        "select id, topic from outbox where available_at <= ? and dispatched_at is null order by id limit 80",
      )
      .bind(now)
      .all<{ id: number; topic: string }>();
    if (results.length === 0) continue;
    await queue.sendBatch(
      results.map((row) => ({ body: { scope, id: row.id, topic: row.topic } })),
    );
    await db.batch(
      results.map((row) =>
        db.prepare("update outbox set dispatched_at = ? where id = ?").bind(now, row.id),
      ),
    );
    relayed += results.length;
  }
  return relayed;
}

/** Runs one delivered job. A missing row means done; the row goes only once the job is done. */
export async function runJob(
  regions: Regions,
  directory: Directory,
  message: JobMessage,
  now: number,
): Promise<JobOutcome> {
  const db = scopeDb(regions, message.scope);
  const row = await db
    .prepare("select topic, subject, generation from outbox where id = ?")
    .bind(message.id)
    .first<{ topic: string; subject: string; generation: number | null }>();
  if (!row) return "done";
  let outcome: JobOutcome;
  if (row.topic === "purge_artifact") {
    outcome = await purgeArtifact(regions, directory, {
      id: row.subject,
      generation: row.generation ?? 0,
      now,
    });
  } else if (row.topic === "account_deletion") {
    const state = await advanceAccountDeletion(regions, { userId: row.subject, now });
    outcome = state === "pending" ? "pending" : "done";
  } else {
    throw new Error(`Unknown topic ${row.topic}`);
  }
  if (outcome !== "pending") {
    await db.prepare("delete from outbox where id = ?").bind(message.id).run();
  }
  return outcome;
}
