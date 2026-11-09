// app.portifact.com: the dashboard, identity, the OAuth authorization server, protected
// resource metadata and the auth pages. Every path not listed here answers 404.
import {
  ArtifactId,
  TokenPrincipal,
  TURNSTILE_ORIGIN,
  TURNSTILE_SITE_KEY_META,
} from "@portifact/contracts";
import { isLocale } from "@portifact/contracts/locales";
import { needsTermsAcceptance } from "@portifact/domain";
import { DOCUMENT_STYLESHEET } from "@portifact/render";
import { Hono } from "hono";
import type { SessionLookup } from "./api/access.ts";
import { type AccountSessionLookup, accountRoutes } from "./api/account.ts";
import { r2Presigner } from "./api/presign.ts";
import { reportRoutes } from "./api/reports.ts";
import { reviewRoutes } from "./api/review.ts";
import { apiRoutes } from "./api/routes.ts";
import { tokenRoutes } from "./api/tokens.ts";
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

/** The query parameter through which a link asks a page for a language (apps/web, src/i18n). */
export const LOCALE_PARAM = "lang";

/** The dashboard SPA, built by apps/web as dashboard.html and served on this host only. */
export const DASHBOARD_PAGE = "/dashboard";

/**
 * Client routes of the dashboard (apps/web/src/dashboard/router.tsx). Each one serves the SPA;
 * any other path keeps answering 404, so a typo never looks like an empty dashboard.
 */
export const DASHBOARD_ROUTES = [
  "/",
  "/publish",
  "/artifacts/:artifactId",
  "/artifacts/:artifactId/publish",
  "/artifacts/:artifactId/edit",
  "/artifacts/:artifactId/history",
  "/profile",
  "/apps",
  "/usage",
  "/settings",
  // The old account page; the dashboard sends it on to the page that holds each section now.
  "/account",
] as const;

/**
 * The viewer with the Portifact bar (apps/web/src/dashboard/screens/viewer.tsx), where top-level
 * visits to an artifact's pages land. It is a route of the dashboard SPA but is served with or
 * without a session: anonymous visitors of a public artifact see it too.
 */
export const VIEWER_ROUTE = "/view/:artifactId";

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

/**
 * The policy of a page that renders the human check (Turnstile): its script and its challenge
 * frame come from Cloudflare's challenge origin, and nothing else is added.
 */
export function withHumanCheck(policy: string): string {
  const scripts = policy.replace("script-src 'self'", `script-src 'self' ${TURNSTILE_ORIGIN}`);
  return /(^|; )frame-src /.test(scripts)
    ? scripts.replace(/(^|; )frame-src ([^;]*)/, `$1frame-src $2 ${TURNSTILE_ORIGIN}`)
    : `${scripts}; frame-src ${TURNSTILE_ORIGIN}`;
}

/** The login page's policy: the strict page policy plus the human check of new accounts. */
export const LOGIN_CSP = withHumanCheck(PAGE_CSP);

/** The S3 endpoint of the artifacts bucket, which the dashboard uploads to and downloads from. */
export function storageOrigin(r2AccountId: string): string {
  return `https://${r2AccountId}.r2.cloudflarestorage.com`;
}

let stylesheetHash: Promise<string> | undefined;

/** CSP source for the one stylesheet of rendered documents, computed once per isolate. */
function documentStylesheetSource(): Promise<string> {
  stylesheetHash ??= crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(DOCUMENT_STYLESHEET))
    .then((digest) => `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`);
  return stylesheetHash;
}

/**
 * The dashboard's policy: the strict page policy plus two narrow additions. Uploads go straight
 * to the bucket's S3 endpoint and downloads are read from it, so `connect-src` names that one
 * origin. The document editor shows the server's rendering in an `iframe` with an empty
 * `sandbox` and `srcdoc`, which inherits this policy, so `style-src` allows exactly the
 * renderer's stylesheet by hash. Frames still load nothing from the network.
 */
export function dashboardPolicy(
  storage: string,
  stylesheetSource: string,
  contentDomain: string,
  /** The one artifact origin the viewer frames; every artifact origin when absent. */
  frameOrigin = `https://*.${contentDomain}`,
): string {
  const policy = PAGE_CSP.replace(
    "style-src 'self'",
    `style-src 'self' ${stylesheetSource}`,
  ).replace("connect-src 'self'", `connect-src 'self' ${storage}`);
  // The review viewer frames artifact origins. Client-side navigation keeps the policy of the
  // first page, so every dashboard route sends it. The frames are cross-site and sandboxed. It
  // also renders the human check of a visitor's first comments.
  return withHumanCheck(`${policy}; frame-src ${frameOrigin}`);
}

export async function dashboardCsp(
  env: Pick<Env, "R2_ACCOUNT_ID" | "CONTENT_DOMAIN">,
): Promise<string> {
  return dashboardPolicy(
    storageOrigin(env.R2_ACCOUNT_ID),
    await documentStylesheetSource(),
    env.CONTENT_DOMAIN,
  );
}

