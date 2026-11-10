// Owners, regions, workspaces and roles (premium plan section 3, "F3 El dueño como workspace";
// decisions 0004 and 0005). An owner is a user's personal space (the owner ID is the user ID) or
// a workspace. A user acts on an owner with a role, which only the services resolve, from the
// membership; adapters never decide one.
import { z } from "zod";
import { Email } from "./core.ts";

/**
 * Where an owner's data is stored (decision 0005). Only the default region exists for now; the
 * EU region arrives with E5. A personal space is always in the default region, and a
 * workspace's region is fixed when it is created.
 */
export const REGIONS = ["default"] as const;
export const Region = z.enum(REGIONS);
export type Region = z.infer<typeof Region>;
export const DEFAULT_REGION: Region = "default";

/**
 * Workspace IDs: `ws_` and 32 lowercase hex characters. User IDs from Better Auth are
 * alphanumeric and artifact IDs are 10 base32 characters, neither ever has an underscore, so an
 * `owner_id` tells a workspace from a user by its prefix alone.
 */
export const WORKSPACE_ID_PREFIX = "ws_";
export const WorkspaceId = z.string().regex(/^ws_[0-9a-f]{32}$/, "Invalid workspace id");
export type WorkspaceId = z.infer<typeof WorkspaceId>;

/** Whether an owner ID names a workspace rather than a user's personal space. */
export function isWorkspaceId(ownerId: string): boolean {
  return ownerId.startsWith(WORKSPACE_ID_PREFIX);
}

/** Workspace slugs: lowercase letters, digits and inner hyphens, unique across workspaces. */
export const WorkspaceSlug = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, "Invalid workspace slug");
export type WorkspaceSlug = z.infer<typeof WorkspaceSlug>;

/**
 * Roles on an owner. `admin`: everything, including members, the plan, policies and deleting
 * the workspace. `editor`: publishes and manages artifacts. `member`: reads and comments on what
 * is shared with the workspace and manages nothing. In a personal space the user is the admin.
 * External readers listed by email are not members and have no role.
 */
export const WORKSPACE_ROLES = ["admin", "editor", "member"] as const;
export const WorkspaceRole = z.enum(WORKSPACE_ROLES);
export type WorkspaceRole = z.infer<typeof WorkspaceRole>;

/**
 * What a role can be asked about. `manage` is acting as the owner on the owner's artifacts: it
 * reads every one of them whatever its access mode, sees every comment and is told it is the
 * owner by the viewer. The rest name one kind of operation each.
 */
export const ROLE_ACTIONS = [
  // Every role.
  "read",
  "comment",
  // Editors and admins.
  "manage",
  "transfer",
  "list",
  "publish",
  "update",
  "access",
  "lifecycle",
  "versions",
  "rollback",
  "moderate",
  "access_log",
  "usage",
  /** Custom domains (decision 0006): like `access`, but never a service token's (decision 0011). */
  "domains",
  // Admins only.
  /** Moving an artifact out of the owner: a workspace's content leaves only with an admin. */
  "transfer_out",
  "members",
  "plan",
  "policies",
  "delete_workspace",
  "webhooks",
  "brand",
  /** Reading the audit log (premium plan T10): what every member did. */
  "audit",
  /** Service tokens of the workspace (decision 0011): creating, listing and revoking them. */
  "tokens",
] as const;
export const RoleAction = z.enum(ROLE_ACTIONS);
export type RoleAction = z.infer<typeof RoleAction>;

/**
 * Where an artifact lives, as every artifact view shows it: the personal space of the user who
 * sees it, or a workspace by slug and name.
 */
export const OwnerView = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("personal") }),
  z.object({ kind: z.literal("workspace"), slug: WorkspaceSlug, name: z.string() }),
]);
export type OwnerView = z.infer<typeof OwnerView>;

/** Workspace names: what members see in lists, one line. */
export const WorkspaceName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "No control characters");

/** A workspace the caller belongs to, with their role (`GET /api/v1/workspaces`, `list_workspaces`). */
export const WorkspaceView = z.object({
  slug: WorkspaceSlug,
  name: z.string(),
  role: WorkspaceRole,
  region: Region,
  createdAt: z.iso.datetime(),
});
export type WorkspaceView = z.infer<typeof WorkspaceView>;

export const WorkspaceList = z.object({ items: z.array(WorkspaceView) });
export type WorkspaceList = z.infer<typeof WorkspaceList>;

