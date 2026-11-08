import { Hono } from "hono";

export interface Env {
  ASSETS: Fetcher;
}

const REPO = "leynier/portifact";
const CANONICAL_HOST = "portifact.com";

/** Installer scripts are attached to every GitHub release; the latest one is always current. */
const installers: Record<string, string> = {
  "/install": "install.sh",
  "/install.ps1": "install.ps1",
};

export const app = new Hono<{ Bindings: Env }>();

// Serve everything from the apex domain so links, cookies and caches have one origin.
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  if (url.hostname === `www.${CANONICAL_HOST}`) {
    url.hostname = CANONICAL_HOST;
    return c.redirect(url.toString(), 301);
  }
  await next();
});

for (const [path, asset] of Object.entries(installers)) {
  app.get(path, (c) => {
    c.header("Cache-Control", "no-store");
    return c.redirect(`https://github.com/${REPO}/releases/latest/download/${asset}`, 302);
  });
}

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
