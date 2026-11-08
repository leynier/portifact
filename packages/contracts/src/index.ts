// Shared input and output shapes for the API, MCP tools, CLI and dashboard.
// Every boundary validates with these schemas; see AGENTS.md "Architecture rules".
import { z } from "zod";

/** Artifact IDs: 10 lowercase base32 characters, used as the `<id>.portifact.dev` hostname label. */
export const ARTIFACT_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
export const ArtifactId = z.string().regex(/^[a-z2-7]{10}$/, "Invalid artifact id");
export type ArtifactId = z.infer<typeof ArtifactId>;

export const ArtifactType = z.enum(["site", "markdown", "text"]);
export type ArtifactType = z.infer<typeof ArtifactType>;

export const AccessMode = z.enum(["public", "authenticated", "restricted"]);
export type AccessMode = z.infer<typeof AccessMode>;

export const AnnotationsState = z.enum(["off", "open", "locked"]);
export type AnnotationsState = z.infer<typeof AnnotationsState>;

export const ArtifactState = z.enum([
  "draft",
  "active",
  "archived",
  "suspended",
  "purging",
  "deleted",
]);
export type ArtifactState = z.infer<typeof ArtifactState>;

export const Email = z
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());

/** Product limits from the plan (section 2). Sizes are decimal: 1 MB = 1,000,000 bytes. */
export const LIMITS = {
  activeArtifacts: 50,
  artifactBytes: 250_000_000,
  accountBytes: 2_500_000_000,
  publishesPer24h: 100,
  filesPerVersion: 1_000,
  documentBytes: 5_000_000,
  inlineMcpBytes: 256 * 1024,
  concurrentUploads: 2,
  newFilesPer24h: 10_000,
  newBytesPer24h: 5_000_000_000,
  newObjectsPerMonth: 100_000,
  retainedPreviousVersions: 2,
  previousVersionRetentionDays: 7,
  activeDays: 30,
  archiveMonths: 6,
  publicAccessMinAccountAgeDays: 7,
  pathMaxLength: 1_024,
} as const;

/** Error codes shared by every interface. Adapters map them to HTTP statuses and messages. */
export const ErrorCode = z.enum([
  "invalid_input",
  "unauthenticated",
  "forbidden",
  "not_found",
  "version_conflict",
  "quota_exceeded",
  "traffic_exceeded",
  "upload_incomplete",
  "artifact_archived",
  "account_too_new_for_public",
  "capacity_unavailable",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiError = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;
