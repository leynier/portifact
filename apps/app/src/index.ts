// Entry point of the portifact-app Worker. It owns three hostnames and routes by host:
// portifact.com and www.portifact.com serve the site, app.portifact.com serves identity and
// the authorization server. Any other host answers 404.
import { createAppHost } from "./app-host.ts";
import { type AuthDeps, workerDeps } from "./auth/deps.ts";
import type { Env } from "./env.ts";
import { createSite, SITE_HOST } from "./site.ts";

export type { Env };

export function createWorker(depsFor: (env: Env) => AuthDeps) {
  const site = createSite();
  const { app } = createAppHost(depsFor);
  return {
    fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
      const host = new URL(request.url).hostname;
      if (host === new URL(env.APP_ORIGIN).hostname) return app.fetch(request, env, ctx);
      if (host === SITE_HOST || host === `www.${SITE_HOST}`) return site.fetch(request, env, ctx);
      return new Response("Not found", { status: 404 });
    },
  } satisfies ExportedHandler<Env>;
}

export default createWorker(workerDeps);
