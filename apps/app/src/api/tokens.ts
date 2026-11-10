// The account's own tokens for the CLI (plan section 6, "Credenciales", and `portifact tokens`):
// the apps holding live tokens and revoking one of them. Bearer tokens only, with the
// `credentials:manage` scope that only the first-party CLI can obtain (decision 0003). The
// dashboard does the same through its session-only /api/v1/account/apps; both run the same
// services and show apps the same way (connectedAppView). There is no MCP tool: MCP clients can
// never hold the scope.
import {
  CREDENTIALS_SCOPE,
  ERROR_STATUS,
  type ErrorCode,
  TokenGrantList,
  TokenRevokeResult,
} from "@portifact/contracts";
import { regionsOf } from "../regions.ts";
import { disconnectApp, listConnectedApps } from "@portifact/services";
import { type Context, Hono } from "hono";
import {
  authorizeResourceRequest,
  type Introspect,
  type ProtectedResource,
} from "../auth/resource.ts";
import type { Env } from "../env.ts";
import { connectedAppView } from "./account.ts";

export interface TokenDeps {
  introspect(env: Env): Introspect;
  /** The API resource: tokens for any other audience are refused. */
  resource(env: Env): ProtectedResource;
  now(): number;
}

type TokenContext = Context<{ Bindings: Env }>;

export function tokenRoutes(deps: TokenDeps) {
  const routes = new Hono<{ Bindings: Env }>();

  /**
   * Runs `handler` for a bearer token of the API resource that holds `credentials:manage`. A
   * session cookie alone is never enough here: without a bearer token the answer is the 401
   * challenge.
   */
  const withCredentialsScope =
    (
      handler: (c: TokenContext, caller: { userId: string; clientId: string }) => Promise<Response>,
    ) =>
    async (c: TokenContext) => {
      const decision = await authorizeResourceRequest(
        deps.introspect(c.env),
        c.req.raw,
        deps.resource(c.env),
        [CREDENTIALS_SCOPE],
      );
      if (!decision.ok) return decision.response;
      c.header("Cache-Control", "no-store");
      return handler(c, decision.principal);
    };

  routes.get(
    "/api/v1/tokens",
    withCredentialsScope(async (c, caller) => {
      const rows = await listConnectedApps(regionsOf(c.env).global, {
        userId: caller.userId,
        now: deps.now(),
      });
      const present = connectedAppView(c.env.APP_ORIGIN);
      return c.json(
        TokenGrantList.parse({
          items: rows.map((row) => ({
            ...present(row),
            current: row.clientId === caller.clientId,
          })),
        }),
      );
    }),
  );

  // Revokes every token the app holds for this account and its consent, like the dashboard's
  // "Disconnect". Revoking the calling app ends the caller's own token too.
  routes.delete(
    "/api/v1/tokens/:clientId",
    withCredentialsScope(async (c, caller) => {
      const clientId = c.req.param("clientId") as string;
      const result = await disconnectApp(regionsOf(c.env).global, { userId: caller.userId, clientId });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(
        TokenRevokeResult.parse({
          clientId: result.value.clientId,
          revoked: true,
          current: result.value.clientId === caller.clientId,
        }),
      );
    }),
  );

  return routes;
}

function error(c: TokenContext, code: ErrorCode, message: string): Response {
  return c.json({ error: { code, message } }, ERROR_STATUS[code] as 400);
}
