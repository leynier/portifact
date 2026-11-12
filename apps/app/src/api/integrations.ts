// Issue integrations at /api/v1 (premium plan T7, decision 0018).
//
// - `GET /api/v1/integrations` lists the space's connections as the owner side picks one: labels,
//   services and targets, never a credential (`artifacts:read`, like a workspace's group names).
// - `/api/v1/integrations/connections` is where admins manage them, and answers only the
//   dashboard's session: a connection holds a credential that acts as a person at GitHub or
//   Linear, so no bearer token reaches it (not the CLI's `credentials:manage` either, which
//   webhooks accept), and neither MCP nor the CLI manage connections.
// - `POST /api/v1/artifacts/:id/annotations/threads/:threadId/issue` asks for an issue from a
//   thread (`annotations:moderate`, an Idempotency-Key header); the jobs Worker creates it.
//
// Without `INTEGRATIONS_ENABLED` and `INTEGRATIONS_KEY` every change answers
// `capacity_unavailable` and the list is empty.
import {
  ERROR_STATUS,
  type ErrorCode,
  IdempotencyKey,
  INTEGRATION_LIMITS,
  IntegrationChoiceList,
  IntegrationConnectionId,
  IntegrationConnectionList,
  IntegrationConnectionView,
  IntegrationCreate,
  IntegrationTestResult,
  IntegrationUpdate,
  type Region,
  type SlackSetupView,
  ThreadIssueCreate,
  ThreadIssueView,
} from "@portifact/contracts";
import {
  slackCreateUrl,
  slackEventsPath,
  slackManifest,
  slackManifestOutdated,
} from "@portifact/domain";
import {
  type ChoiceListing,
  type ConnectionRecord,
  createIntegrationConnection,
  type IntegrationDeps,
  type IntegrationFetch,
  integrationKeys,
  listIntegrationChoices,
  listIntegrationConnections,
  removeIntegrationConnection,
  requestThreadIssue,
  type ThreadIssueRecord,
  testIntegrationConnection,
  updateIntegrationConnection,
} from "@portifact/services";
import { type Context, Hono } from "hono";
import { authUrls } from "../auth/config.ts";
import type { Env } from "../env.ts";
import { artifactDb, ownerScope } from "../regions.ts";
import { fromAppOrigin, hasSessionCookie, type SessionLookup } from "./access.ts";
import { type ApiContext, error, type Guarded, iso, readJson, workspaceParam } from "./http.ts";

/** Whether integrations are offered at all: the explicit switch and a key (decision 0018). */
export function integrationSwitch(env: Env) {
  const enabled = env.INTEGRATIONS_ENABLED === "true" && typeof env.INTEGRATIONS_KEY === "string";
  // Slack is switched on on its own, besides the integrations switch (decision 0025).
  return { enabled, slack: enabled && env.SLACK_ENABLED === "true" };
}

/**
 * How a Slack connection is set up: its events endpoint on this deployment's app origin and the
 * manifest whose unfurl domains are this deployment's content domain and app host.
 */
export function slackSetup(
  env: Pick<Env, "APP_ORIGIN" | "CONTENT_DOMAIN">,
  region: Region,
  row: Pick<ConnectionRecord, "id" | "service" | "manifestVersion">,
): SlackSetupView | null {
  if (row.service !== "slack") return null;
  const origin = authUrls(env.APP_ORIGIN).origin;
  const requestUrl = `${origin}${slackEventsPath(region, row.id)}`;
  const manifest = slackManifest({
    requestUrl,
    unfurlDomains: [env.CONTENT_DOMAIN, new URL(origin).host],
  });
  return {
    requestUrl,
    manifest: JSON.stringify(manifest, null, 2),
    createUrl: slackCreateUrl(manifest),
    manifestVersion: row.manifestVersion,
    outdated: slackManifestOutdated(row.manifestVersion),
  };
}

/** The sealing keys of the app Worker: it seals what admins paste and opens it to test. */
export function appIntegrationKeys(env: Env) {
  return integrationKeys({
    current: env.INTEGRATIONS_KEY,
    previous: env.INTEGRATIONS_KEY_PREVIOUS,
  });
}

export function choiceListView(listing: ChoiceListing): IntegrationChoiceList {
  return IntegrationChoiceList.parse(listing);
}

