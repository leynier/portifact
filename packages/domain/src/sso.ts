// Single sign-on with OpenID Connect for a workspace (premium plan E1, decision 0016): the pure
// rules. The identity provider speaks only for the workspace's verified email domains it serves;
// its `email_verified` claim is never read. Discovery documents and every endpoint they name pass
// the same public-host rule as webhook URLs (`checkPublicHttpsUrl`).
import { SSO_LIMITS, type SsoDiscoveryProblem } from "@portifact/contracts";
import { emailDomainOf } from "./email-domains.ts";
import { fail, ok, type Result } from "./result.ts";
import { checkPublicHttpsUrl } from "./webhooks.ts";

/**
 * ID token signature algorithms accepted: asymmetric only. `none` and the HMAC family (which
 * would make the client secret a signing key) are never accepted, whatever the provider lists.
 */
export const SSO_ID_TOKEN_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
] as const;

/** Where the flow goes, from a checked discovery document. */
export interface SsoEndpoints {
  authorization: string;
  token: string;
  jwks: string;
  /** The accepted algorithms the provider lists, in its order. */
  algorithms: string[];
}

/**
 * The issuer an admin typed, checked: a public https URL without query or fragment. Kept exactly
 * as typed (trimmed), because the ID token's `iss` must equal it character for character.
 */
export function checkSsoIssuer(raw: string): Result<{ issuer: string; host: string }> {
  const issuer = raw.trim();
  const checked = checkPublicHttpsUrl(issuer, SSO_LIMITS.issuerMaxLength);
  if (!checked.ok) return checked;
  if (checked.value.url.search !== "") {
    return fail("invalid_input", "The issuer URL cannot have a query (?).");
  }
  return ok({ issuer, host: checked.value.host });
}

/** The discovery document's URL (OpenID Connect Discovery 1.0, section 4). */
export function discoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
}

function endpoint(value: unknown): Result<string> | null {
  if (typeof value !== "string" || value === "") return null;
  const checked = checkPublicHttpsUrl(value, 2000);
  return checked.ok ? ok(checked.value.url.href) : checked;
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

/**
 * Checks a discovery document against the issuer it was fetched for. Every endpoint must pass the
 * public-host rule, the issuer must match exactly (a mix-up or a document copied from elsewhere
 * fails), the code flow must be offered, PKCE with S256 must not be ruled out, and at least one
 * accepted signature algorithm must be listed.
 */
export function checkDiscovery(
  doc: unknown,
  issuer: string,
): { ok: true; value: SsoEndpoints } | { ok: false; problem: SsoDiscoveryProblem } {
  const problem = (p: SsoDiscoveryProblem) => ({ ok: false as const, problem: p });
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return problem("not_json");
  const d = doc as Record<string, unknown>;
  if (d.issuer !== issuer) return problem("issuer_mismatch");
  const authorization = endpoint(d.authorization_endpoint);
  const token = endpoint(d.token_endpoint);
  const jwks = endpoint(d.jwks_uri);
  if (!authorization || !token || !jwks) return problem("missing_endpoint");
  if (!authorization.ok || !token.ok || !jwks.ok) return problem("invalid_endpoint");
  const responseTypes = strings(d.response_types_supported);
  if (!responseTypes?.includes("code")) return problem("no_code_flow");
  // Optional in the specification: absent means "not said", and PKCE is sent anyway.
  const pkce = strings(d.code_challenge_methods_supported);
  if (d.code_challenge_methods_supported !== undefined && !pkce?.includes("S256")) {
    return problem("no_pkce");
  }
  const listed = strings(d.id_token_signing_alg_values_supported) ?? [];
  const algorithms = listed.filter((alg) =>
    (SSO_ID_TOKEN_ALGORITHMS as readonly string[]).includes(alg),
  );
  if (algorithms.length === 0) return problem("no_signing_algorithm");
  return {
    ok: true,
    value: { authorization: authorization.value, token: token.value, jwks: jwks.value, algorithms },
  };
}

/**
 * The domains a provider signs in right now: those it serves that the workspace still has
 * verified. A domain that lapses or is removed stops at once, without touching the provider.
 */
export function liveSsoDomains(served: readonly string[], verified: readonly string[]): string[] {
  const set = new Set(verified);
  return served.filter((domain) => set.has(domain));
}

/** Whether an address is in one of the live domains (exact domain match, never a subdomain). */
export function ssoServesEmail(email: string, live: readonly string[]): boolean {
  const domain = emailDomainOf(email.trim().toLowerCase());
  return domain !== null && live.includes(domain);
}

/** The served domains an admin chose, normalized, deduplicated and each verified. */
export function checkSsoDomains(
  chosen: readonly string[],
  verified: readonly string[],
): Result<string[]> {
  const normalized = [...new Set(chosen.map((domain) => domain.trim().toLowerCase()))].sort();
  const missing = normalized.filter((domain) => !verified.includes(domain));
  if (missing.length > 0) {
    return fail(
      "invalid_input",
      "Single sign-on can only serve email domains the workspace has verified.",
    );
  }
  return ok(normalized);
}
