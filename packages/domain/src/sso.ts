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
  const { url, host } = checked.value;
  if (url.search !== "") {
    return fail("invalid_input", "The issuer URL cannot have a query (?).");
  }
  if (host === ENTRA_HOST) {
    if (!ENTRA_TENANT_ISSUER.test(url.pathname)) {
      return fail(
        "invalid_input",
        "Use your Microsoft Entra tenant's own issuer, https://login.microsoftonline.com/<tenant ID>/v2.0.",
      );
    }
    if (url.pathname.toLowerCase().startsWith(`/${ENTRA_CONSUMERS_TENANT}/`)) {
      return fail("invalid_input", "This issuer signs in anyone, not only your organization.");
    }
    return ok({ issuer, host });
  }
  const shared = SHARED_SSO_ISSUERS.find((entry) => entry.host === host);
  if (shared && !shared.allowedWith) {
    return fail("invalid_input", "This issuer signs in anyone, not only your organization.");
  }
  return ok({ issuer, host });
}

/**
 * Issuers that sign in the public, not one organization: any account there could assert an
 * address at a workspace's domain, so they are refused as a workspace's provider. Google is the
 * one exception, allowed only because every sign-in checks the token's `hd` (the Google
 * Workspace the account belongs to) against the address's verified domain. Microsoft Entra's
 * shared tenants (`common`, `organizations`, `consumers` and the consumers tenant ID) are refused
 * by requiring a tenant ID in the issuer (`checkSsoIssuer`).
 */
export const SHARED_SSO_ISSUERS: readonly { host: string; why: string; allowedWith?: "hd" }[] = [
  { host: "accounts.google.com", why: "Any Google account", allowedWith: "hd" },
  { host: "login.live.com", why: "Microsoft personal accounts" },
  { host: "appleid.apple.com", why: "Any Apple Account" },
  { host: "gitlab.com", why: "Any GitLab.com account" },
  { host: "github.com", why: "Any GitHub account" },
  { host: "www.facebook.com", why: "Any Facebook account" },
  { host: "id.twitch.tv", why: "Any Twitch account" },
];

const ENTRA_HOST = "login.microsoftonline.com";
const ENTRA_TENANT_ISSUER =
  /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/v2\.0$/i;
/** The tenant of Microsoft personal accounts. */
const ENTRA_CONSUMERS_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

/** How an issuer's claims are read: Google and Entra each have their own rule. */
export type SsoIssuerKind = "generic" | "google" | "entra";

export function ssoIssuerKind(issuer: string): SsoIssuerKind {
  const host = URL.canParse(issuer) ? new URL(issuer).hostname : "";
  if (host === "accounts.google.com") return "google";
  if (host === ENTRA_HOST) return "entra";
  return "generic";
}

export type SsoClaimsVerdict =
  | { ok: true; emailVerified: true | undefined }
  | { ok: false; code: "sso_email_unverified" | "sso_email_outside_domain" };

/**
 * What the ID token says about its address, by issuer kind. `email_verified: false` is refused
 * always. Google: the token's `hd` must name the address's own domain, one the workspace verified.
 * Entra: its `email` is mutable, so it is taken only with `xms_edov: true` (the domain's owner
 * verified it), which also counts as verified. Elsewhere `email_verified: true` is kept and
 * anything else reads as not said.
 */
export function ssoClaimsVerdict(
  kind: SsoIssuerKind,
  claims: Record<string, unknown>,
  email: string,
  live: readonly string[],
): SsoClaimsVerdict {
  if (claims.email_verified === false) return { ok: false, code: "sso_email_unverified" };
  if (kind === "entra") {
    return claims.xms_edov === true
      ? { ok: true, emailVerified: true }
      : { ok: false, code: "sso_email_unverified" };
  }
  if (kind === "google") {
    const domain = emailDomainOf(email.trim().toLowerCase());
    if (
      typeof claims.hd !== "string" ||
      claims.hd.toLowerCase() !== domain ||
      !live.includes(domain)
    ) {
      return { ok: false, code: "sso_email_outside_domain" };
    }
  }
  return { ok: true, emailVerified: claims.email_verified === true ? true : undefined };
}

export interface SsoAccountFacts {
  /** The account this provider's identity (issuer subject) is already linked to. */
  linkedUserId: string | null;
  /** The account with the asserted address, if any. */
  existingUserId: string | null;
  emailVerified: true | undefined;
  /** The account whose session started the flow from the login page, if it did. */
  sessionUserId: string | null;
}

export interface SsoAccountPlan {
  /**
   * `existing`: the identity is already linked. `create`: a new account. `link`: an existing
   * account, the provider vouching for the address. `session`: an existing account linked from its
   * own session.
   */
  mode: "existing" | "create" | "link" | "session";
  userId: string | null;
  /** Whether a pending invitation may be taken in place of the accept step. */
  consumeInvitation: boolean;
}

/**
 * Which account a verified identity signs in to (decision 0016, section 3). An identity already
 * linked keeps its account. No account with the address: a new one, safe without the claim
 * because the address is in a domain the workspace proved and nobody's account is taken over. An
 * existing account gains this identity only when the token says `email_verified: true`, or when
 * that account's own session started the flow; otherwise `sso_link_required`. A session never
 * gains an identity linked to another account.
 */
export function ssoAccountDecision(facts: SsoAccountFacts): Result<SsoAccountPlan> {
  const verified = facts.emailVerified === true;
  const refuse = () => fail<never>("forbidden", "sso_link_required");
  // A flow its own session started only ever links to that session's account.
  if (facts.sessionUserId !== null) {
    if (facts.existingUserId !== facts.sessionUserId) return refuse();
    if (facts.linkedUserId !== null && facts.linkedUserId !== facts.sessionUserId) return refuse();
  }
  if (facts.linkedUserId !== null) {
    if (facts.sessionUserId !== null && facts.sessionUserId !== facts.linkedUserId) return refuse();
    return ok({ mode: "existing", userId: facts.linkedUserId, consumeInvitation: verified });
  }
  if (facts.existingUserId === null) {
    return ok({ mode: "create", userId: null, consumeInvitation: true });
  }
  if (verified && (facts.sessionUserId === null || facts.sessionUserId === facts.existingUserId)) {
    return ok({ mode: "link", userId: facts.existingUserId, consumeInvitation: true });
  }
  if (facts.sessionUserId === facts.existingUserId) {
    return ok({ mode: "session", userId: facts.existingUserId, consumeInvitation: false });
  }
  return refuse();
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
