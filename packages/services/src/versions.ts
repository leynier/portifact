// Version history use cases (plan sections 5, 6 and 9): list the versions an artifact retains,
// read a version's manifest, plan the download of its published files or private sources, and
// roll back. A rollback is a new publish of retained content: a new version that references the
// same stored objects, made current under the same base-version check as a commit. Access belongs
// to the artifact, not to its versions, so a rollback never brings back a removed reader.
import { CURRENT_VERSION, type DownloadKind, type RoleAction } from "@portifact/contracts";
import { type Db, type RegionalDb, schema } from "@portifact/db";
import {
  type Actor,
  can,
  checkPublish,
  type Entitlements,
  fail,
  hasFeature,
  nextExpiry,
  normalizePath,
  ok,
  previousVersionExpiry,
  type Result,
  type SourceOriginInput,
  type VersionRetention,
  versionRetention,
} from "@portifact/domain";
import { and, asc, desc, eq, exists, inArray, lt, sql } from "drizzle-orm";
import { actorOn, authorizeOn } from "./actors.ts";
import { auditEvent } from "./audit.ts";
import { searchIndexJob } from "./content-search.ts";
import { ownerEntitlements } from "./plans.ts";
import { objectKey, windowSum } from "./publish.ts";
import { checkReadAccess } from "./read-access.ts";
import { retainedVersionSql } from "./retention.ts";
import { markWebhookEvent } from "./webhook-activity.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface VersionInfo {
  id: string;
  number: number;
  /** The version visitors see now. */
  current: boolean;
  entrypoint: string;
  publishedBytes: number;
  sourceBytes: number;
  publishedFiles: number;
  sourceFiles: number;
  rendererVersion: string | null;
  committedAt: number;
  /** End of retention for a previous version; null for the current one. */
  expiresAt: number | null;
  /** Declared git origin of the sources; null when the publisher sent none. */
  sourceOrigin: SourceOriginInput | null;
}

export interface VersionPage {
  items: VersionInfo[];
  nextCursor: string | null;
  /** What the owner's plan keeps of previous versions. */
  retention: VersionRetention;
  /** Whether the owner's plan includes comparing versions. */
  versionDiff: boolean;
}

export interface VersionFileEntry {
  path: string;
  kind: DownloadKind;
  sha256: string;
  size: number;
  contentType: string;
}

export interface VersionManifestResult {
  artifactId: string;
  version: VersionInfo;
  files: VersionFileEntry[];
}

export interface DownloadPlan {
  artifactId: string;
  versionId: string;
  versionNumber: number;
  kind: DownloadKind;
  entrypoint: string;
  /** Each file with the R2 key of its bytes; adapters turn the key into a short-lived link. */
  files: (Omit<VersionFileEntry, "kind"> & { r2Key: string })[];
}

export interface RollbackInput {
  /** The signed-in user; an admin or editor of the artifact's owner may roll it back. */
  userId: string;
  artifactId: string;
  /** The retained version whose files become current again. */
  versionId: string;
  /** The current version the client read; a newer one makes the rollback a conflict. */
  baseVersionId: string;
  now: number;
}

export interface RollbackOutcome {
  artifactId: string;
  versionId: string;
  versionNumber: number;
  /** Null while the artifact is pinned: a rollback keeps the pin. */
  expiresAt: number | null;
  fromVersionId: string;
  fromVersionNumber: number;
}

export type ArtifactRow = typeof schema.artifacts.$inferSelect;

export const missingVersion = () =>
  fail<never>(
    "not_found",
    "This version does not exist, is no longer retained or your account cannot download it.",
  );

/**
 * An artifact that still exists, for a user whose role on its owner allows `action`. An owner
 * the user has no role on looks the same as a missing artifact (`missing`).
 */
