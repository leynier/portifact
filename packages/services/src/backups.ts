// Backup verification and recovery (plan section 10, "Backups", and section 16, "Recuperación").
// The storage reconciliation compares D1's object rows with R2 a bounded slice per run and
// records what disagrees without deleting anything. The tombstone markers are exported before a
// D1 Time Travel restore and applied after it, so purged artifacts and deleted accounts that the
// restored database still holds are deleted again instead of coming back (docs/operations.md).

import type { TombstoneMarker } from "@portifact/contracts";
import {
  bothSides,
  type Db,
  type GlobalDb,
  type Region,
  type RegionalDb,
  schema,
} from "@portifact/db";
import { and, asc, eq, gt, inArray, lt, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { eraseAuditEventsOf } from "./audit.ts";
import { purgeJobs } from "./outbox.ts";
import { recomputeDirectoryRoles } from "./scim-groups.ts";
import { chunked, JSON_CHUNK } from "./shapes.ts";
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
  /** Audit streams removed before the restore, or of deleted owners, removed again (0019). */
  auditStreams: number;
  /** Service tokens revoked before the restore, or of deleted workspaces, deleted again. */
  serviceTokens: number;
  /** GitHub trust rules removed before the restore, removed again (decision 0024). */
  githubTrustRules: number;
  /** Workspace email domains removed or lapsed before the restore that it brought back. */
  domains: number;
  /** Workspace groups deleted before the restore that it brought back (decision 0014). */
  groups: number;
  /** Group memberships removed before the restore that it brought back. */
  groupMembers: number;
  ssoProviders: number;
  /**
   * Workspaces with a directory role mapping whose roles were recomputed from the current
   * directory groups (decision 0017), so a role the directory took away does not come back.
   */
  directoryRoles?: number;
  /** SCIM tokens revoked before the restore, deleted again (decision 0017). */
  scimTokens: number;
  /** Directory users the directory deleted before the restore, deleted again. */
  scimUsers: number;
  /** Pending memberships a directory withdrew before the restore, withdrawn again. */
  invitations: number;
  /**
   * Memberships a directory or an admin ended, or their member left, before the restore, ended
   * again (never a workspace's last admin).
   */
  members: number;
  /**
   * Threads deleted before the restore (by comment retention, decision 0023, by their author or
   * by the people who manage the artifact), deleted again.
   */
  commentThreads: number;
  /** Messages deleted before the restore that it brought back, deleted again. */
  commentMessages: number;
  /** Email preferences turned off before the restore that it turned back on, off again. */
  noticeOptOuts: number;
  /** Per-artifact comment notice mutes set before the restore that it lost, set again. */
  noticeMutes: number;
  /** Browser sessions that ended before the restore (sign-outs), ended again. */
  sessions: number;
  /** OAuth access and refresh tokens revoked or deleted before the restore, revoked again. */
  oauthTokens: number;
  /** Consents deleted before the restore (apps disconnected), deleted again. */
  oauthGrants: number;
}

/** The databases a restore re-applies tombstones to: the global one and the regions given. */
export interface RestoreRegions {
  global: GlobalDb;
  all(): readonly { db: RegionalDb }[];
}

/** The kinds a regional statement needs as a list of IDs when its database is not the global one. */
const REGIONAL_KINDS = [
  "artifact",
  "account",
  "workspace",
  "share_link",
  "webhook",
  "audit_stream",
  "comment_thread",
  "comment_message",
  "comment_notice_mute",
] as const;
type RegionalKind = (typeof REGIONAL_KINDS)[number];

/** IDs read from the global database per page, and bound per statement (D1 allows 100). */
const TOMBSTONE_PAGE = 90;

/**
 * Re-applies the tombstones of issue connections after a restore (decision 0018), per region:
 * the IDs of removed connections and of deleted accounts and workspaces are read from the global
 * database a page at a time, and each page deletes, in every region, the connections a restore
 * brought back (and forgets deleted accounts as who connected one). Never one statement across
 * the two databases, and never a list longer than a page. Run it after `applyTombstones`, which
 * stores the markers. Returns how many connections it deleted.
 */
