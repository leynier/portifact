// Audit streams at /api/v1/audit/streams (premium plan E3, decision 0019): the owner's admins point
// its audit log at an HTTPS endpoint they run. Every route answers only the dashboard's session:
// a stream sends the whole log out of Portifact for as long as it exists, so no bearer token of
// any kind manages or reads one (not the CLI's `credentials:manage`, which webhooks accept, and
// never a service token or MCP). That a stream exists is still visible to every reader of the
// log, through its `audit_stream.*` events. `?workspace=<slug>` names a workspace.
//
// Without `WEBHOOKS_ENABLED` and `WEBHOOK_KEY` (the webhook switch, decision 0009) creating,
// changing the URL, resuming, rotating and testing answer `capacity_unavailable`, and the list
// says `serviceAvailable: false`.
import {
  AUDIT_STREAM,
  AuditStreamCreate,
  AuditStreamDeliveries,
  AuditStreamId,
  AuditStreamList,
  AuditStreamRemoved,
  AuditStreamTestQueued,
  AuditStreamUpdate,
  AuditStreamView,
  AuditStreamWithSecret,
  ERROR_STATUS,
  type ErrorCode,
} from "@portifact/contracts";
import {
  createAuditStream,
  listAuditStreamDeliveries,
  listAuditStreams,
  removeAuditStream,
  sendAuditStreamTest,
  updateAuditStream,
  webhookKeys,
} from "@portifact/services";
import { type Context, Hono } from "hono";
import { authUrls } from "../auth/config.ts";
import type { Env } from "../env.ts";
import { ownerScope } from "../regions.ts";
import { fromAppOrigin, hasSessionCookie, type SessionLookup } from "./access.ts";
import { type ApiContext, readJson, workspaceParam } from "./http.ts";

/** Whether streams are offered at all: the webhook switch and its key (decision 0019). */
export function auditStreamService(env: Env) {
  return { enabled: env.WEBHOOKS_ENABLED === "true" && typeof env.WEBHOOK_KEY === "string" };
}

/**
 * The sealing keys of the app Worker: `WEBHOOK_KEY`, and `WEBHOOK_KEY_PREVIOUS` when set, which
 * opens a stream sealed before a rotation while its URL or secret changes.
 */
export function appAuditStreamKeys(env: Env) {
  return webhookKeys({ current: env.WEBHOOK_KEY, previous: env.WEBHOOK_KEY_PREVIOUS });
}

export interface AuditStreamRouteDeps {
  /** The dashboard session's user; a session without the current terms counts as none. */
  session(env: Env): SessionLookup;
  now(): number;
}

function fail(c: ApiContext, code: ErrorCode, message: string): Response {
  return c.json({ error: { code, message } }, ERROR_STATUS[code] as 400);
}

const notFound = "Audit stream not found.";

