// Workspace policies (premium plan E4, feature `policies`, decision 0015): rules a workspace's
// admins set for every artifact of the workspace and everyone acting on them, admins and service
// tokens included. They are decided only in packages/domain and applied in the services; this
// module holds their shape, their defaults and the bounds.
import { z } from "zod";

export const WORKSPACE_POLICIES = {
  /** Email domains one reader allowlist names at most. */
  readerDomains: 20,
  /** The longest maximum lifetime of a share link a policy may set, in days. */
  shareLinkMaxDays: 365,
  /**
   * Rows one step of the enforcement job changes per kind (artifacts narrowed, readers removed,
   * links revoked, link sessions ended); a larger workspace continues in the next delivery.
   */
  enforceBatch: 50,
  /**
   * Workspaces with a policy the maintenance scan checks per run in one query (their flags travel
   * as one JSON parameter); with more, the next run continues from a cursor.
   */
  scanWorkspaces: 500,
  /** Workspaces with a violation the scan corrects per run, one step each, worst first. */
  scanSteps: 20,
  /** IPv4 and IPv6 ranges one network allowlist names at most (decision 0020). */
  ipRanges: 50,
} as const;

export const PUBLIC_ACCESS_POLICIES = ["allowed", "forbidden"] as const;
export const PublicAccessPolicy = z.enum(PUBLIC_ACCESS_POLICIES);
export type PublicAccessPolicy = z.infer<typeof PublicAccessPolicy>;

/** The access modes a new artifact of the workspace may start with: never `public`. */
export const DEFAULT_ACCESS_POLICIES = ["restricted", "workspace", "domain"] as const;
export const DefaultAccessPolicy = z.enum(DEFAULT_ACCESS_POLICIES);
export type DefaultAccessPolicy = z.infer<typeof DefaultAccessPolicy>;

export const SHARE_LINK_POLICIES = ["allowed", "password_required", "disabled"] as const;
export const ShareLinkPolicy = z.enum(SHARE_LINK_POLICIES);
export type ShareLinkPolicy = z.infer<typeof ShareLinkPolicy>;

/**
 * One domain of the reader allowlist as an admin writes it; the domain rules normalize it
 * (`normalizePolicy`) and refuse anything that is not a plain ASCII domain.
 */
const PolicyDomain = z.string().trim().min(1).max(253);

/**
 * One range of a network allowlist as an admin writes it: an IPv4 or IPv6 address, or a CIDR
 * range. The domain rules parse and normalize it (`normalizeIpRanges`, decision 0020).
 */
const PolicyIpRange = z.string().trim().min(1).max(64);

/** A network allowlist: null binds nobody. */
const IpAllowlist = z.array(PolicyIpRange).min(1).max(WORKSPACE_POLICIES.ipRanges).nullable();

/** A workspace's policies. Every field has a default that changes nothing (`DEFAULT_POLICY`). */
export const WorkspacePolicy = z.strictObject({
  /** `forbidden`: no artifact of the workspace can be public. */
  publicAccess: PublicAccessPolicy,
  /** The access mode a new artifact of the workspace starts with. */
  defaultAccess: DefaultAccessPolicy,
  /** Only addresses at these domains may be added as readers; null allows any address. */
  readerDomains: z.array(PolicyDomain).min(1).max(WORKSPACE_POLICIES.readerDomains).nullable(),
  /** Whether share links can be created, and whether they need a password. */
  shareLinks: ShareLinkPolicy,
  /** The longest a share link may live, from its creation, in days; null for no maximum. */
  shareLinkMaxDays: z.number().int().min(1).max(WORKSPACE_POLICIES.shareLinkMaxDays).nullable(),
  /**
   * The networks people (members, admins included) may act on the workspace from, and read its
   * artifacts as members (decision 0020); null binds nobody. Absent in policies stored before it
   * existed, which read as null.
   */
  ipAllowlist: IpAllowlist.default(null),
  /** The networks the workspace's service tokens may act from; null leaves tokens unbound. */
  tokenIpAllowlist: IpAllowlist.default(null),
});
export type WorkspacePolicy = z.infer<typeof WorkspacePolicy>;

/**
 * A network allowlist as a policy view shows it: the ranges to the workspace's admins, only
 * `hidden` to everyone else (a member learns that one exists, never the networks).
 */
export const IpAllowlistView = z.union([z.array(z.string()), z.literal("hidden")]).nullable();
export type IpAllowlistView = z.infer<typeof IpAllowlistView>;

/** A policy as it is shown: `WorkspacePolicy` with the network allowlists hidden from non-admins. */
export const WorkspacePolicyShown = z.object({
  ...WorkspacePolicy.shape,
  ipAllowlist: IpAllowlistView,
  tokenIpAllowlist: IpAllowlistView,
});
export type WorkspacePolicyShown = z.infer<typeof WorkspacePolicyShown>;

export const DEFAULT_POLICY: WorkspacePolicy = {
  publicAccess: "allowed",
  defaultAccess: "restricted",
  readerDomains: null,
  shareLinks: "allowed",
  shareLinkMaxDays: null,
  ipAllowlist: null,
  tokenIpAllowlist: null,
};

