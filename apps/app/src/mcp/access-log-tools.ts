// MCP tool for the owner's access log (plan section 6, "Cuenta"): get_access_logs. It calls the
// same service as GET /api/v1/artifacts/:id/access-log and returns the same body with the same
// scope.
import { AccessLogView, GetAccessLogsInput, type OAuthScope } from "@portifact/contracts";
import type { RegionalDb } from "@portifact/db";
import { getAccessLog } from "@portifact/services";
import { accessLogView } from "../api/access-log.ts";
import { accessDbOf, artifactRegion } from "../regions.ts";
import { failure, type RegisterTool, success, type ToolContext } from "./tools.ts";

export const ACCESS_LOG_TOOL_SCOPES: [string, OAuthScope][] = [
  ["get_access_logs", "artifacts:read"],
];

export function registerAccessLogTools(
  register: RegisterTool,
  context: ToolContext,
  db: RegionalDb,
): void {
  register(
    "get_access_logs",
    {
      title: "Get an artifact's access log",
      description:
        "Get who opened one of the user's artifacts within the days the owner's plan keeps (retentionDays: 30 on the free plan, up to a year on paid plans): the verified email of each signed-in visitor and when, newest first, one entry per visitor and 30-minute window. Openings through a share link name only the link (shareLink, with its label), never the visitor. Only the artifact's owner can read it; anyone else gets not_found. Only artifacts restricted to listed readers record signed-in openings (public and authenticated ones never do; share link openings are recorded for both), the owner's own visits are not recorded, and openings can be missing, so it is not a complete audit. The emails are personal data of the visitors: show them to the user only, do not send them anywhere else. Pass nextCursor back as cursor for the next page.",
      inputSchema: GetAccessLogsInput,
      outputSchema: AccessLogView,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ artifactId, since, cursor, limit }) => {
      const region = await artifactRegion(context.env, artifactId);
      const result = await getAccessLog(region.db, accessDbOf(region), {
        userId: context.userId,
        artifactId,
        cursor,
        limit,
        since: since === undefined ? undefined : Date.parse(since),
        now: context.now(),
      });
      if (!result.ok) return failure(result.code, result.message);
      const body = accessLogView(result.value);
      const lines =
        body.entries.length === 0
          ? [`No openings of ${artifactId} recorded in the last ${body.retentionDays} days.`]
          : body.entries.map((entry) =>
              entry.shareLink
                ? `${entry.openedAt} share link ${entry.shareLink.label ?? entry.shareLink.id}`
                : `${entry.openedAt} ${entry.email}`,
            );
      if (body.nextCursor) lines.push("More entries: call again with cursor set to nextCursor.");
      return success(lines.join("\n"), body);
    },
  );
}
