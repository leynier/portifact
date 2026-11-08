import { API_RESOURCE, MCP_RESOURCE } from "../config.ts";
import { form, type Harness, json, pkcePair } from "./harness.ts";

export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const LOOPBACK_CALLBACK = "http://127.0.0.1:53111/callback";

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  scope: string;
  token_type: string;
  expires_in: number;
}

export interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

let operatorCount = 0;

// The CLI is a pre-registered public client: no secret, device grant and refresh tokens.
export async function seedCliClient(h: Harness): Promise<string> {
  operatorCount += 1;
  const operator = await h.signIn(`operator-${operatorCount}@example.test`);
  const client = await h.auth.api.adminCreateOAuthClient({
    headers: new Headers({ cookie: operator }),
    body: {
      client_name: "Portifact CLI",
      application_type: "native",
      token_endpoint_auth_method: "none",
      grant_types: [DEVICE_GRANT, "refresh_token"],
      // The schema requires one redirect URI even for a device-only client.
      redirect_uris: ["http://127.0.0.1/callback"],
      scope: "artifacts:read artifacts:write artifacts:delete offline_access",
      resources: [API_RESOURCE],
    },
  });
  return client.client_id;
}

export async function requestDeviceCode(
  h: Harness,
  clientId: string,
  scope = "artifacts:read offline_access",
): Promise<DeviceAuthorization> {
  const response = await h.request(
    "/api/auth/device/code",
    form({ client_id: clientId, scope, resource: API_RESOURCE }),
  );
  if (response.status !== 200) throw new Error(`device code failed with ${response.status}`);
  return response.json();
}

export function pollDeviceToken(h: Harness, clientId: string, deviceCode: string) {
  return h.request(
    "/api/auth/oauth2/token",
    form({ grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: clientId }),
  );
}

// What the verification page does: show the request to the signed-in user, then approve.
export async function approveDevice(h: Harness, cookie: string, userCode: string) {
  await h.request(`/api/auth/device?user_code=${encodeURIComponent(userCode)}`, {
    headers: { cookie },
  });
  return h.request("/api/auth/device/approve", json({ userCode }, { cookie }));
}

// Dynamic client registration as an MCP client without a Client ID Metadata Document does it.
export async function registerMcpClient(h: Harness): Promise<string> {
  const response = await h.request(
    "/api/auth/oauth2/register",
    json({
      client_name: "Example MCP client",
      redirect_uris: ["http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "artifacts:read offline_access",
    }),
  );
  if (response.status !== 201) throw new Error(`registration failed with ${response.status}`);
  const body: { client_id: string } = await response.json();
  return body.client_id;
}

export interface AuthorizeOptions {
  clientId: string;
  cookie: string;
  redirectUri?: string;
  scope?: string;
  resource?: string | null;
  codeChallenge?: string | null;
}

// Starts an authorization request and returns the raw response (a redirect).
export async function startAuthorization(h: Harness, options: AuthorizeOptions) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: options.clientId,
    redirect_uri: options.redirectUri ?? LOOPBACK_CALLBACK,
    scope: options.scope ?? "artifacts:read offline_access",
    state: "state-123",
  });
  if (options.codeChallenge !== null) {
    params.set("code_challenge", options.codeChallenge ?? "");
    params.set("code_challenge_method", "S256");
  }
  if (options.resource !== null) params.set("resource", options.resource ?? MCP_RESOURCE);
  return h.request(`/api/auth/oauth2/authorize?${params}`, {
    headers: { cookie: options.cookie },
    redirect: "manual",
  });
}

// Runs the browser part of the authorization code flow: authorize, consent, callback.
export async function authorizeWithPkce(
  h: Harness,
  options: Omit<AuthorizeOptions, "codeChallenge">,
): Promise<{ code: string; state: string | null; iss: string | null; verifier: string }> {
  const { verifier, challenge } = await pkcePair();
  const authorize = await startAuthorization(h, { ...options, codeChallenge: challenge });
  const consentUrl = new URL(authorize.headers.get("location") ?? "", "https://app.portifact.com");
  if (consentUrl.pathname !== "/consent") {
    throw new Error(`expected the consent page, got ${consentUrl.toString()}`);
  }
  const consent = await h.request(
    "/api/auth/oauth2/consent",
    json({ accept: true, oauth_query: consentUrl.search.slice(1) }, { cookie: options.cookie }),
  );
  const body: { url: string } = await consent.json();
  const callback = new URL(body.url);
  return {
    code: callback.searchParams.get("code") ?? "",
    state: callback.searchParams.get("state"),
    iss: callback.searchParams.get("iss"),
    verifier,
  };
}

export function exchangeCode(
  h: Harness,
  values: { clientId: string; code: string; verifier: string; resource?: string | null },
) {
  const body: Record<string, string> = {
    grant_type: "authorization_code",
    code: values.code,
    redirect_uri: LOOPBACK_CALLBACK,
    client_id: values.clientId,
    code_verifier: values.verifier,
  };
  if (values.resource !== null) body.resource = values.resource ?? MCP_RESOURCE;
  return h.request("/api/auth/oauth2/token", form(body));
}

export function callMcp(h: Harness, token: string) {
  return h.request("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}` } });
}

export function callApi(h: Harness, token: string) {
  return h.request("/api/v1/whoami", { headers: { authorization: `Bearer ${token}` } });
}