/** The fields of a policy, for the audit log and the dashboard. */
export const POLICY_FIELDS = [
  "publicAccess",
  "defaultAccess",
  "readerDomains",
  "shareLinks",
  "shareLinkMaxDays",
  "ipAllowlist",
  "tokenIpAllowlist",
] as const satisfies readonly (keyof WorkspacePolicy)[];
export type PolicyField = (typeof POLICY_FIELDS)[number];

/**
 * What saving a policy changes on the workspace's existing artifacts, as counts:
 * - `publicArtifacts`: public artifacts that become `workspace`.
 * - `readersOutside`: readers whose address is outside the allowlist, removed.
 * - `linksRevoked`: active share links revoked because links are disabled.
 * - `linksWithoutPassword`: active links without a password, which stop opening.
 * - `linksOverLifetime`: active links older than the maximum lifetime, which stop opening.
 */
export const PolicyImpact = z.object({
  publicArtifacts: z.int().min(0),
  readersOutside: z.int().min(0),
  linksRevoked: z.int().min(0),
  linksWithoutPassword: z.int().min(0),
  linksOverLifetime: z.int().min(0),
});
export type PolicyImpact = z.infer<typeof PolicyImpact>;

/**
 * `POST /api/v1/workspaces/:slug/policies/preview`: the impact on existing artifacts, and who a
 * network allowlist would bind, as counts (decision 0020): `members` when the people allowlist is
 * set, `tokens` (active service tokens) when the token allowlist is; null without either.
 * Portifact keeps nobody's address, so it cannot tell who is outside the networks.
 */
export const IP_FAMILIES = ["ipv4", "ipv6"] as const;
export const IpFamily = z.enum(IP_FAMILIES);

/**
 * The lists a save sets or changes that name only one address family (decision 0020): each is
 * `ipv4` or `ipv6`, or null when the list names both, is lifted or is unchanged. A save needs
 * exactly these confirmed (`confirmedSingleFamily`).
 */
export const SingleFamilyLists = z.strictObject({
  people: IpFamily.nullable(),
  tokens: IpFamily.nullable(),
});
export type SingleFamilyLists = z.infer<typeof SingleFamilyLists>;

export const PolicyPreview = PolicyImpact.extend({
  networks: z
    .object({
      members: z.int().min(0),
      tokens: z.int().min(0),
      /**
       * Active service tokens that keep working from any network: the people list is set and the
       * token list is not.
       */
      unboundTokens: z.int().min(0),
      singleFamily: SingleFamilyLists,
    })
    .nullable(),
});
export type PolicyPreview = z.infer<typeof PolicyPreview>;

/** The policies page's view (`GET /api/v1/workspaces/:slug/policies`). */
export const WorkspacePolicyView = z.object({
  /** The network allowlists are `hidden` unless the caller is an admin. */
  policy: WorkspacePolicyShown,
  /** Moves with every change; a save names the revision it was made from. */
  revision: z.int().min(0),
  /** Whether the workspace's plan includes `policies`: without it, only loosening is possible. */
  enabled: z.boolean(),
  /** Whether the caller may change them (an admin). */
  editable: z.boolean(),
  /** Whether the workspace has a verified email domain, which the `domain` default needs. */
  domainVerified: z.boolean(),
  /**
   * The caller's address as the app sees it (`CF-Connecting-IP`), shown only to admins so they
   * can include their own network before saving an allowlist; null otherwise. Never stored.
   */
  yourIp: z.string().nullable(),
  /** The workspace's active service tokens, for admins only (null otherwise): counts, no names. */
  serviceTokens: z.int().min(0).nullable(),
});
export type WorkspacePolicyView = z.infer<typeof WorkspacePolicyView>;

/** `POST /api/v1/workspaces/:slug/policies/preview`: what saving this policy would change. */
export const WorkspacePolicyPreviewInput = z.strictObject({ policy: WorkspacePolicy });
export type WorkspacePolicyPreviewInput = z.infer<typeof WorkspacePolicyPreviewInput>;

/**
 * `PUT /api/v1/workspaces/:slug/policies`. `confirmed` is the impact the preview showed and the
 * admin accepted; without it a save that would change existing artifacts is refused with
 * `policy_refused`, and so is one whose impact grew past it since (the admin reviews it again).
 */
export const WorkspacePolicyUpdate = z.strictObject({
  policy: WorkspacePolicy,
  revision: z.int().min(0),
  confirmed: PolicyImpact.optional(),
  /** The single-family lists the preview reported and the admin accepted (decision 0020). */
  confirmedSingleFamily: SingleFamilyLists.optional(),
});
export type WorkspacePolicyUpdate = z.infer<typeof WorkspacePolicyUpdate>;

/** Payload of a `workspace_policy` job: the revision that asked for it (for the logs only). */
export const WorkspacePolicyJobPayload = z.strictObject({ revision: z.int().min(0) });

/**
 * One workspace's policies in the file `export-policies` writes before a D1 Time Travel restore
 * and `apply-policies` reads after it (docs/operations.md). Only workspaces with a policy.
 */
export const WorkspacePolicyExport = z.strictObject({
  workspaceId: z.string().regex(/^ws_[0-9a-f]{32}$/),
  policy: WorkspacePolicy,
});
export type WorkspacePolicyExport = z.infer<typeof WorkspacePolicyExport>;
