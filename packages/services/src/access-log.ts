// The owner's access log (plan sections 2, 11, 13 and 14). The content Worker gathers openings
// of artifacts by signed-in visitors in memory and hands them here in batches; they land in the
// separate access log database (`portifact-access`), one row per artifact, visitor and 30-minute
// window. Only the owner side lists them, for the owner plan's `accessLogRetentionDays` (30 days
// on free, a year on paid plans), which each row's `expires_at` carries. Purges and account
// deletions erase rows (and a purged artifact's view counters) through `erase_access_events`
// outbox jobs, because no D1 batch spans both databases.
import { ACCESS_LOG, type EraseAccessEventsPayload } from "@portifact/contracts";
import {
  type AccessDb,
  accessSchema,
  bothSides,
  type Db,
  type RegionalDb,
  schema,
} from "@portifact/db";
import {
  accessLogCutoff,
  accessWindow,
  DAY_MS,
  entitlements,
  FREE_RETENTION_DAYS,
  fail,
  type OwnerPlanRecord,
  ok,
  type Result,
  retentionExpiry,
} from "@portifact/domain";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { authorizeOn, ownerSide } from "./actors.ts";
import { eraseArtifactViews, keptOpenings, pruneArtifactViews } from "./analytics.ts";
import { heldRefusal, isHeld } from "./legal-holds.ts";
import { ownerEntitlements } from "./plans.ts";
import { shareLinkLabels } from "./share-links.ts";

const IN_CHUNK = 80;
/** Rows one erase or prune statement deletes, so no statement runs long. */
export const ACCESS_DELETE_BATCH = 1_000;

/**
 * One page load of an artifact by a signed-in visitor who is not its owner, or through a share
 * link (decision 0008): then `linkId` is set and `userId` holds the same link ID, the key of the
 * link's row, because a link names no one.
 */
export interface Opening {
  artifactId: string;
  userId: string;
  linkId?: string | undefined;
  at: number;
}

/**
 * Records openings, one row per artifact, visitor and window. The visitor's email and the owner
 * are read from the control database at write time, and only openings of artifacts that are still
 * active, by accounts that still exist and do not own them, are kept: so a batch that was waiting
 * in an isolate while the artifact was purged or the visitor deleted their account writes
 * nothing. Each statement is an upsert keyed by the window, so batches from other isolates, or a
 * retried one, keep one row with the earliest opening. Each row expires on the owner's plan at
 * the time of the opening (`retentionExpiry`), read with the owner in the same query. Returns how
 * many rows it wrote.
 */
