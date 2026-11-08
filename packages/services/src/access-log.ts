// The owner's access log (plan sections 2, 11, 13 and 14). The content Worker gathers openings
// of artifacts by signed-in visitors in memory and hands them here in batches; they land in the
// separate access log database (`portifact-access`), one row per artifact, visitor and 30-minute
// window. Only the owner lists them, for 30 days. Purges and account deletions erase rows through
// `erase_access_events` outbox jobs, because no D1 batch spans both databases.
import { ACCESS_LOG, type EraseAccessEventsPayload } from "@portifact/contracts";
import { type AccessDb, accessSchema, type Db, schema } from "@portifact/db";
import { accessLogCutoff, accessWindow, fail, ok, type Result } from "@portifact/domain";
import { and, asc, desc, eq, gt, gte, inArray, lt, or, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

const IN_CHUNK = 80;
/** Rows one erase or prune statement deletes, so no statement runs long. */
export const ACCESS_DELETE_BATCH = 1_000;

/** One page load of an artifact by a signed-in visitor who is not its owner. */
export interface Opening {
  artifactId: string;
  userId: string;
  at: number;
}

/**
 * Records openings, one row per artifact, visitor and window. The visitor's email and the owner
 * are read from the control database at write time, and only openings of artifacts that are still
 * active, by accounts that still exist and do not own them, are kept: so a batch that was waiting
 * in an isolate while the artifact was purged or the visitor deleted their account writes
 * nothing. Each statement is an upsert keyed by the window, so batches from other isolates, or a
 * retried one, keep one row with the earliest opening. Returns how many rows it wrote.
 */
export async function recordOpenings(
  db: Db,
  access: AccessDb,
  openings: readonly Opening[],
): Promise<number> {
  const earliest = new Map<string, Opening & { windowStart: number }>();
  for (const opening of openings) {
    const windowStart = accessWindow(opening.at);
    const key = `${opening.artifactId}\u0000${windowStart}\u0000${opening.userId}`;
    const current = earliest.get(key);
    if (!current || opening.at < current.at) earliest.set(key, { ...opening, windowStart });
  }
  if (earliest.size === 0) return 0;
  const rows = [...earliest.values()];
  const owners = await activeOwners(db, [...new Set(rows.map((row) => row.artifactId))]);
  const emails = await accountEmails(db, [...new Set(rows.map((row) => row.userId))]);
  const e = accessSchema.accessEvents;
  const statements = rows.flatMap((row) => {
    const ownerId = owners.get(row.artifactId);
    const email = emails.get(row.userId);
    if (ownerId === undefined || email === undefined || ownerId === row.userId) return [];
    return [
      access
        .insert(e)
        .values({
          artifactId: row.artifactId,
          windowStart: row.windowStart,
          userId: row.userId,
          ownerId,
          email,
          openedAt: row.at,
        })
        .onConflictDoUpdate({
          target: [e.artifactId, e.windowStart, e.userId],
          set: { openedAt: sql`min(${e.openedAt}, excluded.opened_at)` },
        }),
    ];
  });
  const [first, ...rest] = statements;
  if (!first) return 0;
  await access.batch([first, ...rest] as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  return statements.length;
}

async function activeOwners(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const rows = await db
      .select({ id: schema.artifacts.id, ownerId: schema.artifacts.ownerId })
      .from(schema.artifacts)
      .where(
        and(
          inArray(schema.artifacts.id, ids.slice(i, i + IN_CHUNK)),
          eq(schema.artifacts.state, "active"),
        ),
      );
    for (const row of rows) owners.set(row.id, row.ownerId);
  }
  return owners;
}

async function accountEmails(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  const emails = new Map<string, string>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const rows = await db
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .where(inArray(schema.users.id, ids.slice(i, i + IN_CHUNK)));
    for (const row of rows) emails.set(row.id, row.email);
  }
  return emails;
}

export interface AccessLogInput {
  ownerId: string;
  artifactId: string;
  cursor?: string | undefined;
  limit: number;
  /** Only openings at or after this instant. */
  since?: number | undefined;
  now: number;
}

export interface AccessLogPage {
  artifactId: string;
  entries: { email: string; openedAt: number }[];
  nextCursor: string | null;
  windowMinutes: number;
  retentionDays: number;
}