export async function applyIntegrationTombstones(regions: {
  global: GlobalDb;
  all(): readonly { db: RegionalDb }[];
}): Promise<{ integrations: number }> {
  const t = schema.tombstones;
  const c = schema.integrationConnections;
  let deleted = 0;
  for (const kinds of [["integration_connection"], ["account", "workspace"]] as const) {
    let after = "";
    for (;;) {
      const page = await regions.global
        .select({ id: t.id, kind: t.kind })
        .from(t)
        .where(and(inArray(t.kind, [...kinds]), gt(t.id, after)))
        .orderBy(asc(t.id))
        .limit(TOMBSTONE_PAGE);
      if (page.length === 0) break;
      const ids = page.map((row) => row.id);
      const accounts = page.filter((row) => row.kind === "account").map((row) => row.id);
      for (const { db } of regions.all()) {
        const gone = await db
          .delete(c)
          .where(
            kinds[0] === "integration_connection" ? inArray(c.id, ids) : inArray(c.ownerId, ids),
          )
          .returning({ id: c.id });
        deleted += gone.length;
        if (accounts.length > 0) {
          await db.update(c).set({ createdBy: null }).where(inArray(c.createdBy, accounts));
        }
      }
      after = ids.at(-1) ?? after;
      if (page.length < TOMBSTONE_PAGE) break;
    }
  }
  return { integrations: deleted };
}

/**
 * How a statement names the tombstoned IDs it needs: subqueries of `tombstones` when it runs on
 * the global database (one database, the statements as they always were), or the IDs read from
 * the global database as one JSON parameter when it runs on a separate regional one.
 */
interface Refs {
  artifacts: SQL;
  owners: SQL;
  accounts: SQL;
  links: SQL;
  webhooks: SQL;
  auditStreams: SQL;
  commentThreads: SQL;
  commentMessages: SQL;
  /** As rows with one column, `ref` (`<artifact>:<user>`), not only a list for `in`. */
  mutes: SQL;
}

const t = schema.tombstones;
const a = schema.artifacts;
const u = schema.users;
const l = schema.shareLinks;
const st = schema.serviceTokens;
const gtr = schema.githubTrustRules;
const ws = schema.workspaces;
const wd = schema.workspaceDeletions;

const tombstonedAccounts = sql`select ${t.id} from ${t} where ${t.kind} = 'account'`;
const tombstonedOwners = sql`select ${t.id} from ${t} where ${t.kind} in ('account', 'workspace')`;

const SUBQUERIES: Refs = {
  artifacts: sql`select ${t.id} from ${t} where ${t.kind} = 'artifact'`,
  owners: tombstonedOwners,
  accounts: tombstonedAccounts,
  links: sql`select ${t.id} from ${t} where ${t.kind} = 'share_link'`,
  webhooks: sql`select ${t.id} from ${t} where ${t.kind} = 'webhook'`,
  auditStreams: sql`select ${t.id} from ${t} where ${t.kind} = 'audit_stream'`,
  commentThreads: sql`select ${t.id} from ${t} where ${t.kind} = 'comment_thread'`,
  commentMessages: sql`select ${t.id} from ${t} where ${t.kind} = 'comment_message'`,
  mutes: sql`select ${t.id} as ref from ${t} where ${t.kind} = 'comment_notice_mute'`,
};

/** A JSON list as the body of an `in (...)` subquery. */
function listed(values: readonly string[]): SQL {
  return sql`select value from json_each(${JSON.stringify(values)})`;
}

/** A JSON list as rows of one column, `ref`. */
function listedRefs(values: readonly string[]): SQL {
  return sql`select value as ref from json_each(${JSON.stringify(values)})`;
}

const wm = schema.workspaceMembers;

/**
 * A membership a `workspace_member` (an admin's or a directory's removal) or
 * `workspace_member_left` (leaving) tombstone ended, when the membership is not newer than it.
 */
function endedMembership(kinds: SQL, member: { workspace: SQL; user: SQL; created: SQL }): SQL {
  return sql`exists (select 1 from ${t} where ${t.kind} in ${kinds} and ${t.id} = ${member.workspace} || ':' || ${member.user} and ${member.created} <= ${t.deletedAt})`;
}

const MEMBER_KINDS = sql`('workspace_member', 'workspace_member_left')`;

/**
 * The memberships the restore ends again: never one that would leave its workspace without an
 * admin (the `workspace_members_keep_admin_on_delete` trigger would refuse the whole batch). An
 * admin goes only while another admin stays whose membership no tombstone ends, or while the
 * workspace is being deleted; a kept admin is listed by the operator tool for a person to settle.
 */
