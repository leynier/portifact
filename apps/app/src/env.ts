// Bindings of the portifact-app Worker. Non-secret values come from `vars` in wrangler.jsonc;
// secrets are set with `wrangler secret put` (docs/releasing.md) and `.dev.vars` locally.
import type { DomainEnv } from "@portifact/services";

/**
 * Custom domains (decision 0006) come from `DomainEnv`: `CUSTOM_DOMAINS_ENABLED` and
 * `CF_CONTENT_ZONE_ID` in `vars`, and the secret `CF_HOSTNAMES_TOKEN`. Without all three the
 * feature is unavailable and nothing calls Cloudflare.
 */
export interface Env extends DomainEnv {
  ASSETS: Fetcher;
  DB: D1Database;
  /** The access log database (`portifact-access`); the app only reads it, for the owner. */
  ACCESS_DB: D1Database;
  /** Artifact content and sources, keyed by owner and SHA-256 (packages/services). */
  ARTIFACTS: R2Bucket;
  EMAIL: SendEmail;
  /** Origin of the identity and authorization server, for example https://app.portifact.com. */
  APP_ORIGIN: string;
  GOOGLE_CLIENT_ID: string;
  GITHUB_CLIENT_ID: string;
  /** Domain whose subdomains serve artifacts: `<id>.<CONTENT_DOMAIN>`. */
  CONTENT_DOMAIN: string;
  /** Cloudflare account and bucket of the R2 S3 endpoint that presigned uploads target. */
  R2_ACCOUNT_ID: string;
  R2_BUCKET: string;
  /**
   * The EU region's bucket (decision 0005), created in the `eu` jurisdiction; bound only where the
   * EU region is (`DB_EU`). Its uploads are signed against the EU endpoint, with
   * `R2_ACCESS_KEY_ID_EU` and `R2_SECRET_ACCESS_KEY_EU` when the default token cannot cover it.
   */
  R2_BUCKET_EU?: string | undefined;
  R2_ACCESS_KEY_ID_EU?: string | undefined;
  R2_SECRET_ACCESS_KEY_EU?: string | undefined;
  /**
   * Public Turnstile site key the login page and the review viewer render the human check with.
   * Empty until the widget exists; then no challenge is shown and new accounts are refused.
   */
  TURNSTILE_SITE_KEY: string;
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_SECRET: string;
  GITHUB_CLIENT_SECRET: string;
  /** R2 API token limited to Object Read and Write on R2_BUCKET; signs upload and download URLs only. */
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  /**
   * Checks the signed unsubscribe links of comment notices, which the jobs Worker signs with the
   * same secret. Without it the unsubscribe endpoint answers 503.
   */
  UNSUBSCRIBE_SECRET?: string | undefined;
  /**
   * Seals webhook URLs and signing secrets at creation (decision 0009); the jobs Worker opens them
   * with the same secret. Without it creating a webhook answers 503.
   */
  WEBHOOK_KEY?: string | undefined;
  /**
   * Exactly `"true"` offers webhooks (decision 0009, "Switched off"): unset in the deployed
   * configuration until the checks in docs/releasing.md pass. Without it, creating, enabling
   * and testing a webhook answer 503.
   */
  WEBHOOKS_ENABLED?: string | undefined;
  /**
   * Exactly `"true"` offers single sign-on for workspaces (decision 0016, "Switched off"): unset
   * in the deployed configuration until the checks in docs/releasing.md ("SSO") pass. Without
   * it the sign-in endpoints and the login page's lookup answer 404 and the provider routes
   * `capacity_unavailable`.
   */
  SSO_ENABLED?: string | undefined;
  /**
   * Exactly `"true"` offers SCIM provisioning for workspaces (decision 0017, "Switched off"):
   * unset in the deployed configuration until the checks in docs/releasing.md ("SCIM") pass.
   * Without it every `/scim/v2` path answers 404, the settings routes `capacity_unavailable`
   * and sign-ins claim no pending memberships.
   */
  SCIM_ENABLED?: string | undefined;
  /**
   * Seals single sign-on client secrets (decision 0016), and `SSO_KEY_PREVIOUS` opens those
   * sealed before a rotation. Without it saving a provider answers 503 and sign-ins stop.
   */
  SSO_KEY?: string | undefined;
  SSO_KEY_PREVIOUS?: string | undefined;
  /** Turnstile secret for siteverify. Without it every human check fails closed (turnstile.ts). */
  TURNSTILE_SECRET_KEY?: string | undefined;
}
