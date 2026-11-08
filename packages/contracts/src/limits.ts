// Kept apart from core.ts so other contract modules can import it without a cycle.
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
  /** Bounds the reader list of a restricted artifact; not a product tier, a safety cap. */
  readersPerArtifact: 500,
  readersPerChange: 100,
} as const;
