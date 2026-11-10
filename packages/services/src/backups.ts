// Backup verification and recovery (plan section 10, "Backups", and section 16, "Recuperación").
// The storage reconciliation compares D1's object rows with R2 a bounded slice per run and
// records what disagrees without deleting anything. The tombstone markers are exported before a
// D1 Time Travel restore and applied after it, so purged artifacts and deleted accounts that the
// restored database still holds are deleted again instead of coming back (docs/operations.md).

import type { TombstoneMarker } from "@portifact/contracts";
import { type Db, type GlobalDb, type Region, type RegionalDb, schema } from "@portifact/db";
import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { eraseAuditEventsOf } from "./audit.ts";
import { purgeJobs } from "./outbox.ts";
import { revokedShareLinks } from "./share-links.ts";
import { deleteOrphanSsoIdentities } from "./workspaces.ts";

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
export async function exportTombstones(regions: {
  global: GlobalDb;
  all(): readonly { db: RegionalDb }[];
}): Promise<TombstoneMarker[]> {
  const markers = new Map<string, TombstoneMarker>();
  const add = (marker: TombstoneMarker) => {
    const key = `${marker.kind}:${marker.id}`;
    if (!markers.has(key)) markers.set(key, marker);
  };
  const global = regions.global;
  for (const row of await global.select().from(schema.tombstones)) add(row);
  for (const row of await global.select().from(schema.accountDeletions)) {
    add({ kind: "account", id: row.userId, deletedAt: row.requestedAt });
  }
  for (const row of await global.select().from(schema.workspaceDeletions)) {
    add({ kind: "workspace", id: row.workspaceId, deletedAt: row.requestedAt });
  }
  // Purges and revocations are regional (decision 0005): every region's.
  for (const { db } of regions.all()) {
    for (const row of await db
      .select({ id: schema.artifacts.id, updatedAt: schema.artifacts.updatedAt })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.state, "purging"))) {
      add({ kind: "artifact", id: row.id, deletedAt: row.updatedAt });
    }
    // A revocation is permanent too: a restore must not reopen a link (decision 0008).
    for (const marker of await revokedShareLinks(db)) add(marker);
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
  /** Workspaces the restore brought back, deleted again. */
  workspaces: number;
  /** Share links the restore brought back unrevoked, revoked again. */
  shareLinks: number;
  /** Webhooks removed before the restore that it brought back, removed again. */
  webhooks: number;
  /** Service tokens revoked before the restore, or of deleted workspaces, deleted again. */
  serviceTokens: number;
  /** Workspace email domains removed or lapsed before the restore that it brought back. */
  domains: number;
  /** Workspace groups deleted before the restore that it brought back (decision 0014). */
  groups: number;
  /** Group memberships removed before the restore that it brought back. */
  groupMembers: number;
  ssoProviders: number;
  /** SCIM tokens revoked before the restore, deleted again (decision 0017). */
  scimTokens: number;
  /** Directory users the directory deleted before the restore, deleted again. */
  scimUsers: number;
  /** Pending memberships a directory withdrew before the restore, withdrawn again. */
  invitations: number;
  /** Memberships a directory ended before the restore, ended again. */
  members: number;
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
  const tombstonedOwners = sql`select ${t.id} from ${t} where ${t.kind} in ('account', 'workspace')`;
  const resurrectedArtifact = sql`${a.state} <> 'purging' and (${a.id} in (select ${t.id} from ${t} where ${t.kind} = 'artifact') or ${a.ownerId} in (${tombstonedOwners}))`;
  const ws = schema.workspaces;
  const wd = schema.workspaceDeletions;
  // A workspace with anything left of it and no deletion in progress.
  const resurrectedWorkspace = sql`${t.kind} = 'workspace' and not exists (select 1 from ${wd} where ${wd.workspaceId} = ${t.id}) and (exists (select 1 from ${ws} where ${ws.id} = ${t.id}) or exists (select 1 from ${a} where ${a.ownerId} = ${t.id}) or exists (select 1 from ${schema.objects} where ${schema.objects.ownerId} = ${t.id}))`;
  // An account with anything left of it and no deletion in progress.
  const resurrectedAccount = sql`${t.kind} = 'account' and not exists (select 1 from ${schema.accountDeletions} where ${schema.accountDeletions.userId} = ${t.id}) and (exists (select 1 from ${u} where ${u.id} = ${t.id}) or exists (select 1 from ${a} where ${a.ownerId} = ${t.id}) or exists (select 1 from ${schema.objects} where ${schema.objects.ownerId} = ${t.id}) or exists (select 1 from ${schema.ownerBrands} where ${schema.ownerBrands.ownerId} = ${t.id}))`;

  const l = schema.shareLinks;
  const st = schema.serviceTokens;
  const [
    ,
    deletions,
    ,
    workspaces,
    ,
    artifacts,
    shareLinks,
    ,
    ,
    serviceTokens,
    ,
    ,
    ,
    ,
    webhooks,
    domains,
    groups,
    groupMembers,
    ,
    ,
    ssoProviders,
    ,
    scimTokens,
    scimUsers,
    invitations,
    ,
    members,
  ] = await db.batch([
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
    db
      .insert(schema.outbox)
      .select(
        sql`select null, 'workspace_deletion', '{}', ${now}, null, 0, ${now}, ${t.id}, null from ${t} where ${resurrectedWorkspace}`,
      ),
    // Written before the workspace rows go, so the last-admin trigger lets their memberships go.
    db
      .insert(wd)
      .select(sql`select ${t.id}, ${now} from ${t} where ${resurrectedWorkspace}`)
      .onConflictDoNothing()
      .returning({ id: wd.workspaceId }),
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
      .update(l)
      .set({ revokedAt: now })
      .where(
        sql`${l.revokedAt} is null and ${l.id} in (select ${t.id} from ${t} where ${t.kind} = 'share_link')`,
      )
      .returning({ id: l.id }),
    db
      .update(schema.abuseReports)
      .set({ reporterEmail: null })
      .where(
        sql`lower(${schema.abuseReports.reporterEmail}) in (select lower(${u.email}) from ${u} where ${u.id} in (${tombstonedAccounts}))`,
      ),
    db
      .delete(schema.deviceCodes)
      .where(sql`${schema.deviceCodes.userId} in (${tombstonedAccounts})`),
    // A revoked token, or one of a deleted workspace, must never authenticate again
    // (decision 0011). Before the workspace rows go, so the count includes their tokens.
    db
      .delete(st)
      .where(
        sql`${st.id} in (select ${t.id} from ${t} where ${t.kind} = 'service_token') or ${st.workspaceId} in (select ${t.id} from ${t} where ${t.kind} = 'workspace')`,
      )
      .returning({ id: st.id }),
    // Cascades to memberships, invitations and service tokens.
    db.delete(ws).where(sql`${ws.id} in (select ${t.id} from ${t} where ${t.kind} = 'workspace')`),
    db.update(l).set({ createdBy: null }).where(sql`${l.createdBy} in (${tombstonedAccounts})`),
    db.update(st).set({ createdBy: null }).where(sql`${st.createdBy} in (${tombstonedAccounts})`),
    // Cascades to sessions, identities, OAuth tokens and consents, read sessions and handoffs.
    db.delete(u).where(sql`${u.id} in (${tombstonedAccounts})`),
    // Removed webhooks and those of deleted accounts and workspaces: a restored destination must
    // never receive.
    db
      .delete(schema.webhooks)
      .where(
        sql`${schema.webhooks.id} in (select ${t.id} from ${t} where ${t.kind} = 'webhook') or ${schema.webhooks.ownerId} in (${tombstonedOwners})`,
      )
      .returning({ id: schema.webhooks.id }),
    // A removed or lapsed email domain must not grant again (decision 0010); rows of deleted
    // workspaces went with the workspace above. By row ID, so a later claim of the name survives.
    db
      .delete(schema.workspaceDomains)
      .where(
        sql`${schema.workspaceDomains.id} in (select ${t.id} from ${t} where ${t.kind} = 'workspace_domain')`,
      )
      .returning({ id: schema.workspaceDomains.id }),
    // A deleted group, or a removed group membership, must not grant again (decision 0014). By
    // row ID, so a later group or membership survives. Groups of deleted workspaces went with the
    // workspace, memberships of deleted accounts with the account.
    db
      .delete(schema.workspaceGroups)
      .where(
        sql`${schema.workspaceGroups.id} in (select ${t.id} from ${t} where ${t.kind} = 'workspace_group')`,
      )
      .returning({ id: schema.workspaceGroups.id }),
    db
      .delete(schema.workspaceGroupMembers)
      .where(
        sql`${schema.workspaceGroupMembers.id} in (select ${t.id} from ${t} where ${t.kind} = 'workspace_group_member')`,
      )
      .returning({ id: schema.workspaceGroupMembers.id }),
    // The audit log of deleted accounts and workspaces (the restore brought it back).
    eraseAuditEventsOf(db, tombstonedOwners),
    // A removed single sign-on provider must never sign anyone in again (decision 0016), nor
    // its linked identities; providers of deleted workspaces went with the workspace above.
    db
      .delete(schema.accounts)
      .where(
        sql`${schema.accounts.providerId} in (select 'sso:' || ${t.id} from ${t} where ${t.kind} = 'workspace_sso')`,
      ),
    db
      .delete(schema.workspaceSso)
      .where(
        sql`${schema.workspaceSso.id} in (select ${t.id} from ${t} where ${t.kind} = 'workspace_sso')`,
      )
      .returning({ id: schema.workspaceSso.id }),
    // Identities of providers that went above, removed or with a deleted workspace.
    deleteOrphanSsoIdentities(db),
    // SCIM (decision 0017): a revoked directory token must never authenticate again, a deleted
    // directory user stays deleted, and what a directory withdrew stays withdrawn: its pending
    // memberships by row ID, and memberships it ended when they are older than the tombstone
    // (a later membership of the same person survives).
    db
      .delete(schema.scimTokens)
      .where(
        sql`${schema.scimTokens.id} in (select ${t.id} from ${t} where ${t.kind} = 'scim_token')`,
      )
      .returning({ id: schema.scimTokens.id }),
    db
      .delete(schema.scimUsers)
      .where(
        sql`${schema.scimUsers.id} in (select ${t.id} from ${t} where ${t.kind} = 'scim_user')`,
      )
      .returning({ id: schema.scimUsers.id }),
    db
      .delete(schema.workspaceInvitations)
      .where(
        sql`${schema.workspaceInvitations.id} in (select ${t.id} from ${t} where ${t.kind} = 'workspace_invitation')`,
      )
      .returning({ id: schema.workspaceInvitations.id }),
    // The single sign-on block goes back with them, or the provider would let them in again.
    db
      .insert(schema.workspaceRemovals)
      .select(
        sql`select ${schema.workspaceMembers.workspaceId}, ${schema.workspaceMembers.userId}, ${t.deletedAt} from ${schema.workspaceMembers} inner join ${t} on ${t.kind} = 'workspace_member' and ${t.id} = ${schema.workspaceMembers.workspaceId} || ':' || ${schema.workspaceMembers.userId} where ${schema.workspaceMembers.createdAt} <= ${t.deletedAt}`,
      )
      .onConflictDoNothing(),
    db
      .delete(schema.workspaceMembers)
      .where(
        sql`exists (select 1 from ${t} where ${t.kind} = 'workspace_member' and ${t.id} = ${schema.workspaceMembers.workspaceId} || ':' || ${schema.workspaceMembers.userId} and ${schema.workspaceMembers.createdAt} <= ${t.deletedAt})`,
      )
      .returning({ userId: schema.workspaceMembers.userId }),
  ]);
  return {
    inserted,
    artifacts: artifacts.length,
    accounts: deletions.length,
    workspaces: workspaces.length,
    shareLinks: shareLinks.length,
    webhooks: webhooks.length,
    serviceTokens: serviceTokens.length,
    domains: domains.length,
    groups: groups.length,
    groupMembers: groupMembers.length,
    ssoProviders: ssoProviders.length,
    scimTokens: scimTokens.length,
    scimUsers: scimUsers.length,
    invitations: invitations.length,
    members: members.length,
  };
}

/**
 * Puts back the directory rows of artifacts a restore of the global database rewound
 * (decision 0005, section 2): every artifact still in the region's database gets its row again.
 * Run next to `applyTombstones` after a restore, before publishing reopens. Running it again
 * changes nothing. Returns the rows added.
 */
export async function rebuildArtifactDirectory(
  global: GlobalDb,
  regional: RegionalDb,
  region: Region,
): Promise<number> {
  const a = schema.artifacts;
  // The directory is global and the artifacts regional (decision 0005): every ID of the region is
  // offered again and the ones the directory still has are left alone.
  const missing = await regional.select({ id: a.id, createdAt: a.createdAt }).from(a);
  let added = 0;
  for (let i = 0; i < missing.length; i += 25) {
    const rows = await global
      .insert(schema.artifactDirectory)
      .values(
        missing.slice(i, i + 25).map((row) => ({ id: row.id, region, createdAt: row.createdAt })),
      )
      .onConflictDoNothing()
      .returning({ id: schema.artifactDirectory.id });
    added += rows.length;
  }
  return added;
}
