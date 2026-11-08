// Shape of the account usage API (`GET /api/v1/usage`, plan section 6, "Uso"): the quotas of
// section 12 with the account's current counters, the 24-hour windows and what blocks it now.
// The MCP tool get_usage returns the same body.
import { z } from "zod";

const count = z.number().int().min(0);

/** One quota: how much is used and how much the account may use. */
export const UsageMeter = z.object({ used: count, limit: count });
export type UsageMeter = z.infer<typeof UsageMeter>;

/**
 * Why the account cannot do something right now. `traffic` means its artifacts answer 429 until
 * the next month. `capacity` is the service's budget protection (plan section 12), the same for
 * every account. Clients should show any reason they do not know with its message.
 */
export const UsageBlockReason = z.enum([
  "active_artifacts",
  "storage",
  "publishes_per_24h",
  "open_uploads",
  "new_files_per_24h",
  "new_bytes_per_24h",
  "new_objects_per_month",
  "account_too_new_for_public",
  "traffic",
  "capacity",
]);
export type UsageBlockReason = z.infer<typeof UsageBlockReason>;

/** What a block stops: creating artifacts, publishing at all, making one public or serving. */
export const UsageBlockEffect = z.enum(["new_artifacts", "publishing", "public_access", "serving"]);
export type UsageBlockEffect = z.infer<typeof UsageBlockEffect>;

export const UsageBlock = z.object({
  reason: UsageBlockReason,
  stops: UsageBlockEffect,
  message: z.string(),
  /** When the block lifts by itself; `null` when it lasts until the account frees capacity. */
  until: z.iso.datetime().nullable(),
});
export type UsageBlock = z.infer<typeof UsageBlock>;

export const AccountUsageView = z.object({
  activeArtifacts: UsageMeter,
  /** Bytes of the unique objects the account keeps, plus `reserved` by uploads in progress. */
  storage: UsageMeter.extend({ reserved: count }),
  /** Commits and rollbacks in the last 24 hours (rolling). */
  publishesLast24h: UsageMeter,
  /** New files and bytes uploaded in the last 24 hours (rolling), after deduplication. */
  newFilesLast24h: UsageMeter,
  newBytesLast24h: UsageMeter,
  /** New stored objects this calendar month (UTC), reset at `resetsAt`. */
  newObjectsThisMonth: UsageMeter.extend({ resetsAt: z.iso.datetime() }),
  openUploads: UsageMeter,
  /**
   * Requests and bytes the account's artifacts served this calendar month (UTC), reset at
   * `resetsAt`. Counted in batches, so they may lag a few seconds behind.
   */
  trafficThisMonth: z.object({
    requests: UsageMeter,
    bytes: UsageMeter,
    resetsAt: z.iso.datetime(),
  }),
  /** Per-version limits, the same for every artifact. */
  versionLimits: z.object({
    publishedBytes: count,
    files: count,
    documentBytes: count,
  }),
  /** From when the account may make artifacts public. */
  publicAccessFrom: z.iso.datetime(),
  /** Everything that stops the account now; empty when nothing does. */
  blocks: z.array(UsageBlock),
});
export type AccountUsageView = z.infer<typeof AccountUsageView>;

/** Input of the MCP tool get_usage: none; the account comes from the token. */
export const GetUsageInput = z.object({});
export type GetUsageInput = z.infer<typeof GetUsageInput>;
