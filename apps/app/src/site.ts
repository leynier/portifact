// portifact.com and www.portifact.com: the landing page and the installer redirects.
import { Hono } from "hono";
import { AUTH_PAGES } from "./app-host.ts";
import type { Env } from "./env.ts";

const REPO = "leynier/portifact";
export const SITE_HOST = "portifact.com";

/** Installer scripts are attached to every GitHub release; the latest one is always current. */
const installers: Record<string, string> = {
  "/install": "install.sh",
  "/install.ps1": "install.ps1",
};

/** Auth pages share the static assets but are only served on the app host. */
const appOnlyPaths = new Set<string>(AUTH_PAGES.flatMap((page) => [page, `${page}.html`]));

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

  site.all("*", async (c): Promise<Response> => {
    const path = new URL(c.req.url).pathname.replace(/\/+$/, "");
    if (appOnlyPaths.has(path)) return c.text("Not found", 404);
    return c.env.ASSETS.fetch(c.req.raw);
  });

  return site;
}
