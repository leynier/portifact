// Single sign-on with OpenID Connect for workspaces (premium plan E1, decision 0016): the
// authorization code flow as a small Better Auth plugin. Better Auth keeps state, PKCE and the
// session: `generateState`/`parseState` bind the flow to a signed cookie and a verification row,
// and `handleOAuthUserInfo` creates or links the account through the same hooks as every other
// sign-in, so the terms acceptance and the human check apply unchanged. This module adds what
// OIDC needs on top: discovery, the nonce, the token request and the ID token's verification
// with `jose` (signature against the provider's keys, `iss`, `aud`, `azp`, `exp`, `iat`,
// `nbf`, `nonce`, asymmetric algorithms only). Who may sign in, and as whom, is decided by the
// services (packages/services/src/sso.ts).
//
// Never logs codes, tokens, ID tokens, client secrets or claims. Reachable only with
// `SSO_ENABLED="true"` (routes.ts).
import { SSO_LIMITS, ssoCallbackPath } from "@portifact/contracts";
import { regionsFromEnv } from "@portifact/db";
import { SSO_ID_TOKEN_ALGORITHMS } from "@portifact/domain";
import {
  checkSsoIdentity,
  discoverSso,
  fetchSsoJson,
  joinWorkspaceThroughSso,
  type SsoFetch,
  ssoAccountProvider,
  ssoKeys,
  ssoProviderForCallback,
  ssoProviderForEmail,
} from "@portifact/services";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import {
  createAuthorizationURL,
  generateState,
  handleOAuthUserInfo,
  parseState,
} from "better-auth/oauth2";
import {
  createLocalJWKSet,
  type JSONWebKeySet,
  type JWTPayload,
  errors as joseErrors,
  jwtVerify,
} from "jose";
import { z } from "zod";
import type { Env } from "../env.ts";

/** Error codes the flow sends back to the login page (SSO_SIGN_IN_ERRORS). */
export const SSO_ERRORS = {
  unavailable: "sso_unavailable",
  outside: "sso_email_outside_domain",
  failed: "sso_failed",
  full: "sso_workspace_full",
} as const;

/** Whether the app Worker offers single sign-on: exactly `"true"`, set only after the checks. */
export function ssoEnabled(env: Pick<Env, "SSO_ENABLED">): boolean {
  return env.SSO_ENABLED === "true";
}

const jwksCache = new Map<string, { at: number; keys: JSONWebKeySet }>();

/** Drops cached key sets; tests use it between cases. */
export function clearSsoKeyCache(): void {
  jwksCache.clear();
}

async function keySet(fetch: SsoFetch, url: string, now: number, fresh: boolean) {
  const cached = jwksCache.get(url);
  if (!fresh && cached && now - cached.at < SSO_LIMITS.cacheSeconds * 1000) return cached.keys;
  const fetched = await fetchSsoJson(fetch, url);
  if (!fetched.ok) return null;
  const keys = fetched.value as JSONWebKeySet;
  if (typeof keys !== "object" || keys === null || !Array.isArray(keys.keys)) return null;
  jwksCache.set(url, { at: now, keys });
  return keys;
}

export interface IdTokenCheck {
  issuer: string;
  clientId: string;
  nonce: string;
  jwksUrl: string;
  algorithms: readonly string[];
  now: number;
}

/**
 * Verifies an ID token and returns its claims, or null. The key set is cached; a token signed
 * with a key the cached set lacks fetches it once more, so a rotated key is picked up at once.
 */
