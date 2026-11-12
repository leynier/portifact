// The e2e stack's hosts (e2e/src/hosts.ts): `.test` is reserved and not on the Public Suffix
// List, so every *.portifact-content.test host is the same site, like *.portifact.dev, and the
// app is another site, like app.portifact.com.
export const APP_HOST = "app.portifact.test";
export const APP_ORIGIN = `https://${APP_HOST}`;
export const CONTENT_SITE = "portifact-content.test";
/** A redirector on a third site: `/?to=<url>` redirects there, as any site an attacker owns. */
export const REDIRECT_HOST = "redirect.elsewhere.test";
export const ARTIFACTS = ["art1", "art2"] as const;
export type ArtifactId = (typeof ARTIFACTS)[number];

export const SESSION_COOKIE = "__Host-app_session";
export const GRANT_COOKIE = "__Host-pf_grant";
export const TX_COOKIE = "__Host-pf_grant_tx";

export function artifactHost(id: ArtifactId): string {
  return `${id}.${CONTENT_SITE}`;
}

export function artifactOrigin(id: ArtifactId): string {
  return `https://${artifactHost(id)}`;
}

export function artifactFromHost(host: string): ArtifactId | undefined {
  const suffix = `.${CONTENT_SITE}`;
  if (!host.endsWith(suffix)) return undefined;
  const label = host.slice(0, -suffix.length);
  return (ARTIFACTS as readonly string[]).includes(label) ? (label as ArtifactId) : undefined;
}

export function isSpikeHost(host: string): boolean {
  return host === APP_HOST || host === REDIRECT_HOST || host.endsWith(`.${CONTENT_SITE}`);
}

export function bounced(to: string): string {
  return `https://${REDIRECT_HOST}/?to=${encodeURIComponent(to)}`;
}
