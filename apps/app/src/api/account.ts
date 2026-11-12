// The account endpoints under /api/v1/account (plan section 6, "Cuenta"): the signed-in user's
// browser sessions, connected apps, defaults for new artifacts, data export and deletion. They answer only the dashboard's session cookie from the
// app's own pages. Bearer tokens are refused: account management has no OAuth scope. The CLI
// lists and revokes the same connected apps through ./tokens.ts, with its own narrow scope.
//
// A session of an account that has not accepted the current terms reaches only what lets a
// person leave without accepting them (docs/legal.md, "Leaving without accepting"): each route is
// named in `ACCOUNT_ROUTE_OPERATIONS` and classified by `accountSessionUsableWithoutCurrentTerms`
// (reads, removals, narrowing changes, the export and the deletions); anything else, or a route
// without a name, answers `terms_not_accepted` (fail closed).
import {
  AccountDeletionCodeRequest,
  AccountDeletionCodeSent,
  AccountDeletionInput,
  AccountDeletionResult,
  AccountDeletionWithCodeInput,
  AccountExport,
  AccountSettings,
  AccountSettingsUpdate,
  AccountSuspensionView,
  type AppResource,
  ArtifactId,
  BRAND_LIMITS,
  BrandSettings,
  BrandUpdate,
  BrowserSessionList,
  CommentNoticeMute,
  CommentNoticeMuteUpdate,
  type ConnectedApp,
  ConnectedAppList,
  DisconnectResult,
  ERROR_STATUS,
  type ErrorCode,
  type ErrorDetail,
  SignOutOthersResult,
  WorkspaceParam,
} from "@portifact/contracts";
import { accountSessionUsableWithoutCurrentTerms } from "@portifact/domain";
import {
  accountSuspensionView,
  type ConnectedAppRow,
  deleteAccountWithCode,
  deleteBrand,
  disconnectApp,
  exportAccount,
  getAccountSettings,
  getBrandSettings,
  getCommentNoticeMute,
  issueAccountDeletionCode,
  listBrowserSessions,
  listConnectedApps,
  RecipientSuppressedError,
  readBrandLogo,
  removeBrandLogo,
  requestAccountDeletion,
  setBrandLogo,
  setCommentNoticeMute,
  updateAccountSettings,
  updateBrand,
} from "@portifact/services";
import type { Context } from "hono";
import { Hono } from "hono";
import { authUrls, CLI_CLIENT_ID } from "../auth/config.ts";
import { deliverAccountDeletionCode, type EmailSender, emailLocale } from "../auth/email.ts";
import { checkLimits, deletionCodeAttemptChecks, deletionCodeSendChecks } from "../auth/limits.ts";
import type { Env } from "../env.ts";
import { artifactDb, bucketOf, defaultDb, ownerScope, regionsOf } from "../regions.ts";
import { fromAppOrigin, hasSessionCookie, SESSION_COOKIE } from "./access.ts";
import { readJson } from "./http.ts";
import { accountRouteOperation } from "./terms-operations.ts";

/** The dashboard session behind a request: its user and the session's own ID. */
export interface AccountSession {
  userId: string;
  sessionId: string;
  /** Whether the account accepted the current terms (`needsTermsAcceptance`). */
  termsAccepted: boolean;
}

export type AccountSessionLookup = (request: Request) => Promise<AccountSession | undefined>;

export interface AccountDeps {
  session(env: Env): AccountSessionLookup;
  /**
   * Ends every other session of the request's user through Better Auth, so its session hooks
   * run: they revoke the tokens that apps received through those browser sessions.
   */
  signOutOthers(env: Env): (request: Request) => Promise<void>;
  /** Sends the account deletion code. */
  email(env: Env): EmailSender;
  now(): number;
}

type AccountContext = Context<{ Bindings: Env }>;

