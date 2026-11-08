// Backup verification and recovery (plan section 10, "Backups", and section 16, "Recuperación").
// The storage reconciliation compares D1's object rows with R2 a bounded slice per run and
// records what disagrees without deleting anything. The tombstone markers are exported before a
// D1 Time Travel restore and applied after it, so purged artifacts and deleted accounts that the
// restored database still holds are deleted again instead of coming back (docs/operations.md).
import type { TombstoneMarker } from "@portifact/contracts";
import { type Db, schema } from "@portifact/db";
import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { purgeJobs } from "./outbox.ts";

const IN_CHUNK = 80;
const OBJECT_PREFIX = "objects/";
/** An R2 object younger than this without a row may be an upload or a delete in flight. */
export const ORPHAN_GRACE_MS = 24 * 60 * 60_000;

type FindingKind = (typeof schema.storageFindings.$inferSelect)["kind"];

export interface ReconcileResult {
  checkedRows: number;
  listedObjects: number;
  missing: number;
  sizeMismatches: number;
  orphans: number;
}

/**
 * Checks the next `rowLimit` object rows against R2 and the next `listLimit` R2 objects against
 * D1, resuming where the previous run stopped. A verified row whose object is gone is `missing`,
 * one whose object has another size is a `size_mismatch`, and an object older than
 * `ORPHAN_GRACE_MS` that no row references is an `orphan`. Findings are kept in
 * `storage_findings` until a later pass sees the key fine again or no longer sees it at all.
 * Nothing is deleted or repaired: an orphan may be the only copy of bytes a restored database
 * should still reference.
 */
export async function reconcileStorage(
  db: Db,
  bucket: R2Bucket,
  now: number,
  rowLimit = 50,
  listLimit = 100,
): Promise<ReconcileResult> {
  const rows = await checkRows(db, bucket, now, rowLimit);
  const listed = await checkListing(db, bucket, now, listLimit);
  return { ...rows, ...listed };
}

async function cursorFor(db: Db, name: string, now: number) {
  const [row] = await db
    .select()
    .from(schema.maintenanceCursors)
    .where(eq(schema.maintenanceCursors.name, name));
  // An empty cursor means the previous pass ended, so a new one starts with this run.
  if (!row || row.cursor === "") return { name, cursor: "", passStartedAt: now };
  return row;
}

/**
 * Saves where the scan resumes. When a pass ends, findings of its kinds that it did not see
 * during the pass are dropped: their row or object is gone.
 */
async function saveCursor(
  db: Db,
  state: { name: string; passStartedAt: number },
  next: string,
  kinds: FindingKind[],
  now: number,
) {
  if (next === "") {
    await db
      .delete(schema.storageFindings)
      .where(
        and(
          inArray(schema.storageFindings.kind, kinds),
          lt(schema.storageFindings.lastSeenAt, state.passStartedAt),
        ),
      );
  }
  await db
    .insert(schema.maintenanceCursors)
    .values({ name: state.name, cursor: next, passStartedAt: state.passStartedAt, updatedAt: now })
    .onConflictDoUpdate({
      target: schema.maintenanceCursors.name,
      set: { cursor: next, passStartedAt: state.passStartedAt, updatedAt: now },
    });
}

async function record(
  db: Db,
  findings: { kind: FindingKind; r2Key: string; detail: string | null }[],
  now: number,
) {
  for (const finding of findings) {
    await db
      .insert(schema.storageFindings)
      .values({ ...finding, firstSeenAt: now, lastSeenAt: now })
      .onConflictDoUpdate({
        target: [schema.storageFindings.kind, schema.storageFindings.r2Key],
        set: { detail: finding.detail, lastSeenAt: now },
      });
  }
}

async function clear(db: Db, kinds: FindingKind[], keys: string[]) {
  for (let i = 0; i < keys.length; i += IN_CHUNK) {
    await db
      .delete(schema.storageFindings)
      .where(
        and(
          inArray(schema.storageFindings.kind, kinds),
          inArray(schema.storageFindings.r2Key, keys.slice(i, i + IN_CHUNK)),
        ),
      );
  }
}

