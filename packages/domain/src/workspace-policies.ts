// Workspace policies (premium plan E4, feature `policies`, decision 0015): the one place that
// decides what a workspace's policies allow. The services read the policy with the actor
// (`Actor.policy`, from the same row as the membership) and apply these rules after
// authorization; adapters never do.
import {
  type AccessMode,
  DEFAULT_POLICY,
  type PolicyField,
  type PolicyImpact,
  WorkspacePolicy,
} from "@portifact/contracts";
import { emailDomainOf, normalizeEmailDomain } from "./email-domains.ts";
import { fail, ok, type Result } from "./result.ts";

const DAY_MS = 86_400_000;

/**
 * The policy stored on a workspace's row: null is the defaults. A stored value was validated on
 * write; one that no longer parses is an error, never the defaults, so a bad row cannot lift a
 * restriction.
 */
export function policyOf(stored: unknown): WorkspacePolicy {
  if (stored === null || stored === undefined) return DEFAULT_POLICY;
  const value = typeof stored === "string" ? (JSON.parse(stored) as unknown) : stored;
  return WorkspacePolicy.parse(value);
}

const refused = (message: string) => fail<never>("policy_refused", message);

export const POLICY_MESSAGES = {
  publicForbidden:
    "The workspace's policy forbids public access. Share it with the workspace, an email domain or named readers instead.",
  readerOutside: (email: string, domains: readonly string[]) =>
    `The workspace's reader domain policy only allows readers at ${domains.join(", ")}; ${email} is not one of them.`,
  linksDisabled: "The workspace's policy does not allow share links.",
  passwordRequired: "The workspace's policy requires a password on every share link.",
  lifetime: (days: number) =>
    `The workspace's policy limits share links to ${days} ${days === 1 ? "day" : "days"}. Choose an expiry within that.`,
  defaultDomain:
    "Verify an email domain on the workspace's Members page before making it the default access.",
  transferPublic:
    "This artifact is public, and the target workspace's policy forbids public access. Narrow its access first, then move it.",
  transferReaders: (domains: readonly string[]) =>
    `This artifact lists readers outside the target workspace's reader domain policy (${domains.join(", ")}). Remove them first, then move it.`,
  transferLinks:
    "This artifact has active share links, and the target workspace's policy does not allow them. Revoke them first, then move it.",
} as const;

/**
 * A policy as an admin sent it, normalized: reader domains lowercased, deduplicated and sorted.
 * A domain must be a plain ASCII domain written as it is stored (an IDN in its `xn--` form), the
 * same rule `emailDomainOf` applies to an address's domain.
 */
export function normalizePolicy(input: WorkspacePolicy): Result<WorkspacePolicy> {
  if (input.readerDomains === null) return ok({ ...input });
  const domains = new Set<string>();
  for (const written of input.readerDomains) {
    const lower = written.trim().toLowerCase();
    const domain = /^[a-z0-9.-]+$/.test(lower) ? normalizeEmailDomain(lower) : null;
    if (!domain?.ok || domain.value !== lower) {
      return fail(
        "invalid_input",
        `${written} is not a plain domain. Write it like example.com, in ASCII (xn-- for international names).`,
      );
    }
    domains.add(domain.value);
  }
  return ok({ ...input, readerDomains: [...domains].sort() });
}

/** Whether a policy changes nothing: every field at its default. */
export function isDefaultPolicy(policy: WorkspacePolicy): boolean {
  return changedFields(DEFAULT_POLICY, policy).length === 0;
}

function sameDomains(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((domain, i) => domain === b[i]);
}

/** The fields that differ between two policies, in `POLICY_FIELDS` order. */
export function changedFields(current: WorkspacePolicy, next: WorkspacePolicy): PolicyField[] {
  const fields: PolicyField[] = [];
  if (current.publicAccess !== next.publicAccess) fields.push("publicAccess");
  if (current.defaultAccess !== next.defaultAccess) fields.push("defaultAccess");
  if (!sameDomains(current.readerDomains, next.readerDomains)) fields.push("readerDomains");
  if (current.shareLinks !== next.shareLinks) fields.push("shareLinks");
  if (current.shareLinkMaxDays !== next.shareLinkMaxDays) fields.push("shareLinkMaxDays");
  return fields;
}

const LINK_ORDER = { allowed: 0, password_required: 1, disabled: 2 } as const;

/**
 * Whether changing one field loosens it: allowing public access, the built-in default access,
 * a wider (or no) reader allowlist, a laxer share link rule, a longer (or no) maximum lifetime.
 */
