// Who is calling /api/v1. OAuth clients (CLI, MCP later) send a bearer token for the API
// resource; the dashboard on the same origin sends its session cookie. Both paths end in the
// same principal, a user ID, and the same scope check, so a route behaves the same for either.
import { CREDENTIALS_SCOPE, OAuthScope } from "@portifact/contracts";
import { COOKIE_PREFIX } from "../auth/auth.ts";
import {
  authorizeResourceRequest,
  type Introspect,
  type ProtectedResource,
} from "../auth/resource.ts";

/** The Better Auth session cookie, matched exactly and case-sensitively (docs/security.md). */
export const SESSION_COOKIE = `${COOKIE_PREFIX}.session_token`;

/** Resolves the session cookie of a request to its user, or undefined without a valid one. */
export type SessionLookup = (request: Request) => Promise<string | undefined>;

/**
 * What a dashboard session may do at the API: the same classes of action as a token that holds
 * every product scope. Ownership of each artifact is still checked by the services.
 */
export const SESSION_SCOPES: readonly OAuthScope[] = OAuthScope.options;

export type ApiDecision = { ok: true; userId: string } | { ok: false; response: Response };

export interface ApiCaller {
  introspect: Introspect;
  resource: ProtectedResource;
  session: SessionLookup;
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);

export async function authorizeApiRequest(
  caller: ApiCaller,
  request: Request,
  scope: OAuthScope,
): Promise<ApiDecision> {
  // A bearer token always wins: OAuth clients never act through a browser session.
  if (!request.headers.has("authorization") && hasSessionCookie(request.headers.get("cookie"))) {
    if (!fromAppOrigin(request, new URL(caller.resource.identifier).origin)) {
      return { ok: false, response: forbidden() };
    }
    const userId = await caller.session(request);
    if (userId) {
      if (!SESSION_SCOPES.includes(scope)) return { ok: false, response: forbidden() };
      return { ok: true, userId };
    }
    // An expired or unknown session answers like a request without credentials.
  }
  const decision = await authorizeResourceRequest(caller.introspect, request, caller.resource, [
    scope,
  ]);
  return decision.ok ? { ok: true, userId: decision.principal.userId } : decision;
}

/** Who manages account-level credentials and channels: the dashboard or the first-party CLI. */
export type AccountDecision =
  | { ok: true; userId: string; via: string }
  | { ok: false; response: Response };

/**
 * For operations that open a standing channel out of the account (webhooks, decision 0003's
 * addendum): the dashboard session, or a bearer token holding `credentials:manage`, which only
 * the Portifact CLI's client record lists. `via` is `dashboard` or the token's client ID.
 */
export async function authorizeAccountRequest(
  caller: ApiCaller,
  request: Request,
): Promise<AccountDecision> {
  if (!request.headers.has("authorization") && hasSessionCookie(request.headers.get("cookie"))) {
    if (!fromAppOrigin(request, new URL(caller.resource.identifier).origin)) {
      return { ok: false, response: forbidden() };
    }
    const userId = await caller.session(request);
    if (userId) return { ok: true, userId, via: "dashboard" };
  }
  const decision = await authorizeResourceRequest(caller.introspect, request, caller.resource, [
    CREDENTIALS_SCOPE,
  ]);
  return decision.ok
    ? { ok: true, userId: decision.principal.userId, via: decision.principal.clientId }
    : decision;
}

export function hasSessionCookie(header: string | null): boolean {
  if (!header) return false;
  return header.split(";").some((pair) => pair.trim().split("=", 1)[0] === SESSION_COOKIE);
}

/**
 * Session requests come only from the dashboard's own pages. Fetch metadata must say
 * same-origin, failing closed when it is missing, and every mutation also needs the exact app
 * Origin, like the browser endpoints under /api/auth. SameSite=Lax already keeps the cookie
 * off cross-site subresource requests; this also refuses sibling hosts and top-level
 * navigations from other sites.
 */
export function fromAppOrigin(request: Request, appOrigin: string): boolean {
  if (request.headers.get("sec-fetch-site") !== "same-origin") return false;
  return SAFE_METHODS.has(request.method) || request.headers.get("origin") === appOrigin;
}

function forbidden(): Response {
  return Response.json(
    { error: { code: "forbidden", message: "Cross-origin request refused." } },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}
