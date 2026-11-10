// Where a bounded maintenance scan resumes between runs (`maintenance_cursors`), so each run does
// a fixed amount of work whatever the size of the table it walks.
import { type Db, schema } from "@portifact/db";
import { eq } from "drizzle-orm";

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
