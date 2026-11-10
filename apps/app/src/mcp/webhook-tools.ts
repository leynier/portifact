// MCP tools for webhooks (premium plan P6, decision 0009): list_webhooks, create_webhook,
// update_webhook, delete_webhook, test_webhook and list_webhook_deliveries. Each calls the same
// service as its /api/v1/webhooks route, with the same scope (`artifacts:share`: a webhook sends
// the owner's activity to a third party) and returns the same body.
import {
  ListWebhooksInput,
  type OAuthScope,
  UpdateWebhookInput,
  WebhookCreate,
  WebhookCreated,
  WebhookDeliveries,
  WebhookList,
  WebhookRef,
  WebhookRemoved,
  WebhookTestQueued,
  WebhookUpdate,
  WebhookView,
} from "@portifact/contracts";
import {
  createWebhook,
  listWebhookDeliveries,
  listWebhooks,
  removeWebhook,
  sendTestEvent,
  updateWebhook,
} from "@portifact/services";
import { appWebhookKeys, deliveriesView, webhookListView, webhookView } from "../api/webhooks.ts";
import { personalScope } from "../regions.ts";
import { failure, type RegisterTool, success, type ToolContext } from "./tools.ts";

export const WEBHOOK_TOOL_SCOPES: [string, OAuthScope][] = [
  ["list_webhooks", "artifacts:share"],
  ["create_webhook", "artifacts:share"],
  ["update_webhook", "artifacts:share"],
  ["delete_webhook", "artifacts:share"],
  ["test_webhook", "artifacts:share"],
  ["list_webhook_deliveries", "artifacts:share"],
];

const READ = { readOnlyHint: true, openWorldHint: false };
const ASK_FIRST =
  "A webhook sends activity about every artifact of the user (names, links, counts, who on their side acted) to a server outside Portifact: only call it after the user asked for exactly this destination.";

function line(webhook: WebhookView): string {
  const reason = webhook.disabledReason ? ` (${webhook.disabledReason})` : "";
  return `${webhook.id} ${webhook.state}${reason}: ${webhook.format} to ${webhook.host}, events ${webhook.events.join(", ")}.`;
}

export function registerWebhookTools(register: RegisterTool, context: ToolContext): void {
  const scope = () => personalScope(context.env, context.userId);

  register(
    "list_webhooks",
    {
      title: "List webhooks",
      description:
        "List the user's webhooks: each one's host (never the full URL), format, events, state (active, disabled with a reason, or paused while the plan lacks webhooks), failures in a row and last attempt; whether the plan includes webhooks; and how many the user can have.",
      inputSchema: ListWebhooksInput,
      outputSchema: WebhookList,
      annotations: READ,
    },
    async () => {
      const { actor, db } = await scope();
      const result = await listWebhooks(db, { actor, now: context.now() });
      if (!result.ok) return failure(result.code, result.message);
      const body = webhookListView(result.value);
      const lines = body.webhooks.length === 0 ? ["No webhooks."] : body.webhooks.map(line);
      if (!body.available) lines.push("The user's plan does not include webhooks.");
      return success(lines.join("\n"), body);
    },
  );

  register(
    "create_webhook",
    {
      title: "Create a webhook",
      description: `Create a webhook that receives events about all the user's artifacts: comment.created, thread.resolved, artifact.published, artifact.expiring and artifact.access_changed. Format generic sends signed JSON (Standard Webhooks headers); slack and discord need that service's incoming webhook URL. ${ASK_FIRST} The URL must be public HTTPS on port 443. The answer holds the signing secret once (generic only): give it to the user for their receiver, never store it or send it anywhere else. Part of a paid plan (plan_required otherwise).`,
      inputSchema: WebhookCreate,
      outputSchema: WebhookCreated,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args: WebhookCreate) => {
      const { actor, db } = await scope();
      const result = await createWebhook(db, {
        actor,
        webhook: args,
        keys: await appWebhookKeys(context.env),
        now: context.now(),
      });
      if (!result.ok) return failure(result.code, result.message);
      const body = WebhookCreated.parse({
        webhook: webhookView(result.value.webhook),
        secret: result.value.secret,
      });
      const secret = body.secret
        ? " The signing secret is in the structured result; show it to the user once."
        : "";
      return success(`Created ${line(body.webhook)}${secret}`, body);
    },
  );

  register(
    "update_webhook",
    {
      title: "Enable, disable or change a webhook",
      description: `Enable or disable one of the user's webhooks, or change its events. Enabling it again resets its failures and needs a paid plan; disabling never does. ${ASK_FIRST}`,
      inputSchema: UpdateWebhookInput,
      outputSchema: WebhookView,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ webhookId, ...change }: UpdateWebhookInput) => {
      const parsed = WebhookUpdate.safeParse(change);
      if (!parsed.success) {
        return failure("invalid_input", parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const { actor, db } = await scope();
      const result = await updateWebhook(db, {
        actor,
        webhookId,
        update: parsed.data,
        now: context.now(),
      });
      if (!result.ok) return failure(result.code, result.message);
      const body = webhookView(result.value);
      return success(line(body), body);
    },
  );

  register(
    "delete_webhook",
    {
      title: "Delete a webhook",
      description:
        "Delete one of the user's webhooks with its delivery log; it receives nothing more. Ask the user before deleting it.",
      inputSchema: WebhookRef,
      outputSchema: WebhookRemoved,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ webhookId }: WebhookRef) => {
      const { actor, db } = await scope();
      const result = await removeWebhook(db, { actor, webhookId, now: context.now() });
      if (!result.ok) return failure(result.code, result.message);
      const body = WebhookRemoved.parse({ webhookId, removed: true });
      return success(`Deleted ${webhookId}.`, body);
    },
  );

  register(
    "test_webhook",
    {
      title: "Send a test event",
      description: `Queue a test event (type webhook.test) for one of the user's enabled webhooks; it goes within about two minutes and its attempt appears in list_webhook_deliveries. ${ASK_FIRST}`,
      inputSchema: WebhookRef,
      outputSchema: WebhookTestQueued,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ webhookId }: WebhookRef) => {
      const { actor, db } = await scope();
      const result = await sendTestEvent(db, { actor, webhookId, now: context.now() });
      if (!result.ok) return failure(result.code, result.message);
      const body = WebhookTestQueued.parse({ webhookId, queued: true });
      return success(`Queued a test event for ${webhookId}.`, body);
    },
  );

  register(
    "list_webhook_deliveries",
    {
      title: "List a webhook's deliveries",
      description:
        "List the delivery attempts of one of the user's webhooks in the last 7 days, newest first: delivery ID, attempt, time, outcome (delivered, failed or skipped) and the receiver's HTTP status or the error (timeout, network, redirect, invalid_url, daily_cap). Bodies are never kept.",
      inputSchema: WebhookRef,
      outputSchema: WebhookDeliveries,
      annotations: READ,
    },
    async ({ webhookId }: WebhookRef) => {
      const { actor, db } = await scope();
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
