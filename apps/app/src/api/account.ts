// The account endpoints under /api/v1/account (plan section 6, "Cuenta"): the signed-in user's
// browser sessions and connected apps. They answer only the dashboard's session cookie from the
// app's own pages. Bearer tokens are refused: no OAuth scope covers account and credential
// management yet, and a token must never list or revoke other credentials.
import {
  AccountDeletionInput,
  AccountDeletionResult,
  AccountExport,
  type AppResource,
  BrowserSessionList,
  ConnectedAppList,
  DisconnectResult,
  ERROR_STATUS,
  type ErrorCode,
  SignOutOthersResult,
} from "@portifact/contracts";
import { createDb } from "@portifact/db";
import {
  disconnectApp,
  exportAccount,
  listBrowserSessions,
  listConnectedApps,
  requestAccountDeletion,
} from "@portifact/services";
import type { Context } from "hono";
import { Hono } from "hono";
import { authUrls, CLI_CLIENT_ID } from "../auth/config.ts";
import type { Env } from "../env.ts";
import { fromAppOrigin, hasSessionCookie, SESSION_COOKIE } from "./access.ts";
import { readJson } from "./http.ts";

/** The dashboard session behind a request: its user and the session's own ID. */
export interface AccountSession {
  userId: string;
  sessionId: string;
}

export type AccountSessionLookup = (request: Request) => Promise<AccountSession | undefined>;

export interface AccountDeps {
  session(env: Env): AccountSessionLookup;
  /**
   * Ends every other session of the request's user through Better Auth, so its session hooks
   * run: they revoke the tokens that apps received through those browser sessions.
   */
  signOutOthers(env: Env): (request: Request) => Promise<void>;
  now(): number;
}

type AccountContext = Context<{ Bindings: Env }>;

export function accountRoutes(deps: AccountDeps) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.use("/api/v1/account/*", async (c, next) => {
    await next();
    c.res.headers.set("Cache-Control", "no-store");
  });

  /** Runs `handler` for the dashboard session of the request, or refuses it. */
  const sessionOnly =
    (handler: (c: AccountContext, session: AccountSession) => Promise<Response>) =>
    async (c: AccountContext) => {
      const request = c.req.raw;
      if (request.headers.has("authorization")) {
        return error(c, "forbidden", "Account settings need a dashboard session.");
      }
      if (!hasSessionCookie(request.headers.get("cookie"))) {
        return error(c, "unauthenticated", "Sign in to see your account.");
      }
      if (!fromAppOrigin(request, authUrls(c.env.APP_ORIGIN).origin)) {
        return error(c, "forbidden", "Cross-origin request refused.");
      }
      const session = await deps.session(c.env)(request);
      if (!session) return error(c, "unauthenticated", "Sign in to see your account.");
      return handler(c, session);
    };

  routes.get(
    "/api/v1/account/sessions",
    sessionOnly(async (c, session) => {
      const rows = await listBrowserSessions(createDb(c.env.DB), {
        userId: session.userId,
        currentSessionId: session.sessionId,
        now: deps.now(),
      });
      return c.json(
        BrowserSessionList.parse({
          items: rows.map((row) => ({
            current: row.current,
            userAgent: row.userAgent,
            createdAt: iso(row.createdAt),
            lastActiveAt: iso(row.lastActiveAt),
            expiresAt: iso(row.expiresAt),
          })),
        }),
      );
    }),
  );

  routes.post(
    "/api/v1/account/sessions/sign-out-others",
    sessionOnly(async (c, session) => {
      const others = (
        await listBrowserSessions(createDb(c.env.DB), {
          userId: session.userId,
          currentSessionId: session.sessionId,
          now: deps.now(),
        })
      ).filter((row) => !row.current).length;
      await deps.signOutOthers(c.env)(c.req.raw);
      return c.json(SignOutOthersResult.parse({ signedOut: others }));
    }),
  );

  routes.get(
    "/api/v1/account/apps",
    sessionOnly(async (c, session) => {
      const urls = authUrls(c.env.APP_ORIGIN);
      const known: Record<string, AppResource> = {
        [urls.apiResource]: "api",
        [urls.mcpResource]: "mcp",
      };
      const rows = await listConnectedApps(createDb(c.env.DB), {
        userId: session.userId,
        now: deps.now(),
      });
      return c.json(
        ConnectedAppList.parse({
          items: rows.map((row) => ({
            clientId: row.clientId,
            name: row.name,
            firstParty: row.clientId === CLI_CLIENT_ID,
            resources: row.resources.flatMap((resource) => known[resource] ?? []),
            scopes: row.scopes,
            approvedAt: iso(row.approvedAt),
            lastIssuedAt: iso(row.lastIssuedAt),
            expiresAt: row.expiresAt === null ? null : iso(row.expiresAt),
          })),
        }),
      );
    }),
  );

  routes.delete(
    "/api/v1/account/apps/:clientId",
    sessionOnly(async (c, session) => {
      const result = await disconnectApp(createDb(c.env.DB), {
        userId: session.userId,
        clientId: c.req.param("clientId") as string,
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(
        DisconnectResult.parse({ clientId: result.value.clientId, disconnected: true }),
      );
    }),
  );

  // The account's data as a JSON download, offered before deletion (plan section 5).
  routes.get(
    "/api/v1/account/export",
    sessionOnly(async (c, session) => {
      const now = deps.now();
      const result = await exportAccount(createDb(c.env.DB), { userId: session.userId, now });
      if (!result.ok) return error(c, result.code, result.message);
      const day = new Date(now).toISOString().slice(0, 10);
      c.header("Content-Disposition", `attachment; filename="portifact-export-${day}.json"`);
      return c.json(AccountExport.parse(result.value));
    }),
  );

  // Deletes the account: the email typed again and a session signed in within the last minutes.
  routes.post(
    "/api/v1/account/delete",
    sessionOnly(async (c, session) => {
      const body = await readJson(c, AccountDeletionInput, 1024);
      if (!body.ok) return body.response;
      const result = await requestAccountDeletion(createDb(c.env.DB), {
        userId: session.userId,
        sessionId: session.sessionId,
        confirmEmail: body.value.confirmEmail,
        now: deps.now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      // The session row is gone with the user; the browser forgets the cookie too.
      c.header(
        "Set-Cookie",
        `${SESSION_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`,
      );
      return c.json(AccountDeletionResult.parse({ deleted: true }));
    }),
  );

  return routes;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function error(c: AccountContext, code: ErrorCode, message: string): Response {
  return c.json({ error: { code, message } }, ERROR_STATUS[code] as 400);
}
