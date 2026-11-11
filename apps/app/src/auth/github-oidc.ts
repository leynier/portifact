// Verifying GitHub Actions ID tokens for the OIDC federation (decision 0024): the signature
// against GitHub's key set (RS256 only, by `kid`), `iss` exactly GitHub's public issuer, `aud`
// exactly the workspace's audience, `exp`, `nbf` and `iat` with a small skew, then the claim
// shapes the rule needs (`githubClaims`). The key set is fetched only from its fixed URL through
// the bounded fetcher single sign-on uses, cached per isolate, and fetched again for an unknown
// `kid` at most once a minute per isolate. Never logs a token, a claim or the key set.
import {
  GITHUB_OIDC_ALGORITHMS,
  GITHUB_OIDC_ISSUER,
  GITHUB_OIDC_JWKS_URL,
  GITHUB_TRUST,
} from "@portifact/contracts";
import { type GitHubClaims, type GitHubRefusal, githubClaims } from "@portifact/domain";
import { fetchSsoJson, type SsoFetch } from "@portifact/services";
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  type JSONWebKeySet,
  errors as joseErrors,
  jwtVerify,
} from "jose";
import type { Env } from "../env.ts";

/** Whether this deployment offers the federation: exactly `"true"`, set only after the checks. */
export function githubOidcEnabled(env: Pick<Env, "GITHUB_OIDC_ENABLED">): boolean {
  return env.GITHUB_OIDC_ENABLED === "true";
}

let cached: { at: number; keys: JSONWebKeySet } | null = null;
let refetchedAt: number | null = null;
let fetches = 0;

/** Forgets the isolate's key set; tests use it between cases. */
export function clearGitHubKeyCache(): void {
  cached = null;
  refetchedAt = null;
  fetches = 0;
}

/** How many times this isolate fetched GitHub's key set; tests check the cache and its limit. */
export function gitHubKeyFetches(): number {
  return fetches;
}

function isKeySet(value: unknown): value is JSONWebKeySet {
  return (
    typeof value === "object" && value !== null && Array.isArray((value as { keys?: unknown }).keys)
  );
}

async function keySet(fetch: SsoFetch, now: number, fresh: boolean): Promise<JSONWebKeySet | null> {
  if (!fresh && cached && now - cached.at < GITHUB_TRUST.jwksCacheMs) return cached.keys;
  fetches += 1;
  const fetched = await fetchSsoJson(fetch, GITHUB_OIDC_JWKS_URL);
  if (!fetched.ok || !isKeySet(fetched.value)) return cached?.keys ?? null;
  // Only RSA signing keys are kept: anything else in the set can never verify a token here.
  const keys = {
    keys: fetched.value.keys.filter(
      (key) =>
        key.kty === "RSA" && (key.alg === undefined || key.alg === "RS256") && key.use !== "enc",
    ),
  };
  cached = { at: now, keys };
  return keys;
}

export type GitHubVerification =
  | { ok: true; claims: GitHubClaims }
  | { ok: false; reason: GitHubRefusal };

/**
 * Verifies an ID token for `audience` and returns the claims a rule needs. Every failure is a
 * reason for the log only; the caller answers one refusal.
 */
export async function verifyGitHubToken(
  fetch: SsoFetch,
  token: string,
  audience: string,
  now: number,
): Promise<GitHubVerification> {
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length === 0) {
    return { ok: false, reason: "signature" };
  }
  const attempt = async (fresh: boolean) => {
    const keys = await keySet(fetch, now, fresh);
    if (!keys) return "unavailable" as const;
    const { payload } = await jwtVerify(token, createLocalJWKSet(keys), {
      issuer: GITHUB_OIDC_ISSUER,
      audience,
      algorithms: [...GITHUB_OIDC_ALGORITHMS],
      clockTolerance: GITHUB_TRUST.clockSkewSeconds,
      currentDate: new Date(now),
      requiredClaims: ["exp", "iat", "jti"],
      maxTokenAge: GITHUB_TRUST.maxTokenAgeSeconds,
    });
    return payload;
  };
  let payload: Awaited<ReturnType<typeof attempt>>;
  try {
    payload = await attempt(false);
  } catch (error) {
    if (!(error instanceof joseErrors.JWKSNoMatchingKey))
      return { ok: false, reason: refusalOf(error) };
    // A `kid` the cached set lacks may follow a rotation, or be made up: fetch the set again, at
    // most once a minute per isolate, so made-up keys cannot make every exchange call GitHub.
    if (refetchedAt !== null && now - refetchedAt < GITHUB_TRUST.jwksRefetchMs) {
      return { ok: false, reason: "signature" };
    }
    refetchedAt = now;
    try {
      payload = await attempt(true);
    } catch (again) {
      return { ok: false, reason: refusalOf(again) };
    }
  }
  if (payload === "unavailable") return { ok: false, reason: "jwks_unavailable" };
  // One audience, exactly ours: a token issued for several services is not accepted.
  const aud = payload.aud;
  if (!(aud === audience || (Array.isArray(aud) && aud.length === 1 && aud[0] === audience))) {
    return { ok: false, reason: "claims" };
  }
  const iat = payload.iat as number;
  const exp = payload.exp as number;
  if (exp - iat > GITHUB_TRUST.maxTokenAgeSeconds) return { ok: false, reason: "claims" };
  const claims = githubClaims(payload as Record<string, unknown>);
  return claims ? { ok: true, claims } : { ok: false, reason: "claims" };
}

function refusalOf(error: unknown): GitHubRefusal {
  // A claim jose checks (issuer, audience, times, required claims); anything else is the token's
  // signature or shape, which only GitHub's own tokens pass.
  if (
    error instanceof joseErrors.JWTClaimValidationFailed ||
    error instanceof joseErrors.JWTExpired
  ) {
    return "claims";
  }
  return "signature";
}