export async function recordOpenings(
  db: RegionalDb,
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
  const people = rows.filter((row) => row.linkId === undefined);
  const emails = await accountEmails(db.global, [...new Set(people.map((row) => row.userId))]);
  const links = await knownLinks(
    db,
    rows.flatMap((row) => (row.linkId === undefined ? [] : [row.linkId])),
  );
  // Visits of whoever acts for the owner (its admins and editors) are the owner's own visits.
  const sides = new Map<string, readonly string[]>();
  for (const ownerId of new Set([...owners.values()].map((owner) => owner.ownerId))) {
    sides.set(ownerId, await ownerSide(db.global, ownerId));
  }
  const e = accessSchema.accessEvents;
  const statements = rows.flatMap((row) => {
    const owner = owners.get(row.artifactId);
    if (owner === undefined) return [];
    const { ownerId } = owner;
    // A link's opening is kept only while the link still belongs to the artifact.
    const linkId = row.linkId;
    if (linkId !== undefined && (links.get(linkId) !== row.artifactId || linkId !== row.userId)) {
      return [];
    }
    const email = linkId === undefined ? emails.get(row.userId) : "";
    if (email === undefined) return [];
    if (linkId === undefined && sides.get(ownerId)?.includes(row.userId)) return [];
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
          linkId: linkId ?? null,
          // Share-link openings follow the same retention as signed-in ones.
          expiresAt: retentionExpiry(row.at, entitlements(owner.plan, row.at)),
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

interface ActiveOwner {
  ownerId: string;
  plan: OwnerPlanRecord | null;
}

/**
 * The owner of each active artifact, with the owner's plan row. Artifacts are regional and plans
 * global (decision 0005): one regional read of the artifacts, then one global read of their
 * owners' plans, per batch of openings (never per request).
 */
async function activeOwners(
  db: RegionalDb,
  ids: readonly string[],
): Promise<Map<string, ActiveOwner>> {
  // One database: the plan comes with the artifacts in one read per chunk, as it always did.
  const both = bothSides(db);
  if (both) return joinedOwners(both, ids);
  const found: { id: string; ownerId: string }[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    found.push(
      ...(await db
        .select({ id: schema.artifacts.id, ownerId: schema.artifacts.ownerId })
        .from(schema.artifacts)
        .where(
          and(
            inArray(schema.artifacts.id, ids.slice(i, i + IN_CHUNK)),
            eq(schema.artifacts.state, "active"),
          ),
        )),
    );
  }
  const plans = new Map<string, OwnerPlanRecord>();
  const ownerIds = [...new Set(found.map((row) => row.ownerId))];
  for (let i = 0; i < ownerIds.length; i += IN_CHUNK) {
    const p = schema.ownerPlans;
    for (const row of await db.global
      .select({
        ownerId: p.ownerId,
        plan: p.plan,
        seats: p.seats,
        validUntil: p.validUntil,
        overrides: p.overrides,
        grace: p.grace,
      })
      .from(p)
      .where(inArray(p.ownerId, ownerIds.slice(i, i + IN_CHUNK)))) {
      const { ownerId, ...plan } = row;
      plans.set(ownerId, plan);
    }
  }
  const owners = new Map<string, ActiveOwner>();
  for (const row of found) {
    owners.set(row.id, { ownerId: row.ownerId, plan: plans.get(row.ownerId) ?? null });
  }
  return owners;
}

async function joinedOwners(both: Db, ids: readonly string[]): Promise<Map<string, ActiveOwner>> {
  const owners = new Map<string, ActiveOwner>();
  const p = schema.ownerPlans;
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const rows = await both
      .select({
        id: schema.artifacts.id,
        ownerId: schema.artifacts.ownerId,
        plan: {
          plan: p.plan,
          seats: p.seats,
          validUntil: p.validUntil,
          overrides: p.overrides,
          grace: p.grace,
        },
      })
      .from(schema.artifacts)
      .leftJoin(p, eq(p.ownerId, schema.artifacts.ownerId))
      .where(
        and(
          inArray(schema.artifacts.id, ids.slice(i, i + IN_CHUNK)),
          eq(schema.artifacts.state, "active"),
        ),
      );
    for (const row of rows) owners.set(row.id, { ownerId: row.ownerId, plan: row.plan });
  }
  return owners;
}

/** The artifact of each share link that still exists. */
async function knownLinks(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const links = new Map<string, string>();
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const rows = await db
      .select({ id: schema.shareLinks.id, artifactId: schema.shareLinks.artifactId })
      .from(schema.shareLinks)
      .where(inArray(schema.shareLinks.id, unique.slice(i, i + IN_CHUNK)));
    for (const row of rows) links.set(row.id, row.artifactId);
  }
  return links;
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
  /** The signed-in user; an admin or editor of the artifact's owner reads its access log. */
  userId: string;
  artifactId: string;
  cursor?: string | undefined;
  limit: number;
  /** Only openings at or after this instant. */
  since?: number | undefined;
  now: number;
}

export interface AccessLogPage {
  artifactId: string;
  entries: {
    email: string;
    openedAt: number;
    shareLink?: { id: string; label: string | null };
  }[];
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
  db: RegionalDb,
  access: AccessDb,
  input: AccessLogInput,
): Promise<Result<AccessLogPage>> {
  const [artifact] = await db
    .select({
      ownerId: schema.artifacts.ownerId,
      state: schema.artifacts.state,
      createdBy: schema.artifacts.createdBy,
      externalKey: schema.artifacts.externalKey,
    })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, input.artifactId))
    .limit(1);
  const missing = () => fail<never>("not_found", "Artifact not found.");
  if (!artifact || artifact.state === "purging" || artifact.state === "deleted") return missing();
  const allowed = await authorizeOn(db, input.userId, artifact, "access_log", missing);
  if (!allowed.ok) return allowed;
  // A held artifact's access log is read by nobody but the operator (legal-holds.ts).
  if (artifact.state === "suspended" && (await isHeld(db, input.artifactId))) {
    return heldRefusal();
  }
  const retentionDays = (await ownerEntitlements(db.global, artifact.ownerId, input.now)).limits
    .accessLogRetentionDays;
  const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
  if (input.cursor !== undefined && !after) return fail("invalid_input", "Invalid cursor.");

  const e = accessSchema.accessEvents;
  // The owner's retention now, and each row's own expiry until the prune or an `owner_retention`
  // job reaches it, so a lower plan never shows more than it keeps.
  const from = Math.max(accessLogCutoff(input.now, retentionDays), input.since ?? 0);
  const conditions: SQL[] = [
    eq(e.artifactId, input.artifactId),
    eq(e.ownerId, artifact.ownerId),
    gte(e.openedAt, from),
    keptOpenings(input.now),
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
      linkId: e.linkId,
    })
    .from(e)
    .where(and(...conditions))
    .orderBy(desc(e.windowStart), asc(e.userId))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  const labels = await shareLinkLabels(
    db,
    input.artifactId,
    page.flatMap((row) => (row.linkId === null ? [] : [row.linkId])),
  );
  return ok({
    artifactId: input.artifactId,
    entries: page.map((row) =>
      row.linkId === null
        ? { email: row.email, openedAt: row.openedAt }
        : {
            email: "",
            openedAt: row.openedAt,
            shareLink: { id: row.linkId, label: labels.get(row.linkId) ?? null },
          },
    ),
    nextCursor: rows.length > input.limit && last ? encodeCursor(last) : null,
    windowMinutes: ACCESS_LOG.windowMinutes,
    retentionDays,
  });
}

