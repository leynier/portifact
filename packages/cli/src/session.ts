import { isServiceTokenSecret } from "@portifact/contracts";
import type { CredentialStore, Credentials } from "./credentials.ts";
import { CliError } from "./errors.ts";
import { messages } from "./messages.ts";
import { refreshTokens, type TokenSet } from "./oauth.ts";
import type { Runtime } from "./runtime.ts";
import type { Server } from "./server.ts";

/**
 * A workspace's service token (decision 0011), for CI: used instead of the stored login, never
 * written to disk or printed, never refreshed.
 */
export const SERVICE_TOKEN_ENV = "PORTIFACT_TOKEN";

/** The service token the environment holds, or undefined; a malformed one is refused. */
export function serviceTokenOf(runtime: Pick<Runtime, "env">): string | undefined {
  const value = runtime.env[SERVICE_TOKEN_ENV]?.trim();
  if (!value) return undefined;
  if (!isServiceTokenSecret(value)) {
    throw new CliError("unauthenticated", messages.errors.serviceTokenMalformed);
  }
  return value;
}

/** Access tokens this close to expiry are refreshed before use, to absorb clock skew. */
export const REFRESH_MARGIN_MS = 60_000;

/** Used when the server omits `expires_in`; the token is then refreshed on its first 401. */
const UNKNOWN_EXPIRY_MS = 3_600_000;

export interface Session {
  runtime: Runtime;
  server: Server;
  store: CredentialStore;
}

export type Authorized<T> = { kind: "ok"; value: T } | { kind: "unauthorized" };

export function credentialsFrom(
  tokens: TokenSet,
  now: number,
  previous?: Credentials,
): Credentials {
  // A server that does not rotate refresh tokens omits it; the current one stays valid.
  const refreshToken = tokens.refresh_token ?? previous?.refreshToken;
  return {
    accessToken: tokens.access_token,
    ...(refreshToken ? { refreshToken } : {}),
    expiresAt: now + (tokens.expires_in ? tokens.expires_in * 1000 : UNKNOWN_EXPIRY_MS),
    scopes: tokens.scope ? tokens.scope.split(" ").filter(Boolean) : (previous?.scopes ?? []),
  };
}

/**
 * Runs a call with a valid access token, refreshing it transparently: before the call when it
 * is about to expire, and once more if the server answers 401.
 */
export async function withAccessToken<T>(
  session: Session,
  call: (accessToken: string) => Promise<Authorized<T>>,
): Promise<T> {
  const { runtime, server, store } = session;
  const serviceToken = serviceTokenOf(runtime);
  if (serviceToken) {
    const result = await call(serviceToken);
    if (result.kind === "ok") return result.value;
    throw new CliError("unauthenticated", messages.errors.serviceTokenRefused(server.origin));
  }
  let credentials = await store.load(server.origin);
  if (!credentials) {
    throw new CliError("unauthenticated", messages.errors.notSignedIn(server.origin));
  }

  let refreshed = false;
  if (credentials.expiresAt - runtime.now() <= REFRESH_MARGIN_MS && credentials.refreshToken) {
    credentials = await refresh(session, credentials);
    refreshed = true;
  }

  const first = await call(credentials.accessToken);
  if (first.kind === "ok") return first.value;

  if (!refreshed && credentials.refreshToken) {
    credentials = await refresh(session, credentials);
    const second = await call(credentials.accessToken);
    if (second.kind === "ok") return second.value;
  }
  throw new CliError("unauthenticated", messages.errors.sessionEnded(server.origin));
}

async function refresh(session: Session, credentials: Credentials): Promise<Credentials> {
  const { runtime, server, store } = session;
  const used = credentials.refreshToken ?? "";
  const result = await refreshTokens(runtime, server, used);
  if (result.kind === "tokens") {
    const next = credentialsFrom(result.tokens, runtime.now(), credentials);
    await store.save(server.origin, next);
    return next;
  }

  // Refresh tokens rotate on use. If another portifact process refreshed first, the stored
  // credentials are newer than the ones this process read and are still good.
  const stored = await store.load(server.origin);
  if (stored?.refreshToken && stored.refreshToken !== used) return stored;

  await store.remove(server.origin);
  throw new CliError("unauthenticated", messages.errors.sessionEnded(server.origin));
}
