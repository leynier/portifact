// Entry to protected artifacts, the app's part (plan section 4, "Entrada a un artifact
// protegido"). An artifact origin sends a visitor without a read session to
// /read/<id>?state=<nonce>. With a dashboard session that passes the artifact's access policy,
// the visitor goes back to that origin's /__portifact/callback with a one-use code bound to the
// artifact, the account, the policy generation and the nonce. Without a session they sign in
// first and come back here. A missing artifact and a forbidden one look the same. The code is
// also bound to the dashboard session, so signing out of the app ends the read sessions it
// opened.
import { ArtifactId, OpaqueToken } from "@portifact/contracts";
import { artifactDb } from "./regions.ts";
import { needsTermsAcceptance } from "@portifact/domain";
import { issueReadHandoff } from "@portifact/services";
import { Hono } from "hono";
import type { Auth } from "./auth/auth.ts";
import { checkLimits, READ_ENTRY_LIMIT } from "./auth/limits.ts";
import type { Env } from "./env.ts";

/** Where the login page explains that the artifact cannot be opened with this account. */
export const UNAVAILABLE_URL = "/login?error=artifact_unavailable";
/** Where the login page explains that the account opened too many artifacts in a short time. */
export const RATE_LIMITED_URL = "/login?error=read_rate_limited";

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
    // An account that has not accepted the current terms accepts them on the login page first.
    const session = await authFor(c.env).api.getSession({ headers: c.req.raw.headers });
    if (!session || needsTermsAcceptance(session.user.termsVersion)) {
      const back = `/read/${id}?${new URLSearchParams({ state })}`;
      return redirect(`/login?${new URLSearchParams({ next: back })}`);
    }

    const now = Date.now();
    const limit = await checkLimits(
      c.env.DB,
      [{ key: `read:user:${session.user.id}`, limit: READ_ENTRY_LIMIT }],
      now,
    );
    if (!limit.ok) {
      const response = redirect(RATE_LIMITED_URL);
      response.headers.set("Retry-After", String(limit.retryAfterSeconds));
      return response;
    }

    const issued = await issueReadHandoff(await artifactDb(c.env, id), {
      artifactId: id,
      userId: session.user.id,
      authSessionId: session.session.id,
      state,
      now,
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