export async function verifyIdToken(
  fetch: SsoFetch,
  token: string,
  check: IdTokenCheck,
): Promise<JWTPayload | null> {
  const algorithms = check.algorithms.filter((alg) =>
    (SSO_ID_TOKEN_ALGORITHMS as readonly string[]).includes(alg),
  );
  if (algorithms.length === 0) return null;
  const attempt = async (fresh: boolean) => {
    const keys = await keySet(fetch, check.jwksUrl, check.now, fresh);
    if (!keys) return null;
    const { payload } = await jwtVerify(token, createLocalJWKSet(keys), {
      issuer: check.issuer,
      audience: check.clientId,
      algorithms,
      clockTolerance: SSO_LIMITS.clockSkewSeconds,
      currentDate: new Date(check.now),
      requiredClaims: ["sub", "exp", "iat", "nonce"],
      maxTokenAge: "1h",
    });
    return payload;
  };
  let payload: JWTPayload | null;
  try {
    payload = await attempt(false);
  } catch (error) {
    if (!(error instanceof joseErrors.JWKSNoMatchingKey)) return null;
    try {
      payload = await attempt(true);
    } catch {
      return null;
    }
  }
  if (!payload || payload.nonce !== check.nonce) return null;
  // With several audiences, the token must say it was issued to this client (OIDC Core 3.1.3.7).
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== check.clientId) {
    return null;
  }
  if (payload.azp !== undefined && payload.azp !== check.clientId) return null;
  return payload;
}

