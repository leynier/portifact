// MCP tool for an artifact's analytics (premium plan P8): get_artifact_stats. It calls the same
// service as GET /api/v1/artifacts/:id/stats and returns the same body with the same scope.
import { ArtifactStatsView, GetArtifactStatsInput, type OAuthScope } from "@portifact/contracts";
import { getArtifactStats } from "@portifact/services";
import { statsView } from "../api/stats.ts";
import { accessDbOf, artifactRegion } from "../regions.ts";
import { failure, type RegisterTool, success, type ToolContext } from "./tools.ts";

export const STATS_TOOL_SCOPES: [string, OAuthScope][] = [["get_artifact_stats", "artifacts:read"]];

export function registerStatsTools(register: RegisterTool, context: ToolContext): void {
  register(
    "get_artifact_stats",
    {
      title: "Get an artifact's analytics",
      description:
        "Get page views per UTC day of one of the user's artifacts, how many came with a signed-in visitor and, only for artifacts restricted to listed readers, how many distinct signed-in readers opened it (null otherwise). Counts only: anonymous visitors are never identified. One visit is one view; subresources, link previews and the owner's own signed-in visits are not counted, but automated browsers can be, so the numbers are an indicator, not an audit. Defaults to the last 30 days; at most 366 days, never before what the owner's plan keeps (retentionDays). Only an admin or editor of the artifact's owner can read it, and the owner's plan must include analytics (plan_required otherwise); anyone else gets not_found.",
      inputSchema: GetArtifactStatsInput,
      outputSchema: ArtifactStatsView,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ artifactId, from, to }) => {
      const region = await artifactRegion(context.env, artifactId);
      const result = await getArtifactStats(region.db, accessDbOf(region), {
        userId: context.userId,
        artifactId,
        from,
        to,
        now: context.now(),
      });
      if (!result.ok) return failure(result.code, result.message);
      const body = statsView(result.value);
      const visitors =
        body.totals.visitors === null
          ? ""
          : `, ${body.totals.visitors} distinct signed-in visitors`;
      const lines = [
        `${artifactId} from ${body.from} to ${body.to}: ${body.totals.views} views, ${body.totals.signedInViews} signed in${visitors}.`,
        ...body.days
          .filter((day) => day.views > 0 || (day.visitors ?? 0) > 0)
          .map(
            (day) =>
              `${day.date} ${day.views} views, ${day.signedInViews} signed in${day.visitors === null ? "" : `, ${day.visitors} visitors`}`,
          ),
      ];
      return success(lines.join("\n"), body);
    },
  );
}
