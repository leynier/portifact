// portifact webhooks list | add | remove | test | deliveries | enable | disable | events: the
// account's webhooks (premium plan P6, decision 0009) through /api/v1/webhooks. The CLI adds no
// rule of its own: the server validates URLs, checks the plan and the role, and its errors are
// shown as they come (plan_required exits 7 like every limit).
import {
  WEBHOOK_EVENTS,
  type WebhookAttempt,
  WebhookCreated,
  WebhookDeliveries,
  type WebhookEventType,
  type WebhookFormat,
  WebhookId,
  WebhookList,
  WebhookRemoved,
  WebhookTestQueued,
  WebhookView,
} from "@portifact/contracts";
import { plain } from "./annotations.ts";
import { callApi } from "./api.ts";
import { table } from "./artifacts.ts";
import { type OutputOptions, openSession, writeJson } from "./commands.ts";
import { CliError } from "./errors.ts";
import { formatDate, messages } from "./messages.ts";
import type { Io, Runtime } from "./runtime.ts";

export function parseWebhookId(value: string): string {
  const parsed = WebhookId.safeParse(value);
  if (!parsed.success) {
    throw new CliError("invalid_input", messages.errors.invalidWebhookId(plain(value)));
  }
  return parsed.data;
}

/** `--events comment.created,artifact.published`, or `all`. */
export function parseEvents(value: string): WebhookEventType[] {
  if (value.trim() === "all") return [...WEBHOOK_EVENTS];
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const known = new Set<string>(WEBHOOK_EVENTS);
  if (names.length === 0 || names.some((name) => !known.has(name))) {
    throw new CliError("invalid_input", messages.errors.invalidWebhookEvents(plain(value)));
  }
  return [...new Set(names)] as WebhookEventType[];
}

function state(webhook: WebhookView): string {
  return webhook.disabledReason ? `${webhook.state} (${webhook.disabledReason})` : webhook.state;
}

function attempt(entry: WebhookAttempt | null): string {
  if (!entry) return "-";
  const detail = entry.status ?? entry.error ?? "";
  return `${entry.outcome}${detail === "" ? "" : ` ${detail}`} ${formatDate(entry.at)}`;
}

export async function listWebhooks(io: Io, runtime: Runtime, options: OutputOptions) {
  const session = await openSession(io, runtime);
  const list = await callApi(session, { method: "GET", path: "/webhooks", schema: WebhookList });
  if (options.json) {
    writeJson(io, list);
    return;
  }
  if (list.webhooks.length === 0) {
    io.stdout(`${messages.webhooksEmpty}\n`);
  } else {
    io.stdout(
      table([
        ["ID", "HOST", "FORMAT", "STATE", "FAILURES", "EVENTS", "VIA", "LAST ATTEMPT"],
        ...list.webhooks.map((webhook) => [
          webhook.id,
          plain(webhook.host),
          webhook.format,
          state(webhook),
          String(webhook.failures),
          webhook.events.join(","),
          plain(webhook.createdVia),
          attempt(webhook.lastAttempt),
        ]),
      ]),
    );
  }
  if (!list.serviceAvailable) io.stdout(`${messages.webhooksNotOffered}\n`);
  else if (!list.available) io.stdout(`${messages.webhooksUnavailable}\n`);
}

export interface AddWebhookOptions extends OutputOptions {
  events: string;
  format?: WebhookFormat | undefined;
}

export async function addWebhook(
  io: Io,
  runtime: Runtime,
  url: string,
  options: AddWebhookOptions,
) {
  const events = parseEvents(options.events);
  const session = await openSession(io, runtime);
  const created = await callApi(session, {
    method: "POST",
    path: "/webhooks",
    body: { url, format: options.format ?? "generic", events },
    schema: WebhookCreated,
  });
  if (options.json) {
    writeJson(io, created);
    return;
  }
  io.stdout(`${messages.webhookAdded(created.webhook.id, plain(created.webhook.host))}\n`);
  if (created.secret) io.stdout(`${messages.webhookSecret(created.secret)}\n`);
}

export interface RemoveWebhookOptions extends OutputOptions {
  yes?: boolean;
}

export async function removeWebhook(
  io: Io,
  runtime: Runtime,
  id: string,
  options: RemoveWebhookOptions,
) {
  const webhookId = parseWebhookId(id);
  if (!options.yes && !runtime.prompt) {
    throw new CliError(
      "invalid_input",
      messages.errors.webhookRemoveConfirmationRequired(webhookId),
    );
  }
  const session = await openSession(io, runtime);
  if (!options.yes && runtime.prompt) {
    const list = await callApi(session, { method: "GET", path: "/webhooks", schema: WebhookList });
    const webhook = list.webhooks.find((item) => item.id === webhookId);
    // Nothing to confirm: the server answers a missing webhook with its own not_found.
    if (webhook) {
      const answer = await runtime.prompt(
        messages.confirmWebhookRemove(webhookId, plain(webhook.host)),
      );
      if (answer.trim().toLowerCase() !== "remove") {
        throw new CliError("cancelled", messages.errors.webhookRemoveCancelled);
      }
    }
  }
  const removed = await callApi(session, {
    method: "DELETE",
    path: `/webhooks/${webhookId}`,
    schema: WebhookRemoved,
  });
  if (options.json) writeJson(io, removed);
  else io.stdout(`${messages.webhookRemoved(webhookId)}\n`);
}

export async function testWebhook(io: Io, runtime: Runtime, id: string, options: OutputOptions) {
  const webhookId = parseWebhookId(id);
  const session = await openSession(io, runtime);
  const queued = await callApi(session, {
    method: "POST",
    path: `/webhooks/${webhookId}/test`,
    schema: WebhookTestQueued,
  });
  if (options.json) writeJson(io, queued);
  else io.stdout(`${messages.webhookTestQueued(webhookId)}\n`);
}

export async function webhookDeliveries(
  io: Io,
  runtime: Runtime,
  id: string,
  options: OutputOptions,
) {
  const webhookId = parseWebhookId(id);
  const session = await openSession(io, runtime);
  const log = await callApi(session, {
    method: "GET",
    path: `/webhooks/${webhookId}/deliveries`,
    schema: WebhookDeliveries,
  });
  if (options.json) {
    writeJson(io, log);
    return;
  }
  if (log.attempts.length === 0) {
    io.stdout(`${messages.webhookDeliveriesEmpty(log.retentionDays)}\n`);
    return;
  }
  io.stdout(
    table([
      ["TIME", "DELIVERY", "ATTEMPT", "OUTCOME", "STATUS"],
      ...log.attempts.map((entry) => [
        formatDate(entry.at),
        entry.deliveryId,
        String(entry.attempt),
        entry.outcome,
        String(entry.status ?? entry.error ?? "-"),
      ]),
    ]),
  );
}

export async function updateWebhook(
  io: Io,
  runtime: Runtime,
  id: string,
  change: { enabled?: boolean; events?: string },
  options: OutputOptions,
) {
  const webhookId = parseWebhookId(id);
  const body = {
    ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
    ...(change.events === undefined ? {} : { events: parseEvents(change.events) }),
  };
  const session = await openSession(io, runtime);
  const webhook = await callApi(session, {
    method: "PATCH",
    path: `/webhooks/${webhookId}`,
    body,
    schema: WebhookView,
  });
  if (options.json) writeJson(io, webhook);
  else {
    io.stdout(
      `${webhook.id} ${state(webhook)}: ${webhook.format} to ${plain(webhook.host)}, events ${webhook.events.join(",")}.\n`,
    );
  }
}
