// Two registrable domains stand in for portifact.com and portifact.dev. `.test` is reserved
// (RFC 6761) and is not on the Public Suffix List, so every *.portifact-content.test host is
// the same site, exactly like *.portifact.dev in production.
export const APP_HOST = "app.portifact.test";
export const CONTENT_SITE = "portifact-content.test";
export const ARTIFACTS = ["art1", "art2"] as const;
export type ArtifactId = (typeof ARTIFACTS)[number];

export const REVIEW_COOKIE = "__Host-pf_review";
// Unpartitioned SameSite=None cookie set next to the review cookie. Whether the browser keeps
// it tells us how the engine treats ordinary third-party cookies in this run.
export const CONTROL_COOKIE = "spike_unpartitioned";

export function artifactHost(id: ArtifactId): string {
  return `${id}.${CONTENT_SITE}`;
}

export function artifactOrigin(id: ArtifactId): string {
  return `https://${artifactHost(id)}`;
}

export function viewerUrl(id: ArtifactId, path = "/"): string {
  return `https://${APP_HOST}/review/${id}?path=${encodeURIComponent(path)}`;
}

export function isArtifactId(value: string): value is ArtifactId {
  return (ARTIFACTS as readonly string[]).includes(value);
}

export function artifactFromHost(host: string): ArtifactId | undefined {
  const suffix = `.${CONTENT_SITE}`;
  if (!host.endsWith(suffix)) return undefined;
  const label = host.slice(0, -suffix.length);
  return isArtifactId(label) ? label : undefined;
}
