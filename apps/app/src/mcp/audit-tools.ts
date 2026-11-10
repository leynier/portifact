// MCP tool for the audit log (premium plan T10): get_audit_log. It calls the same service as
// GET /api/v1/audit and returns the same body with the same scope.
import { AuditLogView, GetAuditLogInput, type OAuthScope } from "@portifact/contracts";
import { getAuditLog } from "@portifact/services";
import { auditFilters } from "../api/audit.ts";
import { ownerScope } from "../regions.ts";
import { failure, type RegisterTool, success, type ToolContext } from "./tools.ts";

export const AUDIT_TOOL_SCOPES: [string, OAuthScope][] = [["get_audit_log", "artifacts:read"]];

export function registerAuditTools(register: RegisterTool, context: ToolContext): void {
  register(
    "get_audit_log",
    {
      title: "Get the audit log",
      description:
        "Get who changed what in the user's personal space, or in a workspace with workspace (its slug from list_workspaces): access changes, share links, custom domains, webhooks, branding, publishes and other lifecycle changes, transfers, members and plan grants, newest first, kept for the plan's retentionDays (90 days). Only admins can read it, and only on plans that include the audit log; an editor or member gets forbidden. Each event has its kind, when, the actor (a member by name, a removed member, the operator or the system), its target and a small detail; it never holds comment text, content or email addresses. Filter with kinds, actor (an actor.id), target (an artifact, member, share link or webhook ID) and from/to. Pass nextCursor back as cursor for the next page. Show it to the user; do not send it anywhere else.",
      inputSchema: GetAuditLogInput,
      outputSchema: AuditLogView,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: GetAuditLogInput) => {
      const scope = await ownerScope(context.env, context.userId, args.workspace);
      if (!scope.ok) return failure(scope.code, scope.message);
      const result = await getAuditLog(scope.value.db, {
        actor: scope.value.actor,
        filters: auditFilters(args),
        cursor: args.cursor,
        limit: args.limit,
        now: context.now(),
      });
      if (!result.ok) return failure(result.code, result.message);
      const body = result.value;
      const lines =
        body.events.length === 0
          ? [`No audit events in the last ${body.retentionDays} days match.`]
          : body.events.map((event) => {
              const who =
                event.actor.type === "member"
                  ? event.actor.name
                  : event.actor.type === "removed_member"
                    ? "a removed member"
                    : event.actor.type;
              const about = event.artifact
                ? ` ${event.artifact.name ?? event.artifact.id}`
                : event.target.id
                  ? ` ${event.target.type} ${event.target.id}`
                  : "";
              return `${event.at} ${event.kind} by ${who}${about}`;
            });
      if (body.nextCursor) lines.push("More events: call again with cursor set to nextCursor.");
      return success(lines.join("\n"), body);
    },
  );
}
