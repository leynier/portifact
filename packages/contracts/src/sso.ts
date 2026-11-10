// Single sign-on for a workspace with OpenID Connect (premium plan E1, decision 0016). One
// identity provider per workspace, managed by its admins through the dashboard session only. The
// provider speaks only for the workspace's verified email domains (decision 0010) that it serves.
// Shipped switched off: nothing is reachable without `SSO_ENABLED="true"` on the app Worker.
import { z } from "zod";

export const SSO_LIMITS = {
  /** The longest issuer URL accepted. */
  issuerMaxLength: 300,
  clientIdMaxLength: 300,
  clientSecretMaxLength: 1000,
  /** How long one call to the identity provider (discovery, keys, token) may take. */
  fetchTimeoutMs: 5000,
  /** The largest discovery document, key set or token response read, in bytes. */
  responseMaxBytes: 64 * 1024,
  /** Seconds of clock difference accepted on an ID token's `iat`, `exp` and `nbf`. */
  clockSkewSeconds: 60,
  /** How long fetched key sets and discovery documents are reused in one isolate. */
  cacheSeconds: 600,
  /** Email lookups on the login page per IP and hour, like the other login endpoints. */
  lookupsPerIpPerHour: 60,
} as const;

/** The provider's row ID: `sso_` and 32 hex characters. It names the redirect URI. */
export const SsoProviderId = z.string().regex(/^sso_[0-9a-f]{32}$/, "Invalid provider id");
export type SsoProviderId = z.infer<typeof SsoProviderId>;

/** The callback path of a provider under Better Auth's base path. */
export function ssoCallbackPath(providerId: string): string {
  return `/sso/callback/${providerId}`;
}

/**
 * What an admin sends to create or change the provider. On a change the client secret may be
 * omitted to keep the stored one; the issuer cannot change (remove the provider and create a new
 * one, which gets a new redirect URI, so identities of one issuer never sign in through another).
 */
export const SsoProviderInput = z.strictObject({
  issuer: z.string().trim().min(1).max(SSO_LIMITS.issuerMaxLength),
  clientId: z.string().trim().min(1).max(SSO_LIMITS.clientIdMaxLength),
  clientSecret: z.string().min(1).max(SSO_LIMITS.clientSecretMaxLength).optional(),
  /** The workspace's verified email domains (A-labels) the provider signs in. */
  domains: z.array(z.string().trim().min(1).max(253)).min(1).max(10),
});
export type SsoProviderInput = z.infer<typeof SsoProviderInput>;

/** What an admin asks the test to check, before or after saving. */
export const SsoTestInput = z.strictObject({
  issuer: z.string().trim().min(1).max(SSO_LIMITS.issuerMaxLength),
});
export type SsoTestInput = z.infer<typeof SsoTestInput>;

/** Why a discovery check failed, in words the dashboard translates. */
export const SSO_DISCOVERY_PROBLEMS = [
  "invalid_issuer",
  "unreachable",
  "timeout",
  "redirect",
  "http_error",
  "too_large",
  "not_json",
  "issuer_mismatch",
  "missing_endpoint",
  "invalid_endpoint",
  "no_code_flow",
  "no_pkce",
  "no_signing_algorithm",
] as const;
export const SsoDiscoveryProblem = z.enum(SSO_DISCOVERY_PROBLEMS);
export type SsoDiscoveryProblem = z.infer<typeof SsoDiscoveryProblem>;

export const SsoTestResult = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    /** Hosts of the endpoints found, for the admin to recognize them. */
    hosts: z.object({ authorization: z.string(), token: z.string(), keys: z.string() }),
  }),
  z.object({ ok: z.literal(false), problem: SsoDiscoveryProblem }),
]);
export type SsoTestResult = z.infer<typeof SsoTestResult>;

/**
 * Whether sign-ins work right now: `on`, or why not. `plan` (the workspace's plan lost `sso`) and
 * `domains` (none of its domains is verified any more) keep the provider; `off` means none is set.
 */
export const SsoState = z.enum(["off", "on", "plan", "domains"]);
export type SsoState = z.infer<typeof SsoState>;

export const SsoProviderView = z.object({
  id: SsoProviderId,
  issuer: z.string(),
  clientId: z.string(),
  /** The domains it serves; a domain no longer verified is listed in `lapsedDomains`. */
  domains: z.array(z.string()),
  lapsedDomains: z.array(z.string()),
  /** The client secret is never returned; only whether one is stored. */
  hasClientSecret: z.boolean(),
  /** What to register at the identity provider as the redirect (callback) URI. */
  redirectUri: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SsoProviderView = z.infer<typeof SsoProviderView>;

export const SsoSettings = z.object({
  state: SsoState,
  provider: SsoProviderView.nullable(),
  /** Whether the workspace's plan includes `sso`: creating and changing need it. */
  available: z.boolean(),
  /** The workspace's verified email domains, to choose from. */
  verifiedDomains: z.array(z.string()),
  /**
   * The redirect URI a new provider gets is only known once it is created; the dashboard shows
   * this pattern before.
   */
  redirectUriPattern: z.string(),
});
export type SsoSettings = z.infer<typeof SsoSettings>;

/** The login page asks whether an address signs in through single sign-on. */
export const SsoLookupInput = z.strictObject({ email: z.string().trim().min(3).max(320) });
export type SsoLookupInput = z.infer<typeof SsoLookupInput>;

/**
 * Only whether the address's domain uses single sign-on: never the workspace, its name or its
 * provider. The domain being verified by some workspace is all it implies.
 */
export const SsoLookupResult = z.object({ sso: z.boolean() });
export type SsoLookupResult = z.infer<typeof SsoLookupResult>;

/**
 * Error codes the sign-in sends back to the login page in `?error=`. Each has a translated
 * message there.
 */
export const SSO_SIGN_IN_ERRORS = [
  "sso_unavailable",
  "sso_email_outside_domain",
  "sso_failed",
  "sso_workspace_full",
] as const;
export type SsoSignInError = (typeof SSO_SIGN_IN_ERRORS)[number];
