// Shapes of the publishing and artifact API (`/api/v1`, plan sections 6 and 9). The CLI, the
// dashboard and MCP send and read exactly these.
import { z } from "zod";
import {
  AccessMode,
  AnnotationsState,
  ArtifactId,
  ArtifactState,
  ArtifactType,
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
  size: z.number().int().min(0).max(LIMITS.artifactBytes),
  contentType: z.string().min(1).max(255),
});
export type ManifestFile = z.infer<typeof ManifestFile>;

/** Starts a publish: a new artifact without `artifactId`, a new version with it. */
export const PublishRequest = z.object({
  artifactId: ArtifactId.optional(),
  type: ArtifactType,
  name: z.string().trim().min(1).max(200),
  entrypoint: z.string().min(1).max(LIMITS.pathMaxLength),
  /** The version the client based its changes on; `null` for a new artifact. */
  baseVersionId: z.string().min(1).max(64).nullable().default(null),
  files: z.array(ManifestFile).min(1).max(LIMITS.filesPerVersion),
});
export type PublishRequest = z.infer<typeof PublishRequest>;

/** Where and how to upload one object the account does not store yet. */
export const UploadTarget = z.object({
  sha256: Sha256Hex,
  size: z.number().int().min(0),
  method: z.literal("PUT"),
  url: z.url(),
  /** Headers the upload must send exactly as given; they are part of the signature. */
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
});
export type UploadTarget = z.infer<typeof UploadTarget>;

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
  expiresAt: z.iso.datetime(),
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
  expiresAt: z.iso.datetime().nullable(),
  archivedAt: z.iso.datetime().nullable(),
  purgeAt: z.iso.datetime().nullable(),
  /** Why an operator suspended it; present only while `state` is `suspended`. */
  suspension: SuspensionView.optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ArtifactSummary = z.infer<typeof ArtifactSummary>;

export const ArtifactList = z.object({
  items: z.array(ArtifactSummary),
  /** Pass as `cursor` to get the next page; `null` on the last page. */
  nextCursor: z.string().nullable(),
});
export type ArtifactList = z.infer<typeof ArtifactList>;

export const ListQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const LifecycleResult = z.object({
  state: z.enum(["active", "archived", "deleted"]),
  expiresAt: z.iso.datetime().nullable(),
  purgeAt: z.iso.datetime().nullable(),
});
export type LifecycleResult = z.infer<typeof LifecycleResult>;

/** Who can open an artifact, as its owner sees it. */
export const AccessPolicyView = z.object({
  mode: AccessMode,
  /** Lowercased addresses that may read a `restricted` artifact. */
  readers: z.array(z.string()),
  indexable: z.boolean(),
  embeddable: z.boolean(),
  /** Increases on every change; read sessions issued before it stop working. */
  policyGeneration: z.number().int().min(1),
});
export type AccessPolicyView = z.infer<typeof AccessPolicyView>;

/** A change to the access policy. Applying the same change twice leaves the same policy. */
export const AccessUpdate = z
  .object({
    mode: AccessMode.optional(),
    indexable: z.boolean().optional(),
    embeddable: z.boolean().optional(),
    addReaders: z.array(Email).max(LIMITS.readersPerChange).optional(),
    removeReaders: z.array(Email).max(LIMITS.readersPerChange).optional(),
  })
  .refine((update) => Object.values(update).some((value) => value !== undefined), {
    message: "Send at least one change.",
  });
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
  capacity_unavailable: 503,
};