/** The token request's client authentication: HTTP Basic with form-encoded parts (RFC 6749). */
function basicAuth(clientId: string, secret: string): string {
  const encode = (value: string) => encodeURIComponent(value).replaceAll("%20", "+");
  return `Basic ${btoa(`${encode(clientId)}:${encode(secret)}`)}`;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export interface SsoPluginDeps {
  env: Env;
  fetch: SsoFetch;
  now: () => number;
}

/** The plugin: `POST /sign-in/sso` starts the flow, `GET /sso/callback/:providerId` ends it. */
export function workspaceSso(deps: SsoPluginDeps) {
  const global = () => regionsFromEnv(deps.env).global;
  const keys = () => ssoKeys({ current: deps.env.SSO_KEY, previous: deps.env.SSO_KEY_PREVIOUS });

  return {
    id: "portifact-workspace-sso",
    endpoints: {
      signInWorkspaceSso: createAuthEndpoint(
        "/sign-in/sso",
        {
          method: "POST",
          body: z.object({
            email: z.string().trim().min(3).max(320),
            callbackURL: z.string().max(2000),
            newUserCallbackURL: z.string().max(2000).optional(),
          }),
        },
        async (ctx) => {
          const now = deps.now();
          const provider = await ssoProviderForEmail(global(), ctx.body.email, now);
          if (!provider) {
            throw new APIError("NOT_FOUND", {
              code: SSO_ERRORS.unavailable,
              message: "Single sign-on is not available for this address.",
            });
          }
          const endpoints = await discoverSso(deps.fetch, provider.issuer, { now });
          if (!endpoints.ok) {
            throw new APIError("SERVICE_UNAVAILABLE", {
              code: SSO_ERRORS.failed,
              message: "The identity provider could not be reached. Try again later.",
            });
          }
          const nonce = randomToken();
          const state = await generateState(ctx, {
            additionalData: { ssoProvider: provider.id, ssoRevision: provider.revision },
            idTokenNonce: nonce,
          });
          const url = await createAuthorizationURL({
            id: "portifact-sso",
            options: { clientId: provider.clientId },
            authorizationEndpoint: endpoints.value.authorization,
            redirectURI: `${ctx.context.baseURL}${ssoCallbackPath(provider.id)}`,
            state: state.state,
            codeVerifier: state.codeVerifier,
            scopes: ["openid", "email", "profile"],
            loginHint: ctx.body.email,
            nonce,
          });
          return ctx.json({ url: url.toString(), redirect: true });
        },
      ),
      callbackWorkspaceSso: createAuthEndpoint(
        "/sso/callback/:providerId",
        {
          method: "GET",
          query: z.object({
            code: z.string().max(4096).optional(),
            state: z.string().max(4096).optional(),
            error: z.string().max(256).optional(),
          }),
        },
        async (ctx) => {
          const state = await parseState(ctx);
          const fallback = `${new URL(ctx.context.baseURL).origin}/login`;
          const back = (code: string): never => {
            // Errors always go back to the login page, which explains each code.
            const url = new URL(fallback);
            url.searchParams.set("error", code);
            throw ctx.redirect(url.toString());
          };
          const providerId = ctx.params.providerId;
          if (state.ssoProvider !== providerId || typeof state.ssoRevision !== "number") {
            return back(SSO_ERRORS.failed);
          }
          if (ctx.query.error !== undefined || !ctx.query.code) return back(SSO_ERRORS.failed);
          const now = deps.now();
          const provider = await ssoProviderForCallback(
            global(),
            await keys(),
            providerId,
            state.ssoRevision,
            now,
          );
          if (!provider) return back(SSO_ERRORS.unavailable);
          const endpoints = await discoverSso(deps.fetch, provider.issuer, { now });
          if (!endpoints.ok) return back(SSO_ERRORS.failed);

          const redirectURI = `${ctx.context.baseURL}${ssoCallbackPath(provider.id)}`;
          const tokens = await fetchSsoJson(deps.fetch, endpoints.value.token, {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              authorization: basicAuth(provider.clientId, provider.clientSecret),
            },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code: ctx.query.code,
              redirect_uri: redirectURI,
              code_verifier: state.codeVerifier,
            }).toString(),
          });
          const idToken =
            tokens.ok && typeof tokens.value === "object" && tokens.value !== null
              ? (tokens.value as { id_token?: unknown }).id_token
              : undefined;
          if (typeof idToken !== "string" || typeof state.idTokenNonce !== "string") {
            return back(SSO_ERRORS.failed);
          }
          const claims = await verifyIdToken(deps.fetch, idToken, {
            issuer: provider.issuer,
            clientId: provider.clientId,
            nonce: state.idTokenNonce,
            jwksUrl: endpoints.value.jwks,
            algorithms: endpoints.value.algorithms,
            now,
          });
          const email = typeof claims?.email === "string" ? claims.email.trim().toLowerCase() : "";
          const subject = claims?.sub;
          if (!claims || !subject || email === "") return back(SSO_ERRORS.failed);
          // The provider's `email_verified` is never read: the workspace's domain proof is what
          // vouches for the address, and only for its own domains.
          const allowed = await checkSsoIdentity(global(), { provider, email, subject });
          if (!allowed.ok) return back(SSO_ERRORS.outside);

          let linked: Awaited<ReturnType<typeof handleOAuthUserInfo>>;
          try {
            linked = await handleOAuthUserInfo(ctx, {
              userInfo: {
                id: subject,
                email,
                emailVerified: true,
                name: typeof claims.name === "string" ? claims.name.slice(0, 200) : "",
                image: null,
              },
              account: { providerId: ssoAccountProvider(provider.id), accountId: subject },
              callbackURL: state.callbackURL,
              disableSignUp: false,
              source: { method: "sso-oidc", sso: { providerId: provider.id } },
              isTrustedProvider: true,
              trustProviderByName: false,
            });
          } catch (error) {
            if (error instanceof APIError && typeof error.body?.code === "string") {
              return back(error.body.code.toLowerCase());
            }
            throw error;
          }
          if (!linked.data) return back(SSO_ERRORS.failed);
          const { session, user } = linked.data;
          const joined = await joinWorkspaceThroughSso(global(), {
            workspaceId: provider.workspaceId,
            userId: user.id,
            email,
            now,
          });
          if (!joined.ok) {
            // The account stays (it accepted the terms), but no session is handed over: the
            // person sees why instead of landing outside the workspace without a word.
            await ctx.context.internalAdapter.deleteSession(session.token);
            // Joining fails only for a lack of seats.
            return back(SSO_ERRORS.full);
          }
          await setSessionCookie(ctx, { session, user });
          const to = linked.isRegister
            ? (state.newUserURL ?? state.callbackURL)
            : state.callbackURL;
          throw ctx.redirect(to);
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
