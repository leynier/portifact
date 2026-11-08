// Fixed identifiers of the spike. In apps/app these come from per-environment configuration.
export const ORIGIN = "https://app.portifact.com";
export const AUTH_BASE_PATH = "/api/auth";
// Better Auth's issuer is its base URL including the base path. MCP clients find it through
// the protected resource metadata, and RFC 8414 path insertion serves its metadata.
export const ISSUER = `${ORIGIN}${AUTH_BASE_PATH}`;

export const API_RESOURCE = `${ORIGIN}/api/v1`;
export const MCP_RESOURCE = `${ORIGIN}/mcp`;

export const PORTIFACT_SCOPES = [
  "artifacts:read",
  "artifacts:write",
  "artifacts:share",
  "artifacts:delete",
  "annotations:read",
  "annotations:write",
  "annotations:moderate",
] as const;

export type PortifactScope = (typeof PORTIFACT_SCOPES)[number];

// The minimal set an MCP client requests first; more scopes come through step-up.
export const MCP_BASELINE_SCOPES: readonly PortifactScope[] = ["artifacts:read"];
