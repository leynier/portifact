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
});
export type WorkspacePolicy = z.infer<typeof WorkspacePolicy>;

export const DEFAULT_POLICY: WorkspacePolicy = {
  publicAccess: "allowed",
  defaultAccess: "restricted",
  readerDomains: null,
  shareLinks: "allowed",
  shareLinkMaxDays: null,
};

/** The fields of a policy, for the audit log and the dashboard. */
export const POLICY_FIELDS = [
  "publicAccess",
  "defaultAccess",
  "readerDomains",
  "shareLinks",
  "shareLinkMaxDays",
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

/** The policies page's view (`GET /api/v1/workspaces/:slug/policies`). */
export const WorkspacePolicyView = z.object({
  policy: WorkspacePolicy,
  /** Moves with every change; a save names the revision it was made from. */
  revision: z.int().min(0),
  /** Whether the workspace's plan includes `policies`: without it, only loosening is possible. */
  enabled: z.boolean(),
  /** Whether the caller may change them (an admin). */
  editable: z.boolean(),
  /** Whether the workspace has a verified email domain, which the `domain` default needs. */
  domainVerified: z.boolean(),
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