function membershipsToEnd(): SQL {
  const ended = endedMembership(MEMBER_KINDS, {
    workspace: sql`${wm.workspaceId}`,
    user: sql`${wm.userId}`,
    created: sql`${wm.createdAt}`,
  });
  const otherEnded = endedMembership(MEMBER_KINDS, {
    workspace: sql`other.workspace_id`,
    user: sql`other.user_id`,
    created: sql`other.created_at`,
  });
  return sql`${ended} and (${wm.role} <> 'admin' or exists (select 1 from ${wm} as other where other.workspace_id = ${wm.workspaceId} and other.role = 'admin' and other.user_id <> ${wm.userId} and not ${otherEnded}) or exists (select 1 from ${wd} where ${wd.workspaceId} = ${wm.workspaceId}))`;
}

/**
 * Whether a tombstoned owner has anything left: with one database the regional rows are looked
 * up in the statement (as always); with separate regional databases `evidence` lists the owners
 * whose rows the regions still hold, read from them first.
 */
function leftovers(kind: "account" | "workspace", oneDatabase: boolean, evidence: string[]) {
  const global =
    kind === "account"
      ? sql`exists (select 1 from ${u} where ${u.id} = ${t.id})`
      : sql`exists (select 1 from ${ws} where ${ws.id} = ${t.id})`;
  const regional = oneDatabase
    ? kind === "account"
      ? sql` or exists (select 1 from ${a} where ${a.ownerId} = ${t.id}) or exists (select 1 from ${schema.objects} where ${schema.objects.ownerId} = ${t.id}) or exists (select 1 from ${schema.ownerBrands} where ${schema.ownerBrands.ownerId} = ${t.id})`
      : sql` or exists (select 1 from ${a} where ${a.ownerId} = ${t.id}) or exists (select 1 from ${schema.objects} where ${schema.objects.ownerId} = ${t.id})`
    : sql``;
  const elsewhere = evidence.length > 0 ? sql` or ${t.id} in (${listed(evidence)})` : sql``;
  return sql`(${global}${regional}${elsewhere})`;
}

type Side = "global" | "regional" | "every";
interface Entry {
  name: string;
  side: Side;
  build(db: Db, refs: Refs): BatchItem<"sqlite">;
}

/**
 * Every statement of the restore, in the order of the one batch it is with one database. With
 * separate regional databases the `global` ones run on the global database, the `regional` ones on
 * each region, and the `every` ones on both.
 */
