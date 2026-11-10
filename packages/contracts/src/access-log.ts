// Shapes of the owner's access log (`GET /api/v1/artifacts/:id/access-log`, the MCP tool
// get_access_logs and `portifact logs`, plan sections 6, 11 and 13): the signed-in visitors who
// opened an artifact, one entry per visitor and 30-minute window, kept 30 days.
import { z } from "zod";
import { ArtifactId } from "./core.ts";
import { ACCESS_LOG } from "./limits.ts";

const cursor = z.string().max(200);
const limit = z.number().int().min(1).max(ACCESS_LOG.pageSize);

/** Query of the API route; `since` is an ISO date, so only later openings are listed. */
export const AccessLogQuery = z.object({
  cursor: cursor.optional(),
  limit: z.coerce.number().pipe(limit).default(50),
  since: z.iso.datetime().optional(),
});
export type AccessLogQuery = z.infer<typeof AccessLogQuery>;

export const AccessLogEntry = z.object({
  /**
   * The visitor's verified email when the opening was recorded; empty for an opening through a
   * share link, which names no one.
   */
  email: z.string(),
  /** The share link the opening went through (its label as the owner gave it), if any. */
  shareLink: z.object({ id: z.string(), label: z.string().nullable() }).optional(),
  /** The first opening in the window, as far as the log knows it. */
  openedAt: z.iso.datetime(),
});
export type AccessLogEntry = z.infer<typeof AccessLogEntry>;

export const AccessLogView = z.object({
  artifactId: ArtifactId,
  /** Newest first. */
  entries: z.array(AccessLogEntry),
  nextCursor: z.string().nullable(),
  windowMinutes: z.number().int().positive(),
  retentionDays: z.number().int().positive(),
});
export type AccessLogView = z.infer<typeof AccessLogView>;

/** Input of the MCP tool get_access_logs; the owner comes from the token. */
export const GetAccessLogsInput = z.object({
  artifactId: ArtifactId.describe("The artifact ID, as list_artifacts or get_artifact return it."),
  since: z.iso
    .datetime()
    .optional()
    .describe("Only openings at or after this ISO 8601 date and time. Omit it for all 30 days."),
  cursor: cursor
    .optional()
    .describe("The nextCursor of the previous page. Omit it for the first page."),
  limit: limit.default(50).describe(`How many entries to return, 1 to ${ACCESS_LOG.pageSize}.`),
});
export type GetAccessLogsInput = z.infer<typeof GetAccessLogsInput>;
