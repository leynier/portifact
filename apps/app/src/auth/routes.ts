// HTTP surface of Better Auth on the app host. Only the endpoints Portifact uses are reachable;
// everything else under /api/auth answers 404, including Better Auth's admin, password,
// first-party device token and client management endpoints.
import { Hono } from "hono";
import type { Env } from "../env.ts";
import type { Auth } from "./auth.ts";
import { AUTH_BASE_PATH, authUrls } from "./config.ts";
import { checkLimits, ENDPOINT_LIMITS, otpSendChecks, pruneOldCounters } from "./limits.ts";

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
  "/email-otp/send-verification-otp": { method: "POST", kind: "browser" },
  "/sign-in/email-otp": { method: "POST", kind: "browser" },
  "/oauth2/authorize": { method: "GET", kind: "browser" },
  "/oauth2/consent": { method: "POST", kind: "browser" },
  "/oauth2/public-client": { method: "GET", kind: "browser" },
  "/device": { method: "GET", kind: "browser" },
  "/device/approve": { method: "POST", kind: "browser" },
  "/device/deny": { method: "POST", kind: "browser" },
  "/oauth2/token": { method: "POST", kind: "client" },
  "/oauth2/revoke": { method: "POST", kind: "client" },
  "/oauth2/register": { method: "POST", kind: "client" },
  "/device/code": { method: "POST", kind: "client" },
};

export function authRoutes(authFor: (env: Env) => Auth) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.all(`${AUTH_BASE_PATH}/*`, async (c) => {
    const path = new URL(c.req.url).pathname.slice(AUTH_BASE_PATH.length);
    const endpoint = ENDPOINTS[path];
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

    return authHeaders(await authFor(c.env).handler(request));
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
    return decision.ok ? undefined : tooManyRequests(decision.retryAfterSeconds);
  }

  if (path === "/device/code" && "user_id" in (await readBody(request))) {
    // The user always comes from the session that approves the code, never from input.
    return Response.json(
      { error: "invalid_request", error_description: "user_id is not accepted" },
      { status: 400 },
    );
  }

  const limit = ENDPOINT_LIMITS[path];
  if (limit) {
    const decision = await checkLimits(env.DB, [{ key: `${path}:ip:${ip}`, limit }], now);
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