function restoreEntries(now: number, oneDatabase: boolean, evidence: string[]): Entry[] {
  // A workspace with anything left of it and no deletion in progress.
  const resurrectedWorkspace = sql`${t.kind} = 'workspace' and not exists (select 1 from ${wd} where ${wd.workspaceId} = ${t.id}) and ${leftovers("workspace", oneDatabase, evidence)}`;
  // An account with anything left of it and no deletion in progress.
  const resurrectedAccount = sql`${t.kind} = 'account' and not exists (select 1 from ${schema.accountDeletions} where ${schema.accountDeletions.userId} = ${t.id}) and ${leftovers("account", oneDatabase, evidence)}`;
  const resurrectedArtifact = (refs: Refs) =>
    sql`${a.state} <> 'purging' and (${a.id} in (${refs.artifacts}) or ${a.ownerId} in (${refs.owners}))`;
  return [
    {
      name: "accountJobs",
      side: "global",
      build: (db) =>
        db
          .insert(schema.outbox)
          .select(
            sql`select null, 'account_deletion', '{}', ${now}, null, 0, ${now}, ${t.id}, null from ${t} where ${resurrectedAccount}`,
          ),
    },
    {
      name: "accounts",
      side: "global",
      build: (db) =>
        db
          .insert(schema.accountDeletions)
          .select(sql`select ${t.id}, ${now} from ${t} where ${resurrectedAccount}`)
          .onConflictDoNothing()
          .returning({ userId: schema.accountDeletions.userId }),
    },
    {
      name: "workspaceJobs",
      side: "global",
      build: (db) =>
        db
          .insert(schema.outbox)
          .select(
            sql`select null, 'workspace_deletion', '{}', ${now}, null, 0, ${now}, ${t.id}, null from ${t} where ${resurrectedWorkspace}`,
          ),
    },
    // Written before the workspace rows go, so the last-admin trigger lets their memberships go.
    {
      name: "workspaces",
      side: "global",
      build: (db) =>
        db
          .insert(wd)
          .select(sql`select ${t.id}, ${now} from ${t} where ${resurrectedWorkspace}`)
          .onConflictDoNothing()
          .returning({ id: wd.workspaceId }),
    },
    {
      name: "purgeJobs",
      side: "regional",
      build: (db, refs) => purgeJobs(db, resurrectedArtifact(refs), now),
    },
    {
      name: "artifacts",
      side: "regional",
      build: (db, refs) =>
        db
          .update(a)
          .set({
            state: "purging",
            suspensionReason: null,
            lifecycleGeneration: sql`${a.lifecycleGeneration} + 1`,
            updatedAt: now,
          })
          .where(resurrectedArtifact(refs))
          .returning({ id: a.id }),
    },
    {
      name: "shareLinks",
      side: "regional",
      build: (db, refs) =>
        db
          .update(l)
          .set({ revokedAt: now })
          .where(sql`${l.revokedAt} is null and ${l.id} in (${refs.links})`)
          .returning({ id: l.id }),
    },
    // Threads comment retention (decision 0023), their author or the artifact's managers deleted:
    // never brought back by a restore. Their messages, comment notices and issue requests go with
    // them by foreign key, and the `annotation_usage` triggers keep the quota right.
    {
      name: "commentThreads",
      side: "regional",
      build: (db, refs) =>
        db
          .delete(schema.annotationThreads)
          .where(sql`${schema.annotationThreads.id} in (${refs.commentThreads})`)
          .returning({ id: schema.annotationThreads.id }),
    },
    // Messages deleted while their thread stayed: the "message deleted" marker again, never the
    // text. The `annotation_usage` triggers give the bytes back.
    {
      name: "commentMessages",
      side: "regional",
      build: (db, refs) =>
        db
          .update(schema.annotationMessages)
          .set({
            state: "deleted",
            body: null,
            bodyBytes: 0,
            revision: sql`${schema.annotationMessages.revision} + 1`,
          })
          .where(
            sql`${schema.annotationMessages.state} <> 'deleted' and ${schema.annotationMessages.id} in (${refs.commentMessages})`,
          )
          .returning({ id: schema.annotationMessages.id }),
    },
    // Per-artifact mutes the restore lost come back, on artifacts that are still there, for
    // accounts that are not deleted.
    {
      name: "noticeMutes",
      side: "regional",
      build: (db, refs) =>
        db
          .insert(schema.commentNoticeMutes)
          .select(
            sql`select artifact, person, ${now} from (select substr(ref, 1, instr(ref, ':') - 1) as artifact, substr(ref, instr(ref, ':') + 1) as person from (${refs.mutes}) where instr(ref, ':') > 0) as muted where exists (select 1 from ${a} where ${a.id} = muted.artifact) and muted.person not in (${refs.accounts})`,
          )
          .onConflictDoNothing()
          .returning({ artifactId: schema.commentNoticeMutes.artifactId }),
    },
    {
      name: "reporters",
      side: "global",
      build: (db) =>
        db
          .update(schema.abuseReports)
          .set({ reporterEmail: null })
          .where(
            sql`lower(${schema.abuseReports.reporterEmail}) in (select lower(${u.email}) from ${u} where ${u.id} in (${tombstonedAccounts}))`,
          ),
    },
    {
      name: "deviceCodes",
      side: "global",
      build: (db) =>
        db
          .delete(schema.deviceCodes)
          .where(sql`${schema.deviceCodes.userId} in (${tombstonedAccounts})`),
    },
    // A revoked token, or one of a deleted workspace, must never authenticate again
    // (decision 0011). Before the workspace rows go, so the count includes their tokens.
    {
      name: "serviceTokens",
      side: "global",
      build: (db) =>
        db
          .delete(st)
          .where(
            sql`${st.id} in (select ${t.id} from ${t} where ${t.kind} = 'service_token') or ${st.workspaceId} in (select ${t.id} from ${t} where ${t.kind} = 'workspace')`,
          )
          .returning({ id: st.id }),
    },
    // A removed GitHub trust rule must never issue credentials again (decision 0024); its
    // credentials go by the cascade. Before the workspace rows, like the tokens above.
    {
      name: "githubTrustRules",
      side: "global",
      build: (db) =>
        db
          .delete(gtr)
          .where(
            sql`${gtr.id} in (select ${t.id} from ${t} where ${t.kind} = 'github_trust_rule') or ${gtr.workspaceId} in (select ${t.id} from ${t} where ${t.kind} = 'workspace')`,
          )
          .returning({ id: gtr.id }),
    },
    {
      name: "githubTrustAuthors",
      side: "global",
      build: (db) =>
        db
          .update(gtr)
          .set({ createdBy: null })
          .where(sql`${gtr.createdBy} in (${tombstonedAccounts})`),
    },
    // Cascades to memberships, invitations and service tokens.
    {
      name: "workspaceRows",
      side: "global",
      build: (db) =>
        db
          .delete(ws)
          .where(sql`${ws.id} in (select ${t.id} from ${t} where ${t.kind} = 'workspace')`),
    },
    {
      name: "linkAuthors",
      side: "regional",
      build: (db, refs) =>
        db.update(l).set({ createdBy: null }).where(sql`${l.createdBy} in (${refs.accounts})`),
    },
    {
      name: "tokenAuthors",
      side: "global",
      build: (db) =>
        db
          .update(st)
          .set({ createdBy: null })
          .where(sql`${st.createdBy} in (${tombstonedAccounts})`),
    },
    // A role a directory gave goes with the account (decision 0017).
    {
      name: "mappedRoles",
      side: "global",
      build: (db) =>
        db
          .update(schema.scimUsers)
          .set({ mappedRole: null })
          .where(sql`${schema.scimUsers.userId} in (${tombstonedAccounts})`),
    },
    // What ended before the restore point stays ended (migration 0071's markers): tokens revoked
    // or deleted (a revoked row is as unusable as a deleted one), sessions signed out and consents
    // of disconnected apps.
    ...([schema.oauthAccessTokens, schema.oauthRefreshTokens] as const).map(
      (table): Entry => ({
        name: table === schema.oauthAccessTokens ? "oauthAccessTokens" : "oauthRefreshTokens",
        side: "global",
        build: (db) =>
          db
            .update(table)
            .set({
              revoked: sql`(select ${t.deletedAt} from ${t} where ${t.kind} = 'oauth_token' and ${t.id} = ${table.id})`,
            })
            .where(
              sql`${table.revoked} is null and ${table.id} in (select ${t.id} from ${t} where ${t.kind} = 'oauth_token')`,
            )
            .returning({ id: table.id }),
      }),
    ),
    {
      name: "sessions",
      side: "global",
      build: (db) =>
        db
          .delete(schema.sessions)
          .where(
            sql`${schema.sessions.id} in (select ${t.id} from ${t} where ${t.kind} = 'session')`,
          )
          .returning({ id: schema.sessions.id }),
    },
    {
      name: "oauthGrants",
      side: "global",
      build: (db) =>
        db
          .delete(schema.oauthConsents)
          .where(
            sql`${schema.oauthConsents.id} in (select ${t.id} from ${t} where ${t.kind} = 'oauth_grant')`,
          )
          .returning({ id: schema.oauthConsents.id }),
    },
    // Cascades to sessions, identities, OAuth tokens and consents, read sessions and handoffs.
    {
      name: "users",
      side: "global",
      build: (db) => db.delete(u).where(sql`${u.id} in (${tombstonedAccounts})`),
    },
    // Removed webhooks and those of deleted accounts and workspaces: a restored destination must
    // never receive.
    {
      name: "webhooks",
      side: "regional",
      build: (db, refs) =>
        db
          .delete(schema.webhooks)
          .where(
            sql`${schema.webhooks.id} in (${refs.webhooks}) or ${schema.webhooks.ownerId} in (${refs.owners})`,
          )
          .returning({ id: schema.webhooks.id }),
    },
    // Removed audit streams and those of deleted owners (decision 0019): a restored endpoint
    // must never receive the log again.
    {
      name: "auditStreams",
      side: "regional",
      build: (db, refs) =>
        db
          .delete(schema.auditStreams)
          .where(
            sql`${schema.auditStreams.id} in (${refs.auditStreams}) or ${schema.auditStreams.ownerId} in (${refs.owners})`,
          )
          .returning({ id: schema.auditStreams.id }),
    },
    // A removed or lapsed email domain must not grant again (decision 0010); rows of deleted
    // workspaces went with the workspace above. By row ID, so a later claim of the name survives.
    {
      name: "domains",
      side: "global",
      build: (db) =>
        db
          .delete(schema.workspaceDomains)
          .where(
            sql`${schema.workspaceDomains.id} in (select ${t.id} from ${t} where ${t.kind} = 'workspace_domain')`,
          )
          .returning({ id: schema.workspaceDomains.id }),
    },
    // A deleted group, or a removed group membership, must not grant again (decision 0014). By
    // row ID, so a later group or membership survives. Groups of deleted workspaces went with the
    // workspace, memberships of deleted accounts with the account.
    {
      name: "groups",
      side: "global",
      build: (db) =>
        db
          .delete(schema.workspaceGroups)
          .where(
            sql`${schema.workspaceGroups.id} in (select ${t.id} from ${t} where ${t.kind} = 'workspace_group')`,
          )
          .returning({ id: schema.workspaceGroups.id }),
    },
    {
      name: "groupMembers",
      side: "global",
      build: (db) =>
        db
          .delete(schema.workspaceGroupMembers)
          .where(
            sql`${schema.workspaceGroupMembers.id} in (select ${t.id} from ${t} where ${t.kind} = 'workspace_group_member')`,
          )
          .returning({ id: schema.workspaceGroupMembers.id }),
    },
    // The audit log of deleted accounts and workspaces (the restore brought it back), in every
    // database that keeps one.
    {
      name: "audit",
      side: "every",
      build: (db, refs) => eraseAuditEventsOf(db, refs.owners),
    },
    // A removed single sign-on provider must never sign anyone in again (decision 0016), nor
    // its linked identities; providers of deleted workspaces went with the workspace above.
    {
      name: "ssoIdentities",
      side: "global",
      build: (db) =>
        db
          .delete(schema.accounts)
          .where(
            sql`${schema.accounts.providerId} in (select 'sso:' || ${t.id} from ${t} where ${t.kind} = 'workspace_sso')`,
          ),
    },
    {
      name: "ssoProviders",
      side: "global",
      build: (db) =>
        db
          .delete(schema.workspaceSso)
          .where(
            sql`${schema.workspaceSso.id} in (select ${t.id} from ${t} where ${t.kind} = 'workspace_sso')`,
          )
          .returning({ id: schema.workspaceSso.id }),
    },
    // Identities of providers that went above, removed or with a deleted workspace.
    { name: "orphanIdentities", side: "global", build: (db) => deleteOrphanSsoIdentities(db) },
    // SCIM (decision 0017): a revoked directory token must never authenticate again, a deleted
    // directory user stays deleted, and what a directory withdrew stays withdrawn: its pending
    // memberships by row ID, and memberships it ended when they are older than the tombstone
    // (a later membership of the same person survives).
    {
      name: "scimTokens",
      side: "global",
      build: (db) =>
        db
          .delete(schema.scimTokens)
          .where(
            sql`${schema.scimTokens.id} in (select ${t.id} from ${t} where ${t.kind} = 'scim_token')`,
          )
          .returning({ id: schema.scimTokens.id }),
    },
    {
      name: "scimUsers",
      side: "global",
      build: (db) =>
        db
          .delete(schema.scimUsers)
          .where(
            sql`${schema.scimUsers.id} in (select ${t.id} from ${t} where ${t.kind} = 'scim_user')`,
          )
          .returning({ id: schema.scimUsers.id }),
    },
    {
      name: "invitations",
      side: "global",
      build: (db) =>
        db
          .delete(schema.workspaceInvitations)
          .where(
            sql`${schema.workspaceInvitations.id} in (select ${t.id} from ${t} where ${t.kind} = 'workspace_invitation')`,
          )
          .returning({ id: schema.workspaceInvitations.id }),
    },
    // The single sign-on block goes back with an admin's or a directory's removal, or the
    // provider would let them in again; leaving by oneself never had one.
    {
      name: "removals",
      side: "global",
      build: (db) =>
        db
          .insert(schema.workspaceRemovals)
          .select(
            sql`select ${wm.workspaceId}, ${wm.userId}, (select max(${t.deletedAt}) from ${t} where ${t.kind} = 'workspace_member' and ${t.id} = ${wm.workspaceId} || ':' || ${wm.userId}) from ${wm} where ${membershipsToEnd()} and ${endedMembership(
              sql`('workspace_member')`,
              {
                workspace: sql`${wm.workspaceId}`,
                user: sql`${wm.userId}`,
                created: sql`${wm.createdAt}`,
              },
            )}`,
          )
          .onConflictDoNothing(),
    },
    {
      name: "members",
      side: "global",
      build: (db) => db.delete(wm).where(membershipsToEnd()).returning({ userId: wm.userId }),
    },
    // Email preferences turned off since the restore point stay off: `<user>:<preference>`.
    ...(["comment_notices", "expiry_notices"] as const).map(
      (preference): Entry => ({
        name: `noticeOptOuts:${preference}`,
        side: "global",
        build: (db) => optOutStatement(db, preference),
      }),
    ),
  ];
}

