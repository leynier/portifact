// Entry to protected artifacts, the app's part (plan section 4, "Entrada a un artifact
// protegido"). An artifact origin sends a visitor without a read session to
// /read/<id>?state=<nonce>. With a dashboard session that passes the artifact's access policy,
// the visitor goes back to that origin's /__portifact/callback with a one-use code bound to the
// artifact, the account, the policy generation and the nonce. Without a session they sign in
// first and come back here. A missing artifact and a forbidden one look the same. The code is
// also bound to the dashboard session, so signing out of the app ends the read sessions it
// opened. A visitor who started on the artifact's custom host (decision 0006) comes with
// `host=<hostname>`: the code goes back there only when that is the artifact's active custom host
// from the tables, and is bound to it; any other host answers like an artifact they cannot open.
// The domain owner controls that host's DNS and could receive the code on a server of theirs, so
// for an `authenticated` artifact (any signed-in account reads it) the visitor confirms first on
// the login page, which sends a same-origin POST here: a visitor who was merely sent to this URL
// gives nothing away without a click.
import { ArtifactId, OpaqueToken } from "@portifact/contracts";
import { needsTermsAcceptance } from "@portifact/domain";
import { customDomainsServing, issueReadHandoff, readEntryConfirmation } from "@portifact/services";
import { Hono } from "hono";
import { z } from "zod";
import { fromAppOrigin } from "./api/access.ts";
import type { Auth } from "./auth/auth.ts";
import { checkLimits, READ_ENTRY_LIMIT } from "./auth/limits.ts";
import type { Env } from "./env.ts";
import { artifactDb } from "./regions.ts";

/** Where the login page explains that the artifact cannot be opened with this account. */
export const UNAVAILABLE_URL = "/login?error=artifact_unavailable";
/** Where the login page explains that the account opened too many artifacts in a short time. */
export const RATE_LIMITED_URL = "/login?error=read_rate_limited";

export function readRoutes(authFor: (env: Env) => Auth) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.on(["GET", "HEAD"], "/read/:id", async (c) => {
    if (c.req.method !== "GET") return redirect(UNAVAILABLE_URL);
    const id = c.req.param("id");
    const params = new URL(c.req.url).searchParams;
    const states = params.getAll("state");
    const hosts = params.getAll("host");
    const parsed = OpaqueToken.safeParse(states.length === 1 ? states[0] : undefined);
    if (!ArtifactId.safeParse(id).success || !parsed.success || hosts.length > 1) {
      return redirect(UNAVAILABLE_URL);
    }
    const state = parsed.data;
    // Untrusted: only compared with the artifact's active custom host after the access check.
    const requestedHost = hosts[0]?.slice(0, 253) ?? null;

    // The account always comes from the session cookie, never from the request.
    // An account that has not accepted the current terms accepts them on the login page first.
    const session = await authFor(c.env).api.getSession({ headers: c.req.raw.headers });
    if (!session || needsTermsAcceptance(session.user.termsVersion)) {
      const back = `/read/${id}?${new URLSearchParams(
        requestedHost === null ? { state } : { state, host: requestedHost },
      )}`;
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

    const db = await artifactDb(c.env, id);
    const entry = {
      artifactId: id,
      userId: session.user.id,
      now,
      requestedHost,
      contentDomain: c.env.CONTENT_DOMAIN,
      customDomains: customDomainsServing(c.env),
    };
    if (await readEntryConfirmation(db, entry)) {
      const back = `/read/${id}?${new URLSearchParams({ state, host: requestedHost as string })}`;
      return redirect(`/login?${new URLSearchParams({ confirm: "read", next: back })}`);
    }
    const issued = await issueReadHandoff(db, {
      ...entry,
      authSessionId: session.session.id,
      state,
      confirmed: false,
    });
    if (!issued.ok) return redirect(UNAVAILABLE_URL);
    return redirect(callbackUrl(issued.value));
  });

  // The confirmation from the login page: the same entry, sent by the page itself (same origin,
  // the app's Origin), answering where to go next as JSON, since a form's redirect to the custom
  // host would leave the page's `form-action`.
  routes.post("/read/:id", async (c) => {
    if (
      !fromAppOrigin(c.req.raw, c.env.APP_ORIGIN) ||
      c.req.header("sec-fetch-site") !== "same-origin"
    ) {
      return c.json({ error: { code: "forbidden", message: "Open the link again." } }, 403);
    }
    const id = c.req.param("id");
    const body = ReadConfirmation.safeParse(await c.req.json().catch(() => null));
    if (!ArtifactId.safeParse(id).success || !body.success) return next(UNAVAILABLE_URL);
    const session = await authFor(c.env).api.getSession({ headers: c.req.raw.headers });
    if (!session || needsTermsAcceptance(session.user.termsVersion)) {
      const back = `/read/${id}?${new URLSearchParams(body.data)}`;
      return next(`/login?${new URLSearchParams({ next: back })}`);
    }
    const now = Date.now();
    const limit = await checkLimits(
      c.env.DB,
      [{ key: `read:user:${session.user.id}`, limit: READ_ENTRY_LIMIT }],
      now,
    );
    if (!limit.ok) return next(RATE_LIMITED_URL);
    const issued = await issueReadHandoff(await artifactDb(c.env, id), {
      artifactId: id,
      userId: session.user.id,
      authSessionId: session.session.id,
      state: body.data.state,
      now,
      requestedHost: body.data.host,
      contentDomain: c.env.CONTENT_DOMAIN,
      customDomains: customDomainsServing(c.env),
      confirmed: true,
    });
    return next(issued.ok ? callbackUrl(issued.value) : UNAVAILABLE_URL);
  });

  return routes;
}

/** What the login page's confirmation sends: the entry's nonce and the custom host. */
const ReadConfirmation = z.strictObject({
  state: OpaqueToken,
  host: z.string().min(1).max(253),
});

/** The artifact origin's callback with the code; the host comes from the service. */
function callbackUrl(issued: { host: string; code: string }): string {
  const callback = new URL(`https://${issued.host}/__portifact/callback`);
  callback.searchParams.set("code", issued.code);
  return callback.toString();
}

/** The confirmation's answer: where the page goes next, never cached. */
function next(url: string): Response {
  return new Response(JSON.stringify({ url }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
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
