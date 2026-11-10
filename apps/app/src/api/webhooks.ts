// /api/v1/webhooks (premium plan P6, decision 0009): the owner's webhooks, managed by its admins.
// Every route is `artifacts:share`: a webhook sends the owner's activity to a third party. The
// MCP webhook tools call the same services and return the same bodies through these views.
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
import { personalScope } from "../regions.ts";
import { error, type Guarded, iso, readJson } from "./http.ts";

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

/** A webhook ID that is not well formed answers exactly like a missing webhook. */
const notFound = "Webhook not found.";

export function webhookRoutes(api: Hono<{ Bindings: Env }>, guarded: Guarded, now: () => number) {
  api.get(
    "/api/v1/webhooks",
    guarded("artifacts:share", async (c, userId) => {
      const { actor, db } = await personalScope(c.env, userId);
      const result = await listWebhooks(db, { actor, now: now() });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(webhookListView(result.value));
    }),
  );

  // No idempotency key: a stored replay would keep the secret (decision 0009).
  api.post(
    "/api/v1/webhooks",
    guarded("artifacts:share", async (c, userId) => {
      const body = await readJson(c, WebhookCreate, 4_096);
      if (!body.ok) return body.response;
      const { actor, db } = await personalScope(c.env, userId);
      const result = await createWebhook(db, {
        actor,
        webhook: body.value,
        keys: await appWebhookKeys(c.env),
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      c.header("Cache-Control", "no-store");
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
    guarded("artifacts:share", async (c, userId) => {
      const webhookId = WebhookId.safeParse(c.req.param("webhookId"));
      if (!webhookId.success) return error(c, "not_found", notFound);
      const body = await readJson(c, WebhookUpdate, 4_096);
      if (!body.ok) return body.response;
      const { actor, db } = await personalScope(c.env, userId);
      const result = await updateWebhook(db, {
        actor,
        webhookId: webhookId.data,
        update: body.value,
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(webhookView(result.value));
    }),
  );

  api.delete(
    "/api/v1/webhooks/:webhookId",
    guarded("artifacts:share", async (c, userId) => {
      const webhookId = WebhookId.safeParse(c.req.param("webhookId"));
      if (!webhookId.success) return error(c, "not_found", notFound);
      const { actor, db } = await personalScope(c.env, userId);
      const result = await removeWebhook(db, { actor, webhookId: webhookId.data, now: now() });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(WebhookRemoved.parse({ webhookId: webhookId.data, removed: true }));
    }),
  );

  api.post(
    "/api/v1/webhooks/:webhookId/test",
    guarded("artifacts:share", async (c, userId) => {
      const webhookId = WebhookId.safeParse(c.req.param("webhookId"));
      if (!webhookId.success) return error(c, "not_found", notFound);
      const { actor, db } = await personalScope(c.env, userId);
      const result = await sendTestEvent(db, { actor, webhookId: webhookId.data, now: now() });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(WebhookTestQueued.parse({ webhookId: webhookId.data, queued: true }), 202);
    }),
  );

  api.get(
    "/api/v1/webhooks/:webhookId/deliveries",
    guarded("artifacts:share", async (c, userId) => {
      const webhookId = WebhookId.safeParse(c.req.param("webhookId"));
      if (!webhookId.success) return error(c, "not_found", notFound);
      const { actor, db } = await personalScope(c.env, userId);
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
