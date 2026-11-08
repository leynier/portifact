// Hosts of the end-to-end stack. `.test` is reserved (RFC 6761) and not on the Public Suffix
// List, so every *.portifact-content.test host is the same site, exactly like *.portifact.dev.
export const APP_HOST = "app.portifact.test";
export const APP_ORIGIN = `https://${APP_HOST}`;
export const CONTENT_SITE = "portifact-content.test";
export const CONTROL_HOST = "control.e2e.test";
export const SESSION_COOKIE = "__Host-pf.session_token";
export const REVIEW_COOKIE = "__Host-pf_review";
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
  return host === APP_HOST || host.endsWith(`.${CONTENT_SITE}`);
}