/**
 * Turns one email preference off again for every account whose `notice_opt_out` tombstone says
 * it was turned off (the restore brought back an earlier "on", or no settings row at all).
 */
function optOutStatement(db: Db, preference: "comment_notices" | "expiry_notices") {
  const s = schema.accountSettings;
  const comment = preference === "comment_notices";
  const suffix = `:${preference}`;
  const user = sql`substr(${t.id}, 1, length(${t.id}) - ${suffix.length})`;
  // Columns in schema order: user, default access mode, annotations, comment visibility, bar,
  // expiry notices, comment notices, comment notices changed at, locale, updated at.
  return db
    .insert(s)
    .select(
      sql`select ${user}, 'restricted', 'off', 'owner', 1, ${comment ? 1 : 0}, ${comment ? 0 : 1}, ${comment ? sql`${t.deletedAt}` : sql`null`}, null, ${t.deletedAt} from ${t} where ${t.kind} = 'notice_opt_out' and substr(${t.id}, -${suffix.length}) = ${suffix} and exists (select 1 from ${u} where ${u.id} = ${user})`,
    )
    .onConflictDoUpdate({
      target: s.userId,
      set: comment
        ? {
            commentNotices: false,
            commentNoticesChangedAt: sql`case when ${s.commentNotices} = 0 then ${s.commentNoticesChangedAt} else excluded.comment_notices_changed_at end`,
          }
        : { expiryNotices: false },
      setWhere: comment ? sql`${s.commentNotices} = 1` : sql`${s.expiryNotices} = 1`,
    })
    .returning({ userId: s.userId });
}

