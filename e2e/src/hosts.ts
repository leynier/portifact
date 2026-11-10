// Hosts of the end-to-end stack. `.test` is reserved (RFC 6761) and not on the Public Suffix
// List, so every *.portifact-content.test host is the same site, exactly like *.portifact.dev.
export const APP_HOST = "app.portifact.test";
export const APP_ORIGIN = `https://${APP_HOST}`;
export const CONTENT_SITE = "portifact-content.test";
/**
 * Stands in for portifact.com, the landing and legal pages: the e2e Worker serves it as the
 * site host (worker/index.ts).
 */
export const SITE_HOST = "portifact.test";
export const SITE_ORIGIN = `https://${SITE_HOST}`;
export const CONTROL_HOST = "control.e2e.test";
/**
 * A customer's own domain for custom domain tests (decision 0006): `<label>.customer-e2e.test`,
 * another site than the content domain, served by the content Worker like a custom hostname.
 */
export const CUSTOMER_SITE = "customer-e2e.test";

export function customHost(label: string): string {
  return `${label}.${CUSTOMER_SITE}`;
}
/**
 * A redirector on a third site, answered by the test front end: `/?to=<url>` redirects to a URL
 * on a stack host. It plays any site an artifact could bounce a navigation through.
 */
export const REDIRECT_HOST = "redirect.elsewhere.test";
export const SESSION_COOKIE = "__Host-pf.session_token";
export const REVIEW_COOKIE = "__Host-pf_review";
export const REVIEW_TAB_COOKIE = "__Host-pf_review_tab";
/**
 * Unpartitioned `SameSite=None` cookie the test front end sets next to the review cookie. Whether
 * the browser sends it back inside the viewer's frame proves how it treats ordinary third-party
 * cookies in that run.
 */
export const CONTROL_COOKIE = "e2e_unpartitioned";

export function artifactOrigin(id: string): string {
  return `https://${id}.${CONTENT_SITE}`;
}

export function isStackHost(host: string): boolean {
  return (
    host === APP_HOST ||
    host === SITE_HOST ||
    host === REDIRECT_HOST ||
    host.endsWith(`.${CONTENT_SITE}`) ||
    host.endsWith(`.${CUSTOMER_SITE}`)
  );
}

/** A URL that reaches `to` through the redirector on another site. */
export function bounced(to: string): string {
  return `https://${REDIRECT_HOST}/?to=${encodeURIComponent(to)}`;
}
