// Where a bounded maintenance scan resumes between runs (`maintenance_cursors`), so each run does
// a fixed amount of work whatever the size of the table it walks.
import { type Db, schema } from "@portifact/db";
import { eq, type SQL, sql } from "drizzle-orm";

const c = schema.maintenanceCursors;

/** The scan's cursor: empty when a pass starts. */
export async function cursorFor(db: Db, name: string): Promise<string> {
  const [row] = await db.select({ cursor: c.cursor }).from(c).where(eq(c.name, name));
  return row?.cursor ?? "";
}

/** Saves where the scan resumes; an empty cursor starts the next pass from the beginning. */
export async function saveCursor(db: Db, name: string, cursor: string, now: number) {
  await db
    .insert(c)
    .values({ name, cursor, passStartedAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: c.name, set: { cursor, updatedAt: now } });
}

/**
 * The cursor as a statement, to read it in the same batch as a scan's first page, so a bounded
 * scan resumes without an extra round trip.
 */
export function cursorRead(db: Db, name: string) {
  return db.select({ cursor: c.cursor }).from(c).where(eq(c.name, name));
}

/** The saved cursor inside a statement: the empty string when the scan has none. */
export function savedCursorSql(name: string): SQL {
  return sql`coalesce((select ${c.cursor} from ${c} where ${c.name} = ${name}), '')`;
}

/**
 * Where a bounded scan resumes: after `resume` when the run stopped at its cap, from the start
 * when the pass reached the end (`resume` null). Writes only when that differs from where the
 * run started, so a scan whose pass fits in one run never writes.
 */
export async function resumeAt(
  db: Db,
  name: string,
  started: string,
  resume: string | null,
  now: number,
): Promise<void> {
  const next = resume ?? "";
  if (next !== started) await saveCursor(db, name, next, now);
}

/** Pages a bounded scan reads per run, and rows per page. */
export interface ScanCaps {
  pageSize: number;
  maxPages: number;
}
