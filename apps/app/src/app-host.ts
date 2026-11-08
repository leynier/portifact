// app.portifact.com: the dashboard, identity, the OAuth authorization server, protected
// resource metadata and the auth pages. Every path not listed here answers 404.
import { TokenPrincipal } from "@portifact/contracts";
import { needsTermsAcceptance } from "@portifact/domain";
import { Hono } from "hono";
import type { SessionLookup } from "./api/access.ts";
import { type AccountSessionLookup, accountRoutes } from "./api/account.ts";
import { r2Presigner } from "./api/presign.ts";
import { reportRoutes } from "./api/reports.ts";
import { apiRoutes } from "./api/routes.ts";
import { type Auth, createAuth } from "./auth/auth.ts";
import { authUrls, MCP_BASELINE_SCOPES } from "./auth/config.ts";
import type { AuthDeps } from "./auth/deps.ts";
import {
  authorizeResourceRequest,
  type Introspect,
  type IntrospectionPayload,
  type ProtectedResource,
  protectedResourceMetadata,
} from "./auth/resource.ts";
import { authRoutes } from "./auth/routes.ts";
import type { Env } from "./env.ts";
import { mcpRoutes } from "./mcp/routes.ts";
import { readRoutes } from "./read.ts";

/**
 * Pages built by apps/web and served from static assets on this host only: the auth pages and
 * the public abuse report form.
 */
export const AUTH_PAGES = ["/login", "/device", "/consent", "/report"] as const;

/** The dashboard SPA, built by apps/web as dashboard.html and served on this host only. */
export const DASHBOARD_PAGE = "/dashboard";

/**
 * Client routes of the dashboard (apps/web/src/dashboard/router.tsx). Each one serves the SPA;
 * any other path keeps answering 404, so a typo never looks like an empty dashboard.
 */
export const DASHBOARD_ROUTES = ["/", "/artifacts/:artifactId", "/account"] as const;

/** Static files the auth pages load. Hashed bundles under /assets/ skip the Worker. */
const STATIC_FILES = ["/favicon.svg", "/favicon.ico"];

// Strict policy for the dashboard and the auth pages: only same-origin scripts, styles, images and requests,
// no framing, no plugins and no base or form targets elsewhere.
export const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

