import { env } from "cloudflare:workers";
import { createDb, schema } from "@portifact/db";
import { CLI_CLIENT_ID } from "../src/auth/config.ts";
import {
  API_RESOURCE,
  form,
  type Harness,
  json,
  MCP_RESOURCE,
  ORIGIN,
  pkcePair,
} from "./harness.ts";

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

let deviceClients = 0;

/**
 * Another public device-grant client shaped like the seeded CLI, for tests that need two
 * clients. Inserted directly, the way migration 0003 seeds the CLI.
 */
export async function insertDeviceClient(): Promise<string> {
  deviceClients += 1;
  const clientId = `test-device-client-${deviceClients}-${crypto.randomUUID()}`;
  const now = new Date();
  const db = createDb(env.DB);
  await db.insert(schema.oauthClients).values({
    id: clientId,
    clientId,
    name: "Other device client",
    disabled: false,
    scopes: JSON.stringify(["artifacts:read", "offline_access"]),
    redirectUris: JSON.stringify(["http://127.0.0.1/callback"]),
    tokenEndpointAuthMethod: "none",
    applicationType: "native",
    grantTypes: JSON.stringify([DEVICE_GRANT, "refresh_token"]),
    requirePKCE: true,
    createdAt: now,
    updatedAt: now,
  });
  await db
    .insert(schema.oauthClientResources)
    .values({ id: `${clientId}-api`, clientId, resourceId: API_RESOURCE, createdAt: now });
  return clientId;
}

export async function requestDeviceCode(
  h: Harness,
  clientId = CLI_CLIENT_ID,
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

/** The query the consent page receives, as its script sends it back. */
export function consentQuery(authorize: Response): string {
  const consentUrl = new URL(authorize.headers.get("location") ?? "", ORIGIN);
  if (consentUrl.pathname !== "/consent") {
    throw new Error(`expected the consent page, got ${consentUrl.toString()}`);
  }
  return consentUrl.search.slice(1);
}

// Runs the browser part of the authorization code flow: authorize, consent, callback.
export async function authorizeWithPkce(
  h: Harness,
  options: Omit<AuthorizeOptions, "codeChallenge">,
): Promise<{ code: string; state: string | null; iss: string | null; verifier: string }> {
  const { verifier, challenge } = await pkcePair();
  const authorize = await startAuthorization(h, { ...options, codeChallenge: challenge });
  const consent = await h.request(
    "/api/auth/oauth2/consent",
    json({ accept: true, oauth_query: consentQuery(authorize) }, { cookie: options.cookie }),
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

/** A tools/list request at the MCP endpoint, as a 2026-07-28 client sends it. */
export function callMcp(h: Harness, token: string) {
  return h.request("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/list",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "flows", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

export function callApi(h: Harness, token: string) {
  return h.request("/api/v1/me", { headers: { authorization: `Bearer ${token}` } });
}
