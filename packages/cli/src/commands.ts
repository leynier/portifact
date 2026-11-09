// login, logout and whoami, and the helpers every command shares. Progress and instructions go
// to stderr; the result goes to stdout, as text or as stable JSON with --json. Tokens never reach
// either stream.
import { CREDENTIALS_SCOPE, OAuthScope, type TokenPrincipal } from "@portifact/contracts";
import { openCredentialStore } from "./credentials.ts";
import { CliError } from "./errors.ts";
import { messages } from "./messages.ts";
import {
  type DeviceAuthorization,
  fetchPrincipal,
  pollDeviceToken,
  requestDeviceCode,
  revokeToken,
} from "./oauth.ts";
import type { Io, Runtime } from "./runtime.ts";
import { resolveServer, type Server } from "./server.ts";
import { type Authorized, credentialsFrom, type Session, withAccessToken } from "./session.ts";

/**
 * Every product scope the CLI's commands use, managing the account's own tokens
 * (`portifact tokens`) and a refresh token.
 */
export const LOGIN_SCOPES: readonly string[] = [
  ...OAuthScope.options,
  CREDENTIALS_SCOPE,
  "offline_access",
];

/** RFC 8628: the default polling interval, and the increase after `slow_down`. */
const DEFAULT_INTERVAL_SECONDS = 5;
const SLOW_DOWN_SECONDS = 5;

export interface OutputOptions {
  json: boolean;
}

export interface LoginOptions extends OutputOptions {
  browser: boolean;
}

export async function login(io: Io, runtime: Runtime, options: LoginOptions): Promise<void> {
  const server = resolveServer(runtime.env);
  announceOverride(io, server);
  const store = await openCredentialStore(runtime);

  const device = await requestDeviceCode(runtime, server, LOGIN_SCOPES);
  const verificationUrl = sameOriginUrl(server, device.verification_uri);
  const openUrl = device.verification_uri_complete
    ? sameOriginUrl(server, device.verification_uri_complete)
    : verificationUrl;

  io.stderr(`${messages.deviceInstructions(verificationUrl, formatUserCode(device.user_code))}\n`);
  if (options.browser && runtime.interactive && (await runtime.openBrowser(openUrl))) {
    io.stderr(`${messages.browserOpened}\n`);
  }
  io.stderr(`${messages.waiting(Math.max(1, Math.ceil(device.expires_in / 60)))}\n`);

  const tokens = await waitForApproval(runtime, server, device);
  const previous = await store.load(server.origin);
  const credentials = credentialsFrom(tokens, runtime.now());
  await store.save(server.origin, credentials);
  // The tokens of an earlier login on this device are no longer reachable; end them.
  if (previous?.refreshToken && previous.refreshToken !== credentials.refreshToken) {
    await revokeToken(runtime, server, previous.refreshToken, "refresh_token");
  }
  if (store.kind === "file") io.stderr(`${messages.fileStoreWarning(store.filePath)}\n`);

  const principal = await withAccessToken({ runtime, server, store }, principalOf(runtime, server));

  if (options.json) {
    writeJson(io, {
      server: server.origin,
      userId: principal.userId,
      clientId: principal.clientId,
      scopes: principal.scopes,
      credentialStore: store.kind,
    });
  } else {
    io.stdout(`${messages.signedIn(server.origin, principal.userId)}\n`);
  }
}

async function waitForApproval(runtime: Runtime, server: Server, device: DeviceAuthorization) {
  let intervalMs = (device.interval ?? DEFAULT_INTERVAL_SECONDS) * 1000;
  const deadline = runtime.now() + device.expires_in * 1000;
  for (;;) {
    await runtime.sleep(intervalMs);
    if (runtime.now() >= deadline) {
      throw new CliError("authorization_expired", messages.errors.expired);
    }
    const result = await pollDeviceToken(runtime, server, device.device_code);
    switch (result.kind) {
      case "tokens":
        return result.tokens;
      case "slow_down":
        intervalMs += SLOW_DOWN_SECONDS * 1000;
        break;
      case "denied":
        throw new CliError("authorization_denied", messages.errors.denied);
      case "expired":
        throw new CliError("authorization_expired", messages.errors.expired);
      default:
        break;
    }
  }
}

export async function whoami(io: Io, runtime: Runtime, options: OutputOptions): Promise<void> {
  const session = await openSession(io, runtime);
  const principal = await signedInPrincipal(session);
  const origin = session.server.origin;
  if (options.json) {
    writeJson(io, {
      server: origin,
      userId: principal.userId,
      clientId: principal.clientId,
      scopes: principal.scopes,
    });
  } else {
    io.stdout(
      `${messages.whoami(origin, principal.userId, principal.clientId, principal.scopes)}\n`,
    );
  }
}

export async function logout(io: Io, runtime: Runtime, options: OutputOptions): Promise<void> {
  const { server, store } = await openSession(io, runtime);
  const credentials = await store.load(server.origin);

  if (credentials) {
    // Revoke first and forget the tokens only once the server has answered, so a network
    // failure never leaves live tokens that this device can no longer revoke.
    const revoked = [
      credentials.refreshToken
        ? await revokeToken(runtime, server, credentials.refreshToken, "refresh_token")
        : true,
      await revokeToken(runtime, server, credentials.accessToken, "access_token"),
    ];
    if (revoked.includes(false)) {
      throw new CliError("network_error", messages.errors.revokeFailed(server.origin));
    }
    await store.remove(server.origin);
  }

  if (options.json) {
    writeJson(io, { server: server.origin, wasSignedIn: credentials !== undefined });
  } else if (credentials) {
    io.stdout(`${messages.signedOut(server.origin)}\n`);
  } else {
    io.stdout(`${messages.notSignedInLogout(server.origin)}\n`);
  }
}

/** The account and client the session's token belongs to. */
export function signedInPrincipal(session: Session): Promise<TokenPrincipal> {
  return withAccessToken(session, principalOf(session.runtime, session.server));
}

function principalOf(
  runtime: Runtime,
  server: Server,
): (token: string) => Promise<Authorized<TokenPrincipal>> {
  return async (token) => {
    const result = await fetchPrincipal(runtime, server, token);
    return result.kind === "ok" ? { kind: "ok", value: result.principal } : result;
  };
}

export async function openSession(io: Io, runtime: Runtime): Promise<Session> {
  const server = resolveServer(runtime.env);
  announceOverride(io, server);
  return { runtime, server, store: await openCredentialStore(runtime) };
}

function announceOverride(io: Io, server: Server): void {
  if (server.overridden) io.stderr(`${messages.serverOverride(server.origin)}\n`);
}

// The page the user opens and the browser launch come from the server's answer. Only pages on
// the server's own origin are shown or opened.
function sameOriginUrl(server: Server, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError("server_error", messages.errors.server(server.origin));
  }
  if (url.origin !== server.origin) {
    throw new CliError("server_error", messages.errors.server(server.origin));
  }
  return url.toString();
}

/** Shows an 8-character code as two groups, the way the device page accepts it. */
export function formatUserCode(code: string): string {
  return /^[A-Za-z0-9]{8}$/.test(code) ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

export function writeJson(io: Io, value: unknown): void {
  io.stdout(`${JSON.stringify(value)}\n`);
}