/** Opaque cursor: the sort key of the last entry, `<windowStart>.<userId>` in base64url. */
function encodeCursor(row: { windowStart: number; userId: string }): string {
  return btoa(`${row.windowStart}.${row.userId}`)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeCursor(cursor: string): { windowStart: number; userId: string } | undefined {
  try {
    const text = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
    const match = /^(\d{1,15})\.([A-Za-z0-9_-]{1,64})$/.exec(text);
    if (!match) return undefined;
    return { windowStart: Number(match[1]), userId: match[2] as string };
  } catch {
    return undefined;
  }
}

/**
 * The owner's access log of one artifact, newest window first. Someone else's artifact, a
 * visitor's, or one being purged answers `not_found` exactly like a missing one. Archived and
 * suspended artifacts keep their log for the owner. Entries past retention that the prune has
 * not reached yet are never returned.
 */
export async function getAccessLog(
  db: Db,
  access: AccessDb,
  input: AccessLogInput,
): Promise<Result<AccessLogPage>> {
  const [artifact] = await db
    .select({ ownerId: schema.artifacts.ownerId, state: schema.artifacts.state })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, input.artifactId))
    .limit(1);
  if (
    !artifact ||
    artifact.ownerId !== input.ownerId ||
    artifact.state === "purging" ||
    artifact.state === "deleted"
  ) {
    return fail("not_found", "Artifact not found.");
  }
  const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
  if (input.cursor !== undefined && !after) return fail("invalid_input", "Invalid cursor.");

  const e = accessSchema.accessEvents;
  const from = Math.max(accessLogCutoff(input.now), input.since ?? 0);
  const conditions: SQL[] = [
    eq(e.artifactId, input.artifactId),
    eq(e.ownerId, input.ownerId),
    gte(e.openedAt, from),
  ];
  if (after) {
    conditions.push(
      or(
        lt(e.windowStart, after.windowStart),
        and(eq(e.windowStart, after.windowStart), gt(e.userId, after.userId)),
      ) as SQL,
    );
  }
  const rows = await access
    .select({
      windowStart: e.windowStart,
      userId: e.userId,
      email: e.email,
      openedAt: e.openedAt,
    })
    .from(e)
    .where(and(...conditions))
    .orderBy(desc(e.windowStart), asc(e.userId))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return ok({
    artifactId: input.artifactId,
    entries: page.map((row) => ({ email: row.email, openedAt: row.openedAt })),
    nextCursor: rows.length > input.limit && last ? encodeCursor(last) : null,
    windowMinutes: ACCESS_LOG.windowMinutes,
    retentionDays: ACCESS_LOG.retentionDays,
  });
}

/**
 * Deletes up to `ACCESS_DELETE_BATCH` rows that match `where`; true when it may have left some.
 * The table has a rowid, so a bounded delete goes through a subquery on it.
 */
async function deleteSome(access: AccessDb, where: SQL): Promise<number> {
  const e = accessSchema.accessEvents;
  const deleted = await access
    .delete(e)
    .where(sql`rowid in (select rowid from ${e} where ${where} limit ${ACCESS_DELETE_BATCH})`)
    .returning({ userId: e.userId });
  return deleted.length;
}

/**
 * Erases the access log of a purged artifact, or every opening by a deleted account, in bounded
 * statements. Returns `pending` when `rounds` statements did not reach the end, so the job runs
 * again; running it again after the end changes nothing.
 */
export async function eraseAccessEvents(
  access: AccessDb,
  kind: EraseAccessEventsPayload["kind"],
  subject: string,
  rounds = 10,
): Promise<"done" | "pending"> {
  const e = accessSchema.accessEvents;
  const where = kind === "artifact" ? eq(e.artifactId, subject) : eq(e.userId, subject);
  for (let round = 0; round < rounds; round += 1) {
    if ((await deleteSome(access, where)) < ACCESS_DELETE_BATCH) return "done";
  }
  return "pending";
}

/**
 * Deletes openings past retention, at most `rounds` bounded statements per run; the next
 * scheduled run goes on where it stopped.
 */
export async function pruneAccessEvents(access: AccessDb, now: number, rounds = 10) {
  const e = accessSchema.accessEvents;
  const where = lt(e.openedAt, accessLogCutoff(now));
  let pruned = 0;
  for (let round = 0; round < rounds; round += 1) {
    const deleted = await deleteSome(access, where);
    pruned += deleted;
    if (deleted < ACCESS_DELETE_BATCH) break;
  }
  return pruned;
}

/**
 * Inserts an `erase_access_events` job for an artifact or an account when `condition` holds. Put
 * it in the batch of the change that ends them, before the guarded write, on the same condition.
 */
export function eraseAccessEventsJob(
  db: Db,
  kind: EraseAccessEventsPayload["kind"],
  subject: string,
  condition: SQL,
  now: number,
) {
  const payload = JSON.stringify({ kind } satisfies EraseAccessEventsPayload);
  return db
    .insert(schema.outbox)
    .select(
      sql`select null, 'erase_access_events', ${payload}, ${now}, null, 0, ${now}, ${subject}, null where ${condition}`,
    );
}