export async function managedArtifact(
  db: RegionalDb,
  userId: string,
  artifactId: string,
  action: RoleAction,
  missing: () => Result<never>,
  now: number,
): Promise<Result<{ artifact: ArtifactRow; actor: Actor; owner: Entitlements }>> {
  const artifact = await loadArtifact(db, artifactId);
  if (!artifact) return missing();
  const actor = await authorizeOn(db, userId, artifact, action, missing);
  if (!actor.ok) return actor;
  // Retention and paid features follow the owner's plan, a workspace's for a workspace.
  const owner = await ownerEntitlements(db, artifact.ownerId, now);
  return ok({ artifact, actor: actor.value, owner });
}

export const missingArtifact = () => fail<never>("not_found", "Artifact not found.");

async function loadArtifact(db: Db, artifactId: string): Promise<ArtifactRow | undefined> {
  const [artifact] = await db
    .select()
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, artifactId))
    .limit(1);
  if (!artifact || artifact.state === "deleted" || artifact.state === "purging") return undefined;
  return artifact;
}

/**
 * Versions that can still be read: committed, and either current or inside the owner's retention.
 * `pruneVersions` deletes the others, but may not have run yet.
 */
function retained(currentVersionId: string | null, retention: VersionRetention, now: number) {
  return retainedVersionSql(sql`${currentVersionId}`, retention, now);
}

function fileCount(kind: DownloadKind) {
  return sql<number>`(select count(*) from ${schema.versionFiles} where ${schema.versionFiles.versionId} = ${schema.versions.id} and ${schema.versionFiles.kind} = ${kind})`;
}

const versionColumns = {
  id: schema.versions.id,
  number: schema.versions.number,
  entrypoint: schema.versions.entrypoint,
  publishedBytes: schema.versions.publishedBytes,
  sourceBytes: schema.versions.sourceBytes,
  publishedFiles: fileCount("published"),
  sourceFiles: fileCount("source"),
  rendererVersion: schema.versions.rendererVersion,
  committedAt: schema.versions.committedAt,
  supersededAt: schema.versions.supersededAt,
  originCommit: schema.sourceOrigins.commit,
  originBranch: schema.sourceOrigins.branch,
  originRemote: schema.sourceOrigins.remote,
  originDirty: schema.sourceOrigins.dirty,
};

const originJoin = eq(schema.sourceOrigins.versionId, schema.versions.id);

type VersionRow = {
  id: string;
  number: number;
  entrypoint: string;
  publishedBytes: number;
  sourceBytes: number;
  publishedFiles: number;
  sourceFiles: number;
  rendererVersion: string | null;
  committedAt: number | null;
  supersededAt: number | null;
  originCommit: string | null;
  originBranch: string | null;
  originRemote: string | null;
  originDirty: boolean | null;
};

function toInfo(
  row: VersionRow,
  currentVersionId: string | null,
  retention: VersionRetention,
): VersionInfo {
  const current = row.id === currentVersionId;
  return {
    id: row.id,
    number: row.number,
    current,
    entrypoint: row.entrypoint,
    publishedBytes: row.publishedBytes,
    sourceBytes: row.sourceBytes,
    publishedFiles: Number(row.publishedFiles),
    sourceFiles: Number(row.sourceFiles),
    rendererVersion: row.rendererVersion,
    // Committed versions always have a commit time; the fallback keeps the type total.
    committedAt: row.committedAt ?? 0,
    expiresAt:
      current || row.supersededAt === null
        ? null
        : previousVersionExpiry(row.supersededAt, retention),
    // The join finds no row when the publisher declared no origin; `dirty` is never null in one.
    sourceOrigin:
      row.originDirty === null
        ? null
        : {
            commit: row.originCommit,
            branch: row.originBranch,
            remote: row.originRemote,
            dirty: row.originDirty,
          },
  };
}