async function checkRows(db: Db, bucket: R2Bucket, now: number, limit: number) {
  const state = await cursorFor(db, "storage_rows", now);
  const o = schema.objects;
  const rows = await db
    .select({ r2Key: o.r2Key, size: o.size, state: o.state })
    .from(o)
    .where(gt(o.r2Key, state.cursor))
    .orderBy(asc(o.r2Key))
    .limit(limit);
  const findings: { kind: FindingKind; r2Key: string; detail: string | null }[] = [];
  const fine: string[] = [];
  // Pending rows are uploads in flight; their bytes may not be there yet.
  for (const row of rows.filter((candidate) => candidate.state === "verified")) {
    const head = await bucket.head(row.r2Key);
    if (!head) {
      findings.push({ kind: "missing", r2Key: row.r2Key, detail: null });
    } else if (head.size !== row.size) {
      findings.push({
        kind: "size_mismatch",
        r2Key: row.r2Key,
        detail: `row ${row.size} bytes, object ${head.size} bytes`,
      });
    } else {
      fine.push(row.r2Key);
    }
  }
  await record(db, findings, now);
  await clear(db, ["missing", "size_mismatch"], fine);
  const next = rows.length < limit ? "" : (rows.at(-1)?.r2Key ?? "");
  await saveCursor(db, state, next, ["missing", "size_mismatch"], now);
  return {
    checkedRows: rows.length,
    missing: findings.filter((finding) => finding.kind === "missing").length,
    sizeMismatches: findings.filter((finding) => finding.kind === "size_mismatch").length,
  };
}

async function checkListing(db: Db, bucket: R2Bucket, now: number, limit: number) {
  const state = await cursorFor(db, "storage_objects", now);
  const listing = await bucket.list({
    prefix: OBJECT_PREFIX,
    limit,
    ...(state.cursor ? { cursor: state.cursor } : {}),
  });
  const keys = listing.objects.map((object) => object.key);
  const referenced = new Set<string>();
  for (let i = 0; i < keys.length; i += IN_CHUNK) {
    for (const row of await db
      .select({ r2Key: schema.objects.r2Key })
      .from(schema.objects)
      .where(inArray(schema.objects.r2Key, keys.slice(i, i + IN_CHUNK)))) {
      referenced.add(row.r2Key);
    }
  }
  const orphans = listing.objects.filter(
    (object) => !referenced.has(object.key) && object.uploaded.getTime() <= now - ORPHAN_GRACE_MS,
  );
  await record(
    db,
    orphans.map((object) => ({
      kind: "orphan" as const,
      r2Key: object.key,
      detail: `${object.size} bytes, uploaded ${object.uploaded.toISOString()}`,
    })),
    now,
  );
  await clear(db, ["orphan"], [...referenced]);
  const next = listing.truncated ? listing.cursor : "";
  await saveCursor(db, state, next, ["orphan"], now);
  return { listedObjects: keys.length, orphans: orphans.length };
}

/** The findings the operator reviews, oldest first. */
export async function listStorageFindings(db: Db, limit = 100) {
  return db
    .select()
    .from(schema.storageFindings)
    .orderBy(asc(schema.storageFindings.firstSeenAt), asc(schema.storageFindings.r2Key))
    .limit(limit);
}

/**
 * Everything a restore must not bring back: the tombstones, accounts whose deletion is still in
 * progress and artifacts already claimed for purging (a purge cannot be undone). Taken from the
 * live database before restoring a backup.
 */
export async function exportTombstones(db: Db): Promise<TombstoneMarker[]> {
  const markers = new Map<string, TombstoneMarker>();
  const add = (marker: TombstoneMarker) => {
    const key = `${marker.kind}:${marker.id}`;
    if (!markers.has(key)) markers.set(key, marker);
  };
  for (const row of await db.select().from(schema.tombstones)) add(row);
  for (const row of await db.select().from(schema.accountDeletions)) {
    add({ kind: "account", id: row.userId, deletedAt: row.requestedAt });
  }
  for (const row of await db
    .select({ id: schema.artifacts.id, updatedAt: schema.artifacts.updatedAt })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.state, "purging"))) {
    add({ kind: "artifact", id: row.id, deletedAt: row.updatedAt });
  }
  return [...markers.values()].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id),
  );
}

