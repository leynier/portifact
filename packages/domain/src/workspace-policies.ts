// Workspace policies (premium plan E4, feature `policies`, decision 0015): the one place that
// decides what a workspace's policies allow. The services read the policy with the actor
// (`Actor.policy`, from the same row as the membership) and apply these rules after
// authorization; adapters never do.
import {
  type AccessMode,
  CLIENT_KINDS,
  type ClientKind,
  type Credential,
  DEFAULT_POLICY,
  type IpAllowlistView,
  type PolicyField,
  type PolicyImpact,
  type RequestContext,
  type RequestRefusal,
  WORKSPACE_POLICIES,
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
const HOUR_MS = 3_600_000;

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

/**
 * What a workspace's row stores for a policy: null for the defaults, and otherwise the policy
 * without a network list it does not set. The release before network lists reads a stored policy
 * with a strict schema that does not know those fields, so a row that only restricts sharing must
 * stay readable by it: a rollback then breaks only workspaces that did set a list, never all with
 * a policy (docs/releasing.md, "Client addresses"). `policyOf` reads a missing list as none.
 */
export function storedPolicy(policy: WorkspacePolicy): Partial<WorkspacePolicy> | null {
  if (changedFields(DEFAULT_POLICY, policy).length === 0) return null;
  // The same for the sign-in policies (decision 0021): a row stores them only while they are set.
  const {
    ipAllowlist,
    tokenIpAllowlist,
    sessionMaxHours,
    allowedClients,
    ssoRequired,
    artifactMaxDays,
    artifactMaxDaysFrom,
    ...rest
  } = policy;
  return {
    ...rest,
    // The maximum life (decision 0023) too: stored only while set.
    ...(artifactMaxDays === null ? {} : { artifactMaxDays, artifactMaxDaysFrom }),
    // "SSO required" too (decision 0021): stored only while set.
    ...(ssoRequired ? { ssoRequired } : {}),
    ...(ipAllowlist === null ? {} : { ipAllowlist }),
    ...(tokenIpAllowlist === null ? {} : { tokenIpAllowlist }),
    ...(sessionMaxHours === null ? {} : { sessionMaxHours }),
    ...(allowedClients === null ? {} : { allowedClients }),
  };
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
  sessionAge: (hours: number, credential: Credential | null | undefined) =>
    `This workspace's policy asks for a new sign-in every ${hoursText(hours)}, and ${signInSubject(credential)} is older than that. ${signInFix(credential)}`,
  sessionUnknown: (credential: Credential | null | undefined) =>
    `This workspace's policy limits how long a sign-in may act on it, and Portifact could not tell when ${signInSubject(credential)} happened. ${signInFix(credential)}`,
  client: (kind: ClientKind) =>
    kind === "cli"
      ? "This workspace's policy does not allow the Portifact CLI to act on it. Use the dashboard, or ask a workspace admin."
      : "This workspace's policy does not allow apps connected through OAuth, such as MCP clients, to act on it. Use the dashboard, or ask a workspace admin.",
  clientUnknown:
    "This workspace's policy limits which apps may act on it, and Portifact could not tell which app made this request. Use the dashboard, or ask a workspace admin.",
  sessionLocksOut: (hours: number) =>
    `Your own sign-in is older than ${hoursText(hours)}, so this maximum session age would lock you out. Sign in again first, or choose a longer maximum.`,
  ssoRequired: (credential: Credential | null | undefined) =>
    `This workspace requires signing in through its single sign-on, and ${signInSubject(credential)} did not. ${ssoFix(credential)}`,
  ssoOff: "Single sign-on is not available on this Portifact, so it cannot be required.",
  ssoNotUsable:
    "Set up the workspace's single sign-on first, serving a verified email domain, on a plan that includes it.",
  ssoLocksOut:
    "Sign in with the workspace's single sign-on first, from this browser, so you know it works before you require it.",
  ssoOutside: (count: number) =>
    `${count} ${count === 1 ? "member's address is" : "members' addresses are"} not at a domain the single sign-on provider serves, so they could no longer act on the workspace. Confirm to require it anyway.`,
  ssoOutsideGrew:
    "More members than you confirmed cannot sign in through the single sign-on provider now. Review the change again before saving.",
  sessionLocksOutUnknown:
    "Portifact could not tell when you signed in, so a maximum session age could lock you out. Sign in again first.",
  singleFamily: (lists: string) =>
    `${lists} only IPv4 or only IPv6 ranges. People on networks that use both reach Portifact over either, and requests over the other one would be refused. Add the other family's ranges, or confirm that the list covers only one.`,
  maxLifeReached: (days: number) =>
    `This artifact reached the workspace's maximum life of ${days} days since its last publish, so it cannot be renewed. Publish a new version to keep it online.`,
  pinUnderMaxLife: (days: number) =>
    `The workspace's policy archives artifacts ${days} days after their last publish, so they cannot be pinned. Publish a new version to keep it online longer.`,
} as const;

function hoursText(hours: number): string {
  return hours % 24 === 0 && hours >= 24
    ? `${hours / 24} ${hours === 24 ? "day" : "days"}`
    : `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

function signInSubject(credential: Credential | null | undefined): string {
  return credential?.kind === "oauth" && credential.client === "oauth_apps"
    ? "this app's connection to Portifact"
    : "your sign-in";
}

/** What fixes a sign-in that did not go through the workspace's single sign-on, per client. */
function ssoFix(credential: Credential | null | undefined): string {
  if (credential?.kind === "oauth") {
    return credential.client === "cli"
      ? "Sign in to the Portifact dashboard with single sign-on, then run `portifact login` and approve it from that browser."
      : "Ask the user to sign in to Portifact with the workspace's single sign-on, then reconnect this app.";
  }
  return "Sign in with single sign-on to continue.";
}

/** What fixes a sign-in that is too old, in the words of the client that made the request. */
function signInFix(credential: Credential | null | undefined): string {
  if (credential?.kind === "oauth") {
    return credential.client === "cli"
      ? "Run `portifact login` to sign in again."
      : "Ask the user to reconnect this app to Portifact, which signs them in again.";
  }
  return "Sign in again to continue.";
}

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
  const networks = {
    ipAllowlist: people.value,
    tokenIpAllowlist: tokens.value,
    // One spelling per set of kinds: no duplicates, in `CLIENT_KINDS` order.
    allowedClients:
      input.allowedClients === null
        ? null
        : CLIENT_KINDS.filter((kind) => input.allowedClients?.includes(kind)),
  };
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
  if (current.sessionMaxHours !== next.sessionMaxHours) fields.push("sessionMaxHours");
  if (!sameDomains(current.allowedClients, next.allowedClients)) fields.push("allowedClients");
  if (current.ssoRequired !== next.ssoRequired) fields.push("ssoRequired");
  // Its effective date is derived from the change (`retentionTiming`), never a field of its own.
  if (current.artifactMaxDays !== next.artifactMaxDays) fields.push("artifactMaxDays");
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
    // A longer (or no) maximum session age; every kind of client allowed before still is.
    case "sessionMaxHours":
      return (
        next.sessionMaxHours === null ||
        (current.sessionMaxHours !== null && next.sessionMaxHours > current.sessionMaxHours)
      );
    case "allowedClients":
      return (
        next.allowedClients === null ||
        current.allowedClients?.every((kind) => next.allowedClients?.includes(kind)) === true
      );
    case "ssoRequired":
      return !next.ssoRequired;
    // A longer (or no) maximum life.
    case "artifactMaxDays":
      return (
        next.artifactMaxDays === null ||
        (current.artifactMaxDays !== null && next.artifactMaxDays > current.artifactMaxDays)
      );
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
    policy.shareLinkMaxDays !== null ||
    policy.artifactMaxDays !== null
  );
}

/** The total of an impact: zero when saving changes no existing artifact, reader or link. */
export function impactTotal(impact: PolicyImpact): number {
  return (
    impact.publicArtifacts +
    impact.readersOutside +
    impact.linksRevoked +
    impact.linksWithoutPassword +
    impact.linksOverLifetime +
    impact.artifactsAtStart +
    impact.artifactsSoon +
    impact.pinsLifted
  );
}

const IMPACT_KEYS = [
  "publicArtifacts",
  "readersOutside",
  "linksRevoked",
  "linksWithoutPassword",
  "linksOverLifetime",
  "artifactsAtStart",
  "artifactsSoon",
  "pinsLifted",
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
    [
      impact.artifactsAtStart,
      "active artifact",
      "active artifacts",
      "would be archived when the maximum life takes effect",
    ],
    [
      impact.artifactsSoon,
      "active artifact",
      "active artifacts",
      "would be archived within 30 days after that",
    ],
    [impact.pinsLifted, "pinned artifact", "pinned artifacts", "would be unpinned"],
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
    ...(fields.includes("sessionMaxHours") ? { sessionMaxHours: next.sessionMaxHours } : {}),
    ...(fields.includes("allowedClients") ? { allowedClients: next.allowedClients } : {}),
    ...(fields.includes("ssoRequired") ? { ssoRequired: next.ssoRequired } : {}),
    ...(fields.includes("artifactMaxDays")
      ? { artifactMaxDays: next.artifactMaxDays, artifactMaxDaysFrom: next.artifactMaxDaysFrom }
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
  if (policy.sessionMaxHours !== null) {
    lines.push(`people sign in again every ${hoursText(policy.sessionMaxHours)}`);
  }
  if (policy.allowedClients !== null) {
    const allowed = ["the dashboard", ...policy.allowedClients.map((kind) => CLIENT_NAMES[kind])];
    lines.push(`people act only through ${allowed.join(" and ")}`);
  }
  if (policy.ssoRequired) lines.push("people sign in through the workspace's single sign-on");
  if (policy.artifactMaxDays !== null) {
    const from =
      policy.artifactMaxDaysFrom === null
        ? ""
        : ` (from ${new Date(policy.artifactMaxDaysFrom).toISOString().slice(0, 10)})`;
    lines.push(
      `artifacts are archived ${policy.artifactMaxDays} days after their last publish or restore, and cannot be pinned${from}`,
    );
  }
  return lines;
}

const CLIENT_NAMES: Record<ClientKind, string> = {
  cli: "the Portifact CLI",
  oauth_apps: "apps connected through OAuth",
};

/**
 * Who a request policy binds: a person (any role, admins included) or a workspace's service
 * token. The two have separate allowlists (decision 0020): CI runners rarely share an office's
 * networks.
 */
export type RequestCaller = "person" | "token";

/** Who is asking and when, for the sign-in policies (decision 0021). */
export interface RequestSubject {
  /** The user (or service token) the role was decided for. */
  userId: string;
  now: number;
  /**
   * The workspace's single sign-on provider while it can sign people in (it exists, serves a
   * verified domain and the plan includes `sso`), by its row ID; null otherwise. "SSO required"
   * binds only while it is set: a provider nobody can sign in through never locks anyone out.
   * Read with the membership, only for a policy that requires it (`actorOn`).
   */
  ssoProvider?: string | null;
}

/**
 * Whether the Worker answering a request offers single sign-on (`SSO_ENABLED`, decision 0021):
 * it decides only whether the sign-in endpoints exist and whether setting the requirement is
 * offered, never whether a stored requirement binds.
 */
export function ssoOffered(request: RequestContext): boolean {
  return request.kind === "request" && request.sso === true;
}

/**
 * Whether "SSO required" binds now (decision 0021): set on the policy and the workspace's provider
 * able to sign people in (it exists, serves a verified domain and the plan includes `sso`), all
 * read from data that is the same on every Worker. Never from a Worker's configuration: a Worker
 * without `SSO_ENABLED` enforces it exactly like one with it (fail closed), so a security rule
 * never depends on two Workers' settings agreeing. A provider that cannot sign anyone in
 * suspends it (the stored setting stays); removing the provider clears it.
 */
export function ssoRequirementBinds(
  policy: WorkspacePolicy | undefined,
  request: RequestContext,
  ssoProvider: string | null | undefined,
): ssoProvider is string {
  return (
    policy?.ssoRequired === true && request.kind === "request" && typeof ssoProvider === "string"
  );
}

/**
 * Whether a request may act on a workspace under its request policies (decisions 0020 and 0021),
 * from the request context the Worker built: work no client is making (`background`) is never
 * bound; otherwise the caller's allowlist, if any, must admit the request's address, and a
 * person's credential must come from an allowed kind of client and a sign-in younger than the
 * maximum age. Refused with `policy_refused` and a message naming the policy and its fix, never
 * the allowed networks.
 */
export function checkRequestPolicy(
  policy: WorkspacePolicy | undefined,
  request: RequestContext,
  caller: RequestCaller,
  subject: RequestSubject,
): Result<true> {
  const verdict = requestVerdict(policy, request, caller);
  // A stored list that does not parse refuses everyone it binds (fail closed), never throws.
  if (verdict === "unreadable") return refused(POLICY_MESSAGES.networkUnreadable);
  if (verdict !== "allowed") {
    const ip = request.kind === "request" ? request.ip : null;
    return refused(
      caller === "person" ? POLICY_MESSAGES.networkPerson(ip) : POLICY_MESSAGES.networkToken(ip),
    );
  }
  const signIn = signInVerdict(policy, request, caller, subject);
  if (signIn === "allowed") return ok(true);
  const credential = request.kind === "request" ? request.credential : undefined;
  const hours = policy?.sessionMaxHours ?? 0;
  const because = (reason: RequestRefusal, message: string): Result<never> => ({
    ok: false,
    code: "policy_refused",
    message,
    reason,
  });
  switch (signIn) {
    case "client":
      return because(
        "client",
        credential?.kind === "oauth"
          ? POLICY_MESSAGES.client(credential.client)
          : POLICY_MESSAGES.clientUnknown,
      );
    case "client_unknown":
      return because("client", POLICY_MESSAGES.clientUnknown);
    case "session_age":
      return because("session_age", POLICY_MESSAGES.sessionAge(hours, credential));
    case "session_unknown":
      return because("session_age", POLICY_MESSAGES.sessionUnknown(credential));
    case "sso":
      return because("sso", POLICY_MESSAGES.ssoRequired(credential));
  }
}

/** What the sign-in policies say about a request (decision 0021). */
export type SignInVerdict =
  | "allowed"
  | "client"
  | "client_unknown"
  | "session_age"
  | "session_unknown"
  | "sso";

/**
 * What the sign-in policies (decision 0021) say about a person's request. Only facts the server
 * recorded count (`RequestContext.credential`): a credential that is missing, unknown or belongs
 * to someone else than the caller fails closed for a policy that needs it. The dashboard's
 * session is always an allowed client. Service tokens have no sign-in and are not bound, and
 * background work never is.
 */
export function signInVerdict(
  policy: WorkspacePolicy | undefined,
  request: RequestContext,
  caller: RequestCaller,
  subject: RequestSubject,
): SignInVerdict {
  if (!policy || request.kind === "background" || caller === "token") return "allowed";
  const { sessionMaxHours, allowedClients } = policy;
  const sso = ssoRequirementBinds(policy, request, subject.ssoProvider);
  if (sessionMaxHours === null && allowedClients === null && !sso) return "allowed";
  const credential = request.credential;
  const known =
    credential && credential.userId === subject.userId && credential.kind !== "service_token"
      ? credential
      : null;
  if (allowedClients !== null) {
    if (!known) return "client_unknown";
    if (known.kind === "oauth" && !allowedClients.includes(known.client)) return "client";
  }
  // "SSO required": the sign-in this credential descends from went through this workspace's
  // provider, matched by its ID; another workspace's provider, a social login with the same
  // address or a method not known is not it. Checked before the age: signing in through the
  // provider fixes both.
  if (sso) {
    const method = known?.method ?? null;
    if (method?.kind !== "sso" || method.providerId !== subject.ssoProvider) return "sso";
  }
  if (sessionMaxHours !== null) {
    const signedInAt = known?.signedInAt ?? null;
    if (signedInAt === null) return "session_unknown";
    if (subject.now - signedInAt > sessionMaxHours * HOUR_MS) return "session_age";
  }
  return "allowed";
}

/**
 * Which request policy refuses a request, for the workspace list and the dashboard's blocked page
 * (`WorkspaceView.blockedBy`): null when none does. An unknown sign-in time is fixed like an old
 * one, by signing in again.
 */
export function requestRefusal(
  policy: WorkspacePolicy | undefined,
  request: RequestContext,
  caller: RequestCaller,
  subject: RequestSubject,
): RequestRefusal | null {
  if (requestVerdict(policy, request, caller) !== "allowed") return "network";
  switch (signInVerdict(policy, request, caller, subject)) {
    case "allowed":
      return null;
    case "client":
    case "client_unknown":
      return "client";
    case "session_age":
    case "session_unknown":
      return "session_age";
    case "sso":
      return "sso";
  }
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
  subject: RequestSubject,
): Result<true> {
  if (request.kind === "background") return ok(true);
  if (next.ipAllowlist !== null && networkVerdict(next.ipAllowlist, request.ip) !== "allowed") {
    return fail("invalid_input", POLICY_MESSAGES.networkLocksOut(request.ip));
  }
  // The sign-in policies (decision 0021): the admin's own sign-in must still be young enough.
  // Saving goes through the dashboard's session, which every client policy allows.
  const verdict = signInVerdict(next, request, "person", subject);
  if (verdict === "session_age" && next.sessionMaxHours !== null) {
    return fail("invalid_input", POLICY_MESSAGES.sessionLocksOut(next.sessionMaxHours));
  }
  if (verdict === "session_unknown") {
    return fail("invalid_input", POLICY_MESSAGES.sessionLocksOutUnknown);
  }
  if (verdict === "client" || verdict === "client_unknown") {
    return fail("invalid_input", POLICY_MESSAGES.clientUnknown);
  }
  if (verdict === "sso") return fail("invalid_input", POLICY_MESSAGES.ssoLocksOut);
  return ok(true);
}

/**
 * Whether "SSO required" may be set (decision 0021): never a setting nobody can satisfy. Single
 * sign-on must be offered (`SSO_ENABLED`) and the workspace's provider able to sign people in;
 * the saving admin's own session must have signed in through it (checked by
 * `checkPolicyKeepsCaller` with the provider, an admin proves it works before requiring it). Only
 * a save that sets it newly or keeps it set is checked; clearing it never is.
 */
export function checkSsoRequirement(
  next: WorkspacePolicy,
  request: RequestContext,
  ssoProvider: string | null,
): Result<true> {
  if (!next.ssoRequired || request.kind === "background") return ok(true);
  if (request.sso !== true) return fail("invalid_input", POLICY_MESSAGES.ssoOff);
  if (ssoProvider === null) return fail("invalid_input", POLICY_MESSAGES.ssoNotUsable);
  return ok(true);
}

/**
 * Members the provider cannot serve are never cut off silently: newly requiring single sign-on
 * needs the admin to confirm the count the preview showed, and a count that grew since is refused
 * again, as the other policies' impact is.
 */
export function checkSsoOutside(
  newly: boolean,
  outside: number,
  confirmed: number | undefined,
): Result<true> {
  if (!newly || outside === 0) return ok(true);
  if (confirmed === undefined) return refused(POLICY_MESSAGES.ssoOutside(outside));
  return outside > confirmed ? refused(POLICY_MESSAGES.ssoOutsideGrew) : ok(true);
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
 * else learns only that one exists (`hidden`). A stored "SSO required" is always shown: it binds
 * whatever a Worker's configuration (decision 0021).
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
      // A longer or no maximum life is never held back (decision 0023): there, re-applying the
      // older, tighter value is what would archive data, so `apply-policies` always applies it.
      case "artifactMaxDays":
        return false;
      default:
        return loosens(field, current, next);
    }
  });
}

/**
 * A policy with its request policies lifted (the network allowlists, the maximum session age,
 * the allowed clients and "SSO required"): the operator's escape hatch.
 */
export function withoutRequestPolicies(policy: WorkspacePolicy): WorkspacePolicy {
  return {
    ...policy,
    ipAllowlist: null,
    tokenIpAllowlist: null,
    sessionMaxHours: null,
    allowedClients: null,
    ssoRequired: false,
  };
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

/** A workspace's maximum life of artifacts (decision 0023): days and when it takes effect. */
export interface MaxLife {
  days: number;
  /** No deadline is earlier than this (milliseconds). */
  from: number;
}

/** The maximum life a policy sets, or null (no policy, or none set). */
export function maxLifeOf(policy: WorkspacePolicy | undefined): MaxLife | null {
  if (!policy || policy.artifactMaxDays === null) return null;
  return { days: policy.artifactMaxDays, from: policy.artifactMaxDaysFrom ?? 0 };
}

/**
 * When an artifact whose life started at `lifeStart` (its last publish, a rollback included, or
 * restore) reaches the maximum: `days` after it, and never before the maximum takes effect. Its
 * SQL twin is `maxLifeDeadlineSql` in packages/services, which must compute exactly this.
 */
export function maxLifeDeadline(life: MaxLife, lifeStart: number): number {
  return Math.max(life.from, lifeStart + life.days * DAY_MS);
}

/**
 * The expiry an artifact gets under its owner's policy: the plan's expiry (`planExpiry`, from a
 * publish, renewal, restore or unpin), capped by the maximum life. Never later than `planExpiry`,
 * so a policy only ever brings an expiry forward; and for an artifact whose life starts now never
 * earlier than `now` plus the shortest maximum (7 days).
 */
export function policyExpiry(
  policy: WorkspacePolicy | undefined,
  planExpiry: number,
  lifeStart: number,
): number {
  const life = maxLifeOf(policy);
  return life === null ? planExpiry : Math.min(planExpiry, maxLifeDeadline(life, lifeStart));
}

/**
 * The policy as it is stored after a save (decision 0023): the server, never the client, decides
 * when a maximum life takes effect. A new or shorter maximum takes effect after the notice period
 * (`retentionNoticeDays` from now); a longer one keeps the date the current one has, so lengthening
 * during the notice period never makes it bind sooner; none clears the date.
 */
export function retentionTiming(
  current: WorkspacePolicy,
  next: WorkspacePolicy,
  now: number,
): WorkspacePolicy {
  if (next.artifactMaxDays === null) return { ...next, artifactMaxDaysFrom: null };
  const tightened =
    current.artifactMaxDays === null || next.artifactMaxDays < current.artifactMaxDays;
  const from = tightened
    ? now + WORKSPACE_POLICIES.retentionNoticeDays * DAY_MS
    : (current.artifactMaxDaysFrom ?? now + WORKSPACE_POLICIES.retentionNoticeDays * DAY_MS);
  return { ...next, artifactMaxDaysFrom: from };
}

/** Whether a change sets a maximum life or shortens it: what needs the notice and the email. */
export function maxLifeTightened(current: WorkspacePolicy, next: WorkspacePolicy): boolean {
  return (
    next.artifactMaxDays !== null &&
    (current.artifactMaxDays === null || next.artifactMaxDays < current.artifactMaxDays)
  );
}

/**
 * The maximum life a change lengthens or removes, or null: the job gives the artifacts it capped
 * their time back (decision 0023, "Loosening").
 */
export function replacedMaxLife(current: WorkspacePolicy, next: WorkspacePolicy): MaxLife | null {
  const was = maxLifeOf(current);
  if (was === null) return null;
  if (next.artifactMaxDays !== null && next.artifactMaxDays <= was.days) return null;
  return was;
}

/**
 * Pinning means "never expires", which a maximum life rules out (decision 0023): while a policy
 * sets one, pinning is refused, and the policy's job unpins what was pinned before.
 */
export function checkPolicyPin(policy: WorkspacePolicy | undefined): Result<true> {
  if (policy?.artifactMaxDays != null) {
    return refused(POLICY_MESSAGES.pinUnderMaxLife(policy.artifactMaxDays));
  }
  return ok(true);
}
