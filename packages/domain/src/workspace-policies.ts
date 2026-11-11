// Workspace policies (premium plan E4, feature `policies`, decision 0015): the one place that
// decides what a workspace's policies allow. The services read the policy with the actor
// (`Actor.policy`, from the same row as the membership) and apply these rules after
// authorization; adapters never do.
import {
  type AccessMode,
  DEFAULT_POLICY,
  type IpAllowlistView,
  type PolicyField,
  type PolicyImpact,
  type RequestContext,
  WorkspacePolicy,
  type WorkspacePolicyShown,
} from "@portifact/contracts";
import { roleAllows } from "./actor.ts";
import { emailDomainOf, normalizeEmailDomain } from "./email-domains.ts";
import {
  type IpFamily,
  type NetworkVerdict,
  networkVerdict,
  normalizeIpRanges,
  rangesCovered,
  singleFamily,
} from "./ip-ranges.ts";
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
  impactChanged:
    "What this policy changes on existing artifacts grew since it was reviewed. Review the change again before saving.",
  transferLinks:
    "This artifact has active share links, and the target workspace's policy does not allow them. Revoke them first, then move it.",
  networkPerson: (ip: string | null) =>
    ip === null
      ? "This workspace's network policy only allows access from approved networks, and Portifact could not tell which network this request came from. Connect from an approved network, or ask a workspace admin."
      : `This workspace's network policy only allows access from approved networks, and your address (${ip}) is not on its list. Connect from an approved network, or ask a workspace admin.`,
  networkToken: (ip: string | null) =>
    `This workspace's network policy only allows its service tokens from approved networks, and this request came from ${ip ?? "an unknown address"}. Run it from an approved network, or ask a workspace admin to add it.`,
  networkLocksOut: (ip: string | null) =>
    ip === null
      ? "Portifact could not tell which network you are on, so this allowlist would lock you out. Try again from your usual network."
      : `This allowlist does not include your current address (${ip}), so saving it would lock you out. Add your network first.`,
  networkUnreadable:
    "This workspace's network policy could not be read, so Portifact refuses requests until it is fixed. Ask a workspace admin to contact Portifact support.",
  singleFamily: (lists: string) =>
    `${lists} only IPv4 or only IPv6 ranges. People on networks that use both reach Portifact over either, and requests over the other one would be refused. Add the other family's ranges, or confirm that the list covers only one.`,
} as const;

/**
 * A policy as an admin sent it, normalized: reader domains lowercased, deduplicated and sorted.
 * A domain must be a plain ASCII domain written as it is stored (an IDN in its `xn--` form), the
 * same rule `emailDomainOf` applies to an address's domain.
 */
export function normalizePolicy(input: WorkspacePolicy): Result<WorkspacePolicy> {
  const people = input.ipAllowlist === null ? ok(null) : normalizeIpRanges(input.ipAllowlist);
  if (!people.ok) return people;
  const tokens =
    input.tokenIpAllowlist === null ? ok(null) : normalizeIpRanges(input.tokenIpAllowlist);
  if (!tokens.ok) return tokens;
  const networks = { ipAllowlist: people.value, tokenIpAllowlist: tokens.value };
  if (input.readerDomains === null) return ok({ ...input, ...networks });
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
  return ok({ ...input, ...networks, readerDomains: [...domains].sort() });
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
  if (!sameDomains(current.ipAllowlist, next.ipAllowlist)) fields.push("ipAllowlist");
  if (!sameDomains(current.tokenIpAllowlist, next.tokenIpAllowlist)) {
    fields.push("tokenIpAllowlist");
  }
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
    // A network allowlist loosens when it is lifted or when every network it admitted still is.
    case "ipAllowlist":
      return networksLoosen(current.ipAllowlist, next.ipAllowlist);
    case "tokenIpAllowlist":
      return networksLoosen(current.tokenIpAllowlist, next.tokenIpAllowlist);
  }
}

