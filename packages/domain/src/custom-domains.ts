// Custom domains (premium plan P7, decision 0006): which hostnames an owner may attach, how the
// content Worker tells an artifact host from a custom one, and the decisions of the daily check
// and the plan limit. Pure functions, no I/O; the services apply them with D1 and Cloudflare.
import { type AccessMode, CUSTOM_DOMAINS, type DomainDetachReason } from "@portifact/contracts";
import type { Entitlements } from "./plans.ts";
import { fail, ok, type Result } from "./result.ts";

const ARTIFACT_LABEL = /^[a-z2-7]{10}$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * Domains that are Portifact's own: a custom hostname is never one of them or under them. The
 * content domain of a deployment is added by the caller, so a staging content domain is
 * reserved too.
 */
export const RESERVED_DOMAINS = ["portifact.com", "portifact.dev", "portifact.test"] as const;

export type HostnameError =
  | "invalid"
  | "ip_literal"
  | "wildcard"
  | "reserved"
  | "lookalike"
  | "apex"
  | "too_long"
  | "zone_apex"
  | "blocked";

export const HOSTNAME_MESSAGES: Readonly<Record<HostnameError, string>> = {
  invalid: "That is not a hostname. Type only the name, for example docs.example.com.",
  ip_literal: "An IP address cannot be a custom domain. Use a hostname such as docs.example.com.",
  wildcard: "Wildcard domains are not supported. Use one hostname such as docs.example.com.",
  reserved: "Portifact's own domains cannot be used as a custom domain.",
  lookalike: "A custom domain cannot contain the word portifact.",
  apex: "Use a subdomain such as docs.example.com: root domains like example.com are not supported.",
  too_long: "A hostname has at most 253 characters.",
  zone_apex:
    "That name is the root of its DNS zone, which cannot point at Portifact with a CNAME. Use a subdomain such as docs.example.com.",
  blocked: "This hostname cannot be used as a custom domain.",
};

/** IPv4 in any of the forms the URL parser accepts ends as dotted digits; IPv6 in brackets. */
function isIpLiteral(hostname: string): boolean {
  return hostname.startsWith("[") || /^[0-9.]+$/.test(hostname);
}

/**
 * Normalizes what an owner typed into the hostname Cloudflare and browsers use: lowercase ASCII
 * (an internationalized name becomes punycode through the URL parser), without a trailing dot,
 * port, path or credentials. Refuses IP literals, wildcards (Cloudflare offers them only on
 * Enterprise), names at or under Portifact's domains and the deployment's `contentDomain`, any
 * label that contains "portifact" (a lookalike of the product is the phishing case), names with
 * fewer than three labels (apex domains need apex proxying, an Enterprise add-on) and names that
 * DNS cannot hold.
 */
