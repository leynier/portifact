// Shapes of the version history API (`/api/v1/artifacts/:id/versions`, plan sections 5, 6 and 9):
// list the retained versions, read a version's manifest, download its published files or its
// private sources through short-lived links, and roll back to a retained version.
import { z } from "zod";
import { ArtifactId } from "./core.ts";
import { CommittedPublish, IdempotencyKey, Sha256Hex, SourceOrigin } from "./publishing.ts";

/** A version ID as the API returns it, or `current` for the artifact's current version. */
export const VersionRef = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "Invalid version id");
export type VersionRef = z.infer<typeof VersionRef>;

/** The alias every version route accepts for the artifact's current version. */
export const CURRENT_VERSION = "current";

export const VersionSummary = z.object({
  id: z.string(),
  number: z.number().int().min(1),
  /** The version visitors see now. */
  current: z.boolean(),
  entrypoint: z.string(),
  publishedBytes: z.number().int().min(0),
  sourceBytes: z.number().int().min(0),
  publishedFiles: z.number().int().min(0),
  sourceFiles: z.number().int().min(0),
  rendererVersion: z.string().nullable(),
  committedAt: z.iso.datetime(),
  /** When a previous version stops being retained; `null` for the current version. */
  expiresAt: z.iso.datetime().nullable(),
  /** Git origin of the sources, when the publisher declared one. Only the owner reads versions. */
  sourceOrigin: SourceOrigin.nullable().default(null),
});
export type VersionSummary = z.infer<typeof VersionSummary>;

export const VersionList = z.object({
  artifactId: ArtifactId,
  items: z.array(VersionSummary),
  /** Pass as `cursor` to get older versions; `null` on the last page. */
  nextCursor: z.string().nullable(),
});
export type VersionList = z.infer<typeof VersionList>;

export const DownloadKind = z.enum(["published", "source"]);
export type DownloadKind = z.infer<typeof DownloadKind>;

export const VersionFile = z.object({
  path: z.string(),
  kind: DownloadKind,
  sha256: Sha256Hex,
  size: z.number().int().min(0),
  contentType: z.string(),
});
export type VersionFile = z.infer<typeof VersionFile>;

/** A version and every file in it, published and source. Only the owner reads it. */
export const VersionManifest = VersionSummary.extend({
  artifactId: ArtifactId,
  files: z.array(VersionFile),
});
export type VersionManifest = z.infer<typeof VersionManifest>;

export const DownloadQuery = z.object({
  kind: DownloadKind.default("published"),
  /** Only this file; omitted for every file of the kind. */
  path: z.string().min(1).max(1_024).optional(),
});
export type DownloadQuery = z.infer<typeof DownloadQuery>;

/** One file and the short-lived link that downloads its exact bytes. */
export const DownloadLink = VersionFile.omit({ kind: true }).extend({
  method: z.literal("GET"),
  url: z.url(),
  expiresAt: z.iso.datetime(),
});
export type DownloadLink = z.infer<typeof DownloadLink>;

export const VersionDownload = z.object({
  artifactId: ArtifactId,
  versionId: z.string(),
  versionNumber: z.number().int().min(1),
  kind: DownloadKind,
  entrypoint: z.string(),
  files: z.array(DownloadLink),
});
export type VersionDownload = z.infer<typeof VersionDownload>;

/** Makes a retained version current again, as a new version with the same files. */
export const RollbackRequest = z.object({
  versionId: VersionRef,
  /** The current version the client read; the rollback fails with a conflict if it changed. */
  baseVersionId: VersionRef,
});
export type RollbackRequest = z.infer<typeof RollbackRequest>;

export const RolledBack = CommittedPublish.extend({
  /** The retained version whose files the new version has. */
  fromVersionId: z.string(),
  fromVersionNumber: z.number().int().min(1),
});
export type RolledBack = z.infer<typeof RolledBack>;

// MCP tool inputs. Outputs are the API shapes above.

const artifactId = ArtifactId.describe(
  "The artifact ID, as list_artifacts or get_artifact return it.",
);

export const ListVersionsInput = z.object({
  artifactId,
  cursor: z
    .string()
    .max(200)
    .optional()
    .describe("The nextCursor of the previous page. Omit it for the first page."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .describe("How many versions to return, 1 to 100."),
});
export type ListVersionsInput = z.infer<typeof ListVersionsInput>;

const versionRef = VersionRef.describe(
  `A version ID from list_versions, or "${CURRENT_VERSION}" for the version visitors see now.`,
);

export const GetVersionInput = z.object({ artifactId, versionId: versionRef });
export type GetVersionInput = z.infer<typeof GetVersionInput>;

export const GetDownloadInput = z.object({
  artifactId,
  versionId: versionRef.default(CURRENT_VERSION),
  kind: DownloadKind.default("published").describe(
    "published for the files the artifact serves, source for its private sources (owner only).",
  ),
  path: z
    .string()
    .min(1)
    .max(1_024)
    .optional()
    .describe("Only this file, as the manifest names it. Omit it for every file of the kind."),
});
export type GetDownloadInput = z.infer<typeof GetDownloadInput>;

export const RollbackArtifactInput = z.object({
  artifactId,
  versionId: VersionRef.describe("The retained version to make current again, from list_versions."),
  baseVersionId: VersionRef.describe(
    "The currentVersionId you last read from get_artifact or list_versions. If another version was published since, the call fails with version_conflict.",
  ),
  idempotencyKey: IdempotencyKey.optional().describe(
    "A unique string (8 to 128 letters, digits, '.', '_', ':' or '-') for this rollback. Retrying with the same key and arguments returns the first result instead of failing with version_conflict.",
  ),
});
export type RollbackArtifactInput = z.infer<typeof RollbackArtifactInput>;
