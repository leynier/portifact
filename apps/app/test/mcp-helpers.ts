// Helpers for MCP tests: real OAuth tokens for the MCP resource and the API, a real MCP client
// from the official SDK talking to the Worker in process, and raw JSON-RPC for wire checks.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { CLI_CLIENT_ID } from "../src/auth/config.ts";
import {
  approveDevice,
  authorizeWithPkce,
  exchangeCode,
  pollDeviceToken,
  requestDeviceCode,
  type TokenResponse,
} from "./flows.ts";
import { form, type Harness, json, MCP_RESOURCE } from "./harness.ts";

export const MODERN = "2026-07-28";
export const ALL_SCOPES = "artifacts:read artifacts:write artifacts:delete offline_access";

/** Dynamic client registration for an MCP client allowed to request `scope`. */
export async function registerClient(h: Harness, scope = ALL_SCOPES): Promise<string> {
  const response = await h.request(
    "/api/auth/oauth2/register",
    json({
      client_name: "Test MCP client",
      redirect_uris: ["http://127.0.0.1:53111/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope,
    }),
  );
  if (response.status !== 201) throw new Error(`registration failed with ${response.status}`);
  return (await response.json<{ client_id: string }>()).client_id;
}

/** A registered MCP client and its access token, signed in as `email`, with `scope`. */
export async function mcpGrant(h: Harness, email: string, scope = ALL_SCOPES) {
  const clientId = await registerClient(h, ALL_SCOPES);
  const cookie = await h.signIn(email);
  const callback = await authorizeWithPkce(h, { clientId, cookie, scope });
  const response = await exchangeCode(h, { clientId, ...callback });
  if (response.status !== 200) throw new Error(`token exchange failed with ${response.status}`);
  return { clientId, token: (await response.json<TokenResponse>()).access_token };
}

/** An access token for the MCP resource, signed in as `email`, with `scope`. */
export async function mcpToken(h: Harness, email: string, scope = ALL_SCOPES): Promise<string> {
  return (await mcpGrant(h, email, scope)).token;
}

/** Revokes an access token at the authorization server, as a client does on sign-out. */
export function revoke(h: Harness, clientId: string, token: string) {
  return h.request(
    "/api/auth/oauth2/revoke",
    form({ token, token_type_hint: "access_token", client_id: clientId }),
  );
}

/** An access token for the API (the CLI's device flow), signed in as `email`, with `scope`. */
export async function apiToken(h: Harness, email: string, scope = ALL_SCOPES): Promise<string> {
  const cookie = await h.signIn(email);
  const device = await requestDeviceCode(h, CLI_CLIENT_ID, scope);
  await approveDevice(h, cookie, device.user_code);
  const response = await pollDeviceToken(h, CLI_CLIENT_ID, device.device_code);
  if (response.status !== 200) throw new Error(`device token failed with ${response.status}`);
  return (await response.json<TokenResponse>()).access_token;
}

/** Calls the API with a bearer token. */
export function api(h: Harness, token: string, path: string, init: RequestInit = {}) {
  return h.request(path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

/** A connected SDK client. `modern` pins 2026-07-28; `legacy` uses the 2025 handshake. */
export async function connect(
  h: Harness,
  token: string,
  era: "modern" | "legacy" = "modern",
): Promise<Client> {
  const client = new Client(
    { name: "portifact-tests", version: "1.0.0" },
    era === "modern" ? { versionNegotiation: { mode: { pin: MODERN } } } : {},
  );
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    request.headers.set("authorization", `Bearer ${token}`);
    return h.request(request.url, request);
  };
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_RESOURCE), { fetch }));
  return client;
}

export interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

/** Calls a tool and returns its result as the client received it. */
export async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

/** One raw 2026-07-28 request, for status codes and headers the SDK client hides. */
export function rpc(
  h: Harness,
  token: string | null,
  method: string,
  params: Record<string, unknown> = {},
) {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": MODERN,
    "mcp-method": method,
  };
  if (typeof params.name === "string") headers["mcp-name"] = params.name;
  if (token) headers.authorization = `Bearer ${token}`;
  return h.request("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientInfo": { name: "raw", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

/** A tools/call over raw JSON-RPC. */
export function rawCall(h: Harness, token: string, name: string, args: Record<string, unknown>) {
  return rpc(h, token, "tools/call", { name, arguments: args });
}
