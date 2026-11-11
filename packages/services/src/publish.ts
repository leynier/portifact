// Publishing use cases: prepare an upload (validate, deduplicate, admit and reserve) and commit
// it (verify the uploaded bytes, then switch the current version atomically). Adapters (API,
// MCP, CLI flows) call these; they never reimplement the rules.
import { type ArtifactType, LIMITS, PublishKey } from "@portifact/contracts";
import { bothSides, type Db, type RegionalDb, schema } from "@portifact/db";
import {
  type Actor,
  authorize,
  checkDocumentManifest,
  checkPublish,
  checkPublishCapacity,
  checkPublishKeyReach,
  checkRenderedVersion,
  checkSourceOrigin,
  DEFAULT_MULTIPART,
  DOCUMENT_CONTENT_TYPES,
  type DocumentType,
  entitlements,
  fail,
  isDocumentType,
  type MultipartConfig,
  nextExpiry,
  ok,
  policyExpiry,
  type Result,
  type SourceOriginInput,
  uncappedExpiry,
  validateManifestPaths,
} from "@portifact/domain";
import { and, eq, gte, inArray, type SQL, sql } from "drizzle-orm";
import { newArtifactDefaults } from "./account-settings.ts";
import { actorOn, authorizeOn, authorizeUploadOn } from "./actors.ts";
import { moveApprovalReview } from "./approval-reviews.ts";
import { auditEvent } from "./audit.ts";
import { platformProtection } from "./budget.ts";
import { searchIndexJob } from "./content-search.ts";
import { claimNewArtifactId } from "./directory.ts";
import {
  type DocumentRendering,
  renderDocument,
  renderingStatements,
  storeRenderings,
} from "./documents.ts";
import { accountSuspension } from "./moderation.ts";
import {
  abortMultipartJob,
  abortOpened,
  assembleObject,
  type MultipartState,
  multipartStates,
  openMultipartUploads,
} from "./multipart.ts";
import { hex, objectKey } from "./objects.ts";
import { ownerEntitlements, ownerPlanRecord } from "./plans.ts";
import { markWebhookEvent } from "./webhook-activity.ts";

export { objectKey } from "./objects.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const UPLOAD_TTL_MS = 24 * HOUR_MS;
const SHA256 = /^[0-9a-f]{64}$/;
/** D1 allows at most 100 bound parameters per statement. */
const LOOKUP_CHUNK = 90;
/** Manifest kinds the client uploads; the server writes the others when it renders. */
const UPLOADED_KINDS: ("published" | "source")[] = ["published", "source"];

export interface ManifestEntry {
  path: string;
  kind: "published" | "source";
  sha256: string;
  size: number;
  contentType: string;
}

export interface PrepareInput {
  /** The signed-in user; their role on the owner decides whether they may publish. */
  userId: string;
  /**
   * The owner a new artifact is created for; the user's personal space when omitted. Ignored
   * with `artifactId`, whose owner it is.
   */
  targetOwnerId?: string | undefined;
  /** Existing artifact to update; omitted to create a new one. */
  artifactId?: string;
  type: ArtifactType;
  name: string;
  entrypoint: string;
  /** The version the client based its changes on (`null` for a new artifact). */
  baseVersionId: string | null;
  files: ManifestEntry[];
  /** Declared git origin of the source files; owner-only metadata of the version. */
  sourceOrigin?: SourceOriginInput | undefined;
  /**
   * A stable publish key (decision 0011): the owner's artifact with this key is updated (from its
   * current version), or a new one is created with it. Not with `artifactId`.
   */
  key?: string | undefined;
  now: number;
}

export interface PendingUpload {
  sha256: string;
  size: number;
  r2Key: string;
  /** Set when the object is uploaded in parts; the parts go to its staging key. */
  multipart?: MultipartState;
}

/** A client that uploads large objects in parts, and the storage that opens the uploads. */
export interface MultipartOption {
  bucket: R2Bucket;
  config?: MultipartConfig;
}

export interface PreparedUpload {
  artifactId: string;
  versionId: string;
  versionNumber: number;
  sessionId: string;
  expiresAt: number;
  /** Objects the client must upload; the rest are already stored for this account. */
  uploads: PendingUpload[];
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** Validates the manifest and normalizes its paths, separately for published files and sources. */
export function validateManifest(
  input: Pick<PrepareInput, "files" | "entrypoint">,
): Result<ManifestEntry[]> {
  if (input.files.length === 0) return fail("invalid_input", "The manifest has no files.");
  if (input.files.length > LIMITS.filesPerVersion) {
    return fail("quota_exceeded", `A version can hold at most ${LIMITS.filesPerVersion} files.`);
  }
  const normalized: ManifestEntry[] = [];
  for (const kind of ["published", "source"] as const) {
    const entries = input.files.filter((file) => file.kind === kind);
    const paths = validateManifestPaths(entries.map((file) => file.path));
    if (!paths.ok) return paths;
    entries.forEach((entry, index) => {
      normalized.push({ ...entry, path: paths.value[index] as string });
    });
  }
  for (const file of normalized) {
    if (!SHA256.test(file.sha256)) return fail("invalid_input", `${file.path}: invalid SHA-256.`);
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      return fail("invalid_input", `${file.path}: invalid size.`);
    }
    if (file.contentType.length === 0 || file.contentType.length > 255) {
      return fail("invalid_input", `${file.path}: invalid content type.`);
    }
  }
  const entrypoint = validateManifestPaths([input.entrypoint]);
  if (
    !entrypoint.ok ||
    !normalized.some((file) => file.kind === "published" && file.path === entrypoint.value[0])
  ) {
    return fail("invalid_input", "The entrypoint must be one of the published files.");
  }
  return ok(normalized);
}

