// HTTP surface of Better Auth on the app host. Only the endpoints Portifact uses are reachable;
// everything else under /api/auth answers 404, including Better Auth's admin, password,
// first-party device token and client management endpoints.
import { SSO_LIMITS, SsoLookupInput, SsoProviderId } from "@portifact/contracts";
import { regionsFromEnv } from "@portifact/db";
import { checkSignInEmail, ssoProviderForEmail } from "@portifact/services";
import { Hono } from "hono";
import type { Env } from "../env.ts";
import { humanCheck } from "../turnstile.ts";
import type { Auth } from "./auth.ts";
import { AUTH_BASE_PATH, authUrls } from "./config.ts";
import { sessionOf } from "./credentials.ts";
import type { FetchLike } from "./deps.ts";
import { exchangeDeviceCode, recordDeviceApproval } from "./device.ts";
import { VERIFY_HUMAN_PATH, verifyHuman } from "./human.ts";
import { checkLimits, ENDPOINT_LIMITS, otpSendChecks, pruneOldCounters } from "./limits.ts";
import { ssoEnabled } from "./sso.ts";
import { ACCEPT_TERMS_PATH, acceptTerms } from "./terms.ts";

/**
 * `browser` endpoints use the dashboard session cookie, so their mutations need the exact app
 * Origin. `client` endpoints serve OAuth clients (CLI, MCP) that authenticate without
 * cookies; any cookie is removed before Better Auth sees the request, so they never act on a
 * browser session.
 */
type EndpointKind = "browser" | "client";

const ENDPOINTS: Record<string, { method: "GET" | "POST"; kind: EndpointKind }> = {
  "/get-session": { method: "GET", kind: "browser" },
  "/sign-out": { method: "POST", kind: "browser" },
  "/sign-in/social": { method: "POST", kind: "browser" },
  "/callback/google": { method: "GET", kind: "browser" },
  "/callback/github": { method: "GET", kind: "browser" },
  "/list-accounts": { method: "GET", kind: "browser" },
  "/email-otp/send-verification-otp": { method: "POST", kind: "browser" },
  "/sign-in/email-otp": { method: "POST", kind: "browser" },
  "/oauth2/authorize": { method: "GET", kind: "browser" },
  "/oauth2/consent": { method: "POST", kind: "browser" },
  "/oauth2/public-client": { method: "GET", kind: "browser" },
  "/device": { method: "GET", kind: "browser" },
  "/device/approve": { method: "POST", kind: "browser" },
  "/device/deny": { method: "POST", kind: "browser" },
  // Portifact's own endpoint (terms.ts), answered by the Worker instead of Better Auth.
  [ACCEPT_TERMS_PATH]: { method: "POST", kind: "browser" },
  // Portifact's own endpoint (human.ts): the login page's human check before a sign-in.
  [VERIFY_HUMAN_PATH]: { method: "POST", kind: "browser" },
  "/oauth2/token": { method: "POST", kind: "client" },
  "/oauth2/revoke": { method: "POST", kind: "client" },
  "/oauth2/register": { method: "POST", kind: "client" },
  "/device/code": { method: "POST", kind: "client" },
};

/** Portifact's own endpoint: whether an address signs in through a workspace's provider. */
export const SSO_LOOKUP_PATH = "/sso/lookup";

/**
 * Single sign-on for workspaces (decision 0016), reachable only with `SSO_ENABLED="true"`:
 * the login page's lookup, starting the flow and each provider's callback (a top-level GET
 * from the identity provider, so the `SameSite=Lax` terms and human-check cookies arrive). No
 * SAML endpoint exists (decision 0016, "SAML").
 */
const SSO_ENDPOINTS: Record<string, { method: "GET" | "POST"; kind: EndpointKind }> = {
  [SSO_LOOKUP_PATH]: { method: "POST", kind: "browser" },
  "/sign-in/sso": { method: "POST", kind: "browser" },
};
const SSO_CALLBACK = /^\/sso\/callback\/([^/]+)$/;

/** The endpoint a path names, or undefined: every other path under the base answers 404. */
export function authEndpoint(
  path: string,
  sso: boolean,
): { method: "GET" | "POST"; kind: EndpointKind } | undefined {
  const fixed = ENDPOINTS[path];
  if (fixed) return fixed;
  if (!sso) return undefined;
  const callback = SSO_CALLBACK.exec(path);
  if (callback) {
    return SsoProviderId.safeParse(callback[1]).success
      ? { method: "GET", kind: "browser" }
      : undefined;
  }
  return SSO_ENDPOINTS[path];
}

