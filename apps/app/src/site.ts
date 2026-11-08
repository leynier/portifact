// portifact.com and www.portifact.com: the landing page, the legal pages, the MCP
// compatibility page and the installer redirects.
import { Hono } from "hono";
import { AUTH_PAGES, DASHBOARD_PAGE, PAGE_CSP } from "./app-host.ts";
import type { Env } from "./env.ts";

const REPO = "leynier/portifact";
export const SITE_HOST = "portifact.com";

/** Installer scripts are attached to every GitHub release; the latest one is always current. */
const installers: Record<string, string> = {
  "/install": "install.sh",
  "/install.ps1": "install.ps1",
};

/** The dashboard and auth pages share the static assets but are only served on the app host. */
const appOnlyPaths = new Set<string>(
  [...AUTH_PAGES, DASHBOARD_PAGE].flatMap((page) => [page, `${page}.html`]),
);

/** The Terms of Service, Privacy Policy and Acceptable Use Policy, built by apps/web. */
export const LEGAL_PAGES = ["/terms", "/privacy", "/acceptable-use"] as const;

/** Static documents served like the legal pages: the MCP compatibility matrix (plan section 17). */
export const DOCUMENT_PAGES = [...LEGAL_PAGES, "/mcp-compatibility"] as const;

/**
 * Static documents with no script: the strict page policy, never framed, and revalidated on
 * every visit so a new version shows at once.
 */
function documentPage(asset: Response): Response {
  const response = new Response(asset.body, asset);
  response.headers.set("Content-Security-Policy", PAGE_CSP);
  response.headers.set("Cache-Control", "no-cache");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return response;
}

export function createSite() {
  const site = new Hono<{ Bindings: Env }>();

  // Serve everything from the apex domain so links, cookies and caches have one origin.
  site.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    if (url.hostname === `www.${SITE_HOST}`) {
      url.hostname = SITE_HOST;
      return c.redirect(url.toString(), 301);
    }
    await next();
  });

  for (const [path, asset] of Object.entries(installers)) {
    site.get(path, (c) => {
      c.header("Cache-Control", "no-store");
      return c.redirect(`https://github.com/${REPO}/releases/latest/download/${asset}`, 302);
    });
  }

  for (const page of DOCUMENT_PAGES) {
    site.get(page, async (c) =>
      documentPage(await c.env.ASSETS.fetch(new Request(new URL(page, c.req.url)))),
    );
  }

  site.all("*", async (c): Promise<Response> => {
    const path = new URL(c.req.url).pathname.replace(/\/+$/, "");
    if (appOnlyPaths.has(path)) return c.text("Not found", 404);
    return c.env.ASSETS.fetch(c.req.raw);
  });

  return site;
}