function loosens(field: PolicyField, current: WorkspacePolicy, next: WorkspacePolicy): boolean {
  switch (field) {
    case "publicAccess":
      return next.publicAccess === "allowed";
    case "defaultAccess":
      return next.defaultAccess === DEFAULT_POLICY.defaultAccess;
    case "readerDomains":
      return (
        next.readerDomains === null ||
        current.readerDomains?.every((domain) => next.readerDomains?.includes(domain)) === true
      );
    case "shareLinks":
      return LINK_ORDER[next.shareLinks] < LINK_ORDER[current.shareLinks];
    case "shareLinkMaxDays":
      return (
        next.shareLinkMaxDays === null ||
        (current.shareLinkMaxDays !== null && next.shareLinkMaxDays > current.shareLinkMaxDays)
      );
  }
}

/**
 * Whether a change needs `policies` in the workspace's plan: any field it sets or tightens. Only
 * loosening (or changing nothing) never does, so a workspace whose plan lapsed keeps its policies
 * and its admins can still lift them.
 */
export function policyChangeNeedsPlan(current: WorkspacePolicy, next: WorkspacePolicy): boolean {
  return changedFields(current, next).some((field) => !loosens(field, current, next));
}

/**
 * The `domain` default needs a verified email domain on the workspace, as the `domain` mode does
 * (decision 0010).
 */
export function checkPolicyDefaults(
  policy: WorkspacePolicy,
  domainVerified: boolean,
): Result<true> {
  if (policy.defaultAccess === "domain" && !domainVerified) {
    return fail("invalid_input", POLICY_MESSAGES.defaultDomain);
  }
  return ok(true);
}

/** Whether a policy may change existing artifacts, so saving it needs its impact counted. */
export function policyTouchesArtifacts(policy: WorkspacePolicy): boolean {
  return (
    policy.publicAccess === "forbidden" ||
    policy.readerDomains !== null ||
    policy.shareLinks !== "allowed" ||
    policy.shareLinkMaxDays !== null
  );
}

/** The total of an impact: zero when saving changes no existing artifact, reader or link. */
export function impactTotal(impact: PolicyImpact): number {
  return (
    impact.publicArtifacts +
    impact.readersOutside +
    impact.linksRevoked +
    impact.linksWithoutPassword +
    impact.linksOverLifetime
  );
}

/**
 * A save that would change existing artifacts is refused until the admin confirms it, naming
 * every count, so nothing is narrowed, removed or revoked silently.
 */
export function checkPolicyImpact(impact: PolicyImpact, confirmed: boolean): Result<true> {
  if (confirmed || impactTotal(impact) === 0) return ok(true);
  const parts = [
    [impact.publicArtifacts, "public artifact", "public artifacts", "would become workspace-only"],
    [impact.readersOutside, "reader", "readers", "outside the allowed domains would be removed"],
    [impact.linksRevoked, "share link", "share links", "would be revoked"],
    [
      impact.linksWithoutPassword,
      "share link",
      "share links",
      "without a password would stop opening",
    ],
    [
      impact.linksOverLifetime,
      "share link",
      "share links",
      "past the maximum lifetime would stop opening",
    ],
  ] as const;
  const listed = parts
    .filter(([count]) => count > 0)
    .map(([count, one, many, effect]) => `${count} ${count === 1 ? one : many} ${effect}`);
  return refused(
    `This policy changes existing artifacts: ${listed.join("; ")}. Narrow them first, or confirm the change.`,
  );
}

/** Whether a policy (absent for a personal space) lets an artifact take the access mode `mode`. */
export function checkPolicyAccess(
  policy: WorkspacePolicy | undefined,
  mode: AccessMode,
): Result<true> {
  if (policy?.publicAccess === "forbidden" && mode === "public") {
    return refused(POLICY_MESSAGES.publicForbidden);
  }
  return ok(true);
}

/** Whether an address may be a reader under a policy's allowlist: its domain, matched exactly. */
export function readerAllowed(policy: WorkspacePolicy | undefined, email: string): boolean {
  if (!policy || policy.readerDomains === null) return true;
  const domain = emailDomainOf(email);
  return domain !== null && policy.readerDomains.includes(domain);
}

/** Refuses adding readers outside a policy's allowlist, naming the first one. */
export function checkPolicyReaders(
  policy: WorkspacePolicy | undefined,
  added: readonly string[],
): Result<true> {
  const outside = added.find((email) => !readerAllowed(policy, email));
  if (outside !== undefined && policy?.readerDomains) {
    return refused(POLICY_MESSAGES.readerOutside(outside, policy.readerDomains));
  }
  return ok(true);
}

/**
 * Whether a new share link meets the policy: links allowed, a password when one is required, and
 * an expiry within the maximum lifetime when there is one (a link without an expiry exceeds it).
 */
