// Shapes of an artifact's analytics (premium plan P8, decision 0007): page views per UTC day and,
// for `restricted` artifacts, distinct signed-in visitors from the access log. One body for
// `GET /api/v1/artifacts/:id/stats`, the MCP tool get_artifact_stats, `portifact stats` and the
// dashboard's Analytics section.
import { z } from "zod";
import { ArtifactId } from "./core.ts";

export const ANALYTICS = {
  /** Days a read returns when it names no range: the last 30, today included. */
  defaultDays: 30,
  /** The longest range one read returns, a safety cap (a year and a leap day). */
  maxRangeDays: 366,
} as const;

/** A UTC calendar day, `YYYY-MM-DD`. */
export const StatsDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const at = Date.parse(`${value}T00:00:00Z`);
    return !Number.isNaN(at) && new Date(at).toISOString().startsWith(value);
  }, "Not a calendar date.");

/** Query of the API route; both days are optional and inclusive. */
export const ArtifactStatsQuery = z.object({
  from: StatsDate.optional(),
  to: StatsDate.optional(),
});
export type ArtifactStatsQuery = z.infer<typeof ArtifactStatsQuery>;

const count = z.number().int().min(0);

export const ArtifactStatsDay = z.object({
  date: StatsDate,
  views: count,
  /** Views that came with a signed-in visitor; a count, it names nobody. */
  signedInViews: count,
  /** Distinct signed-in visitors that day from the access log; null when the artifact keeps none. */
  visitors: count.nullable(),
});
export type ArtifactStatsDay = z.infer<typeof ArtifactStatsDay>;

export const ArtifactStatsView = z.object({
  artifactId: ArtifactId,
  from: StatsDate,
  to: StatsDate,
  /** Every day of the range, oldest first, days without views included as zeros. */
  days: z.array(ArtifactStatsDay),
  totals: z.object({
    views: count,
    signedInViews: count,
    /** Distinct signed-in visitors over the whole range; null when the artifact keeps no log. */
    visitors: count.nullable(),
  }),
  /** How many days the owner's plan keeps, counted back from today. */
  retentionDays: z.number().int().positive(),
});
export type ArtifactStatsView = z.infer<typeof ArtifactStatsView>;

/** Input of the MCP tool get_artifact_stats; the acting user comes from the token. */
export const GetArtifactStatsInput = z.object({
  artifactId: ArtifactId.describe("The artifact ID, as list_artifacts or get_artifact return it."),
  from: StatsDate.optional().describe(
    "First UTC day, YYYY-MM-DD. Omit both days for the last 30 days.",
  ),
  to: StatsDate.optional().describe("Last UTC day, YYYY-MM-DD, at most today. Omit it for today."),
});
export type GetArtifactStatsInput = z.infer<typeof GetArtifactStatsInput>;
