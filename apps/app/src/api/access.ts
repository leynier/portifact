// Who is calling /api/v1. OAuth clients (CLI, MCP later) send a bearer token for the API
// resource; the dashboard on the same origin sends its session cookie; automation sends a
// workspace's service token (decision 0011). Every path ends in the same principal, an ID the
// services resolve a role for, and the same scope check, so a route behaves the same for each.
import { CREDENTIALS_SCOPE, OAuthScope, SERVICE_TOKEN_SECRET_PREFIX } from "@portifact/contracts";
import type { ServiceTokenAuth } from "@portifact/services";
import { COOKIE_PREFIX } from "../auth/auth.ts";
import { bearerToken } from "../auth/introspection.ts";
import {
  authorizeResourceRequest,
  type Introspect,
  type ProtectedResource,
  protectedResourceMetadataUrl,
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

/** Authenticates a service token's secret (`authenticateServiceToken` in the services). */
export type ServiceTokenLookup = (secret: string) => Promise<ServiceTokenAuth>;

export interface ApiCaller {
  introspect: Introspect;
  resource: ProtectedResource;
  session: SessionLookup;
  /** Absent where service tokens are not accepted; `/api/v1` passes it. */
  serviceToken?: ServiceTokenLookup;
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);

export async function authorizeApiRequest(
  caller: ApiCaller,
  request: Request,
  scope: OAuthScope,
): Promise<ApiDecision> {
  const bearer = bearerToken(request.headers.get("authorization"));
  if (caller.serviceToken && bearer?.startsWith(SERVICE_TOKEN_SECRET_PREFIX)) {
    return serviceTokenDecision(await caller.serviceToken(bearer), scope, caller.resource);
  }
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

/**
 * The answer for a service token (decision 0011): refused like an unknown token when revoked,
 * malformed or of a deleted workspace, with its own message when expired, `plan_required` when
 * the workspace's plan no longer includes the feature, and `insufficient_scope` when the route's
 * scope is not one the admin chose.
 */
function serviceTokenDecision(
  auth: ServiceTokenAuth,
  scope: OAuthScope,
  resource: ProtectedResource,
): ApiDecision {
  if (!auth.ok) {
    if (auth.reason === "plan") {
      return { ok: false, response: apiError(403, "plan_required", auth.message) };
    }
    const message =
      auth.reason === "expired"
        ? `This service token expired on ${new Date(auth.expiresAt).toISOString().slice(0, 10)}. Ask a workspace admin for a new one.`
        : "This service token is not valid. It may have been revoked.";
    return {
      ok: false,
      response: apiError(401, "unauthenticated", message, {
        "WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="${protectedResourceMetadataUrl(resource)}"`,
      }),
    };
  }
  if (!(auth.scopes as readonly string[]).includes(scope)) {
    return {
      ok: false,
      response: apiError(403, "forbidden", `This service token does not have the ${scope} scope.`, {
        "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${scope}"`,
      }),
    };
  }
  return { ok: true, userId: auth.tokenId };
}

function apiError(
  status: 401 | 403,
  code: "unauthenticated" | "forbidden" | "plan_required",
  message: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { ...headers, "Cache-Control": "no-store" } },
  );
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