function networksLoosen(current: string[] | null, next: string[] | null): boolean {
  if (next === null) return true;
  return current !== null && rangesCovered(current, next);
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

const IMPACT_KEYS = [
  "publicArtifacts",
  "readersOutside",
  "linksRevoked",
  "linksWithoutPassword",
  "linksOverLifetime",
] as const satisfies readonly (keyof PolicyImpact)[];

/**
 * A save that would change existing artifacts is refused until the admin confirms the impact the
 * preview showed, naming every count, so nothing is narrowed, removed or revoked silently. The
 * confirmation holds only for what the admin saw: a count that grew since is refused again.
 */
export function checkPolicyImpact(
  impact: PolicyImpact,
  confirmed: PolicyImpact | undefined,
): Result<true> {
  if (impactTotal(impact) === 0) return ok(true);
  if (confirmed) {
    return IMPACT_KEYS.some((key) => impact[key] > confirmed[key])
      ? refused(POLICY_MESSAGES.impactChanged)
      : ok(true);
  }
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

/**
 * The access mode a new artifact of the workspace starts with: its `defaultAccess`, never wider
 * than a mode the workspace can give now. `domain` without a verified email domain (one lapsed or
 * was removed) starts as `workspace`, and without `workspaces` in the plan both workspace modes
 * start as `restricted`, the modes `updateAccess` would still let an editor set.
 */
export function policyDefaultAccess(
  policy: WorkspacePolicy | undefined,
  workspace: { domainVerified: boolean; workspacesFeature: boolean } = {
    domainVerified: true,
    workspacesFeature: true,
  },
): AccessMode {
  const wanted = policy?.defaultAccess ?? DEFAULT_POLICY.defaultAccess;
  if (wanted === "restricted" || !workspace.workspacesFeature) return "restricted";
  if (wanted === "domain" && !workspace.domainVerified) return "workspace";
  return wanted;
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
    // Counts only: an address or range never enters the audit log (decision 0020).
    ...(fields.includes("ipAllowlist") ? { ipRanges: next.ipAllowlist?.length ?? null } : {}),
    ...(fields.includes("tokenIpAllowlist")
      ? { tokenIpRanges: next.tokenIpAllowlist?.length ?? null }
      : {}),
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
export function describePolicy(policy: WorkspacePolicy | WorkspacePolicyShown): string[] {
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
  // Never the networks themselves: every member reads this line.
  if (policy.ipAllowlist) lines.push("people only from approved networks");
  if (policy.tokenIpAllowlist) lines.push("service tokens only from approved networks");
  return lines;
}

/**
 * Who a request policy binds: a person (any role, admins included) or a workspace's service
 * token. The two have separate allowlists (decision 0020): CI runners rarely share an office's
 * networks.
 */
export type RequestCaller = "person" | "token";

/**
 * Whether a request may act on a workspace under its request policies (decision 0020), from the
 * request context the Worker built: work no client is making (`background`) is never bound;
 * otherwise the caller's allowlist, if any, must admit the request's address. Refused with
 * `policy_refused` and a message naming the network policy and the caller's own address, never
 * the allowed networks.
 */
export function checkRequestPolicy(
  policy: WorkspacePolicy | undefined,
  request: RequestContext,
  caller: RequestCaller,
): Result<true> {
  const verdict = requestVerdict(policy, request, caller);
  if (verdict === "allowed") return ok(true);
  // A stored list that does not parse refuses everyone it binds (fail closed), never throws.
  if (verdict === "unreadable") return refused(POLICY_MESSAGES.networkUnreadable);
  const ip = request.kind === "request" ? request.ip : null;
  return refused(
    caller === "person" ? POLICY_MESSAGES.networkPerson(ip) : POLICY_MESSAGES.networkToken(ip),
  );
}

/**
 * What the caller's allowlist says about a request: `unreadable` when the stored list does not
 * parse, which callers log (with the workspace's ID, never an address) so the operator finds it.
 */
export function requestVerdict(
  policy: WorkspacePolicy | undefined,
  request: RequestContext,
  caller: RequestCaller,
): NetworkVerdict {
  if (!policy || request.kind === "background") return "allowed";
  const allowlist = caller === "person" ? policy.ipAllowlist : policy.tokenIpAllowlist;
  if (allowlist === null) return "allowed";
  return networkVerdict(allowlist, request.ip);
}

/**
 * Lock-out safety (decision 0020): an admin cannot save a people allowlist that leaves out the
 * address they are saving from. The token allowlist binds tokens only, so it cannot lock the
 * dashboard out.
 */
export function checkPolicyKeepsCaller(
  next: WorkspacePolicy,
  request: RequestContext,
): Result<true> {
  if (next.ipAllowlist === null || request.kind === "background") return ok(true);
  if (networkVerdict(next.ipAllowlist, request.ip) === "allowed") return ok(true);
  return fail("invalid_input", POLICY_MESSAGES.networkLocksOut(request.ip));
}

/** Which lists a save sets or changes that cover a single address family (decision 0020). */
export interface SingleFamilyLists {
  people: IpFamily | null;
  tokens: IpFamily | null;
}

/**
 * The lists `next` sets or changes that name only IPv4 or only IPv6 ranges. An unchanged list is
 * not being saved, so it is not reported again.
 */
export function singleFamilyLists(
  current: WorkspacePolicy,
  next: WorkspacePolicy,
): SingleFamilyLists {
  const fields = changedFields(current, next);
  const of = (field: "ipAllowlist" | "tokenIpAllowlist") => {
    const list = next[field];
    return list !== null && fields.includes(field) ? singleFamily(list) : null;
  };
  return { people: of("ipAllowlist"), tokens: of("tokenIpAllowlist") };
}

/**
 * A list covering one address family is never saved silently: the admin confirms exactly what
 * the preview reported, and a save whose lists changed since is refused again.
 */
export function checkSingleFamily(
  required: SingleFamilyLists,
  confirmed: SingleFamilyLists | undefined,
): Result<true> {
  if (required.people === null && required.tokens === null) return ok(true);
  if (confirmed && confirmed.people === required.people && confirmed.tokens === required.tokens) {
    return ok(true);
  }
  const named = [
    required.people === null ? null : "The allowlist for people names",
    required.tokens === null ? null : "The allowlist for service tokens names",
  ].filter((part): part is string => part !== null);
  return refused(
    POLICY_MESSAGES.singleFamily(
      named.length === 2
        ? "The allowlists for people and for service tokens name"
        : (named[0] as string),
    ),
  );
}

function shownNetworks(list: string[] | null, sees: boolean): IpAllowlistView {
  if (list === null) return null;
  return sees ? list : "hidden";
}

/**
 * Whether a caller sees a workspace's networks: an admin the network policy admits. A blocked
 * admin (a stolen session or token used from elsewhere) learns only that a list exists, never
 * which networks to get into.
 */
export function seesNetworks(role: Parameters<typeof roleAllows>[0], blocked: boolean): boolean {
  return roleAllows(role, "policies") && !blocked;
}

/**
 * A policy as a caller sees it: the network allowlists only when `sees` (`seesNetworks`); anyone
 * else learns only that one exists (`hidden`).
 */
export function shownPolicy(policy: WorkspacePolicy, sees: boolean): WorkspacePolicyShown {
  return {
    ...policy,
    ipAllowlist: shownNetworks(policy.ipAllowlist, sees),
    tokenIpAllowlist: shownNetworks(policy.tokenIpAllowlist, sees),
  };
}

/**
 * The restrictions `next` would lift from `current`: what `current` refuses and `next` would
 * allow. The operator's `apply-policies` reports them and lifts them only when asked to, so a
 * file older than a restriction cannot remove it silently.
 */
export function liftedFields(current: WorkspacePolicy, next: WorkspacePolicy): PolicyField[] {
  return changedFields(current, next).filter((field) => {
    switch (field) {
      // The access a new artifact starts with restricts nothing.
      case "defaultAccess":
        return false;
      case "readerDomains":
        return (
          current.readerDomains !== null &&
          (next.readerDomains === null ||
            next.readerDomains.some((domain) => !current.readerDomains?.includes(domain)))
        );
      case "ipAllowlist":
      case "tokenIpAllowlist": {
        const was = current[field];
        const now = next[field];
        return was !== null && (now === null || !rangesCovered(now, was));
      }
      default:
        return loosens(field, current, next);
    }
  });
}

/** A policy with its request policies (the network allowlists) lifted: the operator's escape hatch. */
export function withoutRequestPolicies(policy: WorkspacePolicy): WorkspacePolicy {
  return { ...policy, ipAllowlist: null, tokenIpAllowlist: null };
}

/**
 * Whether the content Worker serves a request under the owning workspace's people allowlist
 * (decision 0020), with nothing but what the delivery lookup holds: it binds the signed-in
 * readers of a `workspace` artifact, every one of them a member. Public visitors, share links and
 * the outsiders a `restricted` or `domain` artifact names are people the workspace chose to reach
 * outside it; a member reading those modes is bound where the session renews (`actorOn`).
 */
export function networkAdmits(input: {
  accessMode: AccessMode;
  networks: readonly string[] | null;
  signedIn: boolean;
  ip: string | null;
}): boolean {
  return networkDecision(input) === "allowed";
}

/** `networkAdmits` with the reason, so the content Worker can log an unreadable list. */
export function networkDecision(input: {
  accessMode: AccessMode;
  networks: readonly string[] | null;
  signedIn: boolean;
  ip: string | null;
}): NetworkVerdict {
  if (input.networks === null || !input.signedIn || input.accessMode !== "workspace") {
    return "allowed";
  }
  return networkVerdict(input.networks, input.ip);
}