/** Seats in use: members plus pending invitations that have not expired, and the plan's cap. */
export const SeatsView = z.object({
  used: z.int().min(0),
  limit: z.int().min(1),
});
export type SeatsView = z.infer<typeof SeatsView>;

export const WorkspaceMemberView = z.object({
  userId: z.string().min(1),
  name: z.string(),
  email: z.string(),
  role: WorkspaceRole,
  joinedAt: z.iso.datetime(),
  /** The member is the caller. */
  you: z.boolean(),
});
export type WorkspaceMemberView = z.infer<typeof WorkspaceMemberView>;

export const WorkspaceMemberList = z.object({
  workspace: WorkspaceView,
  items: z.array(WorkspaceMemberView),
  seats: SeatsView,
});
export type WorkspaceMemberList = z.infer<typeof WorkspaceMemberList>;

export const MemberRoleUpdate = z.strictObject({ role: WorkspaceRole });
export type MemberRoleUpdate = z.infer<typeof MemberRoleUpdate>;

/** Invitations (premium plan T1): sent by email, valid for a week, one per address and workspace. */
export const INVITATION_LIMITS = {
  ttlDays: 7,
  /** Invitations one workspace sends in a day. */
  perWorkspacePerDay: { max: 50, windowSeconds: 86_400 },
  /** Invitations one admin sends in an hour, across workspaces. */
  perAdminPerHour: { max: 20, windowSeconds: 3_600 },
  /** Invitations one address receives in a day, across workspaces (keyed by a hash of it). */
  perRecipientPerDay: { max: 5, windowSeconds: 86_400 },
} as const;

export const InvitationCreate = z.strictObject({ email: Email, role: WorkspaceRole });
export type InvitationCreate = z.infer<typeof InvitationCreate>;

/** IDs of invitations: `inv_` and 32 hex characters. */
export const InvitationId = z.string().regex(/^inv_[0-9a-f]{32}$/, "Invalid invitation id");

/** The token in an invitation's link: 43 base64url characters (32 random bytes). */
export const InvitationToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "Invalid invitation token");

/** A pending invitation as the workspace's admins see it. */
export const InvitationView = z.object({
  id: InvitationId,
  email: z.string(),
  role: WorkspaceRole,
  /** The admin who sent it; null once their account is gone. */
  invitedBy: z.string().nullable(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type InvitationView = z.infer<typeof InvitationView>;

export const InvitationList = z.object({ items: z.array(InvitationView), seats: SeatsView });
export type InvitationList = z.infer<typeof InvitationList>;

/** An invitation as the invited person sees it. */
export const IncomingInvitationView = z.object({
  id: InvitationId,
  workspace: z.object({ slug: WorkspaceSlug, name: z.string() }),
  role: WorkspaceRole,
  invitedBy: z.string().nullable(),
  expiresAt: z.iso.datetime(),
});
export type IncomingInvitationView = z.infer<typeof IncomingInvitationView>;

export const IncomingInvitationList = z.object({ items: z.array(IncomingInvitationView) });
export type IncomingInvitationList = z.infer<typeof IncomingInvitationList>;

/**
 * What the invitation page shows for a link's token (`POST /api/v1/invitations/lookup`): the
 * invitation for its verified address, or only the address it was sent to for any other account,
 * so the person can switch accounts. A missing, expired, revoked or used one is `not_found`.
 */
export const InvitationLookup = z.discriminatedUnion("status", [
  z.object({ status: z.literal("invited"), invitation: IncomingInvitationView }),
  z.object({ status: z.literal("other_account"), email: z.string() }),
]);
export type InvitationLookup = z.infer<typeof InvitationLookup>;

/** Accepting or declining from the email's link. */
export const InvitationTokenInput = z.strictObject({ token: InvitationToken });
export type InvitationTokenInput = z.infer<typeof InvitationTokenInput>;

/**
 * Moving an artifact to another space: a workspace by slug, or `null` for the caller's personal
 * space (`POST /api/v1/artifacts/:id/transfer`, `transfer_artifact`, `portifact transfer`).
 */
export const TransferRequest = z.strictObject({ workspace: WorkspaceSlug.nullable() });
export type TransferRequest = z.infer<typeof TransferRequest>;

/** The `workspace` query parameter of owner-scoped routes; absent for the personal space. */
export const WorkspaceParam = WorkspaceSlug.optional();