async function runEntries(db: Db, entries: Entry[], refs: Refs): Promise<Map<string, unknown[]>> {
  const results = await db.batch(
    entries.map((entry) => entry.build(db, refs)) as [
      BatchItem<"sqlite">,
      ...BatchItem<"sqlite">[],
    ],
  );
  return new Map(entries.map((entry, i) => [entry.name, (results[i] ?? []) as unknown[]]));
}

/** The tombstoned IDs a separate regional database needs, read from the global database. */
async function regionalTombstones(global: GlobalDb): Promise<Record<RegionalKind, string[]>> {
  const rows = await global
    .select({ kind: t.kind, id: t.id })
    .from(t)
    .where(inArray(t.kind, [...REGIONAL_KINDS]));
  const lists = Object.fromEntries(REGIONAL_KINDS.map((kind) => [kind, [] as string[]])) as Record<
    RegionalKind,
    string[]
  >;
  for (const row of rows) lists[row.kind as RegionalKind]?.push(row.id);
  return lists;
}

/**
 * One separate region's half of the restore: which tombstoned owners it still holds rows of
 * (the evidence the global half needs), then its regional statements, a chunk of IDs at a time.
 */
async function applyRegionalTombstones(
  db: RegionalDb,
  lists: Record<RegionalKind, string[]>,
  entries: Entry[],
) {
  const owners = [...lists.account, ...lists.workspace];
  // A mute of a deleted account never comes back. The statement's `not in` only sees one round's
  // slice of the accounts, so the full set filters the mutes here, before they are chunked.
  const deletedAccounts = new Set(lists.account);
  const mutes = lists.comment_notice_mute.filter(
    (ref) => !deletedAccounts.has(ref.slice(ref.indexOf(":") + 1)),
  );
  const evidence = new Set<string>();
  for (const chunk of chunked(owners)) {
    const ids = listed(chunk);
    const rows = await db.all<{ owner: string }>(
      sql`select ${a.ownerId} as owner from ${a} where ${a.ownerId} in (${ids}) union select ${schema.objects.ownerId} from ${schema.objects} where ${schema.objects.ownerId} in (${ids}) union select ${schema.ownerBrands.ownerId} from ${schema.ownerBrands} where ${schema.ownerBrands.ownerId} in (${ids})`,
    );
    for (const row of rows) evidence.add(row.owner);
  }
  const counts = new Map<string, number>();
  const regional = entries.filter((entry) => entry.side !== "global");
  const rounds = Math.max(
    1,
    ...REGIONAL_KINDS.map((kind) => Math.ceil(lists[kind].length / JSON_CHUNK)),
    Math.ceil(owners.length / JSON_CHUNK),
  );
  for (let round = 0; round < rounds; round++) {
    const part = (values: string[]) =>
      listed(values.slice(round * JSON_CHUNK, (round + 1) * JSON_CHUNK));
    const refs: Refs = {
      artifacts: part(lists.artifact),
      owners: part(owners),
      accounts: part(lists.account),
      links: part(lists.share_link),
      webhooks: part(lists.webhook),
      auditStreams: part(lists.audit_stream),
      commentThreads: part(lists.comment_thread),
      commentMessages: part(lists.comment_message),
      mutes: listedRefs(mutes.slice(round * JSON_CHUNK, (round + 1) * JSON_CHUNK)),
    };
    for (const [name, rows] of await runEntries(db, regional, refs)) {
      counts.set(name, (counts.get(name) ?? 0) + rows.length);
    }
  }
  return { evidence: [...evidence], counts };
}