/** A retained version of the artifact, by ID or `current`, under the owner's retention. */
export async function resolveVersion(
  db: Db,
  artifact: ArtifactRow,
  ref: string,
  retention: VersionRetention,
  now: number,
): Promise<VersionInfo | undefined> {
  const id = ref === CURRENT_VERSION ? artifact.currentVersionId : ref;
  if (id === null) return undefined;
  const [row] = await db
    .select(versionColumns)
    .from(schema.versions)
    .leftJoin(schema.sourceOrigins, originJoin)
    .where(
      and(
        eq(schema.versions.id, id),
        eq(schema.versions.artifactId, artifact.id),
        retained(artifact.currentVersionId, retention, now),
      ),
    )
    .limit(1);
  return row ? toInfo(row, artifact.currentVersionId, retention) : undefined;
}

/** Cursor of the version list: the number of the last version on the page. */
function decodeVersionCursor(cursor: string): number | undefined {
  return /^[1-9]\d{0,8}$/.test(cursor) ? Number(cursor) : undefined;
}

/** The owner's retained versions of an artifact, newest first. Archived artifacts keep theirs. */
export async function listVersions(
  db: RegionalDb,
  input: {
    userId: string;
    artifactId: string;
    now: number;
    cursor?: string | undefined;
    limit: number;
  },
): Promise<Result<VersionPage>> {
  const managed = await managedArtifact(
    db,
    input.userId,
    input.artifactId,
    "versions",
    missingArtifact,
    input.now,
  );
  if (!managed.ok) return managed;
  const { artifact, owner } = managed.value;
  const retention = versionRetention(owner.limits);
  const before = input.cursor === undefined ? undefined : decodeVersionCursor(input.cursor);
  if (input.cursor !== undefined && before === undefined) {
    return fail("invalid_input", "Invalid cursor.");
  }
  const rows = await db
    .select(versionColumns)
    .from(schema.versions)
    .leftJoin(schema.sourceOrigins, originJoin)
    .where(
      and(
        eq(schema.versions.artifactId, artifact.id),
        retained(artifact.currentVersionId, retention, input.now),
        before === undefined ? undefined : lt(schema.versions.number, before),
      ),
    )
    .orderBy(desc(schema.versions.number))
    .limit(input.limit + 1);
  const items = rows
    .slice(0, input.limit)
    .map((row) => toInfo(row, artifact.currentVersionId, retention));
  const last = items.at(-1);
  return ok({
    items,
    nextCursor: rows.length > input.limit && last ? String(last.number) : null,
    retention,
    versionDiff: hasFeature(owner, "versionDiff"),
  });
}

/** A retained version and all of its files, published and source. Owner only. */
export async function getVersionManifest(
  db: RegionalDb,
  input: { userId: string; artifactId: string; versionId: string; now: number },
): Promise<Result<VersionManifestResult>> {
  const managed = await managedArtifact(
    db,
    input.userId,
    input.artifactId,
    "versions",
    missingVersion,
    input.now,
  );
  if (!managed.ok) return managed;
  const { artifact, owner } = managed.value;
  const version = await resolveVersion(
    db,
    artifact,
    input.versionId,
    versionRetention(owner.limits),
    input.now,
  );
  if (!version) return missingVersion();
  const files = await db
    .select({
      path: schema.versionFiles.path,
      kind: schema.versionFiles.kind,
      sha256: schema.versionFiles.sha256,
      size: schema.versionFiles.size,
      contentType: schema.versionFiles.contentType,
    })
    .from(schema.versionFiles)
    .where(
      and(
        eq(schema.versionFiles.versionId, version.id),
        // Rendered pages and block maps are derived by the server, not part of the manifest.
        inArray(schema.versionFiles.kind, ["published", "source"]),
      ),
    )
    .orderBy(asc(schema.versionFiles.kind), asc(schema.versionFiles.path));
  return ok({
    artifactId: artifact.id,
    version,
    files: files as (Omit<(typeof files)[number], "kind"> & { kind: "published" | "source" })[],
  });
}

