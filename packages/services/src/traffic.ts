// Traffic metering (plan sections 11, 12 and 14). The content Worker adds up what it serves in
// memory and hands it here in batches, so delivery does not write to D1 on every request; the
// counters are read back by delivery (through the artifact lookup) and by the usage report.
import { type Db, schema } from "@portifact/db";
import { trafficCycle } from "@portifact/domain";
import { and, eq, lt, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

/** Requests and bytes served for one account in one cycle, still to be added to its counter. */
export interface TrafficDelta {
  ownerId: string;
  cycleStart: number;
  requests: number;
  bytes: number;
}

/**
 * Adds each delta to its account's counter in one batch. Each statement is a single upsert, so
 * concurrent batches from other isolates add up instead of overwriting each other.
 */
export async function recordTraffic(
  db: Db,
  deltas: readonly TrafficDelta[],
  now: number,
): Promise<void> {
  const statements = deltas
    .filter((delta) => delta.requests > 0 || delta.bytes > 0)
    .map((delta) =>
      db
        .insert(schema.trafficCounters)
        .values({ ...delta, updatedAt: now })
        .onConflictDoUpdate({
          target: [schema.trafficCounters.ownerId, schema.trafficCounters.cycleStart],
          set: {
            requests: sql`${schema.trafficCounters.requests} + excluded.requests`,
            bytes: sql`${schema.trafficCounters.bytes} + excluded.bytes`,
            updatedAt: sql`max(${schema.trafficCounters.updatedAt}, excluded.updated_at)`,
          },
        }),
    );
  const [first, ...rest] = statements;
  if (!first) return;
  await db.batch([first, ...rest] as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}

/** What the account's artifacts served in the cycle that contains `now`. */
export async function getTraffic(
  db: Db,
  ownerId: string,
  now: number,
): Promise<{ requests: number; bytes: number }> {
  const [row] = await db
    .select({
      requests: schema.trafficCounters.requests,
      bytes: schema.trafficCounters.bytes,
    })
    .from(schema.trafficCounters)
    .where(
      and(
        eq(schema.trafficCounters.ownerId, ownerId),
        eq(schema.trafficCounters.cycleStart, trafficCycle(now).start),
      ),
    )
    .limit(1);
  return { requests: row?.requests ?? 0, bytes: row?.bytes ?? 0 };
}

/**
 * Deletes counters older than the previous cycle; the current and previous ones stay, so a late
 * batch from the end of last month still lands on a row that is kept for a while.
 */
export async function pruneTrafficCounters(db: Db, now: number): Promise<number> {
  const previous = trafficCycle(trafficCycle(now).start - 1).start;
  const deleted = await db
    .delete(schema.trafficCounters)
    .where(lt(schema.trafficCounters.cycleStart, previous))
    .returning({ ownerId: schema.trafficCounters.ownerId });
  return deleted.length;
}
