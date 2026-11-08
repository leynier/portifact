// HTTP calls to the authorization server and the API. Responses are validated before use, and
// no response body, token or code is ever included in an error message.
import { TokenPrincipal } from "@portifact/contracts";
import { z } from "zod";
import { CliError } from "./errors.ts";
import { messages } from "./messages.ts";
import type { Runtime } from "./runtime.ts";
import type { Server } from "./server.ts";

/** The first-party CLI client, seeded by packages/db/migrations/0003_seed_oauth_clients.sql. */
export const CLI_CLIENT_ID = "portifact-cli";
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const DeviceAuthorization = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().min(1),
  verification_uri_complete: z.string().min(1).optional(),
  expires_in: z.number().positive(),
  interval: z.number().positive().optional(),
});
export type DeviceAuthorization = z.infer<typeof DeviceAuthorization>;

const TokenSet = z.object({
  access_token: z.string().min(1),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  expires_in: z.number().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});
export type TokenSet = z.infer<typeof TokenSet>;

const OAuthError = z.object({ error: z.string() });

export type PollResult =
  | { kind: "tokens"; tokens: TokenSet }
  | { kind: "pending" }
  | { kind: "slow_down" }
  | { kind: "denied" }
  | { kind: "expired" }
  /** The server could not answer this time; polling goes on until the code expires. */
  | { kind: "transient" };

export type RefreshResult = { kind: "tokens"; tokens: TokenSet } | { kind: "invalid_grant" };
export type PrincipalResult = { kind: "ok"; principal: TokenPrincipal } | { kind: "unauthorized" };

export async function requestDeviceCode(
  runtime: Runtime,
  server: Server,
  scopes: readonly string[],
): Promise<DeviceAuthorization> {
  const response = await postForm(runtime, server, "/device/code", {
    client_id: CLI_CLIENT_ID,
    scope: scopes.join(" "),
    resource: server.apiResource,
  });
  if (!response.ok) throw unexpected(server, response);
  return parse(server, DeviceAuthorization, await readJson(response));
}

export async function pollDeviceToken(
  runtime: Runtime,
  server: Server,
  deviceCode: string,
): Promise<PollResult> {
  let response: Response;
  try {
    response = await postForm(runtime, server, "/oauth2/token", {
      grant_type: DEVICE_GRANT,
      device_code: deviceCode,
      client_id: CLI_CLIENT_ID,
    });
  } catch {
    // send only throws for network failures.
    return { kind: "transient" };
  }
  if (response.ok) {
    return { kind: "tokens", tokens: parse(server, TokenSet, await readJson(response)) };
  }
  if (response.status >= 500) return { kind: "transient" };
  switch (await oauthError(response)) {
    case "authorization_pending":
      return { kind: "pending" };
    case "slow_down":
      return { kind: "slow_down" };
    case "access_denied":
      return { kind: "denied" };
    // The code was already redeemed or forgotten after a denial: it can no longer succeed.
    case "expired_token":
    case "invalid_grant":
      return { kind: "expired" };
    default:
      throw unexpected(server, response);
  }
}

export async function refreshTokens(
  runtime: Runtime,
  server: Server,
  refreshToken: string,
): Promise<RefreshResult> {
  const response = await postForm(runtime, server, "/oauth2/token", {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLI_CLIENT_ID,
  });
  if (response.ok) {
    return { kind: "tokens", tokens: parse(server, TokenSet, await readJson(response)) };
  }
  if (response.status === 400 && (await oauthError(response)) === "invalid_grant") {
    return { kind: "invalid_grant" };
  }
  throw unexpected(server, response);
}

/**
 * Revokes one token (RFC 7009). Returns false when the server could not answer, so the caller
 * keeps the credentials and can retry. Any other answer is final: the server replies 200 even
 * for tokens it does not know.
 */
export async function revokeToken(
  runtime: Runtime,
  server: Server,
  token: string,
  hint: "access_token" | "refresh_token",
): Promise<boolean> {
  try {
    const response = await postForm(runtime, server, "/oauth2/revoke", {
      token,
      token_type_hint: hint,
      client_id: CLI_CLIENT_ID,
    });
    await response.body?.cancel();
    return response.status < 500 && response.status !== 429;
  } catch {
    return false;
  }
}

export async function fetchPrincipal(
  runtime: Runtime,
  server: Server,
  accessToken: string,
): Promise<PrincipalResult> {
  const response = await send(runtime, server, `${server.apiResource}/me`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (response.status === 401) {
    await response.body?.cancel();
    return { kind: "unauthorized" };
  }
  if (!response.ok) throw unexpected(server, response);
  return { kind: "ok", principal: parse(server, TokenPrincipal, await readJson(response)) };
}

function postForm(
  runtime: Runtime,
  server: Server,
  path: string,
  values: Record<string, string>,
): Promise<Response> {
  return send(runtime, server, `${server.authBase}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(values).toString(),
  });
}

export async function send(
  runtime: Runtime,
  server: Server,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    // Redirects are not followed: a redirect would carry the tokens to another URL.
    return await runtime.fetch(url, { ...init, redirect: "manual" });
  } catch {
    throw new CliError("network_error", messages.errors.network(server.origin));
  }
}

export async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function oauthError(response: Response): Promise<string | undefined> {
  const parsed = OAuthError.safeParse(await readJson(response));
  return parsed.success ? parsed.data.error : undefined;
}

function parse<T>(server: Server, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new CliError("server_error", messages.errors.server(server.origin));
  return parsed.data;
}

function unexpected(server: Server, response: Response): CliError {
  if (response.status === 429) return new CliError("rate_limited", messages.errors.rateLimited);
  return new CliError("server_error", messages.errors.server(server.origin));
}