export function accountRoutes(deps: AccountDeps) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.use("/api/v1/account/*", async (c, next) => {
    await next();
    c.res.headers.set("Cache-Control", "no-store");
  });

  /**
   * Runs `handler` for the dashboard session of the request, or refuses it. A session of an
   * account without the current terms runs only the operations the domain rule leaves open, by
   * the route's name (`accountRouteOperation`); an unnamed route is refused to it.
   */
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
      const operation = accountRouteOperation(c.req.method, c.req.routePath);
      if (!session.termsAccepted && !accountSessionUsableWithoutCurrentTerms(operation)) {
        return error(
          c,
          "terms_not_accepted",
          "Accept the current terms in the dashboard to change your account.",
        );
      }
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
            signInMethod: row.signInMethod,
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

  // Whether the operator suspended this account, with the statement of reasons (operations.md,
  // "Reports"), for the Settings page. Session only, like every account endpoint.
  routes.get(
    "/api/v1/account/suspension",
    sessionOnly(async (c, session) =>
      c.json(
        AccountSuspensionView.parse(await accountSuspensionView(defaultDb(c.env), session.userId)),
      ),
    ),
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

  // The brand of the account's space on the viewer's bar (premium plan P9). Session only, like
  // the other account settings: a leaked token must never be able to dress the bar as someone
  // else, and agents have no use for it (decision 0003 keeps credentials-like powers narrow).
  // `?workspace=<slug>` names a workspace, as on the other owner-scoped routes; without it the
  // personal space. The services decide the role (`brand`, admins only) and the plan (the
  // owner's), and a workspace the user is not in answers like a missing one.
  const brandRoute = "/api/v1/account/branding";
  const brandScope = async (c: AccountContext, session: AccountSession) => {
    const raw = c.req.query("workspace");
    const slug = raw === undefined || raw === "" ? undefined : WorkspaceParam.safeParse(raw);
    if (slug && !slug.success) {
      return { ok: false as const, code: "not_found" as const, message: "Workspace not found." };
    }
    return ownerScope(c.env, session.userId, slug?.data);
  };
  const brandAnswer = (c: AccountContext, result: Awaited<ReturnType<typeof getBrandSettings>>) =>
    result.ok ? c.json(BrandSettings.parse(result.value)) : error(c, result.code, result.message);

  routes.get(
    brandRoute,
    sessionOnly(async (c, session) => {
      const scope = await brandScope(c, session);
      if (!scope.ok) return error(c, scope.code, scope.message);
      const { actor, db } = scope.value;
      return brandAnswer(c, await getBrandSettings(db, { actor, now: deps.now() }));
    }),
  );

  routes.put(
    brandRoute,
    sessionOnly(async (c, session) => {
      const body = await readJson(c, BrandUpdate, 4096);
      if (!body.ok) return body.response;
      const scope = await brandScope(c, session);
      if (!scope.ok) return error(c, scope.code, scope.message);
      const { actor, db } = scope.value;
      return brandAnswer(
        c,
        await updateBrand(db, {
          actor,
          update: body.value,
          blockedHosts: [new URL(c.env.APP_ORIGIN).hostname, c.env.CONTENT_DOMAIN],
          now: deps.now(),
        }),
      );
    }),
  );

  routes.delete(
    brandRoute,
    sessionOnly(async (c, session) => {
      const scope = await brandScope(c, session);
      if (!scope.ok) return error(c, scope.code, scope.message);
      const { actor, db } = scope.value;
      return brandAnswer(c, await deleteBrand(db, { actor, now: deps.now() }));
    }),
  );

  // The logo is sent as the raw bytes of the file; its declared type and name are ignored, and
  // the services judge it by its bytes.
  routes.put(
    `${brandRoute}/logo`,
    sessionOnly(async (c, session) => {
      const bytes = await readBounded(c.req.raw, BRAND_LIMITS.logoMaxBytes);
      if (bytes === null) {
        return error(
          c,
          "invalid_input",
          `logo: Use an image of at most ${BRAND_LIMITS.logoMaxBytes / 1000} KB.`,
        );
      }
      const scope = await brandScope(c, session);
      if (!scope.ok) return error(c, scope.code, scope.message);
      const { actor, db } = scope.value;
      const bucket = bucketOf(regionsOf(c.env).get(actor.region));
      return brandAnswer(c, await setBrandLogo(db, bucket, { actor, bytes, now: deps.now() }));
    }),
  );

  routes.delete(
    `${brandRoute}/logo`,
    sessionOnly(async (c, session) => {
      const scope = await brandScope(c, session);
      if (!scope.ok) return error(c, scope.code, scope.message);
      const { actor, db } = scope.value;
      return brandAnswer(c, await removeBrandLogo(db, { actor, now: deps.now() }));
    }),
  );

  // The stored logo for the Branding page's own preview: same-origin and session only, so it is
  // never an address another site can show; served as an image that can never run.
  routes.get(
    `${brandRoute}/logo`,
    sessionOnly(async (c, session) => {
      const scope = await brandScope(c, session);
      if (!scope.ok) return error(c, scope.code, scope.message);
      const { actor, db } = scope.value;
      const logo = await readBrandLogo(db, bucketOf(regionsOf(c.env).get(actor.region)), {
        actor,
      });
      if (!logo.ok) return error(c, logo.code, logo.message);
      return new Response(logo.value.body, {
        headers: {
          "Content-Type": logo.value.type,
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Cross-Origin-Resource-Policy": "same-origin",
          "Content-Disposition": "inline",
        },
      });
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
      const result = await requestAccountDeletion(regionsOf(c.env), {
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

  // Leaving without accepting new terms (docs/legal.md, "Leaving without accepting"): the
  // account deletion code, emailed to the account's address for a session of an account without
  // the current terms. It never signs anyone in and records no acceptance; the code is never
  // logged or returned.
  routes.post(
    "/api/v1/account/deletion-code",
    sessionOnly(async (c, session) => {
      const body = await readJson(c, AccountDeletionCodeRequest, 256);
      if (!body.ok) return body.response;
      const now = deps.now();
      const ip = c.req.header("cf-connecting-ip") ?? "unknown";
      const limited = await checkLimits(c.env.DB, deletionCodeSendChecks(session.userId, ip), now);
      if (!limited.ok) return tooMany(c, limited.retryAfterSeconds);
      const global = regionsOf(c.env).global;
      const issued = await issueAccountDeletionCode(global, {
        userId: session.userId,
        sessionId: session.sessionId,
        secret: c.env.BETTER_AUTH_SECRET,
        now,
      });
      if (!issued.ok) return error(c, issued.code, issued.message, issued.detail);
      try {
        await deliverAccountDeletionCode(global, deps.email(c.env), {
          email: issued.value.email,
          code: issued.value.code,
          expiresInMinutes: issued.value.expiresInMinutes,
          now: deps.now,
          locale: emailLocale(c.req.raw.headers),
        });
      } catch (failure) {
        if (failure instanceof RecipientSuppressedError) {
          return error(
            c,
            "forbidden",
            "We cannot send email to your account's address because earlier messages to it bounced or were reported as spam. Write to privacy@portifact.com to delete your account.",
            "email_suppressed",
          );
        }
        return error(c, "capacity_unavailable", "The email could not be sent. Try again later.");
      }
      return c.json(
        AccountDeletionCodeSent.parse({
          sent: true,
          expiresInMinutes: issued.value.expiresInMinutes,
        }),
      );
    }),
  );

  routes.post(
    "/api/v1/account/delete-with-code",
    sessionOnly(async (c, session) => {
      const body = await readJson(c, AccountDeletionWithCodeInput, 256);
      if (!body.ok) return body.response;
      const now = deps.now();
      const ip = c.req.header("cf-connecting-ip") ?? "unknown";
      const limited = await checkLimits(c.env.DB, deletionCodeAttemptChecks(ip), now);
      if (!limited.ok) return tooMany(c, limited.retryAfterSeconds);
      const result = await deleteAccountWithCode(regionsOf(c.env), {
        userId: session.userId,
        sessionId: session.sessionId,
        secret: c.env.BETTER_AUTH_SECRET,
        code: body.value.code,
        now,
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
    signInMethod: row.signInMethod,
  });
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** The request body, or null when it is longer than `max` bytes; never reads past it. */
async function readBounded(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > max) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

function error(
  c: AccountContext,
  code: ErrorCode,
  message: string,
  detail?: ErrorDetail | undefined,
): Response {
  const body = detail ? { code, message, details: { reason: detail } } : { code, message };
  return c.json({ error: body }, ERROR_STATUS[code] as 400);
}

function tooMany(c: AccountContext, retryAfterSeconds: number): Response {
  c.header("Retry-After", String(retryAfterSeconds));
  return error(c, "rate_limited", "Too many requests. Wait a moment and try again.");
}
