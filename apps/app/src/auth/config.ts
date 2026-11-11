import { CLI_CLIENT_ID, CREDENTIALS_SCOPE, OAuthScope } from "@portifact/contracts";

export const AUTH_BASE_PATH = "/api/auth";

/** The product scopes: classes of action on artifacts and annotations. */
export const PORTIFACT_SCOPES: readonly string[] = OAuthScope.options;
export const OFFLINE_ACCESS = "offline_access";

/**
 * What a dynamically registered or CIMD client (MCP) may ever ask for: the product scopes and a
 * refresh token, never `credentials:manage` (decision 0003).
 */
export const REGISTRATION_SCOPES: readonly string[] = [...PORTIFACT_SCOPES, OFFLINE_ACCESS];

/**
 * Every scope the authorization server knows. `credentials:manage` is granted only to clients
 * whose own record lists it, which today is the seeded CLI client (migration 0024).
 */
export const ALL_SCOPES: readonly string[] = [
  ...PORTIFACT_SCOPES,
  CREDENTIALS_SCOPE,
  OFFLINE_ACCESS,
];

// The minimal set an MCP client requests first; more scopes come through step-up.
export const MCP_BASELINE_SCOPES: readonly string[] = ["artifacts:read"];

/** The first-party CLI client, seeded by migration 0003 (decision 0021 names its kind). */
export { CLI_CLIENT_ID };

export interface AuthUrls {
  origin: string;
  /** Better Auth's issuer is its base URL including the base path. */
  issuer: string;
  /** Canonical resource URIs (RFC 8707). Tokens must carry the one they are used at. */
  apiResource: string;
  mcpResource: string;
}

export function authUrls(appOrigin: string): AuthUrls {
  const origin = new URL(appOrigin).origin;
  return {
    origin,
    issuer: `${origin}${AUTH_BASE_PATH}`,
    apiResource: `${origin}/api/v1`,
    mcpResource: `${origin}/mcp`,
  };
}