/**
 * What a download of one kind of files of a version may fetch. An admin or editor of the owner
 * downloads published files and sources of any retained version. Anyone else gets only the published files of the
 * current version of a Markdown or text artifact they can read now (plan section 5); everything
 * else answers like a missing version, so it reveals nothing.
 */
export async function getVersionDownload(
  db: RegionalDb,
  input: {
    userId: string;
    artifactId: string;
    versionId: string;
    kind: DownloadKind;
    path?: string | undefined;
    now: number;
  },
): Promise<Result<DownloadPlan>> {
  let path: string | undefined;
  if (input.path !== undefined) {
    const normalized = normalizePath(input.path);
    if (!normalized.ok) return fail("invalid_input", normalized.message);
    path = normalized.value;
  }
  const artifact = await loadArtifact(db, input.artifactId);
  if (!artifact) return missingVersion();
  const actor = await actorOn(db.global, input.userId, artifact);
  if (!(actor && can(actor, "versions"))) {
    if (input.kind !== "published" || artifact.type === "site") return missingVersion();
    const ref = input.versionId === CURRENT_VERSION ? artifact.currentVersionId : input.versionId;
    if (ref === null || ref !== artifact.currentVersionId) return missingVersion();
    const access = await checkReadAccess(db, {
      artifactId: artifact.id,
      userId: input.userId,
      now: input.now,
    });
    if (!access.ok) return missingVersion();
  }
  const owner = await ownerEntitlements(db, artifact.ownerId, input.now);
  const version = await resolveVersion(
    db,
    artifact,
    input.versionId,
    versionRetention(owner.limits),
    input.now,
  );
  if (!version) return missingVersion();
  const files = await db
    .select({
      path: schema.versionFiles.path,
      ownerId: schema.versionFiles.ownerId,
      sha256: schema.versionFiles.sha256,
      size: schema.versionFiles.size,
      contentType: schema.versionFiles.contentType,
      // The object row's key, not one built from the owner: a transferred artifact's objects
      // keep the key they were stored under (transfer.ts).
      // Columns named with their tables: Drizzle leaves select fields unqualified.
      r2Key: sql<
        string | null
      >`(select "objects"."r2_key" from "objects" where "objects"."owner_id" = "version_files"."owner_id" and "objects"."sha256" = "version_files"."sha256")`,
    })
    .from(schema.versionFiles)
    .where(
      and(
        eq(schema.versionFiles.versionId, version.id),
        eq(schema.versionFiles.kind, input.kind),
        path === undefined ? undefined : eq(schema.versionFiles.path, path),
      ),
    )
    .orderBy(asc(schema.versionFiles.path));
  if (path !== undefined && files.length === 0) {
    return fail("not_found", "This version has no such file.");
  }
  return ok({
    artifactId: artifact.id,
    versionId: version.id,
    versionNumber: version.number,
    kind: input.kind,
    entrypoint: version.entrypoint,
    files: files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      size: file.size,
      contentType: file.contentType,
      r2Key: file.r2Key ?? objectKey(file.ownerId, file.sha256),
    })),
  });
}

/**
 * Makes a retained version current again as a new version with the same files, so the stored
 * objects are referenced again and nothing is uploaded. The switch is conditional on the base
 * version and on the target still being retained; every other write is conditional on the
 * switch to this request's new version ID, so a concurrent publish or rollback leaves a clean
 * `version_conflict` with nothing applied. Callers make it idempotent with a key.
 */
