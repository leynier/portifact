// Shapes of the publishing and artifact API (`/api/v1`, plan sections 6 and 9). The CLI, the
// dashboard and MCP send and read exactly these.
import { z } from "zod";
import {
  AccessMode,
  AnnotationsState,
  ArtifactId,
  ArtifactState,
  ArtifactType,
  CommentScope,
  CommentVisibility,
  Email,
  type ErrorCode,
} from "./core.ts";
import { LIMITS } from "./limits.ts";
import { SuspensionView } from "./moderation.ts";

export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "Invalid SHA-256");

/** One file of a version: published content or a private source. */
export const ManifestFile = z.object({
  path: z.string().min(1).max(LIMITS.pathMaxLength),
  kind: z.enum(["published", "source"]).default("published"),
  sha256: Sha256Hex,
  size: z.number().int().min(0).max(LIMITS.fileBytesCap),
  contentType: z.string().min(1).max(255),
});
export type ManifestFile = z.infer<typeof ManifestFile>;

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;

/**
 * Where a version's private sources came from in git (plan section 6, "Fuentes desde git"). The
 * client declares it and the server only checks its form; only the owner sees it, like the
 * sources. `commit` is null in a repository without commits, `branch` on a detached HEAD and
 * `remote` without one. The remote never carries credentials (see `checkSourceOrigin`).
 */
export const SourceOrigin = z.strictObject({
  commit: z
    .string()
    .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "Invalid commit")
    .nullable(),
  branch: z.string().min(1).max(255).regex(NO_CONTROL, "Invalid branch").nullable(),
  remote: z.string().min(1).max(2_048).regex(NO_CONTROL, "Invalid remote").nullable(),
  /** The sources had changes that were not committed. */
  dirty: z.boolean(),
});
export type SourceOrigin = z.infer<typeof SourceOrigin>;

/** Starts a publish: a new artifact without `artifactId`, a new version with it. */
export const PublishRequest = z.object({
  artifactId: ArtifactId.optional(),
  type: ArtifactType,
  name: z.string().trim().min(1).max(200),
  entrypoint: z.string().min(1).max(LIMITS.pathMaxLength),
  /** The version the client based its changes on; `null` for a new artifact. */
  baseVersionId: z.string().min(1).max(64).nullable().default(null),
  files: z.array(ManifestFile).min(1).max(LIMITS.filesPerVersion),
  /** Git origin of the `source` files; only with at least one of them. */
  sourceOrigin: SourceOrigin.optional(),
  /**
   * The client can upload large objects in parts (`MultipartUploadTarget`). Without it every
   * object gets one presigned PUT, as for clients older than multipart uploads.
   */
  multipart: z.boolean().optional(),
});
export type PublishRequest = z.infer<typeof PublishRequest>;

/** Where and how to upload one object the account does not store yet, in one request. */
export const SingleUploadTarget = z.object({
  sha256: Sha256Hex,
  size: z.number().int().min(0),
  method: z.literal("PUT"),
  url: z.url(),
  /** Headers the upload must send exactly as given; they are part of the signature. */
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
});
export type SingleUploadTarget = z.infer<typeof SingleUploadTarget>;

/** One part of a multipart upload still to send: bytes `[offset, offset + size)` of the file. */
export const UploadPartTarget = z.object({
  partNumber: z.number().int().min(1),
  offset: z.number().int().min(0),
  size: z.number().int().min(1),
  method: z.literal("PUT"),
  url: z.url(),
  /** Headers the part must send exactly as given; they are part of the signature. */
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
});
export type UploadPartTarget = z.infer<typeof UploadPartTarget>;

/**
 * A large object uploaded in parts. After each part, the client reports the `ETag` storage
 * answered with (`POST /publishes/:uploadId/parts`); `parts` lists only the parts not reported
 * yet, so an interrupted upload resumes where it stopped.
 */
export const MultipartUploadTarget = z.object({
  sha256: Sha256Hex,
  size: z.number().int().min(0),
  method: z.literal("MULTIPART"),
  partSize: z.number().int().min(1),
  partCount: z.number().int().min(1),
  /** Parts already reported, which the client must not send again. */
  doneParts: z.array(z.number().int().min(1)),
  parts: z.array(UploadPartTarget),
});
export type MultipartUploadTarget = z.infer<typeof MultipartUploadTarget>;