/** The entrypoint's normalized path; `validateManifest` has already accepted it. */
function normalizedEntrypoint(raw: string): string {
  const result = validateManifestPaths([raw]);
  return result.ok ? (result.value[0] ?? raw) : raw;
}

/**
 * Checks a document manifest and stores its original with the document's MIME type, whatever
 * the client sent, so the download can never be served as HTML.
 */
function documentManifest(
  type: DocumentType,
  entrypoint: string,
  files: ManifestEntry[],
): Result<ManifestEntry[]> {
  const checked = checkDocumentManifest(type, entrypoint, files);
  if (!checked.ok) return checked;
  return ok(
    files.map((file) =>
      file.kind === "published" && file.path === entrypoint
        ? { ...file, contentType: DOCUMENT_CONTENT_TYPES[type] }
        : file,
    ),
  );
}

async function existingObjects(db: Db, ownerId: string, hashes: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < hashes.length; i += LOOKUP_CHUNK) {
    const chunk = hashes.slice(i, i + LOOKUP_CHUNK);
    const rows = await db
      .select({ sha256: schema.objects.sha256 })
      .from(schema.objects)
      .where(
        and(
          eq(schema.objects.ownerId, ownerId),
          inArray(schema.objects.sha256, chunk),
          // Only bytes already verified count as stored. A pending object from another open
          // upload may never arrive, so this publish gets its own upload target for it.
          eq(schema.objects.state, "verified"),
        ),
      );
    for (const row of rows) found.add(row.sha256);
  }
  return found;
}

