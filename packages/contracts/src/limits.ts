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

/**
 * Traffic each account may serve per calendar month (UTC), across all of its artifacts (plan
 * section 2). Requests count every authorized request a content Worker answers for one of its
 * artifacts, including 304s and 404s inside it; bytes count the bodies it sends. When either is
 * used up, that account's artifacts answer 429 `traffic_exceeded` until the next month.
 */
export const TRAFFIC_LIMITS = {
  requestsPerMonth: 1_000_000,
  bytesPerMonth: 25_000_000_000,
} as const;

/**
 * Annotation limits (plan section 2). Bodies count Unicode code points and UTF-8 bytes.
 * `messagesPerThread`, `artifactWritesPer24h` and the page size are safety caps, not product
 * tiers.
 */
export const ANNOTATION_LIMITS = {
  bodyMaxCodePoints: 4_000,
  bodyMaxBytes: 8 * 1024,
  /** Whole JSON body of a request that creates a thread or a message. */
  createPayloadMaxBytes: 16 * 1024,
  threadsPerArtifact: 1_000,
  messagesPerThread: 200,
  /** Per artifact owner, across all of their artifacts. Deleted messages do not count. */
  messagesPerOwner: 5_000,
  /** Message bodies plus thread targets, per artifact owner. */
  bytesPerOwner: 50_000_000,
  /** New messages and edits per author. */
  writesPerMinute: 5,
  writesPer24h: 100,
  /** New messages and edits on one artifact, from all authors together. */
  artifactWritesPer24h: 1_000,
  pageDefault: 25,
  pageMax: 50,
  /**
   * An account's first comments (threads and replies) on artifacts it does not own need a solved
   * human check (plan section 13), so they can only be posted from the review viewer.
   */
  humanCheckedComments: 3,
} as const;