export function createAppHost(depsFor: (env: Env) => AuthDeps) {
  // One Better Auth instance per environment object, which is stable per isolate.
  const instances = new WeakMap<Env, Auth>();
  const authFor = (env: Env): Auth => {
    let auth = instances.get(env);
    if (!auth) {
      auth = createAuth(env, depsFor(env));
      instances.set(env, auth);
    }
    return auth;
  };

  const introspectFor =
    (env: Env): Introspect =>
    async (token) =>
      (await authFor(env).api.introspectBearer({
        headers: new Headers({ authorization: `Bearer ${token}` }),
      })) as IntrospectionPayload;

  // The signed-in user behind the dashboard's session cookie, checked against D1. A session of
  // an account that has not accepted the current terms counts as none, so the dashboard sends
  // it to the login page, which asks for the acceptance.
  const sessionUserFor =
    (env: Env): SessionLookup =>
    async (request) => {
      const session = await authFor(env).api.getSession({ headers: request.headers });
      return session && !needsTermsAcceptance(session.user.termsVersion)
        ? session.user.id
        : undefined;
    };

  // The same session with its own ID, for the account endpoints that tell it from the others.
  const accountSessionFor =
    (env: Env): AccountSessionLookup =>
    async (request) => {
      const found = await authFor(env).api.getSession({ headers: request.headers });
      return found ? { userId: found.user.id, sessionId: found.session.id } : undefined;
    };

  const presignerFor = (env: Env) =>
    r2Presigner({
      accountId: env.R2_ACCOUNT_ID,
      bucket: env.R2_BUCKET,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    });

  const resources = (env: Env) => {
    const urls = authUrls(env.APP_ORIGIN);
    const resource = (identifier: string, name: string): ProtectedResource => ({
      identifier,
      name,
      issuer: urls.issuer,
      challengeScopes: MCP_BASELINE_SCOPES,
    });
    return {
      api: resource(urls.apiResource, "Portifact API"),
      mcp: resource(urls.mcpResource, "Portifact MCP"),
    };
  };

  const app = new Hono<{ Bindings: Env }>();

  app.use("*", async (c, next) => {
    await next();
    // Responses from assets and redirects have immutable headers; copy before setting.
    c.res = new Response(c.res.body, c.res);
    c.res.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    c.res.headers.set("X-Frame-Options", "DENY");
  });

  // RFC 9728 protected resource metadata, with the path of each resource inserted.
  app.get("/.well-known/oauth-protected-resource/mcp", (c) =>
    c.json(protectedResourceMetadata(resources(c.env).mcp)),
  );
  app.get("/.well-known/oauth-protected-resource/api/v1", (c) =>
    c.json(protectedResourceMetadata(resources(c.env).api)),
  );

  // RFC 8414 authorization server metadata for the issuer path. Better Auth answers it.
  app.on(["GET", "HEAD"], "/.well-known/oauth-authorization-server/api/auth", (c) =>
    authFor(c.env).handler(c.req.raw),
  );

  app.route("/", authRoutes(authFor));
  app.route(
    "/",
    apiRoutes({
      introspect: introspectFor,
      resource: (env) => resources(env).api,
      session: sessionUserFor,
      presigner: presignerFor,
      now: () => Date.now(),
    }),
  );
  app.route(
    "/",
    accountRoutes({
      session: accountSessionFor,
      signOutOthers: (env) => async (request) => {
        await authFor(env).api.revokeOtherSessions({ headers: request.headers });
      },
      now: () => Date.now(),
    }),
  );
  app.route("/", reportRoutes({ now: () => Date.now() }));
  app.route("/", readRoutes(authFor));

  // Who the token belongs to. Any valid API token works; no scope is needed.
  app.get("/api/v1/me", async (c) => {
    const decision = await authorizeResourceRequest(
      introspectFor(c.env),
      c.req.raw,
      resources(c.env).api,
      [],
    );
    if (!decision.ok) return decision.response;
    c.header("Cache-Control", "no-store");
    return c.json(TokenPrincipal.parse(decision.principal));
  });

  app.route(
    "/",
    mcpRoutes({
      introspect: introspectFor,
      resource: (env) => resources(env).mcp,
      presigner: presignerFor,
      now: () => Date.now(),
    }),
  );

  // The landing's "Sign in" link points at the root. Without a session the visitor goes to the
  // login page, which comes back here after signing in.
  for (const route of DASHBOARD_ROUTES) {
    app.get(route, async (c) => {
      c.header("Cache-Control", "no-store");
      if (!(await sessionUserFor(c.env)(c.req.raw))) {
        const url = new URL(c.req.url);
        const next = `${url.pathname}${url.search}`;
        return c.redirect(`/login?${new URLSearchParams({ next })}`, 302);
      }
      return trustedPage(await c.env.ASSETS.fetch(new Request(new URL(DASHBOARD_PAGE, c.req.url))));
    });
  }

  for (const page of AUTH_PAGES) {
    app.get(page, async (c) =>
      trustedPage(await c.env.ASSETS.fetch(new Request(new URL(page, c.req.url)))),
    );
  }

  for (const file of STATIC_FILES) {
    app.get(file, (c) => c.env.ASSETS.fetch(c.req.raw));
  }
  app.get("/assets/*", (c) => c.env.ASSETS.fetch(c.req.raw));

  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found." } }, 404));

  return { app, authFor };
}

/** Headers of every page on the app host: strict CSP, never cached, no referrer. */
function trustedPage(asset: Response): Response {
  const response = new Response(asset.body, asset);
  response.headers.set("Content-Security-Policy", PAGE_CSP);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
