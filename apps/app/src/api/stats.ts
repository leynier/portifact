// GET /api/v1/artifacts/:id/stats (premium plan P8, decision 0007): page views per UTC day and,
// for `restricted` artifacts, distinct signed-in visitors, for the owner side on a plan with
// analytics. The MCP tool get_artifact_stats and `portifact stats` return the same body.
import { ArtifactStatsQuery, ArtifactStatsView } from "@portifact/contracts";
import { type ArtifactStats, getArtifactStats } from "@portifact/services";
import type { Hono } from "hono";
import type { Env } from "../env.ts";
import { accessDbOf, artifactRegion } from "../regions.ts";
import { error, type Guarded } from "./http.ts";

export function statsView(stats: ArtifactStats): ArtifactStatsView {
  return ArtifactStatsView.parse(stats);
}

export function statsRoutes(api: Hono<{ Bindings: Env }>, guarded: Guarded, now: () => number) {
  api.get(
    "/api/v1/artifacts/:artifactId/stats",
    guarded("artifacts:read", async (c, userId) => {
      const query = ArtifactStatsQuery.safeParse({
        from: c.req.query("from"),
        to: c.req.query("to"),
      });
      if (!query.success) return error(c, "invalid_input", "Invalid from or to: use YYYY-MM-DD.");
      const artifactId = c.req.param("artifactId") as string;
      const region = await artifactRegion(c.env, artifactId);
      const result = await getArtifactStats(region.db, accessDbOf(region), {
        userId,
        artifactId,
        from: query.data.from,
        to: query.data.to,
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(statsView(result.value));
    }),
  );
}
