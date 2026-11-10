// MCP tools for webhooks (premium plan P6, decision 0009): list_webhooks and
// list_webhook_deliveries, read-only, with `artifacts:read` like their /api/v1 routes and the same
// bodies. Creating, changing, testing and removing webhooks is not offered to MCP clients: a
// webhook is a standing channel out of the account (decision 0003, addendum), managed only in the
// dashboard or with the Portifact CLI.
import {
  ListWebhooksInput,
  type OAuthScope,
  WebhookDeliveries,
  WebhookList,
  WebhookRef,
  type WebhookView,
  WorkspaceParam,
} from "@portifact/contracts";
import { listWebhookDeliveries, listWebhooks } from "@portifact/services";
import { deliveriesView, webhookListView, webhookService } from "../api/webhooks.ts";
import { ownerScope } from "../regions.ts";
import { failure, type RegisterTool, success, type ToolContext } from "./tools.ts";

export const WEBHOOK_TOOL_SCOPES: [string, OAuthScope][] = [
  ["list_webhooks", "artifacts:read"],
  ["list_webhook_deliveries", "artifacts:read"],
];

const READ = { readOnlyHint: true, openWorldHint: false };
const MANAGED_ELSEWHERE =
  "Webhooks are created, changed, tested and removed only in the Portifact dashboard or with the portifact CLI, never through MCP: tell the user where to do it.";

function line(webhook: WebhookView): string {
  const reason = webhook.disabledReason ? ` (${webhook.disabledReason})` : "";
  return `${webhook.id} ${webhook.state}${reason}: ${webhook.format} to ${webhook.host}, events ${webhook.events.join(", ")}.`;
}

export function registerWebhookTools(register: RegisterTool, context: ToolContext): void {
  /** The space a tool names; a slug that is not well formed answers like a missing workspace. */
  const scope = async (workspace: string | undefined) => {
    if (
      workspace !== undefined &&
      workspace !== "" &&
      !WorkspaceParam.safeParse(workspace).success
    ) {
      return { ok: false as const, code: "not_found" as const, message: "Workspace not found." };
    }
    return ownerScope(context.env, context.userId, workspace || undefined);
  };

  register(
    "list_webhooks",
    {
      title: "List webhooks",
      description: `List the webhooks of the user's personal space, or of a workspace with workspace (its slug from list_workspaces; admins only): each one's host (never the full URL), format, events, state (active, disabled with a reason, or paused while the plan lacks webhooks), failures in a row, last attempt and where it was created; whether the plan includes webhooks, whether Portifact offers them yet, and how many the user can have. ${MANAGED_ELSEWHERE}`,
      inputSchema: ListWebhooksInput,
      outputSchema: WebhookList,
      annotations: READ,
    },
    async ({ workspace }: ListWebhooksInput) => {
      const space = await scope(workspace);
      if (!space.ok) return failure(space.code, space.message);
      const { actor, db } = space.value;
      const result = await listWebhooks(db, {
        actor,
        service: webhookService(context.env),
        now: context.now(),
      });
      if (!result.ok) return failure(result.code, result.message);
      const body = webhookListView(result.value);
      const lines = body.webhooks.length === 0 ? ["No webhooks."] : body.webhooks.map(line);
      if (!body.available) lines.push("The plan of this space does not include webhooks.");
      if (!body.serviceAvailable) lines.push("Portifact does not offer webhooks yet.");
      return success(lines.join("\n"), body);
    },
  );

  register(
    "list_webhook_deliveries",
    {
      title: "List a webhook's deliveries",
      description: `List the delivery attempts of one webhook of the user's personal space, or of a workspace with workspace, in the last 7 days, newest first: delivery ID, attempt, time, outcome (delivered, failed or skipped) and the receiver's HTTP status or the error (timeout, network, redirect, invalid_url, key_unavailable, daily_cap). Bodies are never kept. ${MANAGED_ELSEWHERE}`,
      inputSchema: WebhookRef,
      outputSchema: WebhookDeliveries,
      annotations: READ,
    },
    async ({ webhookId, workspace }: WebhookRef) => {
      const space = await scope(workspace);
      if (!space.ok) return failure(space.code, space.message);
      const { actor, db } = space.value;
      const result = await listWebhookDeliveries(db, { actor, webhookId, now: context.now() });
      if (!result.ok) return failure(result.code, result.message);
      const body = deliveriesView(webhookId, result.value);
      const lines =
        body.attempts.length === 0
          ? [`No attempts in the last ${body.retentionDays} days.`]
          : body.attempts.map(
              (a) =>
                `${a.at} ${a.deliveryId} attempt ${a.attempt}: ${a.outcome}${a.status === null ? "" : ` ${a.status}`}${a.error ? ` (${a.error})` : ""}`,
            );
      return success(lines.join("\n"), body);
    },
  );
}
