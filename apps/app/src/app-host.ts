// app.portifact.com: identity, the OAuth authorization server, protected resource metadata and
// the auth pages. Every path not listed here answers 404.
import { TokenPrincipal } from "@portifact/contracts";
import { Hono } from "hono";
import { r2Presigner } from "./api/presign.ts";
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
import { readRoutes } from "./read.ts";

/** Pages built by apps/web and served from static assets on this host only. */
export const AUTH_PAGES = ["/login", "/device", "/consent"] as const;

/** Static files the auth pages load. Hashed bundles under /assets/ skip the Worker. */
const STATIC_FILES = ["/favicon.svg", "/favicon.ico"];

// Strict policy for the auth pages: only same-origin scripts, styles, images and requests,
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
      presigner: (env) =>
        r2Presigner({
          accountId: env.R2_ACCOUNT_ID,
          bucket: env.R2_BUCKET,
          accessKeyId: env.R2_ACCESS_KEY_ID,
          secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        }),
      now: () => Date.now(),
    }),
  );
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

  // The MCP endpoint authenticates like the final server will, so clients can discover the
  // authorization server and sign in. The tools arrive in phase 5.
  app.all("/mcp", async (c) => {
    const decision = await authorizeResourceRequest(
      introspectFor(c.env),
      c.req.raw,
      resources(c.env).mcp,
      MCP_BASELINE_SCOPES,
    );
    if (!decision.ok) return decision.response;
    return c.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32601, message: "The Portifact MCP tools are not available yet." },
      },
      501,
    );
  });

  // The landing's "Sign in" link points here. Until the dashboard is served at the root, the
  // login page is the way in; it shows the signed-in account when there is a session.
  app.get("/", (c) => {
    c.header("Cache-Control", "no-store");
    return c.redirect("/login", 302);
  });

  for (const page of AUTH_PAGES) {
    app.get(page, async (c) => {
      const asset = await c.env.ASSETS.fetch(new Request(new URL(page, c.req.url)));
      const response = new Response(asset.body, asset);
      response.headers.set("Content-Security-Policy", PAGE_CSP);
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("Referrer-Policy", "no-referrer");
      return response;
    });
  }

  for (const file of STATIC_FILES) {
    app.get(file, (c) => c.env.ASSETS.fetch(c.req.raw));
  }
  app.get("/assets/*", (c) => c.env.ASSETS.fetch(c.req.raw));

  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found." } }, 404));

  return { app, authFor };
}
