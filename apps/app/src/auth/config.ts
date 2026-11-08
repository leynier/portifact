import { OAuthScope } from "@portifact/contracts";

export const AUTH_BASE_PATH = "/api/auth";

/** Every scope a client can request: the product scopes plus refresh tokens. */
export const PORTIFACT_SCOPES: readonly string[] = OAuthScope.options;
export const OFFLINE_ACCESS = "offline_access";
export const ALL_SCOPES: readonly string[] = [...PORTIFACT_SCOPES, OFFLINE_ACCESS];

// The minimal set an MCP client requests first; more scopes come through step-up.
export const MCP_BASELINE_SCOPES: readonly string[] = ["artifacts:read"];

/** The first-party CLI client, seeded by migration 0003. */
export const CLI_CLIENT_ID = "portifact-cli";

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
