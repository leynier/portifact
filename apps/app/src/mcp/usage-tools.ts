// MCP tool for account usage (plan section 6, "Cuenta"): get_usage. It calls the same service as
// GET /api/v1/usage and returns the same body with the same scope.
import { AccountUsageView, GetUsageInput, type OAuthScope } from "@portifact/contracts";
import type { RegionalDb } from "@portifact/db";
import { getAccountUsage } from "@portifact/services";
import { usageView } from "../api/usage.ts";
import { ownerScope } from "../regions.ts";
import { failure, type RegisterTool, success, type ToolContext } from "./tools.ts";

export const USAGE_TOOL_SCOPES: [string, OAuthScope][] = [["get_usage", "artifacts:read"]];

export function registerUsageTools(
  register: RegisterTool,
  context: ToolContext,
  db: RegionalDb,
): void {
  register(
    "get_usage",
    {
      title: "Get account usage",
      description:
        "Get the usage of the user's personal space, or of a workspace with workspace (its slug from list_workspaces; admins and editors only): active artifacts, storage (with bytes reserved by uploads in progress), publishes, new files and new bytes in the last 24 hours, new files this month, open uploads, and the requests and bytes the user's artifacts served this month (traffic), each with its limit; the per-version limits; when the account may make artifacts public; and blocks, the reasons the account cannot do something right now, each with when it lifts by itself (null when the user must free capacity). A traffic block (stops serving) means every artifact of the user answers 429 traffic_exceeded until it lifts at the next month. Call it before a large publish, or to explain a quota_exceeded or traffic_exceeded error.",
      inputSchema: GetUsageInput,
      outputSchema: AccountUsageView,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: GetUsageInput) => {
      const scope = await ownerScope(context.env, context.userId, args.workspace);
      if (!scope.ok) return failure(scope.code, scope.message);
      const { actor, db: owned } = scope.value;
      const report = await getAccountUsage(owned, { actor, now: context.now() });
      if (!report.ok) return failure(report.code, report.message);
      const body = usageView(report.value);
      const lines = [
        `Active artifacts: ${body.activeArtifacts.used} of ${body.activeArtifacts.limit}.`,
        `Storage: ${body.storage.used + body.storage.reserved} of ${body.storage.limit} bytes.`,
        `Publishes in the last 24 hours: ${body.publishesLast24h.used} of ${body.publishesLast24h.limit}.`,
        `Traffic this month: ${body.trafficThisMonth.requests.used} of ${body.trafficThisMonth.requests.limit} requests, ${body.trafficThisMonth.bytes.used} of ${body.trafficThisMonth.bytes.limit} bytes, resets ${body.trafficThisMonth.resetsAt}.`,
        ...(body.blocks.length === 0
          ? ["Nothing blocks the account."]
          : body.blocks.map(
              (block) =>
                `Blocked (${block.reason}, stops ${block.stops}): ${block.message}${block.until ? ` Lifts ${block.until}.` : ""}`,
            )),
      ];
      return success(lines.join("\n"), body);
    },
  );
}
