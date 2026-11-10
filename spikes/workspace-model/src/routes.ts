// The endpoints the organization, SSO and SCIM plugins add, and which of them Portifact would add
// to the allowlist in apps/app/src/auth/routes.ts. routes.test.ts lists every endpoint Better
// Auth 1.7.18 actually registers and fails if one is not classified here, so an upgrade that
// adds an endpoint cannot slip through unreviewed.
//
// `browser`: the dashboard session cookie, exact Origin on POST (as today).
// `idp`: called by the identity provider through the user's browser (a cross-site form POST for
// SAML), so it cannot carry the app Origin; the plugin validates the signed response instead.
// `scim`: called by the customer's directory with a bearer token; cookies are stripped.
export type Kind = "browser" | "idp" | "public" | "scim";

export interface OpenEndpoint {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  kind: Kind;
  why: string;
}

export const OPEN: readonly OpenEndpoint[] = [
  {
    method: "POST",
    path: "/sign-in/sso",
    kind: "browser",
    why: "Starts SSO sign-in from the login page",
  },
  {
    method: "GET",
    path: "/sso/callback/:providerId",
    kind: "idp",
    why: "OIDC redirect back from the identity provider",
  },
  {
    method: "POST",
    path: "/sso/saml2/sp/acs/:providerId",
    kind: "idp",
    why: "SAML assertion consumer service",
  },
  {
    method: "GET",
    path: "/sso/saml2/sp/metadata",
    kind: "public",
    why: "SP metadata the customer loads into their IdP",
  },
  { method: "GET", path: "/scim/v2/ServiceProviderConfig", kind: "scim", why: "SCIM discovery" },
  { method: "GET", path: "/scim/v2/Schemas", kind: "scim", why: "SCIM discovery" },
  { method: "GET", path: "/scim/v2/Schemas/:schemaId", kind: "scim", why: "SCIM discovery" },
  { method: "GET", path: "/scim/v2/ResourceTypes", kind: "scim", why: "SCIM discovery" },
  {
    method: "GET",
    path: "/scim/v2/ResourceTypes/:resourceTypeId",
    kind: "scim",
    why: "SCIM discovery",
  },
  { method: "GET", path: "/scim/v2/Users", kind: "scim", why: "Directory reads users" },
  { method: "POST", path: "/scim/v2/Users", kind: "scim", why: "Directory provisions a user" },
  { method: "GET", path: "/scim/v2/Users/:userId", kind: "scim", why: "Directory reads a user" },
  { method: "PUT", path: "/scim/v2/Users/:userId", kind: "scim", why: "Directory replaces a user" },
  {
    method: "PATCH",
    path: "/scim/v2/Users/:userId",
    kind: "scim",
    why: "Directory deactivates or updates a user",
  },
  {
    method: "DELETE",
    path: "/scim/v2/Users/:userId",
    kind: "scim",
    why: "Directory deprovisions a user",
  },
  { method: "GET", path: "/scim/v2/Groups", kind: "scim", why: "Directory reads groups (T3)" },
  { method: "POST", path: "/scim/v2/Groups", kind: "scim", why: "Directory creates a group (T3)" },
  {
    method: "GET",
    path: "/scim/v2/Groups/:groupId",
    kind: "scim",
    why: "Directory reads a group (T3)",
  },
  {
    method: "PUT",
    path: "/scim/v2/Groups/:groupId",
    kind: "scim",
    why: "Directory replaces a group (T3)",
  },
  {
    method: "PATCH",
    path: "/scim/v2/Groups/:groupId",
    kind: "scim",
    why: "Directory changes group members (T3)",
  },
  {
    method: "DELETE",
    path: "/scim/v2/Groups/:groupId",
    kind: "scim",
    why: "Directory deletes a group (T3)",
  },
];

/**
 * Closed, with the reason. Workspace and SSO administration must behave the same from the web,
 * the CLI and MCP, so it belongs in /api/v1 over packages/services, never in cookie-only Better
 * Auth endpoints that a bearer token cannot reach.
 */
export const CLOSED: Readonly<Record<string, string>> = {
  "/organization/*":
    "Workspace management goes through /api/v1 and the services for web, CLI and MCP parity, batches, audit and quotas",
  "/sso/register": "Provider administration goes through /api/v1 (admin role from the services)",
  "/sso/update-provider": "Provider administration goes through /api/v1",
  "/sso/delete-provider": "Provider administration goes through /api/v1",
  "/sso/get-provider": "Provider administration goes through /api/v1",
  "/sso/providers": "Provider administration goes through /api/v1",
  "/sso/request-domain-verification":
    "Needs node:dns resolveTxt; domains are verified by T2's own DNS check",
  "/sso/verify-domain": "Needs node:dns resolveTxt; domains are verified by T2's own DNS check",
  "/sso/callback": "Shared OIDC callback; per-provider callbacks are enough",
  "/sso/saml2/sp/slo/:providerId": "Single Logout is not offered",
  "/sso/saml2/logout/:providerId": "Single Logout is not offered",
  "GET /sso/saml2/sp/acs/:providerId": "Only the HTTP-POST binding is offered",
  "/scim/v2/*": "Managed connection, decommission and reconcile endpoints are operator work",
};

function matches(pattern: string, path: string): boolean {
  const a = pattern.split("/");
  const b = path.split("/");
  return (
    a.length === b.length &&
    a.every((part, i) => (part.startsWith(":") ? (b[i] ?? "") !== "" : part === b[i]))
  );
}

/** The open endpoint for a request path under the auth base path, if any. */
export function openEndpoint(method: string, path: string): OpenEndpoint | undefined {
  return OPEN.find((e) => e.method === method && matches(e.path, path));
}

/** Whether a registered endpoint path is classified as open or closed. */
export function classified(method: string, path: string): "open" | "closed" | undefined {
  if (OPEN.some((e) => e.method === method && e.path === path)) return "open";
  if (path in CLOSED || `${method} ${path}` in CLOSED) return "closed";
  if (path.startsWith("/organization/") || path.startsWith("/scim/v2/")) return "closed";
  return undefined;
}