export interface ApplyTombstonesResult {
  /** Markers the database did not have as tombstones yet. */
  inserted: number;
  /** Artifacts the restore brought back, claimed for purging again. */
  artifacts: number;
  /** Accounts the restore brought back, deleted again. */
  accounts: number;
}

/**
 * Re-applies tombstones after a restore: stores the given markers as tombstones, then in one
 * batch claims for purging every artifact that has a tombstone or belongs to a tombstoned
 * account (each with its purge job), and deletes every tombstoned account the restore brought
 * back the way a deletion request does, with an `account_deletion` job that finishes it. The
 * jobs Worker purges the bytes. Running it again changes nothing.
 */
export async function applyTombstones(
  db: Db,
  markers: readonly TombstoneMarker[],
  now: number,
): Promise<ApplyTombstonesResult> {
  let inserted = 0;
  for (let i = 0; i < markers.length; i += 25) {
    const rows = await db
      .insert(schema.tombstones)
      .values(
        markers.slice(i, i + 25).map((m) => ({ kind: m.kind, id: m.id, deletedAt: m.deletedAt })),
      )
      .onConflictDoNothing()
      .returning({ id: schema.tombstones.id });
    inserted += rows.length;
  }

  const t = schema.tombstones;
  const a = schema.artifacts;
  const u = schema.users;
  const tombstonedAccounts = sql`select ${t.id} from ${t} where ${t.kind} = 'account'`;
  const resurrectedArtifact = sql`${a.state} <> 'purging' and (${a.id} in (select ${t.id} from ${t} where ${t.kind} = 'artifact') or ${a.ownerId} in (${tombstonedAccounts}))`;
  // An account with anything left of it and no deletion in progress.
  const resurrectedAccount = sql`${t.kind} = 'account' and not exists (select 1 from ${schema.accountDeletions} where ${schema.accountDeletions.userId} = ${t.id}) and (exists (select 1 from ${u} where ${u.id} = ${t.id}) or exists (select 1 from ${a} where ${a.ownerId} = ${t.id}) or exists (select 1 from ${schema.objects} where ${schema.objects.ownerId} = ${t.id}))`;

  const [, deletions, , artifacts] = await db.batch([
    db
      .insert(schema.outbox)
      .select(
        sql`select null, 'account_deletion', '{}', ${now}, null, 0, ${now}, ${t.id}, null from ${t} where ${resurrectedAccount}`,
      ),
    db
      .insert(schema.accountDeletions)
      .select(sql`select ${t.id}, ${now} from ${t} where ${resurrectedAccount}`)
      .onConflictDoNothing()
      .returning({ userId: schema.accountDeletions.userId }),
    purgeJobs(db, resurrectedArtifact, now),
    db
      .update(a)
      .set({
        state: "purging",
        suspensionReason: null,
        lifecycleGeneration: sql`${a.lifecycleGeneration} + 1`,
        updatedAt: now,
      })
      .where(resurrectedArtifact)
      .returning({ id: a.id }),
    db
      .update(schema.abuseReports)
      .set({ reporterEmail: null })
      .where(
        sql`lower(${schema.abuseReports.reporterEmail}) in (select lower(${u.email}) from ${u} where ${u.id} in (${tombstonedAccounts}))`,
      ),
    db
      .delete(schema.deviceCodes)
      .where(sql`${schema.deviceCodes.userId} in (${tombstonedAccounts})`),
    // Cascades to sessions, identities, OAuth tokens and consents, read sessions and handoffs.
    db.delete(u).where(sql`${u.id} in (${tombstonedAccounts})`),
  ]);
  return { inserted, artifacts: artifacts.length, accounts: deletions.length };
}
