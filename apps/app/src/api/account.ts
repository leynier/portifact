// The account endpoints under /api/v1/account (plan section 6, "Cuenta"): the signed-in user's
// browser sessions, connected apps, defaults for new artifacts, data export and deletion. They answer only the dashboard's session cookie from the
// app's own pages. Bearer tokens are refused: account management has no OAuth scope. The CLI
// lists and revokes the same connected apps through ./tokens.ts, with its own narrow scope.
import {
  AccountDeletionInput,
  AccountDeletionResult,
  AccountExport,
  AccountSettings,
  AccountSettingsUpdate,
  type AppResource,
  ArtifactId,
  BrowserSessionList,
  CommentNoticeMute,
  CommentNoticeMuteUpdate,
  type ConnectedApp,
  ConnectedAppList,
  DisconnectResult,
  ERROR_STATUS,
  type ErrorCode,
  SignOutOthersResult,
} from "@portifact/contracts";
import {
  type ConnectedAppRow,
  disconnectApp,
  exportAccount,
  getAccountSettings,
  getCommentNoticeMute,
  listBrowserSessions,
  listConnectedApps,
  requestAccountDeletion,
  setCommentNoticeMute,
  updateAccountSettings,
} from "@portifact/services";
import type { Context } from "hono";
import { Hono } from "hono";
import { authUrls, CLI_CLIENT_ID } from "../auth/config.ts";
import type { Env } from "../env.ts";
import { artifactDb, defaultDb, regionsOf } from "../regions.ts";
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
      const rows = await listBrowserSessions(regionsOf(c.env).global, {
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
        await listBrowserSessions(regionsOf(c.env).global, {
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
      const rows = await listConnectedApps(regionsOf(c.env).global, {
        userId: session.userId,
        now: deps.now(),
      });
      const present = connectedAppView(c.env.APP_ORIGIN);
      return c.json(ConnectedAppList.parse({ items: rows.map(present) }));
    }),
  );

  routes.delete(
    "/api/v1/account/apps/:clientId",
    sessionOnly(async (c, session) => {
      const result = await disconnectApp(regionsOf(c.env).global, {
        userId: session.userId,
        clientId: c.req.param("clientId") as string,
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(
        DisconnectResult.parse({ clientId: result.value.clientId, disconnected: true }),
      );
    }),
  );

  // Defaults for new artifacts, applied by the publish service for every client.
  routes.get(
    "/api/v1/account/settings",
    sessionOnly(async (c, session) => {
      const result = await getAccountSettings(regionsOf(c.env).global, { userId: session.userId });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(AccountSettings.parse(result.value));
    }),
  );

  routes.patch(
    "/api/v1/account/settings",
    sessionOnly(async (c, session) => {
      const body = await readJson(c, AccountSettingsUpdate, 1024);
      if (!body.ok) return body.response;
      const result = await updateAccountSettings(regionsOf(c.env).global, {
        userId: session.userId,
        update: body.value,
        now: deps.now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(AccountSettings.parse(result.value));
    }),
  );

  // The caller's comment notices for one artifact: whether the owner's plan has them and the
  // caller's mute. A personal preference, like the settings, so it has no MCP tool or CLI command.
  const muteRoute = "/api/v1/account/comment-notices/:artifactId";
  routes.get(
    muteRoute,
    sessionOnly(async (c, session) => {
      const artifactId = ArtifactId.safeParse(c.req.param("artifactId"));
      if (!artifactId.success) return error(c, "not_found", "Artifact not found.");
      const result = await getCommentNoticeMute(await artifactDb(c.env, artifactId.data), {
        userId: session.userId,
        artifactId: artifactId.data,
        now: deps.now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(CommentNoticeMute.parse(result.value));
    }),
  );

  routes.put(
    muteRoute,
    sessionOnly(async (c, session) => {
      const artifactId = ArtifactId.safeParse(c.req.param("artifactId"));
      if (!artifactId.success) return error(c, "not_found", "Artifact not found.");
      const body = await readJson(c, CommentNoticeMuteUpdate, 256);
      if (!body.ok) return body.response;
      const result = await setCommentNoticeMute(await artifactDb(c.env, artifactId.data), {
        userId: session.userId,
        artifactId: artifactId.data,
        muted: body.value.muted,
        now: deps.now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(CommentNoticeMute.parse(result.value));
    }),
  );

  // The account's data as a JSON download, offered before deletion (plan section 5).
  routes.get(
    "/api/v1/account/export",
    sessionOnly(async (c, session) => {
      const now = deps.now();
      const result = await exportAccount(defaultDb(c.env), { userId: session.userId, now });
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
      const result = await requestAccountDeletion(defaultDb(c.env), {
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

/**
 * How a connected app is shown, the same for the dashboard (`/api/v1/account/apps`) and the CLI
 * (`/api/v1/tokens`): only Portifact's own resources are named, and no token ever appears.
 */
export function connectedAppView(appOrigin: string): (row: ConnectedAppRow) => ConnectedApp {
  const urls = authUrls(appOrigin);
  const known: Record<string, AppResource> = {
    [urls.apiResource]: "api",
    [urls.mcpResource]: "mcp",
  };
  return (row) => ({
    clientId: row.clientId,
    name: row.name,
    firstParty: row.clientId === CLI_CLIENT_ID,
    resources: row.resources.flatMap((resource) => known[resource] ?? []),
    scopes: row.scopes,
    approvedAt: iso(row.approvedAt),
    lastIssuedAt: iso(row.lastIssuedAt),
    expiresAt: row.expiresAt === null ? null : iso(row.expiresAt),
  });
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function error(c: AccountContext, code: ErrorCode, message: string): Response {
  return c.json({ error: { code, message } }, ERROR_STATUS[code] as 400);
}
