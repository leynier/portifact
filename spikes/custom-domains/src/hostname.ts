// Hostnames an owner may attach, and how the content Worker tells an artifact host from a custom
// one. Pure functions, no I/O.

const ARTIFACT_ID = /^[a-z2-7]{10}$/;

/** Domains that are Portifact's own: a custom hostname may never be one of them or below them. */
export const RESERVED_DOMAINS = ["portifact.com", "portifact.dev", "portifact.test"] as const;

export type HostnameError =
  | "invalid"
  | "ip_literal"
  | "wildcard"
  | "reserved"
  | "lookalike"
  | "single_label";

/**
 * Normalizes what an owner typed into the hostname Cloudflare and the browser will use: lowercase
 * ASCII (IDNs become punycode through the URL parser), no trailing dot, no port, path or
 * credentials. Refuses IP literals, wildcards (Cloudflare offers them only on Enterprise), any
 * name at or under Portifact's domains, any label that contains "portifact" (a lookalike of the
 * product on a paid domain is the phishing case) and single labels.
 */
export function normalizeHostname(
  input: string,
): { ok: true; hostname: string } | { ok: false; error: HostnameError } {
  const trimmed = input.trim().replace(/\.$/, "");
  if (trimmed.startsWith("*.")) return { ok: false, error: "wildcard" };
  if (trimmed === "" || /[/\\@:?#\s]/.test(trimmed)) return { ok: false, error: "invalid" };
  let hostname: string;
  try {
    hostname = new URL(`https://${trimmed}/`).hostname;
  } catch {
    return { ok: false, error: "invalid" };
  }
  if (hostname.startsWith("[") || /^[\d.]+$/.test(hostname)) {
    return { ok: false, error: "ip_literal" };
  }
  if (hostname.length > 253 || !/^[a-z0-9.-]+$/.test(hostname)) {
    return { ok: false, error: "invalid" };
  }
  const labels = hostname.split(".");
  if (labels.some((label) => !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    return { ok: false, error: "invalid" };
  }
  if (labels.length < 2) return { ok: false, error: "single_label" };
  if (RESERVED_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`))) {
    return { ok: false, error: "reserved" };
  }
  if (labels.some((label) => label.includes("portifact"))) {
    return { ok: false, error: "lookalike" };
  }
  return { ok: true, hostname };
}

/** What the content Worker makes of a request's host. */
export type HostKind =
  | { kind: "artifact"; artifactId: string }
  | { kind: "custom"; hostname: string }
  | { kind: "none" };

/**
 * `<id>.<contentDomain>` is an artifact host as today; anything else under the content domain
 * (the apex, the fallback origin, nested labels) is nothing; any other name can only be a custom
 * hostname, because Cloudflare routes to the zone only hostnames it holds a custom hostname for.
 */
export function classifyHost(hostname: string, contentDomain: string): HostKind {
  const suffix = `.${contentDomain}`;
  if (hostname === contentDomain) return { kind: "none" };
  if (hostname.endsWith(suffix)) {
    const label = hostname.slice(0, -suffix.length);
    return ARTIFACT_ID.test(label) ? { kind: "artifact", artifactId: label } : { kind: "none" };
  }
  const normalized = normalizeHostname(hostname);
  return normalized.ok && normalized.hostname === hostname
    ? { kind: "custom", hostname }
    : { kind: "none" };
}

/** The origin Portifact gives every artifact, whatever domain it has. */
export function artifactOrigin(artifactId: string, contentDomain: string): string {
  return `https://${artifactId}.${contentDomain}`;
}

/**
 * The domain the injected-cookie cleanup expires sibling cookies on. Only the content domain:
 * on a custom host the siblings are the customer's own sites, their cookies are the customer's,
 * and without the Public Suffix List the Worker cannot tell which registrable domain to name.
 * Foreign cookies still grant nothing there, because authorization reads only exact `__Host-`
 * names.
 */
export function cookieCleanupDomain(hostname: string, contentDomain: string): string | null {
  return classifyHost(hostname, contentDomain).kind === "artifact" ? contentDomain : null;
}