/**
 * The viewer's policy: the dashboard's, with `frame-src` narrowed to the one artifact it shows
 * (and the human check), so its frame can never be navigated to another artifact or site. Its
 * links to the dashboard load a new page, which gets the dashboard's own policy.
 */
export async function viewerCsp(
  env: Pick<Env, "R2_ACCOUNT_ID" | "CONTENT_DOMAIN">,
  artifactId: string,
): Promise<string> {
  return dashboardPolicy(
    storageOrigin(env.R2_ACCOUNT_ID),
    await documentStylesheetSource(),
    env.CONTENT_DOMAIN,
    `https://${artifactId}.${env.CONTENT_DOMAIN}`,
  );
}

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
    // No app URL (codes, states, artifact IDs) ever leaves as Referer, from JSON, assets or
    // pages alike. The one link that must send the app's origin, the review tab link, says so
    // itself with `referrerpolicy="origin"`.
    c.res.headers.set("Referrer-Policy", "no-referrer");
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

  app.route(
    "/",
    authRoutes(authFor, (env) => depsFor(env).siteverify),
  );
  app.route(
    "/",
    apiRoutes({
      introspect: introspectFor,
      resource: (env) => resources(env).api,
      session: sessionUserFor,
      presigner: presignerFor,
      siteverify: (env) => depsFor(env).siteverify,
      multipart: (env) => depsFor(env).multipart,
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
  app.route(
    "/",
    tokenRoutes({
      introspect: introspectFor,
      resource: (env) => resources(env).api,
      now: () => Date.now(),
    }),
  );
  app.route("/", reportRoutes({ now: () => Date.now() }));
  app.route("/", readRoutes(authFor));
  app.route(
    "/",
    reviewRoutes({
      session: accountSessionFor,
      viewer: sessionUserFor,
      now: () => Date.now(),
    }),
  );

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
      siteverify: (env) => depsFor(env).siteverify,
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
        const login = new URLSearchParams({ next });
        // A language asked for on the way in (the landing's links) applies to the login page too.
        const lang = url.searchParams.get(LOCALE_PARAM);
        if (isLocale(lang)) login.set(LOCALE_PARAM, lang);
        return c.redirect(`/login?${login}`, 302);
      }
      return withSiteKey(
        trustedPage(
          await c.env.ASSETS.fetch(new Request(new URL(DASHBOARD_PAGE, c.req.url))),
          await dashboardCsp(c.env),
        ),
        c.env.TURNSTILE_SITE_KEY,
      );
    });
  }

  // The viewer is the dashboard SPA with or without a session; the page itself holds nothing.
  // Never indexed: crawlers get the artifact itself on its own origin (docs/security.md).
  app.get(VIEWER_ROUTE, async (c) => {
    const artifactId = c.req.param("artifactId");
    if (!ArtifactId.safeParse(artifactId).success) return c.notFound();
    const page = trustedPage(
      await c.env.ASSETS.fetch(new Request(new URL(DASHBOARD_PAGE, c.req.url))),
      await viewerCsp(c.env, artifactId),
    );
    page.headers.set("X-Robots-Tag", "noindex");
    return withSiteKey(page, c.env.TURNSTILE_SITE_KEY);
  });

  // The review viewer became the viewer; old links keep working.
  app.get("/review/:artifactId", (c) => {
    const artifactId = c.req.param("artifactId");
    if (!ArtifactId.safeParse(artifactId).success) return c.notFound();
    c.header("Cache-Control", "no-store");
    return c.redirect(`/view/${artifactId}`, 301);
  });

  for (const page of AUTH_PAGES) {
    app.get(page, async (c) => {
      const asset = await c.env.ASSETS.fetch(new Request(new URL(page, c.req.url)));
      if (page !== "/login") return trustedPage(asset);
      return withSiteKey(trustedPage(asset, LOGIN_CSP), c.env.TURNSTILE_SITE_KEY);
    });
  }

  for (const file of STATIC_FILES) {
    app.get(file, (c) => c.env.ASSETS.fetch(c.req.raw));
  }
  app.get("/assets/*", (c) => c.env.ASSETS.fetch(c.req.raw));

  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found." } }, 404));

  return { app, authFor };
}

const META_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Gives a page the public Turnstile site key in a `<meta>`, so the static bundle needs no
 * build per environment. Without a key the page renders no challenge.
 */
export function withSiteKey(page: Response, siteKey: string | undefined): Response {
  if (!siteKey) return page;
  const content = siteKey.replace(/[&<>"']/g, (char) => META_ESCAPES[char] ?? char);
  return new HTMLRewriter()
    .on("head", {
      element(head) {
        head.append(`<meta name="${TURNSTILE_SITE_KEY_META}" content="${content}">`, {
          html: true,
        });
      },
    })
    .transform(page);
}

/** Headers of every page on the app host: strict CSP, never cached, no referrer. */
function trustedPage(asset: Response, policy = PAGE_CSP): Response {
  const response = new Response(asset.body, asset);
  response.headers.set("Content-Security-Policy", policy);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
