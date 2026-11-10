// /api/v1/webhooks (premium plan P6, decision 0009): the owner's webhooks, managed by its admins.
// `?workspace=<slug>` names a workspace (the personal space without it); a slug the caller is not a
// member of answers like a missing one, and the role decides in the services.
// A webhook is a standing channel out of the account, so creating, changing, testing and removing
// one take the dashboard session or the Portifact CLI's `credentials:manage` token (decision 0003,
// addendum); any client with `artifacts:read` may list them and their deliveries (hosts, never
// URLs or secrets). The read-only MCP tools return the same bodies through these views.
import {
  WEBHOOK_LIMITS,
  type WebhookAttempt,
  WebhookCreate,
  WebhookCreated,
  WebhookDeliveries,
  WebhookId,
  WebhookList,
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
  type WebhookAttemptRecord,
  type WebhookListing,
  type WebhookRecord,
  webhookKeys,
} from "@portifact/services";
import type { Hono } from "hono";
import type { Env } from "../env.ts";
import { ownerScope } from "../regions.ts";
import {
  type AccountGuarded,
  type ApiContext,
  error,
  type Guarded,
  iso,
  readJson,
  workspaceParam,
} from "./http.ts";

export function attemptView(attempt: WebhookAttemptRecord): WebhookAttempt {
  return { ...attempt, at: iso(attempt.at) };
}

export function webhookView(record: WebhookRecord): WebhookView {
  return WebhookView.parse({
    ...record,
    createdAt: iso(record.createdAt),
    disabledAt: record.disabledAt === null ? null : iso(record.disabledAt),
    lastAttempt: record.lastAttempt === null ? null : attemptView(record.lastAttempt),
  });
}

export function webhookListView(listing: WebhookListing): WebhookList {
  return WebhookList.parse({ ...listing, webhooks: listing.webhooks.map(webhookView) });
}

export function deliveriesView(webhookId: string, attempts: WebhookAttemptRecord[]) {
  return WebhookDeliveries.parse({
    webhookId,
    attempts: attempts.map(attemptView),
    retentionDays: WEBHOOK_LIMITS.logDays,
  });
}

/** The sealing keys of the app Worker: it only seals, so only `WEBHOOK_KEY`. */
export function appWebhookKeys(env: Env) {
  return webhookKeys({ current: env.WEBHOOK_KEY });
}

/** Whether webhooks are offered at all: the explicit switch and a key (decision 0009). */
export function webhookService(env: Env) {
  return { enabled: env.WEBHOOKS_ENABLED === "true" && typeof env.WEBHOOK_KEY === "string" };
}

/** A webhook ID that is not well formed answers exactly like a missing webhook. */
const notFound = "Webhook not found.";

/** The space the request names, as for the audit log and usage. */
async function scopeOf(c: ApiContext, userId: string) {
  const workspace = workspaceParam(c);
  if (!workspace.ok)
    return { ok: false as const, response: error(c, "not_found", "Workspace not found.") };
  const scope = await ownerScope(c.env, userId, workspace.slug);
  if (!scope.ok) return { ok: false as const, response: error(c, scope.code, scope.message) };
  return { ok: true as const, actor: scope.value.actor, db: scope.value.db };
}

export function webhookRoutes(
  api: Hono<{ Bindings: Env }>,
  guarded: Guarded,
  account: AccountGuarded,
  now: () => number,
) {
  api.get(
    "/api/v1/webhooks",
    guarded("artifacts:read", async (c, userId) => {
      const scope = await scopeOf(c, userId);
      if (!scope.ok) return scope.response;
      const { actor, db } = scope;
      const result = await listWebhooks(db, { actor, service: webhookService(c.env), now: now() });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(webhookListView(result.value));
    }),
  );

  // No idempotency key: a stored replay would keep the secret (decision 0009).
  api.post(
    "/api/v1/webhooks",
    account(async (c, caller) => {
      const body = await readJson(c, WebhookCreate, 4_096);
      if (!body.ok) return body.response;
      const scope = await scopeOf(c, caller.userId);
      if (!scope.ok) return scope.response;
      const { actor, db } = scope;
      const result = await createWebhook(db, {
        actor,
        webhook: body.value,
        keys: await appWebhookKeys(c.env),
        service: webhookService(c.env),
        via: caller.via,
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(
        WebhookCreated.parse({
          webhook: webhookView(result.value.webhook),
          secret: result.value.secret,
        }),
        201,
      );
    }),
  );

  api.patch(
    "/api/v1/webhooks/:webhookId",
    account(async (c, caller) => {
      const webhookId = WebhookId.safeParse(c.req.param("webhookId"));
      if (!webhookId.success) return error(c, "not_found", notFound);
      const body = await readJson(c, WebhookUpdate, 4_096);
      if (!body.ok) return body.response;
      const scope = await scopeOf(c, caller.userId);
      if (!scope.ok) return scope.response;
      const { actor, db } = scope;
      const result = await updateWebhook(db, {
        actor,
        webhookId: webhookId.data,
        update: body.value,
        service: webhookService(c.env),
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(webhookView(result.value));
    }),
  );

  api.delete(
    "/api/v1/webhooks/:webhookId",
    account(async (c, caller) => {
      const webhookId = WebhookId.safeParse(c.req.param("webhookId"));
      if (!webhookId.success) return error(c, "not_found", notFound);
      const scope = await scopeOf(c, caller.userId);
      if (!scope.ok) return scope.response;
      const { actor, db } = scope;
      const result = await removeWebhook(db, { actor, webhookId: webhookId.data, now: now() });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(WebhookRemoved.parse({ webhookId: webhookId.data, removed: true }));
    }),
  );

  api.post(
    "/api/v1/webhooks/:webhookId/test",
    account(async (c, caller) => {
      const webhookId = WebhookId.safeParse(c.req.param("webhookId"));
      if (!webhookId.success) return error(c, "not_found", notFound);
      const scope = await scopeOf(c, caller.userId);
      if (!scope.ok) return scope.response;
      const { actor, db } = scope;
      const result = await sendTestEvent(db, {
        actor,
        webhookId: webhookId.data,
        service: webhookService(c.env),
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(WebhookTestQueued.parse({ webhookId: webhookId.data, queued: true }), 202);
    }),
  );

  api.get(
    "/api/v1/webhooks/:webhookId/deliveries",
    guarded("artifacts:read", async (c, userId) => {
      const webhookId = WebhookId.safeParse(c.req.param("webhookId"));
      if (!webhookId.success) return error(c, "not_found", notFound);
      const scope = await scopeOf(c, userId);
      if (!scope.ok) return scope.response;
      const { actor, db } = scope;
      const result = await listWebhookDeliveries(db, {
        actor,
        webhookId: webhookId.data,
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(deliveriesView(webhookId.data, result.value));
    }),
  );
}
