// The request context (decisions 0020 and 0021): the facts about how a request reaches Portifact
// that a workspace's request policies bind, built once by each Worker's entry from what the
// platform says, never from anything a client can set. It travels with the global database
// handle (`GlobalDb.request` in @portifact/db), so the only place a role is decided (`actorOn`)
// always has one and applies the policies there.

/** The OAuth client ID of the first-party Portifact CLI: the one record seeded by migration. */
export const CLI_CLIENT_ID = "portifact-cli";

/**
 * The kinds of client that act on a workspace with a person's authorization, as far as the server
 * knows them for a fact (decision 0021): the Portifact CLI is the one seeded client record
 * (`CLI_CLIENT_ID`, the only record that lists `credentials:manage`, decision 0003); every other
 * OAuth client registered itself, chose its own name and is `oauth_apps`. The dashboard is not a
 * kind: it is always allowed.
 */
export const CLIENT_KINDS = ["cli", "oauth_apps"] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

/** The kind of an OAuth client, from its ID in the server's token record. */
export function clientKindOf(clientId: string): ClientKind {
  return clientId === CLI_CLIENT_ID ? "cli" : "oauth_apps";
}

/**
 * How a session signed in, recorded by the server when Better Auth creates the session (decision
 * 0021, "SSO required"): an email code, Google or GitHub, or a workspace's single sign-on provider
 * by its row ID (`sso_` and 32 hex digits, decision 0016). Stored as text on `sessions`, the OAuth
 * tokens and device codes (`signInMethodText`); a session from before it was recorded, or a value
 * this release does not know, reads as null: "not known".
 */
export type SignInMethod =
  | { kind: "code" }
  | { kind: "social"; provider: SocialProvider }
  | { kind: "sso"; providerId: string };

export const SOCIAL_PROVIDERS = ["google", "github"] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

/** The kinds a sign-in method is shown as (the Apps page). `unknown` is a session from before. */
export const SIGN_IN_METHOD_KINDS = ["code", "google", "github", "sso", "unknown"] as const;
export type SignInMethodKind = (typeof SIGN_IN_METHOD_KINDS)[number];

const SSO_METHOD = /^sso:(sso_[0-9a-f]{32})$/;

/** The stored spelling of a method: `code`, `google`, `github` or `sso:<provider ID>`. */
export function signInMethodText(method: SignInMethod): string {
  switch (method.kind) {
    case "code":
      return "code";
    case "social":
      return method.provider;
    case "sso":
      return `sso:${method.providerId}`;
  }
}

/** A stored method, or null when it is missing or not one this release knows (fail closed). */
export function parseSignInMethod(stored: unknown): SignInMethod | null {
  if (stored === "code") return { kind: "code" };
  if (stored === "google" || stored === "github") return { kind: "social", provider: stored };
  if (typeof stored !== "string") return null;
  const sso = SSO_METHOD.exec(stored);
  return sso?.[1] ? { kind: "sso", providerId: sso[1] } : null;
}

/** How a stored method is shown: never the provider's ID, which only admins know. */
export function signInMethodKind(stored: unknown): SignInMethodKind {
  const method = parseSignInMethod(stored);
  if (!method) return "unknown";
  return method.kind === "social" ? method.provider : method.kind;
}

/**
 * How the caller of a request authenticated, from the server's own records only (decision 0021):
 * - `session`: a Better Auth session (the dashboard, and the read and review sessions on the
 *   artifact origin that descend from one). `signedInAt` is the session row's `created_at`, which
 *   Better Auth keeps when it extends the session.
 * - `oauth`: an OAuth access token. `clientId` is the token row's; `signedInAt` the sign-in its
 *   grant came from (`oauth_access_tokens.auth_time`, carried through every refresh), null when
 *   the record does not say.
 * - `service_token`: a workspace's service token; it has no sign-in.
 * `method` is how the sign-in the credential descends from happened (`SignInMethod`), null when
 * the record does not say; "SSO required" refuses that.
 * `userId` is who the credential belongs to; the policies apply its facts only to that caller.
 */
export type Credential =
  | { kind: "session"; userId: string; signedInAt: number; method: SignInMethod | null }
  | {
      kind: "oauth";
      userId: string;
      clientId: string;
      client: ClientKind;
      signedInAt: number | null;
      method: SignInMethod | null;
    }
  | { kind: "service_token"; userId: string };

/**
 * - `request`: a request a Worker answers. `ip` is `CF-Connecting-IP` as Cloudflare sets it,
 *   null when it is missing or unreadable, which no network allowlist admits (fail closed).
 *   `credential` is recorded where the request authenticates (`recordCredential`); absent until
 *   then, and null when the request presented two different ones. A policy that needs a fact the
 *   context lacks refuses (fail closed).
 *   `sso` is whether the Worker offers single sign-on (`SSO_ENABLED`): without it nobody can sign
 *   in through a provider, so "SSO required" does not bind (it ships switched off).
 * - `background`: work no client is making right now (outbox jobs, maintenance scans, the
 *   operator tool, a Worker's deferred flushes). The policies were applied to the request that
 *   asked for it; there is no network or sign-in to check.
 */
export type RequestContext =
  | { kind: "request"; ip: string | null; credential?: Credential | null; sso?: boolean }
  | { kind: "background" };

/** Work no client is making right now (see `RequestContext`). */
export const BACKGROUND: RequestContext = Object.freeze({ kind: "background" });

/**
 * What a handle built without a context gets: a request from nowhere, which every network
 * allowlist refuses. A Worker that forgets to build its context fails closed, never open. It is
 * frozen, so no credential is ever recorded on it.
 */
export const UNKNOWN_REQUEST: RequestContext = Object.freeze({ kind: "request", ip: null });

/**
 * The context of a request a Worker answers, from Cloudflare's `CF-Connecting-IP` only, and
 * whether the Worker offers single sign-on (its own configuration, never the request).
 */
export function requestContextOf(
  request: Request,
  options: { sso?: boolean } = {},
): RequestContext {
  const ip = request.headers.get("cf-connecting-ip")?.trim();
  return { kind: "request", ip: ip ? ip : null, ...(options.sso === true ? { sso: true } : {}) };
}

function sameMethod(a: SignInMethod | null, b: SignInMethod | null): boolean {
  if (a === null || b === null) return a === b;
  return signInMethodText(a) === signInMethodText(b);
}

function sameCredential(a: Credential, b: Credential): boolean {
  if (a.kind !== b.kind || a.userId !== b.userId) return false;
  if (a.kind === "service_token" || b.kind === "service_token") return true;
  if (a.signedInAt !== b.signedInAt || !sameMethod(a.method, b.method)) return false;
  return a.kind === "oauth" && b.kind === "oauth" ? a.clientId === b.clientId : true;
}

/**
 * Records how the request authenticated, where it does (decision 0021): the dashboard's session
 * lookup, the OAuth token's introspection, a service token's check, a read or review session's
 * renewal. The context is the request's own object, shared by every handle built for it. A
 * second, different credential makes it unknown (null) for the rest of the request, so a policy
 * that needs it refuses. Background and frozen contexts never take one.
 */
export function recordCredential(context: RequestContext, credential: Credential): void {
  if (context.kind !== "request" || Object.isFrozen(context)) return;
  if (context.credential === null) return;
  if (context.credential !== undefined && !sameCredential(context.credential, credential)) {
    context.credential = null;
    return;
  }
  context.credential = credential;
}