export function checkPolicyShareLink(
  policy: WorkspacePolicy | undefined,
  link: { password: boolean; expiresAt: number | null },
  now: number,
): Result<true> {
  if (!policy) return ok(true);
  if (policy.shareLinks === "disabled") return refused(POLICY_MESSAGES.linksDisabled);
  if (policy.shareLinks === "password_required" && !link.password) {
    return refused(POLICY_MESSAGES.passwordRequired);
  }
  const max = policy.shareLinkMaxDays;
  if (max !== null && (link.expiresAt === null || link.expiresAt > now + max * DAY_MS)) {
    return refused(POLICY_MESSAGES.lifetime(max));
  }
  return ok(true);
}

/**
 * Whether an existing link still opens under the policy, checked when a visitor opens it: never
 * while links are disabled, not without a password while one is required, and not once it is
 * older than the maximum lifetime. Links created before a policy tightened stop opening here.
 */
export function policyLinkOpens(
  policy: WorkspacePolicy | undefined,
  link: { hasPassword: boolean; createdAt: number },
  now: number,
): boolean {
  if (!policy) return true;
  if (policy.shareLinks === "disabled") return false;
  if (policy.shareLinks === "password_required" && !link.hasPassword) return false;
  const max = policy.shareLinkMaxDays;
  return max === null || now < link.createdAt + max * DAY_MS;
}

/** The access mode a new artifact of the workspace starts with. */
export function policyDefaultAccess(policy: WorkspacePolicy | undefined): AccessMode {
  return policy?.defaultAccess ?? DEFAULT_POLICY.defaultAccess;
}

/**
 * Whether an artifact may move into a workspace under its policy: not public where public access
 * is forbidden, no reader outside its allowlist, and no active share link where links are
 * disabled. The admin narrows the artifact first; a move never changes it silently. A link that
 * a stricter link rule refuses simply stops opening there.
 */
export function checkPolicyTransfer(
  policy: WorkspacePolicy | undefined,
  artifact: { accessMode: AccessMode; readers: readonly string[]; activeLinks: number },
): Result<true> {
  if (!policy) return ok(true);
  if (policy.publicAccess === "forbidden" && artifact.accessMode === "public") {
    return refused(POLICY_MESSAGES.transferPublic);
  }
  if (policy.readerDomains && artifact.readers.some((email) => !readerAllowed(policy, email))) {
    return refused(POLICY_MESSAGES.transferReaders(policy.readerDomains));
  }
  if (policy.shareLinks === "disabled" && artifact.activeLinks > 0) {
    return refused(POLICY_MESSAGES.transferLinks);
  }
  return ok(true);
}

/** The audit detail of a policy change: the fields that changed and their new values. */
export function policyChangeDetail(
  current: WorkspacePolicy,
  next: WorkspacePolicy,
  confirmed: boolean,
) {
  const fields = changedFields(current, next);
  return {
    fields,
    ...(fields.includes("publicAccess") ? { publicAccess: next.publicAccess } : {}),
    ...(fields.includes("defaultAccess") ? { defaultAccess: next.defaultAccess } : {}),
    ...(fields.includes("readerDomains") ? { readerDomains: next.readerDomains } : {}),
    ...(fields.includes("shareLinks") ? { shareLinks: next.shareLinks } : {}),
    ...(fields.includes("shareLinkMaxDays") ? { shareLinkMaxDays: next.shareLinkMaxDays } : {}),
    confirmed,
  };
}

/** The moment before which a link is past a policy's maximum lifetime; null without one. */
export function lifetimeCutoff(policy: WorkspacePolicy, now: number): number | null {
  return policy.shareLinkMaxDays === null ? null : now - policy.shareLinkMaxDays * DAY_MS;
}

/**
 * A policy in short English phrases, for the CLI and MCP (empty for the defaults): what a client
 * shows before trying something the policy refuses.
 */
export function describePolicy(policy: WorkspacePolicy): string[] {
  const lines: string[] = [];
  if (policy.publicAccess === "forbidden") lines.push("public access forbidden");
  if (policy.defaultAccess !== DEFAULT_POLICY.defaultAccess) {
    lines.push(`new artifacts start as ${policy.defaultAccess}`);
  }
  if (policy.readerDomains) lines.push(`readers only at ${policy.readerDomains.join(", ")}`);
  if (policy.shareLinks === "disabled") lines.push("share links disabled");
  if (policy.shareLinks === "password_required") lines.push("share links need a password");
  if (policy.shareLinkMaxDays !== null && policy.shareLinks !== "disabled") {
    lines.push(`share links last at most ${policy.shareLinkMaxDays} days`);
  }
  return lines;
}