/**
 * Deletes up to `ACCESS_DELETE_BATCH` rows that match `where`; true when it may have left some.
 * The table has a rowid, so a bounded delete goes through a subquery on it.
 */
/** Openings of artifacts that are not held, with the held IDs as one JSON parameter. */
function notHeldEvents(held: readonly string[]): SQL {
  const e = accessSchema.accessEvents;
  return sql`${e.artifactId} not in (select value from json_each(${JSON.stringify(held)}))`;
}

async function deleteSome(access: AccessDb, where: SQL): Promise<number> {
  const e = accessSchema.accessEvents;
  const deleted = await access
    .delete(e)
    .where(sql`rowid in (select rowid from ${e} where ${where} limit ${ACCESS_DELETE_BATCH})`)
    .returning({ userId: e.userId });
  return deleted.length;
}

/**
 * Erases the access log and the view counters of a purged artifact, or every opening by a
 * deleted account, in bounded statements. Returns `pending` when `rounds` statements did not
 * reach the end, so the job runs again; running it again after the end changes nothing.
 */
export async function eraseAccessEvents(
  access: AccessDb,
  kind: EraseAccessEventsPayload["kind"],
  subject: string,
  rounds = 10,
  /** Artifacts under a legal hold: an account's openings of them stay until the release. */
  held: readonly string[] = [],
): Promise<"done" | "pending"> {
  const e = accessSchema.accessEvents;
  const where =
    kind === "artifact"
      ? eq(e.artifactId, subject)
      : (and(eq(e.userId, subject), notHeldEvents(held)) as SQL);
  let finished = false;
  for (let round = 0; round < rounds && !finished; round += 1) {
    finished = (await deleteSome(access, where)) < ACCESS_DELETE_BATCH;
  }
  if (!finished) return "pending";
  return kind === "artifact" ? eraseArtifactViews(access, subject, rounds) : "done";
}

/**
 * Deletes openings and view counters past their expiry (legacy openings without one after the
 * free 30 days), at most `rounds` bounded statements per table and run; the next scheduled run
 * goes on where it stopped.
 */
export async function pruneAccessEvents(
  access: AccessDb,
  now: number,
  rounds = 10,
  /**
   * Artifacts under a legal hold in the region (`heldArtifactIds`): the access database cannot
   * join the hold, so the caller reads them; their rows are kept past their expiry.
   */
  held: readonly string[] = [],
) {
  const e = accessSchema.accessEvents;
  const where = and(
    or(
      lt(e.expiresAt, now),
      and(isNull(e.expiresAt), lt(e.openedAt, now - FREE_RETENTION_DAYS * DAY_MS)),
    ),
    notHeldEvents(held),
  ) as SQL;
  let pruned = 0;
  for (let round = 0; round < rounds; round += 1) {
    const deleted = await deleteSome(access, where);
    pruned += deleted;
    if (deleted < ACCESS_DELETE_BATCH) break;
  }
  return pruned + (await pruneArtifactViews(access, now, rounds, held));
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