export function normalizeHostname(input: string, contentDomain?: string): Result<string> {
  const refuse = (error: HostnameError) => fail<string>("invalid_input", HOSTNAME_MESSAGES[error]);
  const trimmed = input.trim().toLowerCase();
  if (trimmed.startsWith("*")) return refuse("wildcard");
  const withoutDot = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  if (/^\[.*\]$/.test(withoutDot)) return refuse("ip_literal");
  if (withoutDot === "" || /[/\\@:?#%\s*]/.test(withoutDot)) return refuse("invalid");
  // A top-level label is never all digits, and the URL parser reads such names as IPv4.
  if (/(^|\.)[0-9]+$/.test(withoutDot)) return refuse("ip_literal");
  let hostname: string;
  try {
    hostname = new URL(`https://${withoutDot}/`).hostname;
  } catch {
    return refuse("invalid");
  }
  if (isIpLiteral(hostname)) return refuse("ip_literal");
  if (hostname.length > 253) return refuse("too_long");
  const labels = hostname.split(".");
  if (!/^[a-z0-9.-]+$/.test(hostname) || labels.some((label) => !LABEL.test(label))) {
    return refuse("invalid");
  }
  const reserved = contentDomain ? [...RESERVED_DOMAINS, contentDomain] : RESERVED_DOMAINS;
  if (reserved.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
    return refuse("reserved");
  }
  if (labels.some((label) => label.includes("portifact"))) return refuse("lookalike");
  if (labels.length < 3) return refuse("apex");
  return ok(hostname);
}

/** What the content Worker makes of a request's host. */
export type HostKind =
  | { kind: "artifact"; artifactId: string }
  | { kind: "custom"; hostname: string }
  | { kind: "none" };

/**
 * `<id>.<contentDomain>` is an artifact host; anything else under the content domain (the apex,
 * the CNAME target, nested labels) is nothing; any other name can only be a custom hostname,
 * because Cloudflare routes to the zone only hostnames it holds a custom hostname for. A name
 * that `normalizeHostname` would change or refuse is nothing too.
 */
export function classifyHost(hostname: string, contentDomain: string): HostKind {
  if (hostname === contentDomain) return { kind: "none" };
  const suffix = `.${contentDomain}`;
  if (hostname.endsWith(suffix)) {
    const label = hostname.slice(0, -suffix.length);
    return ARTIFACT_LABEL.test(label) ? { kind: "artifact", artifactId: label } : { kind: "none" };
  }
  const normalized = normalizeHostname(hostname, contentDomain);
  return normalized.ok && normalized.value === hostname
    ? { kind: "custom", hostname }
    : { kind: "none" };
}

/** The domains an owner's plan allows: none without the feature, whatever the count says. */
export function domainLimit(owner: Entitlements): number {
  return owner.features.includes("customDomains") ? owner.limits.customDomains : 0;
}

/**
 * The moment whose entitlements decide the plan limit of existing domains: an expired plan keeps
 * its domains for `downgradeGraceDays`, so the owner has a week to renew before any is detached.
 * A plan removed or lowered by the operator applies at once (its row says so, not its expiry).
 */
export function domainLimitAt(now: number): number {
  return now - CUSTOM_DOMAINS.downgradeGraceDays * DAY_MS;
}

/**
 * Which domains a lower limit detaches: the oldest stay (by proof, then hostname), the newest
 * go. `domains` are the owner's domains that count (proven and not being removed).
 */
export function domainsOverLimit(
  domains: readonly { hostname: string; verifiedAt: number }[],
  limit: number,
): string[] {
  return [...domains]
    .sort((a, b) => a.verifiedAt - b.verifiedAt || a.hostname.localeCompare(b.hostname))
    .slice(Math.max(0, limit))
    .map((domain) => domain.hostname);
}

/** Whether a new domain fits the owner's limit, counting the domains it already has. */
export function checkDomainCount(used: number, limit: number): Result<null> {
  if (used < limit) return ok(null);
  return fail(
    "quota_exceeded",
    `Your plan includes ${limit} custom ${limit === 1 ? "domain" : "domains"}. Remove one before adding another.`,
  );
}

/** When a claim made at `now` expires. */
export function claimExpiry(now: number): number {
  return now + CUSTOM_DOMAINS.claimTtlDays * DAY_MS;
}

/** Cloudflare's state of a custom hostname, reduced to what Portifact acts on. */
export type CloudflareStatus = "pending" | "active" | "moved" | "deleted" | "blocked" | "missing";

/** What the daily check does with a domain, decided from what it found. */
export type DomainCheck =
  | { action: "keep"; missedChecks: number }
  | { action: "detach"; reason: DetachReason };

export type DetachReason = DomainDetachReason;

/**
 * The daily check of a domain that is proven: three misses of the TXT proof in a row detach it,
 * and so does a Cloudflare hostname that moved, was deleted or blocked, or is missing. A check
 * that could not reach DNS (`txt: "unknown"`) neither counts as a miss nor resets the count.
 */
export function checkProvenDomain(input: {
  missedChecks: number;
  txt: "held" | "missing" | "unknown";
  cloudflare: CloudflareStatus | "unknown";
}): DomainCheck {
  if (
    input.cloudflare === "moved" ||
    input.cloudflare === "deleted" ||
    input.cloudflare === "blocked" ||
    input.cloudflare === "missing"
  ) {
    return { action: "detach", reason: "cloudflare_gone" };
  }
  if (input.txt === "unknown") return { action: "keep", missedChecks: input.missedChecks };
  if (input.txt === "held") return { action: "keep", missedChecks: 0 };
  const missed = input.missedChecks + 1;
  return missed >= CUSTOM_DOMAINS.maxMissedChecks
    ? { action: "detach", reason: "txt_lost" }
    : { action: "keep", missedChecks: missed };
}

/** Where a name resolves, as the DNS check found it: to Portifact's CNAME target or elsewhere. */
export type Pointing = "here" | "elsewhere" | "unknown";

/**
 * The daily check of where an active name points (decision 0006, "Where the name points"): a
 * name that no longer resolves to Portifact's CNAME target may be serving something else inside
 * Portifact's bar, so `maxMissedChecks` such checks in a row detach it, counted apart from the TXT
 * misses. A check that could not reach DNS neither counts nor resets.
 */
export function checkPointing(input: {
  missedPointChecks: number;
  pointing: Pointing;
}): { action: "keep"; missedPointChecks: number } | { action: "detach"; reason: DetachReason } {
  if (input.pointing === "unknown") {
    return { action: "keep", missedPointChecks: input.missedPointChecks };
  }
  if (input.pointing === "here") return { action: "keep", missedPointChecks: 0 };
  const missed = input.missedPointChecks + 1;
  return missed >= CUSTOM_DOMAINS.maxMissedChecks
    ? { action: "detach", reason: "cname_elsewhere" }
    : { action: "keep", missedPointChecks: missed };
}

/** Whether a proven domain is due for its daily check at `now`. */
export function recheckDue(checkedAt: number, now: number): boolean {
  return now - checkedAt >= CUSTOM_DOMAINS.recheckHours * HOUR_MS;
}

/** Whether a domain still provisioning at `now` has waited too long (Cloudflare bills it). */
export function provisioningExpired(verifiedAt: number, now: number): boolean {
  return now - verifiedAt >= CUSTOM_DOMAINS.provisioningMaxDays * DAY_MS;
}

/** Whether `values` (TXT strings at the record's name) hold exactly the claim's value. */
export function holdsTxt(values: readonly string[], expected: string): boolean {
  return values.some((value) => value.trim() === expected);
}

/** Whether `hostname` is a blocked name or under one (the operator's block list). */
export function isBlockedHostname(hostname: string, blocked: readonly string[]): boolean {
  return blocked.some((name) => hostname === name || hostname.endsWith(`.${name}`));
}

/** The refusal of a blocked name, a zone apex or another name `normalizeHostname` refused. */
export function hostnameRefusal(error: "zone_apex" | "blocked"): Result<never> {
  return fail("invalid_input", HOSTNAME_MESSAGES[error]);
}

/** The artifact's own Portifact origin host, whatever domain it has. */
export function devHost(artifactId: string, contentDomain: string): string {
  return `${artifactId}.${contentDomain}`;
}

/**
 * Where a one-use code may be sent (read, review and share-link handoffs): the artifact's `.dev`
 * host when nothing else was asked for, or its active custom host when that exact host was asked
 * for. Any other requested host gives null, and the caller answers it like an artifact the
 * visitor cannot open, so the answer reveals nothing about the artifact's domain.
 */
export function handoffHost(input: {
  artifactId: string;
  contentDomain: string;
  requested: string | null;
  activeHost: string | null;
}): string | null {
  if (input.requested === null) return devHost(input.artifactId, input.contentDomain);
  return input.activeHost !== null && input.requested === input.activeHost
    ? input.activeHost
    : null;
}

/**
 * Whether the app may send a visitor's code to the artifact's custom host without a click of
 * theirs (decision 0006, "Codes on a custom host"). The domain owner controls that host's DNS and
 * may receive the code on a server of their own. An `authenticated` artifact is read by every
 * signed-in account, so a visitor who was merely sent there confirms first on the app (the read
 * entry), or stays on the `.dev` host (the viewer's frame and its review codes). A public artifact
 * needs no code to be read, and the readers of a restricted one are the owner's own choice.
 */
export function customHostWithoutClick(accessMode: AccessMode): boolean {
  return accessMode !== "authenticated";
}

/**
 * The origin the viewer frames, for its `frame-src`, the review code's iframe URL and the page
 * links it shows: the active custom host only when the visitor may read the artifact, otherwise
 * the `.dev` origin, so the viewer page of a missing, protected or unavailable artifact is the
 * same with or without a domain and never names it.
 */
export function viewerFrameOrigin(input: {
  artifactId: string;
  contentDomain: string;
  readable: boolean;
  activeHost: string | null;
}): string {
  return input.readable && input.activeHost !== null
    ? `https://${input.activeHost}`
    : `https://${devHost(input.artifactId, input.contentDomain)}`;
}

/**
 * The canonical redirect of an old `.dev` link to the artifact's custom host (decision 0006,
 * section 6): only for a top-level page visit served on the `.dev` host, after authorization,
 * outside review mode, not through a share link (its session lives on the origin it opened on),
 * and only with the bar off, because with the bar on the viewer wins and frames the custom host
 * itself. The same path and query; null when nothing redirects.
 */
export function canonicalLocation(input: {
  onDevHost: boolean;
  customHost: string | null;
  bar: boolean;
  topLevelPage: boolean;
  review: boolean;
  link: boolean;
  pathAndQuery: string;
}): string | null {
  if (!input.onDevHost || input.customHost === null || input.bar) return null;
  if (!input.topLevelPage || input.review || input.link) return null;
  return `https://${input.customHost}${input.pathAndQuery}`;
}

/**
 * The downgrade notice (decision 0006, section 7): when the owner's plan already ended but the
 * grace still keeps some of its domains, the ones the end of the grace will detach and when.
 * Null when nothing is at risk or the owner was already told about this detach time.
 */
export function domainNotice(input: {
  /** The owner's domains that count, with their proofs. */
  domains: readonly { hostname: string; verifiedAt: number; noticeFor: number | null }[];
  /** The plan's limit now and as the grace reads it (`domainLimitAt`). */
  limitNow: number;
  limitInGrace: number;
  /** When the plan ended; the grace ends `downgradeGraceDays` later. */
  validUntil: number | null;
}): { hostnames: string[]; detachAt: number } | null {
  if (input.validUntil === null || input.limitNow >= input.domains.length) return null;
  const detachAt = input.validUntil + CUSTOM_DOMAINS.downgradeGraceDays * DAY_MS;
  const hostnames = domainsOverLimit(input.domains, input.limitNow);
  const due = input.domains.filter(
    (domain) => hostnames.includes(domain.hostname) && domain.noticeFor !== detachAt,
  );
  return due.length > 0 && input.limitInGrace >= input.domains.length
    ? { hostnames, detachAt }
    : null;
}

/**
 * A name for the operator's block list: lowercase ASCII (punycode), no trailing dot, any number of
 * labels (a registrable domain blocks every name under it). Null when it is not a hostname.
 */
export function normalizeBlockName(input: string): string | null {
  const trimmed = input.trim().toLowerCase().replace(/\.$/, "");
  if (trimmed === "" || /[/\\@:?#%\s*[\]]/.test(trimmed)) return null;
  let hostname: string;
  try {
    hostname = new URL(`https://${trimmed}/`).hostname;
  } catch {
    return null;
  }
  const labels = hostname.split(".");
  if (labels.length < 2 || labels.some((label) => !LABEL.test(label))) return null;
  if (/^[0-9]+$/.test(labels[labels.length - 1] as string)) return null;
  return hostname;
}
