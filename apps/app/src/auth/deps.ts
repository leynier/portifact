// External boundaries of the authorization server. Tests replace them with fakes.
import type { MultipartConfig } from "@portifact/domain";
import {
  type DomainDeps,
  dohTxt,
  domainDepsFromEnv,
  type EmailDomainDeps,
} from "@portifact/services";
import type { Env } from "../env.ts";
import { cloudflareEmailSender, type EmailSender } from "./email.ts";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface AuthDeps {
  /** Delivers sign-in codes. Never log the message: it holds the code. */
  email: EmailSender;
  /** Fetches Client ID Metadata Documents for MCP clients that use a URL as client_id. */
  fetchClientMetadata: FetchLike;
  /** Calls Turnstile's siteverify endpoint (../turnstile.ts). Never log what it sends. */
  siteverify: FetchLike;
  /** Threshold and part size of multipart uploads; tests make them small. Defaults otherwise. */
  multipart?: MultipartConfig;
  /**
   * Cloudflare's custom hostnames and DNS over HTTPS for custom domains; null while the feature
   * is switched off (no token or no `CUSTOM_DOMAINS_ENABLED`), when nothing calls them.
   */
  domains: DomainDeps | null;
  /**
   * DNS over HTTPS for workspace email domain proofs (decision 0010). Tests and the e2e stack
   * inject a fake; omitted, verifying a domain answers `capacity_unavailable` and nothing calls
   * out.
   */
  emailDomains?: EmailDomainDeps | undefined;
  /**
   * Calls workspaces' identity providers for single sign-on (decision 0016): discovery, keys and
   * the token endpoint. Tests and the e2e stack inject a fake provider; never a real one.
   */
  ssoFetch: FetchLike;
}

// Fetch transport for Client ID Metadata Documents on Workers. The Worker runs with the
// global_fetch_strictly_public compatibility flag, so fetch() cannot reach private or
// internal addresses. Redirects are refused, because a document must be served at the
// exact client_id URL, and only HTTPS is allowed. 304 Not Modified is not a redirect: the
// plugin revalidates a stale cached document with its ETag and handles the 304 itself.
export function createClientMetadataFetch(fetchImpl: FetchLike): FetchLike {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.protocol !== "https:") {
      throw new Error("client metadata must be served over https");
    }
    const response = await fetchImpl(url, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      throw new Error("client metadata redirects are not followed");
    }
    return response;
  };
}

export function workerDeps(env: Env): AuthDeps {
  return {
    email: cloudflareEmailSender(env.EMAIL),
    fetchClientMetadata: createClientMetadataFetch((input, init) => fetch(input, init)),
    siteverify: (input, init) => fetch(input, init),
    domains: domainDepsFromEnv(env, (input, init) => fetch(input, init)),
    emailDomains: { txt: dohTxt((input, init) => fetch(input, init)) },
    ssoFetch: (input, init) => fetch(input, init),
  };
}