export const UploadTarget = z.discriminatedUnion("method", [
  SingleUploadTarget,
  MultipartUploadTarget,
]);
export type UploadTarget = z.infer<typeof UploadTarget>;

/** A part storage accepted, with the `ETag` header of its answer. Reporting it twice is harmless. */
export const UploadedPart = z.strictObject({
  sha256: Sha256Hex,
  partNumber: z.number().int().min(1),
  etag: z.string().min(1).max(200),
});
export type UploadedPart = z.infer<typeof UploadedPart>;

export const PreparedPublish = z.object({
  artifactId: ArtifactId,
  versionId: z.string(),
  versionNumber: z.number().int().min(1),
  uploadId: z.string(),
  /** After this the upload is abandoned and its reservation released. */
  expiresAt: z.iso.datetime(),
  uploads: z.array(UploadTarget),
});
export type PreparedPublish = z.infer<typeof PreparedPublish>;

export const CommittedPublish = z.object({
  artifactId: ArtifactId,
  versionId: z.string(),
  versionNumber: z.number().int().min(1),
  url: z.url(),
  /** When it is archived unless renewed; null while it is pinned. */
  expiresAt: z.iso.datetime().nullable(),
});
export type CommittedPublish = z.infer<typeof CommittedPublish>;

export const ArtifactSummary = z.object({
  id: ArtifactId,
  name: z.string(),
  type: ArtifactType,
  state: ArtifactState,
  accessMode: AccessMode,
  annotations: AnnotationsState,
  currentVersionId: z.string().nullable(),
  url: z.url(),
  /** When it is archived unless renewed; null while it is pinned or not active. */
  expiresAt: z.iso.datetime().nullable(),
  archivedAt: z.iso.datetime().nullable(),
  purgeAt: z.iso.datetime().nullable(),
  /** Pinned: it stays active with no expiry until unpinned (a paid plan's `pin` feature). */
  pinned: z.boolean(),
  /** Why an operator suspended it; present only while `state` is `suspended`. */
  suspension: SuspensionView.optional(),
  /**
   * The artifact's custom domain (decision 0006), present only while one is active; `url` is
   * then on it, the address people should use. The `.dev` address keeps working.
   */
  customHost: z.string().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ArtifactSummary = z.infer<typeof ArtifactSummary>;

/**
 * Consumption and activity of an artifact in the list. Traffic is counted per account, not per
 * artifact, so it is in the account usage (`GET /api/v1/usage`), not here.
 */
export const ArtifactActivity = z.object({
  /** Committed versions that can still be read, the current one included. */
  versions: z.int().min(0),
  /** Bytes of the current version, published files and sources; `null` without one. */
  currentBytes: z.int().min(0).nullable(),
  /** Open threads on the current version. */
  openThreads: z.int().min(0),
  /** When a thread on any version last changed: a comment, reply, resolution or moderation. */
  lastAnnotationAt: z.iso.datetime().nullable(),
});
export type ArtifactActivity = z.infer<typeof ArtifactActivity>;

/** An artifact in the list: its summary and its activity. */
export const ArtifactListItem = ArtifactSummary.extend({ activity: ArtifactActivity });
export type ArtifactListItem = z.infer<typeof ArtifactListItem>;

export const ArtifactList = z.object({
  items: z.array(ArtifactListItem),
  /** Pass as `cursor` to get the next page; `null` on the last page. */
  nextCursor: z.string().nullable(),
});
export type ArtifactList = z.infer<typeof ArtifactList>;

export const ListQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** States the artifact list can show: drafts and deleted artifacts are never listed. */
export const ListedArtifactState = z.enum(["active", "archived", "suspended", "purging"]);
export type ListedArtifactState = z.infer<typeof ListedArtifactState>;

/** Longest text the artifact list searches for, as long as the longest name. */
export const LIST_SEARCH_MAX = 200;

/**
 * Narrows the artifact list. `search` matches a part of the name (letters A to Z in any case)
 * or of the ID; every filter given must hold. A cursor continues only the same filters.
 */
export const ArtifactListFilters = z.object({
  search: z.string().trim().min(1).max(LIST_SEARCH_MAX).optional(),
  state: ListedArtifactState.optional(),
  type: ArtifactType.optional(),
  access: AccessMode.optional(),
  annotations: AnnotationsState.optional(),
});
export type ArtifactListFilters = z.infer<typeof ArtifactListFilters>;

/** Query of `GET /api/v1/artifacts`: a page and the filters. */
export const ArtifactListQuery = ListQuery.extend(ArtifactListFilters.shape);
export type ArtifactListQuery = z.infer<typeof ArtifactListQuery>;

export const LifecycleResult = z.object({
  state: z.enum(["active", "archived", "deleted"]),
  expiresAt: z.iso.datetime().nullable(),
  purgeAt: z.iso.datetime().nullable(),
  pinned: z.boolean(),
});
export type LifecycleResult = z.infer<typeof LifecycleResult>;

/** Who can open an artifact, as its owner sees it. */
export const AccessPolicyView = z.object({
  mode: AccessMode,
  /** Lowercased addresses that may read a `restricted` artifact. */
  readers: z.array(z.string()),
  indexable: z.boolean(),
  embeddable: z.boolean(),
  /**
   * The Portifact bar: top-level visits to the artifact's pages open in the viewer on
   * app.portifact.com, with the bar and the comments sidebar. Off, they get the artifact itself.
   */
  bar: z.boolean(),
  /** Who sees the comment threads; the owner always sees all of them. */
  commentVisibility: CommentVisibility,
  /**
   * Readers with an exception to `commentVisibility`, by address: `all` threads or only their
   * `own` and the owner's. Readers not listed here follow `commentVisibility`.
   */
  readerCommentVisibility: z.array(
    z.object({ email: z.string(), commentVisibility: CommentScope }),
  ),
  /** Increases on every change; read sessions issued before it stop working. */
  policyGeneration: z.number().int().min(1),
});
export type AccessPolicyView = z.infer<typeof AccessPolicyView>;

/** A reader's exception to who sees comments, or `inherit` to drop it. */
export const ReaderCommentVisibility = z.enum([...CommentScope.options, "inherit"]);
export type ReaderCommentVisibility = z.infer<typeof ReaderCommentVisibility>;

/** A change to the access policy. Applying the same change twice leaves the same policy. */
export const AccessUpdate = z
  .object({
    mode: AccessMode.optional(),
    indexable: z.boolean().optional(),
    embeddable: z.boolean().optional(),
    bar: z.boolean().optional(),
    addReaders: z.array(Email).max(LIMITS.readersPerChange).optional(),
    removeReaders: z.array(Email).max(LIMITS.readersPerChange).optional(),
    commentVisibility: CommentVisibility.optional(),
    /**
     * Exceptions for readers on the list (added in the same change or before): `all`, `own`,
     * or `inherit` to follow `commentVisibility` again. One entry per address.
     */
    readerCommentVisibility: z
      .array(z.object({ email: Email, commentVisibility: ReaderCommentVisibility }))
      .max(LIMITS.readersPerChange)
      .optional(),
  })
  .refine((update) => Object.values(update).some((value) => value !== undefined), {
    message: "Send at least one change.",
  })
  .refine(
    (update) => {
      const emails = (update.readerCommentVisibility ?? []).map((entry) => entry.email);
      return new Set(emails).size === emails.length;
    },
    { message: "Send one comment visibility per reader.", path: ["readerCommentVisibility"] },
  );
export type AccessUpdate = z.infer<typeof AccessUpdate>;

/** `Idempotency-Key` header of retryable mutations. */
export const IdempotencyKey = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,128}$/, "Invalid idempotency key");

/** HTTP status of each error code, the same for every route. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  invalid_input: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  version_conflict: 409,
  upload_incomplete: 409,
  artifact_archived: 409,
  account_too_new_for_public: 403,
  quota_exceeded: 429,
  traffic_exceeded: 429,
  rate_limited: 429,
  reauthentication_required: 403,
  human_verification_required: 403,
  capacity_unavailable: 503,
  sole_workspace_admin: 409,
  plan_required: 403,
};