/**
 * Re-applies tombstones after a restore: stores the given markers as tombstones, then claims for
 * purging every artifact that has a tombstone or belongs to a tombstoned account (each with its
 * purge job), and deletes every tombstoned account the restore brought back the way a deletion
 * request does, with an `account_deletion` job that finishes it. The jobs Worker purges the
 * bytes. Running it again changes nothing.
 *
 * With one database (a region whose database is the global one) everything is one batch, as it
 * always was. Each separate regional database is done first, with the tombstoned IDs read from
 * the global database (which owners it still holds rows of is read there too), then the global
 * half, which also deletes again the owners only a separate region still had rows of. A failure
 * in between leaves the global half undone; running it again finishes it (decision 0005).
 * `regions` may be one region's handle, or the regions a restore rewound (the operator's
 * `--region`); the global half always runs.
 */
export async function applyTombstones(
  regions: RestoreRegions | RegionalDb,
  markers: readonly TombstoneMarker[],
  now: number,
): Promise<ApplyTombstonesResult> {
  const target: RestoreRegions =
    "batch" in regions ? { global: regions.global, all: () => [{ db: regions }] } : regions;
  const global = target.global;
  let inserted = 0;
  for (let i = 0; i < markers.length; i += 25) {
    const rows = await global
      .insert(schema.tombstones)
      .values(
        markers.slice(i, i + 25).map((m) => ({ kind: m.kind, id: m.id, deletedAt: m.deletedAt })),
      )
      .onConflictDoNothing()
      .returning({ id: schema.tombstones.id });
    inserted += rows.length;
  }

  const shared = target
    .all()
    .map(({ db }) => bothSides(db))
    .find((both): both is Db => both !== null);
  const separate = target.all().filter(({ db }) => bothSides(db) === null);
  const counts = new Map<string, number>();
  const add = (results: Map<string, unknown[]> | Map<string, number>) => {
    for (const [name, value] of results) {
      counts.set(
        name,
        (counts.get(name) ?? 0) + (typeof value === "number" ? value : value.length),
      );
    }
  };
  const evidence = new Set<string>();
  if (separate.length > 0) {
    const lists = await regionalTombstones(global);
    const entries = restoreEntries(now, false, []);
    for (const { db } of separate) {
      const done = await applyRegionalTombstones(db, lists, entries);
      for (const owner of done.evidence) evidence.add(owner);
      add(done.counts);
    }
  }
  if (shared) {
    // The one batch of the default region, whose database is the global one.
    add(await runEntries(shared, restoreEntries(now, true, [...evidence]), SUBQUERIES));
  } else {
    const entries = restoreEntries(now, false, [...evidence]).filter(
      (entry) => entry.side !== "regional",
    );
    add(await runEntries(global, entries, SUBQUERIES));
  }
  // Roles from directory groups, recomputed from what the restore and the tombstones left
  // (decision 0017): bounded per run (`recomputeDirectoryRoles`), run again while `more`.
  const roles = await recomputeDirectoryRoles(global, now);
  const count = (name: string) => counts.get(name) ?? 0;
  return {
    inserted,
    artifacts: count("artifacts"),
    accounts: count("accounts"),
    workspaces: count("workspaces"),
    shareLinks: count("shareLinks"),
    webhooks: count("webhooks"),
    auditStreams: count("auditStreams"),
    serviceTokens: count("serviceTokens"),
    githubTrustRules: count("githubTrustRules"),
    domains: count("domains"),
    groups: count("groups"),
    groupMembers: count("groupMembers"),
    ssoProviders: count("ssoProviders"),
    scimTokens: count("scimTokens"),
    scimUsers: count("scimUsers"),
    invitations: count("invitations"),
    members: count("members"),
    commentThreads: count("commentThreads"),
    commentMessages: count("commentMessages"),
    noticeOptOuts: count("noticeOptOuts:comment_notices") + count("noticeOptOuts:expiry_notices"),
    noticeMutes: count("noticeMutes"),
    sessions: count("sessions"),
    oauthTokens: count("oauthAccessTokens") + count("oauthRefreshTokens"),
    oauthGrants: count("oauthGrants"),
    directoryRoles: roles.workspaces,
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