export function authRoutes(authFor: (env: Env) => Auth, siteverifyFor: (env: Env) => FetchLike) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.all(`${AUTH_BASE_PATH}/*`, async (c) => {
    const path = new URL(c.req.url).pathname.slice(AUTH_BASE_PATH.length);
    const endpoint = authEndpoint(path, ssoEnabled(c.env));
    if (!endpoint || endpoint.method !== c.req.method) {
      return authHeaders(apiError(404, "not_found", "Not found."));
    }

    let request = c.req.raw;
    if (endpoint.kind === "client") {
      request = withoutCookies(request);
    } else if (
      endpoint.method === "POST" &&
      request.headers.get("origin") !== authUrls(c.env.APP_ORIGIN).origin
    ) {
      return authHeaders(apiError(403, "forbidden", "Cross-origin request refused."));
    }

    const refused = await refuseRequest(path, request, c.env, c.executionCtx);
    if (refused) return authHeaders(refused);

    if (path === ACCEPT_TERMS_PATH) {
      return authHeaders(
        await acceptTerms(request, {
          db: c.env.DB,
          secret: c.env.BETTER_AUTH_SECRET,
          sessionUserId: async (req) =>
            (await sessionOf(authFor(c.env), c.env, req.headers))?.user.id,
          now: Date.now(),
        }),
      );
    }

    if (path === SSO_LOOKUP_PATH) {
      const body = SsoLookupInput.safeParse(await readBody(request));
      if (!body.success)
        return authHeaders(apiError(400, "invalid_input", "Enter an email address."));
      // Only whether the domain uses single sign-on: never which workspace (decision 0016).
      const provider = await ssoProviderForEmail(
        regionsFromEnv(c.env).global,
        body.data.email,
        Date.now(),
      );
      return authHeaders(Response.json({ sso: provider !== null }));
    }

    if (path === VERIFY_HUMAN_PATH) {
      const check = humanCheck(c.env, siteverifyFor(c.env), request, undefined);
      return authHeaders(
        await verifyHuman(request, {
          secret: c.env.BETTER_AUTH_SECRET,
          verify: check.verify,
          now: Date.now(),
        }),
      );
    }

    // A device login inherits the approving session's sign-in (decision 0021): recorded at
    // approval, copied onto the tokens at the exchange.
    const auth = authFor(c.env);
    if (path === "/device/approve") {
      await recordDeviceApproval(auth, c.env, request.headers, await readBody(request));
    }
    if (path === "/oauth2/token") {
      return authHeaders(
        await exchangeDeviceCode(auth, c.env, await readBody(request), () => auth.handler(request)),
      );
    }
    if (path === "/get-session") {
      return authHeaders(await withoutSignInMethod(await auth.handler(request)));
    }
    return authHeaders(await auth.handler(request));
  });

  return routes;
}

// Checks that Better Auth does not do: rate limits, and inputs Portifact never accepts.
async function refuseRequest(
  path: string,
  request: Request,
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
): Promise<Response | undefined> {
  const now = Date.now();
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";

  if (path === "/email-otp/send-verification-otp") {
    const body = await readBody(request);
    if (body.type !== "sign-in") {
      return apiError(400, "invalid_input", "Only sign-in codes can be requested.");
    }
    if (typeof body.email !== "string") return undefined;
    const email = body.email.trim().toLowerCase();
    const decision = await checkLimits(
      env.DB,
      await otpSendChecks(email, ip, env.BETTER_AUTH_SECRET),
      now,
    );
    ctx.waitUntil(pruneOldCounters(env.DB, now));
    if (!decision.ok) return tooManyRequests(decision.retryAfterSeconds);
    // After the rate limits, so the answer cannot be used to test many addresses quickly.
    const check = await checkSignInEmail(regionsFromEnv(env).global, email, now);
    if (check.ok) return undefined;
    return apiError(check.code === "capacity_unavailable" ? 503 : 403, check.code, check.message);
  }

  if (path === "/device/code" && "user_id" in (await readBody(request))) {
    // The user always comes from the session that approves the code, never from input.
    return Response.json(
      { error: "invalid_request", error_description: "user_id is not accepted" },
      { status: 400 },
    );
  }

  // The lookup and starting single sign-on answer the same question: one budget for both.
  const sso = path === SSO_LOOKUP_PATH || path === "/sign-in/sso";
  const limit = sso
    ? { max: SSO_LIMITS.lookupsPerIpPerHour, windowSeconds: 3_600 }
    : ENDPOINT_LIMITS[path];
  if (limit) {
    const key = sso ? `sso-lookup:ip:${ip}` : `${path}:ip:${ip}`;
    const decision = await checkLimits(env.DB, [{ key, limit }], now);
    if (!decision.ok) return tooManyRequests(decision.retryAfterSeconds);
  }
  return undefined;
}

/** Reads a JSON or form body without consuming the request. Unparsable bodies are empty. */
async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.clone().text();
  if (request.headers.get("content-type")?.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The session payload the login page and the dashboard read, without how the session signed in
 * (decision 0021): Better Auth returns additional fields by default, and `returned: false` would
 * also strip it from the server-side `getSession` that `sessionOf` records the credential from.
 * The browser never needs it there; the Apps page reads it from `/api/v1/account/sessions`.
 */
export async function withoutSignInMethod(response: Response): Promise<Response> {
  if (!response.headers.get("content-type")?.includes("application/json")) return response;
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as {
    session?: Record<string, unknown>;
  } | null;
  if (!body?.session || !("signInMethod" in body.session)) return response;
  const { signInMethod: _hidden, ...session } = body.session;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify({ ...body, session }), {
    status: response.status,
    headers,
  });
}

function withoutCookies(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  return new Request(request, { headers });
}

function apiError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

function tooManyRequests(retryAfterSeconds: number): Response {
  const response = apiError(429, "rate_limited", "Too many requests. Wait a moment and try again.");
  response.headers.set("Retry-After", String(retryAfterSeconds));
  return response;
}

/** Auth responses carry credentials or codes: never cached, never leaked through Referer. */
function authHeaders(response: Response): Response {
  const copy = new Response(response.body, response);
  copy.headers.set("Cache-Control", "no-store");
  copy.headers.set("Pragma", "no-cache");
  copy.headers.set("Referrer-Policy", "no-referrer");
  copy.headers.set("X-Content-Type-Options", "nosniff");
  return copy;
}