export async function rollbackArtifact(
  db: RegionalDb,
  input: RollbackInput,
): Promise<Result<RollbackOutcome>> {
  const managed = await managedArtifact(
    db,
    input.userId,
    input.artifactId,
    "rollback",
    missingArtifact,
    input.now,
  );
  if (!managed.ok) return managed;
  const { artifact, owner } = managed.value;
  const retention = versionRetention(owner.limits);
  const ownerId = artifact.ownerId;
  if (artifact.state === "suspended") {
    return fail("forbidden", "This artifact is suspended; it cannot be rolled back.");
  }
  if (artifact.state === "archived") {
    return fail("artifact_archived", "Restore the artifact before rolling it back.");
  }
  if (artifact.currentVersionId === null) {
    return fail("not_found", "This artifact has no published version to roll back.");
  }
  if (artifact.currentVersionId !== input.baseVersionId) {
    return fail(
      "version_conflict",
      "The artifact changed since your last read. Fetch it and try again.",
    );
  }
  const target = await resolveVersion(db, artifact, input.versionId, retention, input.now);
  if (!target) return missingVersion();
  if (target.current) {
    return fail("invalid_input", "That version is already the current one.");
  }

  // A rollback publishes: it counts against the publishes per 24 hours and the file limit, but
  // uploads nothing and opens no upload, so storage and upload limits do not apply. Nor does the
  // plan's per-artifact size: the retained version fit the plan it was published under and adds
  // no bytes, and a lower plan never blocks going back to it (premium plan, downgrades).
  const [usageRow] = await db
    .select({ activeArtifacts: schema.accountUsage.activeArtifacts })
    .from(schema.accountUsage)
    .where(eq(schema.accountUsage.ownerId, ownerId))
    .limit(1);
  const admission = checkPublish(
    {
      activeArtifacts: usageRow?.activeArtifacts ?? 0,
      storedBytes: 0,
      publishesLast24h: await windowSum(db, ownerId, "publish", input.now - DAY_MS),
      openUploads: 0,
      newFilesLast24h: 0,
      newBytesLast24h: 0,
      newObjectsThisMonth: 0,
    },
    {
      createsArtifact: false,
      versionBytes: 0,
      files: target.publishedFiles + target.sourceFiles,
      newBytes: 0,
      newFiles: 0,
    },
    owner.limits,
  );
  if (!admission.ok) return admission;

  const versionId = `ver_${crypto.randomUUID().replaceAll("-", "")}`;
  const expiresAt = nextExpiry(new Date(input.now)).getTime();
  const v = schema.versions;
  const files = schema.versionFiles;
  const targetRetained = exists(
    db
      .select({ one: sql`1` })
      .from(v)
      .where(
        and(
          eq(v.id, target.id),
          eq(v.artifactId, artifact.id),
          retained(input.baseVersionId, retention, input.now),
        ),
      ),
  );
  // The new version ID is unique to this request, so only the request that switched the
  // artifact to it sees this condition true.
  const switched = sql`exists (select 1 from ${schema.artifacts} where ${schema.artifacts.id} = ${artifact.id} and ${schema.artifacts.currentVersionId} = ${versionId})`;

  const [switchedRows] = await db.batch([
    db
      .update(schema.artifacts)
      .set({
        currentVersionId: versionId,
        expiresAt: sql`case when ${schema.artifacts.pinned} then null else ${expiresAt} end`,
        lifecycleGeneration: sql`${schema.artifacts.lifecycleGeneration} + 1`,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(schema.artifacts.id, artifact.id),
          eq(schema.artifacts.ownerId, ownerId),
          eq(schema.artifacts.state, "active"),
          eq(schema.artifacts.currentVersionId, input.baseVersionId),
          targetRetained,
        ),
      )
      .returning({ id: schema.artifacts.id, pinned: schema.artifacts.pinned }),
    db.insert(v).select(
      db
        .select({
          id: sql<string>`${versionId}`.as("id"),
          artifactId: v.artifactId,
          // Computed in the statement, so an upload prepared meanwhile cannot take the number.
          number:
            sql<number>`(select coalesce(max("prior"."number"), 0) + 1 from ${v} as "prior" where "prior"."artifact_id" = ${artifact.id})`.as(
              "number",
            ),
          authorId: sql<string>`${input.userId}`.as("author_id"),
          state: sql<"committed">`'committed'`.as("state"),
          entrypoint: v.entrypoint,
          publishedBytes: v.publishedBytes,
          sourceBytes: v.sourceBytes,
          rendererVersion: v.rendererVersion,
          committedAt: sql<number>`${input.now}`.as("committed_at"),
          supersededAt: sql<number | null>`null`.as("superseded_at"),
          createdAt: sql<number>`${input.now}`.as("created_at"),
        })
        .from(v)
        .where(and(eq(v.id, target.id), switched)),
    ),
    db.insert(files).select(
      db
        .select({
          versionId: sql<string>`${versionId}`.as("version_id"),
          kind: files.kind,
          path: files.path,
          ownerId: files.ownerId,
          sha256: files.sha256,
          size: files.size,
          contentType: files.contentType,
        })
        .from(files)
        .where(and(eq(files.versionId, target.id), switched)),
    ),
    // The files include the sources, so their declared origin comes along.
    db.insert(schema.sourceOrigins).select(
      db
        .select({
          versionId: sql<string>`${versionId}`.as("version_id"),
          commit: schema.sourceOrigins.commit,
          branch: schema.sourceOrigins.branch,
          remote: schema.sourceOrigins.remote,
          dirty: schema.sourceOrigins.dirty,
        })
        .from(schema.sourceOrigins)
        .where(and(eq(schema.sourceOrigins.versionId, target.id), switched)),
    ),
    // The version that stops being current becomes a previous version, kept by the owner's plan
    // from now on, like after a publish.
    db
      .update(v)
      .set({ supersededAt: input.now })
      .where(and(eq(v.id, input.baseVersionId), switched)),
    // Annotations (plan section 8): when threads exist, move the open threads of the base
    // version to the owner's history here, conditioned on `switched` like the writes above,
    // exactly as commitPublish must do on a publish.
    db
      .insert(schema.usageEvents)
      .select(sql`select null, ${ownerId}, 'publish', 1, ${input.now} where ${switched}`),
    db
      .insert(schema.lifecycleEvents)
      .select(
        sql`select null, ${artifact.id}, ${input.userId}, 'system', 'rolled_back', ${JSON.stringify({ fromVersionId: target.id, versionId })}, ${input.now} where ${switched}`,
      ),
    auditEvent(
      db,
      {
        ownerId,
        kind: "artifact.rolled_back",
        actor: { type: "user", id: input.userId },
        targetId: artifact.id,
        artifactId: artifact.id,
        // The new number is set by the insert above; the placeholder is replaced in SQL.
        detail: { version: 1, from: target.number },
        computed: { version: sql`(select ${v.number} from ${v} where ${v.id} = ${versionId})` },
        now: input.now,
      },
      switched,
    ),
    // A rollback is a new version for the owner's webhooks, numbered by the insert above.
    ...markWebhookEvent(db, {
      entitlements: owner,
      ownerId,
      artifactId: artifact.id,
      type: "artifact.published",
      actorId: input.userId,
      version: sql`(select ${v.number} from ${v} where ${v.id} = ${versionId})`,
      now: input.now,
      condition: switched,
    }),
    // The restored text becomes the searchable one (decision 0012).
    ...searchIndexJob(db, {
      entitlements: owner,
      artifactId: artifact.id,
      versionId,
      condition: switched,
      now: input.now,
    }),
  ]);

  if (switchedRows.length === 0) {
    return fail(
      "version_conflict",
      "The artifact changed while rolling back. Fetch it and try again.",
    );
  }
  const [created] = await db
    .select({ number: v.number })
    .from(v)
    .where(eq(v.id, versionId))
    .limit(1);
  return ok({
    artifactId: artifact.id,
    versionId,
    versionNumber: created?.number ?? 0,
    expiresAt: switchedRows[0]?.pinned ? null : expiresAt,
    fromVersionId: target.id,
    fromVersionNumber: target.number,
  });
}