/** Sum of an account's usage events of one kind since `since`, for the 24-hour limits. */
export async function windowSum(
  db: Db,
  ownerId: string,
  kind: "publish" | "new_files" | "new_bytes",
  since: number,
) {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${schema.usageEvents.amount}), 0)` })
    .from(schema.usageEvents)
    .where(
      and(
        eq(schema.usageEvents.ownerId, ownerId),
        eq(schema.usageEvents.kind, kind),
        gte(schema.usageEvents.at, since),
      ),
    );
  return Number(row?.total ?? 0);
}

function monthStart(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/** Validates, deduplicates and admits a publish, then reserves its capacity in one transaction. */
export async function preparePublish(
  db: RegionalDb,
  input: PrepareInput,
  multipart?: MultipartOption,
  /** Draws new artifact IDs; only tests replace it. */
  drawArtifactId?: () => string,
  /** Set on the second try of a keyed publish that lost the race to create the artifact. */
  keyRetry = false,
): Promise<Result<PreparedUpload>> {
  if (input.key !== undefined) {
    if (input.artifactId) {
      return fail("invalid_input", "Send an artifact ID or a key, not both.");
    }
    if (!PublishKey.safeParse(input.key).success) {
      return fail(
        "invalid_input",
        "A key is 1 to 128 letters, digits, dots, underscores, slashes or hyphens, starting with a letter or digit.",
      );
    }
  }
  const validated = validateManifest(input);
  if (!validated.ok) return validated;
  const entrypoint = normalizedEntrypoint(input.entrypoint);
  const manifest = isDocumentType(input.type)
    ? documentManifest(input.type, entrypoint, validated.value)
    : validated;
  if (!manifest.ok) return manifest;
  if (input.sourceOrigin) {
    const sources = manifest.value.filter((file) => file.kind === "source").length;
    const origin = checkSourceOrigin(input.sourceOrigin, sources);
    if (!origin.ok) return origin;
  }
  const name = input.name.trim();
  if (name.length === 0 || name.length > 200)
    return fail("invalid_input", "Name must be 1 to 200 characters.");
  if (await accountSuspension(db, input.userId)) {
    return fail(
      "forbidden",
      "Your account is suspended, so it cannot publish. Contact abuse@portifact.com.",
    );
  }

  let artifactId = input.artifactId;
  let versionNumber = 1;
  let actor: Actor;
  if (artifactId) {
    const [artifact] = await db
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, artifactId))
      .limit(1);
    // An artifact of an owner the user has no role on looks the same as a missing one.
    if (!artifact) return missingArtifact();
    const allowed = await authorizeOn(db, input.userId, artifact, "update", missingArtifact);
    if (!allowed.ok) return allowed;
    actor = allowed.value;
    if (artifact.type !== input.type) {
      return fail(
        "invalid_input",
        "The artifact type cannot change; publish a new artifact instead.",
      );
    }
    if (artifact.state !== "active" && artifact.state !== "draft") {
      return fail("artifact_archived", "Restore the artifact before publishing to it.");
    }
    if (artifact.currentVersionId !== input.baseVersionId) {
      return fail(
        "version_conflict",
        "The artifact changed since your last read. Fetch it and try again.",
      );
    }
    const [last] = await db
      .select({ number: sql<number>`coalesce(max(${schema.versions.number}), 0)` })
      .from(schema.versions)
      .where(eq(schema.versions.artifactId, artifactId));
    versionNumber = Number(last?.number ?? 0) + 1;
  } else {
    const resolved = await actorOn(db.global, input.userId, input.targetOwnerId ?? input.userId);
    if (!resolved.ok) return resolved;
    const allowed = authorize(resolved.value, "publish");
    if (!allowed.ok) return allowed;
    actor = allowed.value;
    const reach = checkPublishKeyReach(actor.token, input.key);
    if (!reach.ok) return reach;
    if (input.key !== undefined) {
      const keyed = await artifactByKey(db, actor.ownerId, input.key);
      // The key names an artifact already: this publish is its next version.
      if (keyed) {
        return preparePublish(
          db,
          {
            ...input,
            key: undefined,
            artifactId: keyed.id,
            baseVersionId: keyed.currentVersionId,
          },
          multipart,
          drawArtifactId,
          true,
        );
      }
    }
  }
  // Quotas, storage and the plan are the owner's: a workspace's, or the user's own.
  const ownerId = actor.ownerId;
  const createsArtifact = !artifactId;
  // Budget protection (plan section 12): the brake stops new artifacts, the first step every upload.
  const capacity = checkPublishCapacity(
    (await platformProtection(db.global, input.now)).actions,
    createsArtifact,
  );
  if (!capacity.ok) return capacity;

  const unique = new Map<string, number>();
  for (const file of manifest.value) unique.set(file.sha256, file.size);
  const stored = await existingObjects(db, ownerId, [...unique.keys()]);
  const uploads: PendingUpload[] = [...unique]
    .filter(([sha256]) => !stored.has(sha256))
    .map(([sha256, size]) => ({ sha256, size, r2Key: objectKey(ownerId, sha256) }));

  const [usageRow] = await db
    .select()
    .from(schema.accountUsage)
    .where(eq(schema.accountUsage.ownerId, ownerId))
    .limit(1);
  const since = input.now - DAY_MS;
  const sameMonth = usageRow && usageRow.monthStartedAt === monthStart(input.now);
  const newBytes = uploads.reduce((sum, upload) => sum + upload.size, 0);
  const owner = await ownerEntitlements(db.global, ownerId, input.now);
  const admission = checkPublish(
    {
      activeArtifacts: usageRow?.activeArtifacts ?? 0,
      storedBytes: (usageRow?.storedBytes ?? 0) + (usageRow?.reservedBytes ?? 0),
      publishesLast24h: await windowSum(db, ownerId, "publish", since),
      openUploads: usageRow?.openUploads ?? 0,
      newFilesLast24h: await windowSum(db, ownerId, "new_files", since),
      newBytesLast24h: await windowSum(db, ownerId, "new_bytes", since),
      newObjectsThisMonth: sameMonth ? usageRow.newObjectsThisMonth : 0,
    },
    {
      createsArtifact,
      versionBytes: manifest.value
        .filter((file) => file.kind === "published")
        .reduce((sum, file) => sum + file.size, 0),
      files: manifest.value.length,
      newBytes,
      newFiles: uploads.length,
    },
    owner.limits,
  );
  if (!admission.ok) return admission;

  // A new artifact starts with the owner's defaults (access, comments, the bar); updates keep
  // the artifact's own policy.
  const policy = createsArtifact
    ? await newArtifactDefaults(db.global, actor, input.now, owner)
    : null;
  if (!artifactId) {
    // The ID is claimed in the global directory before the regional batch (decision 0005).
    const claimed = await claimNewArtifactId(
      db.global,
      actor.region,
      input.now,
      drawArtifactId,
      actor.ownerId,
    );
    // An owner being deleted answers like one that no longer exists.
    if (claimed === "owner_deleting") return fail("not_found", "Not found.");
    if (!claimed) return fail("version_conflict", "Try again.");
    artifactId = claimed;
  }
  const versionId = newId("ver");
  const sessionId = newId("upl");
  const expiresAt = input.now + UPLOAD_TTL_MS;
  const reservation = admission.value;
  const publishedBytes = manifest.value
    .filter((file) => file.kind === "published")
    .reduce((sum, file) => sum + file.size, 0);

  const multipartRows = multipart
    ? await openMultipartUploads(multipart.bucket, {
        ownerId,
        sessionId,
        objects: uploads,
        config: multipart.config ?? DEFAULT_MULTIPART,
        now: input.now,
      })
    : [];

  try {
    await db.batch([
      db
        .insert(schema.accountUsage)
        .values({ ownerId: ownerId, monthStartedAt: monthStart(input.now) })
        .onConflictDoNothing(),
      db
        .update(schema.accountUsage)
        .set({
          // CHECK constraints reject this update if a concurrent admission took the capacity.
          activeArtifacts: sql`${schema.accountUsage.activeArtifacts} + ${reservation.activeSlots}`,
          reservedBytes: sql`${schema.accountUsage.reservedBytes} + ${reservation.bytes}`,
          openUploads: sql`${schema.accountUsage.openUploads} + 1`,
          newObjectsThisMonth: sameMonth ? sql`${schema.accountUsage.newObjectsThisMonth}` : sql`0`,
          monthStartedAt: monthStart(input.now),
          updatedAt: input.now,
        })
        .where(eq(schema.accountUsage.ownerId, ownerId)),
      ...(policy
        ? [
            db.insert(schema.artifacts).values({
              id: artifactId,
              ownerId,
              type: input.type,
              name,
              ...policy,
              externalKey: input.key ?? null,
              createdBy: input.userId,
              createdAt: input.now,
              updatedAt: input.now,
            }),
          ]
        : []),
      db.insert(schema.versions).values({
        id: versionId,
        artifactId,
        number: versionNumber,
        authorId: input.userId,
        entrypoint,
        publishedBytes,
        sourceBytes: manifest.value
          .filter((file) => file.kind === "source")
          .reduce((sum, file) => sum + file.size, 0),
        createdAt: input.now,
      }),
      db.insert(schema.versionFiles).values(
        manifest.value.map((file) => ({
          versionId,
          kind: file.kind,
          path: file.path,
          ownerId,
          sha256: file.sha256,
          size: file.size,
          contentType: file.contentType,
        })),
      ),
      ...(input.sourceOrigin
        ? [
            db.insert(schema.sourceOrigins).values({
              versionId,
              commit: input.sourceOrigin.commit,
              branch: input.sourceOrigin.branch,
              remote: input.sourceOrigin.remote,
              dirty: input.sourceOrigin.dirty,
            }),
          ]
        : []),
      ...(uploads.length > 0
        ? [
            db
              .insert(schema.objects)
              .values(
                uploads.map((upload) => ({
                  ownerId,
                  sha256: upload.sha256,
                  size: upload.size,
                  r2Key: upload.r2Key,
                  createdAt: input.now,
                })),
              )
              .onConflictDoNothing(),
          ]
        : []),
      db.insert(schema.uploadSessions).values({
        id: sessionId,
        ownerId,
        artifactId,
        versionId,
        baseVersionId: input.baseVersionId,
        reservedSlots: reservation.activeSlots,
        reservedBytes: reservation.bytes,
        reservedFiles: reservation.files,
        expiresAt,
        createdAt: input.now,
      }),
      ...(multipartRows.length > 0
        ? [db.insert(schema.multipartUploads).values(multipartRows)]
        : []),
    ]);
  } catch (error) {
    if (multipart) await abortOpened(multipart.bucket, multipartRows);
    // A concurrent first publish with the same key created the artifact: publish to it instead.
    if (input.key !== undefined && !keyRetry && causeIncludes(error, "artifacts.external_key")) {
      return preparePublish(db, input, multipart, drawArtifactId, true);
    }
    if (constraintFailed(error, "UNIQUE")) {
      return fail("version_conflict", "Another publish to this artifact started first. Try again.");
    }
    // The random ID belonged to a purged artifact (tombstoned IDs are refused by a trigger).
    if (causeIncludes(error, "artifact_id_tombstoned")) {
      return fail("version_conflict", "Try again.");
    }
    // CHECK constraints guard slots and bytes; a trigger guards the open uploads.
    if (
      constraintFailed(error, "CHECK") ||
      causeIncludes(error, "account_usage_open_uploads_limit")
    ) {
      return fail("quota_exceeded", "Your account reached a limit while preparing this publish.");
    }
    throw error;
  }

  const planned = new Map(
    multipartRows.map((row) => [
      row.sha256,
      {
        uploadId: row.uploadId,
        key: row.r2Key,
        partSize: row.partSize,
        partCount: row.partCount,
        doneParts: [],
      } satisfies MultipartState,
    ]),
  );
  return ok({
    artifactId,
    versionId,
    versionNumber,
    sessionId,
    expiresAt,
    uploads: withMultipart(uploads, planned),
  });
}

/** The owner's artifact holding a publish key: deleted and purging artifacts hold none. */
export async function artifactByKey(
  db: Db,
  ownerId: string,
  key: string,
): Promise<{ id: string; currentVersionId: string | null } | undefined> {
  const a = schema.artifacts;
  const [row] = await db
    .select({ id: a.id, currentVersionId: a.currentVersionId })
    .from(a)
    .where(
      and(
        eq(a.ownerId, ownerId),
        eq(a.externalKey, key),
        sql`${a.state} not in ('purging', 'deleted')`,
      ),
    )
    .limit(1);
  return row;
}

function withMultipart(
  uploads: PendingUpload[],
  states: Map<string, MultipartState>,
): PendingUpload[] {
  return uploads.map((upload) => {
    const state = states.get(upload.sha256);
    return state ? { ...upload, multipart: state } : upload;
  });
}

export interface CommitInput {
  /** The signed-in user; an admin or editor of the upload's owner may commit or cancel it. */
  userId: string;
  sessionId: string;
  now: number;
}

const missingUpload = () => fail<never>("not_found", "Upload not found.");
const missingArtifact = () => fail<never>("not_found", "Artifact not found.");

/**
 * Whether the user may act on an upload of `ownerId`: an upload of an owner the user has no role
 * on answers like a missing one.
 */
async function authorizeUpload(
  db: RegionalDb,
  userId: string,
  session: { ownerId: string; artifactId: string },
): Promise<Result<Actor>> {
  return authorizeUploadOn(db, userId, session, "publish", missingUpload);
}

export interface CommittedPublish {
  artifactId: string;
  versionId: string;
  versionNumber: number;
  /** Null while the artifact is pinned. */
  expiresAt: number | null;
}

/** SHA-256 of an R2 object: the checksum R2 verified at upload, or a streamed recomputation. */
async function objectSha256(object: R2ObjectBody): Promise<string> {
  const stored = object.checksums.sha256;
  if (stored) return hex(stored);
  const digest = new crypto.DigestStream("SHA-256");
  await object.body.pipeTo(digest);
  return hex(await digest.digest);
}

/**
 * Verifies the uploaded objects and makes the version current. The switch is conditional on
 * the base version, and every other write is conditioned on that switch having happened, so a
 * concurrent publish produces a clean `version_conflict` with nothing half-applied.
 */
export async function commitPublish(
  db: RegionalDb,
  bucket: R2Bucket,
  input: CommitInput,
): Promise<Result<CommittedPublish>> {
  const [session] = await db
    .select()
    .from(schema.uploadSessions)
    .where(eq(schema.uploadSessions.id, input.sessionId))
    .limit(1);
  if (!session) return missingUpload();
  const allowed = await authorizeUpload(db, input.userId, session);
  if (!allowed.ok) return allowed;
  const ownerId = session.ownerId;
  if (session.state === "committed") {
    const [version] = await db
      .select()
      .from(schema.versions)
      .where(eq(schema.versions.id, session.versionId))
      .limit(1);
    const [artifact] = await db
      .select({ expiresAt: schema.artifacts.expiresAt })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, session.artifactId))
      .limit(1);
    // Retrying a successful commit returns the same result instead of failing.
    return ok({
      artifactId: session.artifactId,
      versionId: session.versionId,
      versionNumber: version?.number ?? 0,
      expiresAt: artifact?.expiresAt ?? null,
    });
  }
  if (session.state !== "uploading" && session.state !== "ready") {
    return fail("upload_incomplete", `This upload is ${session.state}; start a new one.`);
  }
  if (input.now >= session.expiresAt)
    return fail("upload_incomplete", "This upload expired; start a new one.");

  const pending = await db
    .select({
      sha256: schema.objects.sha256,
      size: schema.objects.size,
      r2Key: schema.objects.r2Key,
    })
    .from(schema.objects)
    .innerJoin(
      schema.versionFiles,
      and(
        eq(schema.versionFiles.ownerId, schema.objects.ownerId),
        eq(schema.versionFiles.sha256, schema.objects.sha256),
      ),
    )
    .where(
      and(
        eq(schema.versionFiles.versionId, session.versionId),
        inArray(schema.versionFiles.kind, UPLOADED_KINDS),
        eq(schema.objects.ownerId, ownerId),
        eq(schema.objects.state, "pending"),
      ),
    )
    .groupBy(schema.objects.sha256);

  const problems: string[] = [];
  const multipart = await multipartStates(db, session.id);
  for (const object of pending) {
    const state = multipart.get(object.sha256);
    if (state) {
      const problem = await assembleObject(db, bucket, {
        sessionId: session.id,
        sha256: object.sha256,
        size: object.size,
        r2Key: object.r2Key,
        state,
      });
      if (problem) {
        problems.push(problem);
        continue;
      }
    }
    const body = await bucket.get(object.r2Key);
    if (!body) {
      problems.push(`${object.sha256} is missing`);
      continue;
    }
    if (body.size !== object.size) {
      await body.body.cancel();
      problems.push(`${object.sha256} has ${body.size} bytes, expected ${object.size}`);
      continue;
    }
    if ((await objectSha256(body)) !== object.sha256)
      problems.push(`${object.sha256} does not match its hash`);
  }
  if (problems.length > 0) {
    return fail("upload_incomplete", `Some files are missing or invalid: ${problems.join("; ")}.`);
  }

  const [version] = await db
    .select({
      number: schema.versions.number,
      entrypoint: schema.versions.entrypoint,
      publishedBytes: schema.versions.publishedBytes,
    })
    .from(schema.versions)
    .where(eq(schema.versions.id, session.versionId))
    .limit(1);
  // The owner's plan, so the webhook events below cost no read: with the artifact when the
  // region's database is the global one, as it always did; otherwise read from the global
  // database alongside the artifact (decision 0005), the same number of calls.
  const both = bothSides(db);
  const p = schema.ownerPlans;
  const [[artifact], plan] = both
    ? await both
        .select({
          type: schema.artifacts.type,
          name: schema.artifacts.name,
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
        .where(eq(schema.artifacts.id, session.artifactId))
        .limit(1)
        .then((rows) => [rows, rows[0]?.plan ?? null] as const)
    : await Promise.all([
        db
          .select({ type: schema.artifacts.type, name: schema.artifacts.name })
          .from(schema.artifacts)
          .where(eq(schema.artifacts.id, session.artifactId))
          .limit(1),
        ownerPlanRecord(db.global, ownerId),
      ]);
  const owner = entitlements(plan, input.now);
  const sessionOpen = sql`exists (select 1 from ${schema.uploadSessions} where ${schema.uploadSessions.id} = ${session.id} and ${schema.uploadSessions.state} in ('uploading', 'ready'))`;
  let rendering: DocumentRendering | null = null;
  if (version && artifact && isDocumentType(artifact.type)) {
    const rendered = await renderVersion(db, bucket, {
      ownerId,
      versionId: session.versionId,
      type: artifact.type,
      name: artifact.name,
      entrypoint: version.entrypoint,
      publishedBytes: version.publishedBytes,
      artifactBytes: owner.limits.artifactBytes,
      guard: sessionOpen,
      now: input.now,
    });
    if (!rendered.ok) {
      // The same bytes would fail again, so the upload cannot succeed; release it now.
      await closeUploadSession(db, { ownerId, sessionId: session.id, now: input.now }, "failed");
      return rendered;
    }
    rendering = rendered.value;
  }
  const renderedHashes = rendering?.files.map((file) => file.sha256) ?? [];
  // A workspace's maximum life (decision 0023) caps it; a publish starts a new life, so the cap
  // is computed from now with the policy that came with the actor: no read for it.
  const planExpiry = nextExpiry(new Date(input.now)).getTime();
  const expiresAt = policyExpiry(allowed.value.policy, planExpiry, input.now, input.now);
  const uncappedExpiresAt = uncappedExpiry(planExpiry, expiresAt);
  // Every write after the switch applies only if this commit performed it: the artifact now
  // points at this version and the session is still open. The session is closed last, so a
  // concurrent or repeated commit of the same session cannot apply the effects twice.
  const switched = sql`(exists (select 1 from ${schema.artifacts} where ${schema.artifacts.id} = ${session.artifactId} and ${schema.artifacts.currentVersionId} = ${session.versionId}) and ${sessionOpen})`;
  const verified = pending.map((object) => object.sha256);

  const batch = db.batch([
    db
      .update(schema.artifacts)
      .set({
        currentVersionId: session.versionId,
        state: "active",
        // A pinned artifact stays pinned through a publish: it keeps no expiry.
        expiresAt: sql`case when ${schema.artifacts.pinned} then null else ${expiresAt} end`,
        uncappedExpiresAt: sql`case when ${schema.artifacts.pinned} then null else ${uncappedExpiresAt} end`,
        archivedAt: null,
        purgeAt: null,
        lifecycleGeneration: sql`${schema.artifacts.lifecycleGeneration} + 1`,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(schema.artifacts.id, session.artifactId),
          eq(schema.artifacts.ownerId, ownerId),
          inArray(schema.artifacts.state, ["draft", "active"]),
          session.baseVersionId === null
            ? sql`${schema.artifacts.currentVersionId} is null`
            : eq(schema.artifacts.currentVersionId, session.baseVersionId),
        ),
      )
      .returning({ pinned: schema.artifacts.pinned }),
    db
      .update(schema.versions)
      .set({
        state: "committed",
        committedAt: input.now,
        rendererVersion: rendering?.rendererVersion ?? null,
      })
      .where(and(eq(schema.versions.id, session.versionId), switched)),
    ...(session.baseVersionId
      ? [
          db
            .update(schema.versions)
            // A previous version from now on, kept by the owner's plan (`retainedVersionSql`).
            .set({ supersededAt: input.now })
            .where(and(eq(schema.versions.id, session.baseVersionId), switched)),
        ]
      : []),
    ...(verified.length > 0
      ? [
          db
            .update(schema.objects)
            .set({ state: "verified" })
            .where(
              and(
                eq(schema.objects.ownerId, ownerId),
                inArray(schema.objects.sha256, verified),
                switched,
              ),
            ),
        ]
      : []),
    // Renderings are new bytes the reservation could not know about. They count once, when
    // their object becomes verified; the CHECK constraint refuses them past the account limit.
    ...(renderedHashes.length > 0
      ? [
          db
            .update(schema.accountUsage)
            .set({
              storedBytes: sql`${schema.accountUsage.storedBytes} + (select coalesce(sum(${schema.objects.size}), 0) from ${schema.objects} where ${schema.objects.ownerId} = ${ownerId} and ${inArray(schema.objects.sha256, renderedHashes)} and ${schema.objects.state} = 'pending')`,
            })
            .where(and(eq(schema.accountUsage.ownerId, ownerId), switched)),
          db
            .update(schema.objects)
            .set({ state: "verified" })
            .where(
              and(
                eq(schema.objects.ownerId, ownerId),
                inArray(schema.objects.sha256, renderedHashes),
                switched,
              ),
            ),
        ]
      : []),
    db
      .update(schema.accountUsage)
      .set({
        reservedBytes: sql`${schema.accountUsage.reservedBytes} - ${session.reservedBytes}`,
        storedBytes: sql`${schema.accountUsage.storedBytes} + ${session.reservedBytes}`,
        openUploads: sql`${schema.accountUsage.openUploads} - 1`,
        newObjectsThisMonth: sql`${schema.accountUsage.newObjectsThisMonth} + ${session.reservedFiles}`,
        updatedAt: input.now,
      })
      .where(and(eq(schema.accountUsage.ownerId, ownerId), switched)),
    db
      .insert(schema.usageEvents)
      .select(sql`select null, ${ownerId}, 'publish', 1, ${input.now} where ${switched}`),
    ...markWebhookEvent(db, {
      entitlements: owner,
      ownerId,
      artifactId: session.artifactId,
      type: "artifact.published",
      // Only an admin or editor of the owner publishes, so the publisher acts for the owner.
      actorId: input.userId,
      version: version?.number,
      now: input.now,
      condition: switched,
    }),
    db
      .insert(schema.usageEvents)
      .select(
        sql`select null, ${ownerId}, 'new_files', ${session.reservedFiles}, ${input.now} where ${switched}`,
      ),
    db
      .insert(schema.usageEvents)
      .select(
        sql`select null, ${ownerId}, 'new_bytes', ${session.reservedBytes}, ${input.now} where ${switched}`,
      ),
    db
      .insert(schema.lifecycleEvents)
      .select(
        sql`select null, ${session.artifactId}, ${input.userId}, 'system', 'published', null, ${input.now} where ${switched}`,
      ),
    auditEvent(
      db,
      {
        ownerId,
        kind: "artifact.published",
        actor: { type: "user", id: input.userId },
        targetId: session.artifactId,
        artifactId: session.artifactId,
        detail: { version: version?.number ?? 1, first: session.baseVersionId === null },
        now: input.now,
      },
      switched,
    ),
    // An open approval review follows the new version with no verdicts (decision 0013).
    moveApprovalReview(db, {
      artifactId: session.artifactId,
      versionId: session.versionId,
      switched,
      now: input.now,
    }),
    abortMultipartJob(db, session.id, switched, input.now),
    // The new version's text, for content search (decision 0012), read from R2 by a job.
    ...searchIndexJob(db, {
      entitlements: owner,
      artifactId: session.artifactId,
      versionId: session.versionId,
      condition: switched,
      now: input.now,
    }),
    db
      .update(schema.uploadSessions)
      .set({ state: "committed" })
      .where(and(eq(schema.uploadSessions.id, session.id), switched)),
  ]);
  // A CHECK failure means the renderings do not fit the account; anything else is unexpected.
  const outcome = await batch.catch((error: unknown) => {
    if (constraintFailed(error, "CHECK")) return null;
    throw error;
  });
  if (outcome === null) {
    await closeUploadSession(db, { ownerId, sessionId: session.id, now: input.now }, "failed");
    return fail("quota_exceeded", "With its rendered page, this publish exceeds your storage.");
  }
  const [switchResult] = outcome;

  if (switchResult.length === 0) {
    await closeUploadSession(db, { ownerId, sessionId: session.id, now: input.now }, "failed");
    return fail(
      "version_conflict",
      "Another publish changed this artifact first. Fetch it and try again.",
    );
  }
  return ok({
    artifactId: session.artifactId,
    versionId: session.versionId,
    versionNumber: version?.number ?? 0,
    expiresAt: switchResult[0]?.pinned ? null : expiresAt,
  });
}

interface RenderVersionInput {
  ownerId: string;
  versionId: string;
  type: DocumentType;
  name: string;
  entrypoint: string;
  publishedBytes: number;
  /** The owner's per-artifact size (their plan), which the rendering counts toward. */
  artifactBytes: number;
  guard: SQL;
  now: number;
}

/**
 * Renders the document of a version being committed and stores the rendering as pending
 * objects of that version. The commit batch verifies them and counts their bytes.
 */
async function renderVersion(
  db: Db,
  bucket: R2Bucket,
  input: RenderVersionInput,
): Promise<Result<DocumentRendering>> {
  const [source] = await db
    .select({ sha256: schema.objects.sha256, r2Key: schema.objects.r2Key })
    .from(schema.versionFiles)
    .innerJoin(
      schema.objects,
      and(
        eq(schema.objects.ownerId, schema.versionFiles.ownerId),
        eq(schema.objects.sha256, schema.versionFiles.sha256),
      ),
    )
    .where(
      and(
        eq(schema.versionFiles.versionId, input.versionId),
        eq(schema.versionFiles.kind, "published"),
        eq(schema.versionFiles.path, input.entrypoint),
      ),
    )
    .limit(1);
  if (!source) return fail("upload_incomplete", "The document's source is missing.");
  const rendered = await renderDocument(bucket, {
    type: input.type,
    name: input.name,
    sourceKey: source.r2Key,
    sourceSha256: source.sha256,
  });
  if (!rendered.ok) return rendered;
  const fits = checkRenderedVersion(input.publishedBytes, rendered.value.bytes, {
    artifactBytes: input.artifactBytes,
  });
  if (!fits.ok) return fits;
  // Rows first: the version references the objects before their bytes exist, so the orphan
  // sweep never deletes them, and a failed commit leaves them to the abandoned-version cleanup.
  const [first, ...rest] = renderingStatements(db, {
    ownerId: input.ownerId,
    versionId: input.versionId,
    entrypoint: input.entrypoint,
    files: rendered.value.files,
    state: "pending",
    guard: input.guard,
    now: input.now,
  });
  // A rendering always has its page, so there is a first statement.
  if (first) await db.batch([first, ...rest]);
  await storeRenderings(db, bucket, input.ownerId, rendered.value.files);
  return rendered;
}

/**
 * An open upload as `preparePublish` returned it, with only the objects still pending, so a
 * client can resume after its upload URLs expired.
 */
export async function uploadProgress(
  db: RegionalDb,
  input: { userId: string; sessionId: string; now: number },
): Promise<Result<PreparedUpload>> {
  const [session] = await db
    .select({
      artifactId: schema.uploadSessions.artifactId,
      versionId: schema.uploadSessions.versionId,
      state: schema.uploadSessions.state,
      expiresAt: schema.uploadSessions.expiresAt,
      ownerId: schema.uploadSessions.ownerId,
      versionNumber: schema.versions.number,
    })
    .from(schema.uploadSessions)
    .innerJoin(schema.versions, eq(schema.versions.id, schema.uploadSessions.versionId))
    .where(eq(schema.uploadSessions.id, input.sessionId))
    .limit(1);
  if (!session) return missingUpload();
  const allowed = await authorizeUpload(db, input.userId, session);
  if (!allowed.ok) return allowed;
  if (
    (session.state !== "uploading" && session.state !== "ready") ||
    input.now >= session.expiresAt
  ) {
    return fail("upload_incomplete", `This upload is no longer open; start a new one.`);
  }
  const uploads = await db
    .select({
      sha256: schema.objects.sha256,
      size: schema.objects.size,
      r2Key: schema.objects.r2Key,
    })
    .from(schema.objects)
    .innerJoin(
      schema.versionFiles,
      and(
        eq(schema.versionFiles.ownerId, schema.objects.ownerId),
        eq(schema.versionFiles.sha256, schema.objects.sha256),
      ),
    )
    .where(
      and(
        eq(schema.versionFiles.versionId, session.versionId),
        inArray(schema.versionFiles.kind, UPLOADED_KINDS),
        eq(schema.objects.ownerId, session.ownerId),
        eq(schema.objects.state, "pending"),
      ),
    )
    .groupBy(schema.objects.sha256);
  return ok({
    artifactId: session.artifactId,
    versionId: session.versionId,
    versionNumber: session.versionNumber,
    sessionId: input.sessionId,
    expiresAt: session.expiresAt,
    uploads: withMultipart(uploads, await multipartStates(db, input.sessionId)),
  });
}

/** Cancels an open upload for the user and releases its reservations. Idempotent. */
export async function abortPublish(db: RegionalDb, input: CommitInput): Promise<Result<true>> {
  const [session] = await db
    .select({
      ownerId: schema.uploadSessions.ownerId,
      artifactId: schema.uploadSessions.artifactId,
    })
    .from(schema.uploadSessions)
    .where(eq(schema.uploadSessions.id, input.sessionId))
    .limit(1);
  if (!session) return missingUpload();
  const allowed = await authorizeUpload(db, input.userId, session);
  if (!allowed.ok) return allowed;
  return closeUploadSession(
    db,
    { ownerId: session.ownerId, sessionId: input.sessionId, now: input.now },
    "aborted",
  );
}

/**
 * Closes an open upload of `ownerId` and releases its reservations, with no role check: for the
 * services' own flows (a failed commit, an expired upload). Idempotent.
 */
export async function closeUploadSession(
  db: Db,
  input: { ownerId: string; sessionId: string; now: number },
  finalState: "aborted" | "failed" | "expired",
): Promise<Result<true>> {
  const [session] = await db
    .select()
    .from(schema.uploadSessions)
    .where(eq(schema.uploadSessions.id, input.sessionId))
    .limit(1);
  if (!session || session.ownerId !== input.ownerId) return missingUpload();
  if (session.state !== "uploading" && session.state !== "ready") return ok(true);

  // The release reads the reservation from the session only while it is still open, and the
  // session is closed in the same transaction, so concurrent aborts release it exactly once.
  const open = sql`${schema.uploadSessions.id} = ${session.id} and ${schema.uploadSessions.state} in ('uploading', 'ready')`;
  await db.batch([
    db
      .update(schema.accountUsage)
      .set({
        activeArtifacts: sql`${schema.accountUsage.activeArtifacts} - coalesce((select ${schema.uploadSessions.reservedSlots} from ${schema.uploadSessions} where ${open}), 0)`,
        reservedBytes: sql`${schema.accountUsage.reservedBytes} - coalesce((select ${schema.uploadSessions.reservedBytes} from ${schema.uploadSessions} where ${open}), 0)`,
        openUploads: sql`${schema.accountUsage.openUploads} - (select count(*) from ${schema.uploadSessions} where ${open})`,
        updatedAt: input.now,
      })
      .where(eq(schema.accountUsage.ownerId, input.ownerId)),
    abortMultipartJob(
      db,
      session.id,
      sql`exists (select 1 from ${schema.uploadSessions} where ${open})`,
      input.now,
    ),
    db.update(schema.uploadSessions).set({ state: finalState }).where(open),
    // A new artifact that never got a version disappears with its only upload.
    db
      .delete(schema.artifacts)
      .where(
        and(
          eq(schema.artifacts.id, session.artifactId),
          eq(schema.artifacts.state, "draft"),
          sql`${schema.artifacts.currentVersionId} is null`,
          sql`not exists (select 1 from ${schema.uploadSessions} where ${schema.uploadSessions.artifactId} = ${session.artifactId} and ${schema.uploadSessions.state} in ('uploading', 'ready'))`,
        ),
      ),
  ]);
  return ok(true);
}

function constraintFailed(error: unknown, kind: "UNIQUE" | "CHECK"): boolean {
  return causeIncludes(error, `${kind} constraint failed`);
}

function causeIncludes(error: unknown, text: string): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (e.message.includes(text)) return true;
  }
  return false;
}