export function auditStreamRoutes(deps: AuditStreamRouteDeps) {
  const routes = new Hono<{ Bindings: Env }>();

  const sessionOnly =
    (handler: (c: ApiContext, userId: string) => Promise<Response>) =>
    async (c: Context<{ Bindings: Env }>) => {
      c.header("Cache-Control", "no-store");
      const request = c.req.raw;
      if (request.headers.has("authorization")) {
        return fail(c, "forbidden", "Audit streams are managed in the dashboard.");
      }
      if (!hasSessionCookie(request.headers.get("cookie"))) {
        return fail(c, "unauthenticated", "Sign in to manage audit streams.");
      }
      if (!fromAppOrigin(request, authUrls(c.env.APP_ORIGIN).origin)) {
        return fail(c, "forbidden", "Cross-origin request refused.");
      }
      const userId = await deps.session(c.env)(request);
      if (!userId) return fail(c, "unauthenticated", "Sign in to manage audit streams.");
      return handler(c, userId);
    };

  /** The space the request names, and the caller's role on it. */
  const scoped =
    (
      handler: (
        c: ApiContext,
        scope: Extract<Awaited<ReturnType<typeof ownerScope>>, { ok: true }>["value"],
      ) => Promise<Response>,
    ) =>
    (c: ApiContext, userId: string) =>
      (async () => {
        const workspace = workspaceParam(c);
        if (!workspace.ok) return fail(c, "not_found", "Workspace not found.");
        const scope = await ownerScope(c.env, userId, workspace.slug);
        if (!scope.ok) return fail(c, scope.code, scope.message);
        return handler(c, scope.value);
      })();

  const streamId = (c: ApiContext) => {
    const parsed = AuditStreamId.safeParse(c.req.param("streamId"));
    return parsed.success ? parsed.data : null;
  };

  routes.get(
    "/api/v1/audit/streams",
    sessionOnly(
      scoped(async (c, scope) => {
        const result = await listAuditStreams(scope.db, {
          actor: scope.actor,
          service: auditStreamService(c.env),
          now: deps.now(),
        });
        if (!result.ok) return fail(c, result.code, result.message);
        return c.json(AuditStreamList.parse(result.value));
      }),
    ),
  );

  // No idempotency key: a stored replay would keep the secret (as for webhooks).
  routes.post(
    "/api/v1/audit/streams",
    sessionOnly(async (c, userId) => {
      const body = await readJson(c, AuditStreamCreate, 4_096);
      if (!body.ok) return body.response;
      return scoped(async (c2, scope) => {
        const result = await createAuditStream(scope.db, {
          actor: scope.actor,
          stream: body.value,
          keys: await appAuditStreamKeys(c2.env),
          service: auditStreamService(c2.env),
          now: deps.now(),
        });
        if (!result.ok) return fail(c2, result.code, result.message);
        return c2.json(AuditStreamWithSecret.parse(result.value), 201);
      })(c, userId);
    }),
  );

  routes.patch(
    "/api/v1/audit/streams/:streamId",
    sessionOnly(async (c, userId) => {
      const id = streamId(c);
      if (!id) return fail(c, "not_found", notFound);
      const body = await readJson(c, AuditStreamUpdate, 4_096);
      if (!body.ok) return body.response;
      return scoped(async (c2, scope) => {
        const result = await updateAuditStream(scope.db, {
          actor: scope.actor,
          streamId: id,
          update: body.value,
          keys: await appAuditStreamKeys(c2.env),
          service: auditStreamService(c2.env),
          now: deps.now(),
        });
        if (!result.ok) return fail(c2, result.code, result.message);
        if (result.value.secret !== null) {
          return c2.json(
            AuditStreamWithSecret.parse({
              stream: result.value.stream,
              secret: result.value.secret,
            }),
          );
        }
        return c2.json({ stream: AuditStreamView.parse(result.value.stream), secret: null });
      })(c, userId);
    }),
  );

  routes.delete(
    "/api/v1/audit/streams/:streamId",
    sessionOnly(async (c, userId) => {
      const id = streamId(c);
      if (!id) return fail(c, "not_found", notFound);
      return scoped(async (c2, scope) => {
        const result = await removeAuditStream(scope.db, {
          actor: scope.actor,
          streamId: id,
          now: deps.now(),
        });
        if (!result.ok) return fail(c2, result.code, result.message);
        return c2.json(AuditStreamRemoved.parse({ streamId: id, removed: true }));
      })(c, userId);
    }),
  );

  routes.post(
    "/api/v1/audit/streams/:streamId/test",
    sessionOnly(async (c, userId) => {
      const id = streamId(c);
      if (!id) return fail(c, "not_found", notFound);
      return scoped(async (c2, scope) => {
        const result = await sendAuditStreamTest(scope.db, {
          actor: scope.actor,
          streamId: id,
          service: auditStreamService(c2.env),
          now: deps.now(),
        });
        if (!result.ok) return fail(c2, result.code, result.message);
        return c2.json(AuditStreamTestQueued.parse({ streamId: id, queued: true }), 202);
      })(c, userId);
    }),
  );

  routes.get(
    "/api/v1/audit/streams/:streamId/deliveries",
    sessionOnly(async (c, userId) => {
      const id = streamId(c);
      if (!id) return fail(c, "not_found", notFound);
      return scoped(async (c2, scope) => {
        const result = await listAuditStreamDeliveries(scope.db, {
          actor: scope.actor,
          streamId: id,
          now: deps.now(),
        });
        if (!result.ok) return fail(c2, result.code, result.message);
        return c2.json(
          AuditStreamDeliveries.parse({
            streamId: id,
            attempts: result.value,
            retentionDays: AUDIT_STREAM.logDays,
          }),
        );
      })(c, userId);
    }),
  );

  return routes;
}
