// `portifact export`: what a space's export folder holds (decision 0022, second delivery). The
// CLI writes `manifest.json` last, from what it verified on disk, so a reader of the folder (or a
// later run that resumes it) knows exactly what is there and what was left out, and why.
import { z } from "zod";
import { ArtifactId } from "./core.ts";
import { DownloadKind } from "./versions.ts";

/** The version of the manifest's shape; a change that a reader must notice raises it. */
export const EXPORT_MANIFEST_FORMAT = 1;

/** The manifest's file name, at the root of the export folder. */
export const EXPORT_MANIFEST_FILE = "manifest.json";

/**
 * Why something a space holds is not in the export: the caller may not read it (`forbidden`,
 * `plan_required`), it is gone (`not_found`: deleted or being purged while the export ran), or
 * the server asked to wait (`rate_limited`: a later run completes it, so the export exits 1).
 */
export const ExportSkipReason = z.enum(["forbidden", "plan_required", "not_found", "rate_limited"]);
export type ExportSkipReason = z.infer<typeof ExportSkipReason>;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const ExportedFile = z.strictObject({
  kind: DownloadKind,
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256,
});
export type ExportedFile = z.infer<typeof ExportedFile>;

export const ExportedVersion = z.strictObject({
  id: z.string().min(1),
  number: z.number().int().min(1),
  current: z.boolean(),
  /** Relative to the export folder, `/`-separated. */
  folder: z.string().min(1),
  files: z.array(ExportedFile),
});
export type ExportedVersion = z.infer<typeof ExportedVersion>;

/** A JSON Lines file of the export, or why it is not there. */
export const ExportedLog = z.union([
  z.strictObject({ file: z.string().min(1), lines: z.number().int().nonnegative() }),
  z.strictObject({ skipped: ExportSkipReason }),
]);
export type ExportedLog = z.infer<typeof ExportedLog>;

export const ExportManifest = z.strictObject({
  format: z.literal(EXPORT_MANIFEST_FORMAT),
  /** The workspace's slug, or `personal`. */
  space: z.string().min(1),
  /** The owner's opaque ID, the same the folder's marker holds. */
  ownerId: z.string().min(1).max(200),
  exportedAt: z.iso.datetime(),
  artifacts: z.array(
    z.strictObject({
      id: ArtifactId,
      name: z.string(),
      versions: z.array(ExportedVersion),
      accessLog: ExportedLog,
      /** Set when the artifact (or the rest of its versions) could not be exported, and why. */
      skipped: ExportSkipReason.optional(),
    }),
  ),
  audit: ExportedLog,
  totals: z.strictObject({
    artifacts: z.number().int().nonnegative(),
    versions: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  }),
});
export type ExportManifest = z.infer<typeof ExportManifest>;
