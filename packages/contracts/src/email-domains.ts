// Verified email domains of a workspace (premium plan T2, decision 0010): the domains whose
// verified addresses may read the workspace's artifacts in the `domain` access mode. Managed by
// admins through the dashboard session only.
import { z } from "zod";

export const WORKSPACE_DOMAINS = {
  /** Domains per workspace, pending or verified: a safety cap, not a plan value. */
  perWorkspace: 10,
  /** How long a claim waits for its TXT record before it is dropped. */
  claimTtlDays: 7,
  /** Hours between two re-checks of a verified domain. */
  recheckHours: 24,
  /** Missed re-checks in a row that remove a verified domain. */
  maxFailedChecks: 3,
  /** Verified domains one maintenance run re-checks. */
  recheckBatch: 50,
  /** The TXT record's name is this label before the domain. */
  recordLabel: "_portifact-email",
  /** The TXT record's value is this prefix and the claim's token. */
  recordPrefix: "portifact-email-verify=",
} as const;

/** A domain ID: `wd_` and 32 hex characters. */
export const WorkspaceDomainId = z.string().regex(/^wd_[0-9a-f]{32}$/, "Invalid domain id");
export type WorkspaceDomainId = z.infer<typeof WorkspaceDomainId>;

/** What an admin types; the services normalize and check it. */
export const WorkspaceDomainCreate = z.strictObject({
  domain: z.string().trim().min(1).max(300),
});
export type WorkspaceDomainCreate = z.infer<typeof WorkspaceDomainCreate>;

/** Why a verified domain's last re-check failed. */
export const WorkspaceDomainProblem = z.enum(["txt_missing"]);
export type WorkspaceDomainProblem = z.infer<typeof WorkspaceDomainProblem>;

export const WorkspaceDomainView = z.object({
  id: WorkspaceDomainId,
  /** The A-label (`xn--…` for an internationalized domain), as addresses are matched. */
  domain: z.string(),
  /** The Unicode form when it differs from `domain`, for display; null otherwise. */
  unicode: z.string().nullable(),
  state: z.enum(["pending", "verified"]),
  /** The TXT record to publish: its name and its exact value. */
  record: z.object({ name: z.string(), value: z.string() }),
  createdAt: z.iso.datetime(),
  verifiedAt: z.iso.datetime().nullable(),
  checkedAt: z.iso.datetime().nullable(),
  /** When a pending claim is dropped; null once verified. */
  expiresAt: z.iso.datetime().nullable(),
  /** Missed re-checks in a row; the domain is removed when it reaches `maxFailedChecks`. */
  failedChecks: z.number().int().min(0),
  problem: WorkspaceDomainProblem.nullable(),
});
export type WorkspaceDomainView = z.infer<typeof WorkspaceDomainView>;

export const WorkspaceDomainList = z.object({
  items: z.array(WorkspaceDomainView),
  /** Whether the workspace's plan includes verifying domains (`workspaces`). */
  available: z.boolean(),
  limit: z.number().int().positive(),
});
export type WorkspaceDomainList = z.infer<typeof WorkspaceDomainList>;

/**
 * Who a `workspace` or `domain` artifact reaches right now, for the people who manage its access.
 * Null on a personal artifact.
 */
export const AccessAudience = z.object({
  /** Members of the owning workspace, every role. */
  members: z.number().int().min(0),
  /** The workspace's verified email domains (A-labels). */
  domains: z.array(z.string()),
  /**
   * Whether the owner's plan includes `workspaces`. Without it, `domain` artifacts are read by
   * members only, and neither mode can be chosen.
   */
  featureAvailable: z.boolean(),
});
export type AccessAudience = z.infer<typeof AccessAudience>;