export function connectionView(
  row: ConnectionRecord,
  slack: SlackSetupView | null = null,
): IntegrationConnectionView {
  const { manifestVersion: _, ...shown } = row;
  return IntegrationConnectionView.parse({
    ...shown,
    slack,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}

export function threadIssueView(row: ThreadIssueRecord): ThreadIssueView {
  return ThreadIssueView.parse({ ...row, createdAt: iso(row.createdAt) });
}

const notFound = "Connection not found.";

/** The space the request names (`?workspace=<slug>`), as for webhooks and usage. */
async function scopeOf(c: ApiContext, userId: string) {
  const workspace = workspaceParam(c);
  if (!workspace.ok) {
    return { ok: false as const, response: error(c, "not_found", "Workspace not found.") };
  }
  const scope = await ownerScope(c.env, userId, workspace.slug);
  if (!scope.ok) return { ok: false as const, response: error(c, scope.code, scope.message) };
  return { ok: true as const, actor: scope.value.actor, db: scope.value.db };
}

/** The read and issue routes, behind the API's bearer-or-session gate. */
export function integrationApiRoutes(
  api: Hono<{ Bindings: Env }>,
  guarded: Guarded,
  now: () => number,
) {
  api.get(
    "/api/v1/integrations",
    guarded("artifacts:read", async (c, userId) => {
      const scope = await scopeOf(c, userId);
      if (!scope.ok) return scope.response;
      const result = await listIntegrationChoices(scope.db, {
        actor: scope.actor,
        service: integrationSwitch(c.env),
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(choiceListView(result.value));
    }),
  );

  api.post(
    "/api/v1/artifacts/:artifactId/annotations/threads/:threadId/issue",
    guarded("annotations:moderate", async (c, userId) => {
      const key = IdempotencyKey.safeParse(c.req.header("idempotency-key"));
      if (!key.success) {
        return error(c, "invalid_input", "Send an Idempotency-Key header (8 to 128 characters).");
      }
      const body = await readJson(c, ThreadIssueCreate, 4_096);
      if (!body.ok) return body.response;
      const artifactId = c.req.param("artifactId") as string;
      const result = await requestThreadIssue(await artifactDb(c.env, artifactId), {
        userId,
        artifactId,
        threadId: c.req.param("threadId") as string,
        request: body.value,
        idempotencyKey: key.data,
        service: integrationSwitch(c.env),
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(threadIssueView(result.value), 202);
    }),
  );
}

export interface IntegrationRouteDeps {
  /** The dashboard session's user; a session without the current terms counts as none. */
  session(env: Env): SessionLookup;
  /** The network to GitHub and Linear: the Worker's `fetch`, or the fakes in tests. */
  fetch(env: Env): IntegrationFetch;
  now(): number;
}

function fail(c: ApiContext, code: ErrorCode, message: string): Response {
  return c.json({ error: { code, message } }, ERROR_STATUS[code] as 400);
}

/** The routes only the dashboard's session reaches: managing connections. */
export function integrationRoutes(deps: IntegrationRouteDeps) {
  const routes = new Hono<{ Bindings: Env }>();

  const sessionOnly =
    (handler: (c: ApiContext, userId: string) => Promise<Response>) =>
    async (c: Context<{ Bindings: Env }>) => {
      c.header("Cache-Control", "no-store");
      const request = c.req.raw;
      // A connection holds a credential for another service: no token, of any kind, manages one.
      if (request.headers.has("authorization")) {
        return fail(c, "forbidden", "Connections are managed in the dashboard.");
      }
      if (!hasSessionCookie(request.headers.get("cookie"))) {
        return fail(c, "unauthenticated", "Sign in to manage connections.");
      }
      if (!fromAppOrigin(request, authUrls(c.env.APP_ORIGIN).origin)) {
        return fail(c, "forbidden", "Cross-origin request refused.");
      }
      const userId = await deps.session(c.env)(request);
      if (!userId) return fail(c, "unauthenticated", "Sign in to manage connections.");
      return handler(c, userId);
    };

  const callDeps = async (c: ApiContext): Promise<IntegrationDeps> => ({
    keys: await appIntegrationKeys(c.env),
    service: integrationSwitch(c.env),
    fetch: deps.fetch(c.env),
  });

  const connectionId = (c: ApiContext) => {
    const parsed = IntegrationConnectionId.safeParse(c.req.param("connectionId"));
    return parsed.success ? parsed.data : null;
  };

  routes.get(
    "/api/v1/integrations/connections",
    sessionOnly(async (c, userId) => {
      const scope = await scopeOf(c, userId);
      if (!scope.ok) return scope.response;
      const result = await listIntegrationConnections(scope.db, {
        actor: scope.actor,
        service: integrationSwitch(c.env),
        now: deps.now(),
      });
      if (!result.ok) return fail(c, result.code, result.message);
      return c.json(
        IntegrationConnectionList.parse({
          connections: result.value.connections.map((row) =>
            connectionView(row, slackSetup(c.env, scope.actor.region, row)),
          ),
          available: result.value.available,
          serviceAvailable: result.value.serviceAvailable,
          slackAvailable: integrationSwitch(c.env).slack,
          limit: INTEGRATION_LIMITS.perOwner,
          targetLimit: INTEGRATION_LIMITS.targetsPerConnection,
        }),
      );
    }),
  );

  // No idempotency key: a stored replay would keep the answer around, and a retried create makes
  // a second connection the admin removes (as webhooks do, decision 0009).
  routes.post(
    "/api/v1/integrations/connections",
    sessionOnly(async (c, userId) => {
      const body = await readJson(c, IntegrationCreate, 4_096);
      if (!body.ok) return body.response;
      const scope = await scopeOf(c, userId);
      if (!scope.ok) return scope.response;
      const result = await createIntegrationConnection(scope.db, {
        actor: scope.actor,
        connection: body.value,
        deps: await callDeps(c),
        now: deps.now(),
      });
      if (!result.ok) return fail(c, result.code, result.message);
      return c.json(
        connectionView(result.value, slackSetup(c.env, scope.actor.region, result.value)),
        201,
      );
    }),
  );

  routes.patch(
    "/api/v1/integrations/connections/:connectionId",
    sessionOnly(async (c, userId) => {
      const id = connectionId(c);
      if (!id) return fail(c, "not_found", notFound);
      const body = await readJson(c, IntegrationUpdate, 4_096);
      if (!body.ok) return body.response;
      const scope = await scopeOf(c, userId);
      if (!scope.ok) return scope.response;
      const result = await updateIntegrationConnection(scope.db, {
        actor: scope.actor,
        connectionId: id,
        update: body.value,
        deps: await callDeps(c),
        now: deps.now(),
      });
      if (!result.ok) return fail(c, result.code, result.message);
      return c.json(
        connectionView(result.value, slackSetup(c.env, scope.actor.region, result.value)),
      );
    }),
  );

  routes.post(
    "/api/v1/integrations/connections/:connectionId/test",
    sessionOnly(async (c, userId) => {
      const id = connectionId(c);
      if (!id) return fail(c, "not_found", notFound);
      const scope = await scopeOf(c, userId);
      if (!scope.ok) return scope.response;
      const result = await testIntegrationConnection(scope.db, {
        actor: scope.actor,
        connectionId: id,
        deps: await callDeps(c),
        now: deps.now(),
      });
      if (!result.ok) return fail(c, result.code, result.message);
      return c.json(IntegrationTestResult.parse(result.value));
    }),
  );

  routes.delete(
    "/api/v1/integrations/connections/:connectionId",
    sessionOnly(async (c, userId) => {
      const id = connectionId(c);
      if (!id) return fail(c, "not_found", notFound);
      const scope = await scopeOf(c, userId);
      if (!scope.ok) return scope.response;
      const result = await removeIntegrationConnection(scope.db, {
        actor: scope.actor,
        connectionId: id,
        now: deps.now(),
        // A removed Slack connection's token is revoked at Slack after the answer (decision 0025).
        slack: {
          enabled: integrationSwitch(c.env).slack,
          keys: await appIntegrationKeys(c.env),
          fetch: deps.fetch(c.env),
          defer: (task) => c.executionCtx.waitUntil(task),
        },
      });
      if (!result.ok) return fail(c, result.code, result.message);
      return c.json({ connectionId: id, removed: true });
    }),
  );

  return routes;
}
