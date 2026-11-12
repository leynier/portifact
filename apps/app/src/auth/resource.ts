import type { TokenPrincipal } from "@portifact/contracts";
import { needsTermsAcceptance } from "@portifact/domain";
import { bearerToken } from "./introspection.ts";

export interface ProtectedResource {
  /** Canonical resource URI (RFC 8707). Tokens must carry it in their audience. */
  identifier: string;
  /** Human-readable name for the protected resource metadata. */
  name: string;
  /** Scopes advertised in the 401 challenge, so clients request the minimal set first. */
  challengeScopes: readonly string[];
  /** The authorization server that issues tokens for this resource. */
  issuer: string;
}

export type ResourceDecision =
  /** `termsAccepted`: the token's account accepted the current terms (docs/legal.md). */
  | { ok: true; principal: TokenPrincipal; termsAccepted: boolean }
  | { ok: false; response: Response };

/** RFC 7662 shaped result of validating an access token. */
export interface IntrospectionPayload {
  active?: boolean;
  aud?: string | string[];
  sub?: string;
  client_id?: string;
  scope?: string;
  /** When the sign-in the token descends from happened, in seconds (decision 0021). */
  portifact_auth_time?: number;
  /** How that sign-in happened (decision 0021, "SSO required"), from the token row. */
  portifact_sign_in_method?: string;
  /** The terms version the token's account accepted (`TERMS_VERSION_CLAIM`), absent if none. */
  portifact_terms_version?: string;
}

export type Introspect = (token: string) => Promise<IntrospectionPayload>;

/** RFC 9728 metadata URL: the resource's path inserted after the well-known prefix. */
export function protectedResourceMetadataUrl(resource: ProtectedResource): string {
  const url = new URL(resource.identifier);
  return `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`;
}

/** RFC 9728 protected resource metadata. */
export function protectedResourceMetadata(resource: ProtectedResource) {
  return {
    resource: resource.identifier,
    resource_name: resource.name,
    authorization_servers: [resource.issuer],
    scopes_supported: [...resource.challengeScopes],
    bearer_methods_supported: ["header"],
  };
}

// Validates the bearer token for one resource and one operation. The scope only allows a
// class of action; ownership of a specific artifact is checked by the domain layer.
export async function authorizeResourceRequest(
  introspect: Introspect,
  request: Request,
  resource: ProtectedResource,
  requiredScopes: readonly string[],
): Promise<ResourceDecision> {
  const token = bearerToken(request.headers.get("authorization"));
  if (!token) {
    return deny(401, resource, { scope: resource.challengeScopes });
  }
  const payload = await introspect(token);
  const principal = activePrincipal(payload);
  if (!principal) {
    return deny(401, resource, { error: "invalid_token" });
  }
  if (!audiences(payload).includes(resource.identifier)) {
    // A token issued for another resource is not valid here (RFC 8707, MCP token handling).
    return deny(401, resource, { error: "invalid_token" });
  }
  const missing = requiredScopes.filter((scope) => !principal.scopes.includes(scope));
  if (missing.length > 0) {
    return deny(403, resource, { error: "insufficient_scope", scope: requiredScopes });
  }
  return {
    ok: true,
    principal,
    termsAccepted: !needsTermsAcceptance(payload.portifact_terms_version),
  };
}

// Only active tokens issued to a user through a client are accepted.
function activePrincipal(payload: IntrospectionPayload): TokenPrincipal | undefined {
  const { active, sub, client_id: clientId, scope } = payload;
  if (active !== true || !sub || !clientId) return undefined;
  return { userId: sub, clientId, scopes: scope ? scope.split(" ") : [] };
}

function audiences(payload: IntrospectionPayload): string[] {
  if (typeof payload.aud === "string") return [payload.aud];
  return payload.aud ?? [];
}

function deny(
  status: 401 | 403,
  resource: ProtectedResource,
  challenge: { error?: string; scope?: readonly string[] },
): ResourceDecision {
  const params = [`resource_metadata="${protectedResourceMetadataUrl(resource)}"`];
  if (challenge.error) params.unshift(`error="${challenge.error}"`);
  if (challenge.scope?.length) params.push(`scope="${challenge.scope.join(" ")}"`);
  return {
    ok: false,
    response: Response.json(
      { error: challenge.error ?? "invalid_request" },
      {
        status,
        headers: { "WWW-Authenticate": `Bearer ${params.join(", ")}`, "Cache-Control": "no-store" },
      },
    ),
  };
}
