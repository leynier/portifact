// Entry to protected artifacts, the app's part (plan section 4, "Entrada a un artifact
// protegido"). An artifact origin sends a visitor without a read session to
// /read/<id>?state=<nonce>. With a dashboard session that passes the artifact's access policy,
// the visitor goes back to that origin's /__portifact/callback with a one-use code bound to the
// artifact, the account, the policy generation and the nonce. Without a session they sign in
// first and come back here. A missing artifact and a forbidden one look the same.
import { ArtifactId, OpaqueToken } from "@portifact/contracts";
import { createDb } from "@portifact/db";
import { issueReadHandoff } from "@portifact/services";
import { Hono } from "hono";
import type { Auth } from "./auth/auth.ts";
import type { Env } from "./env.ts";

/** Where the login page explains that the artifact cannot be opened with this account. */
export const UNAVAILABLE_URL = "/login?error=artifact_unavailable";

export function readRoutes(authFor: (env: Env) => Auth) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.on(["GET", "HEAD"], "/read/:id", async (c) => {
    if (c.req.method !== "GET") return redirect(UNAVAILABLE_URL);
    const id = c.req.param("id");
    const states = new URL(c.req.url).searchParams.getAll("state");
    const parsed = OpaqueToken.safeParse(states.length === 1 ? states[0] : undefined);
    if (!ArtifactId.safeParse(id).success || !parsed.success) return redirect(UNAVAILABLE_URL);
    const state = parsed.data;

    // The account always comes from the session cookie, never from the request.
    const session = await authFor(c.env).api.getSession({ headers: c.req.raw.headers });
    if (!session) {
      const back = `/read/${id}?${new URLSearchParams({ state })}`;
      return redirect(`/login?${new URLSearchParams({ next: back })}`);
    }

    const issued = await issueReadHandoff(createDb(c.env.DB), {
      artifactId: id,
      userId: session.user.id,
      state,
      now: Date.now(),
    });
    if (!issued.ok) return redirect(UNAVAILABLE_URL);
    const callback = new URL(`https://${id}.${c.env.CONTENT_DOMAIN}/__portifact/callback`);
    callback.searchParams.set("code", issued.value.code);
    return redirect(callback.toString());
  });

  return routes;
}

/** 303 that is never cached and never sends this URL (with its code or state) as Referer. */
function redirect(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
