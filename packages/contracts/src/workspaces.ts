// Owners, regions, workspaces and roles (premium plan section 3, "F3 El dueño como workspace";
// decisions 0004 and 0005). An owner is a user's personal space (the owner ID is the user ID) or
// a workspace. A user acts on an owner with a role, which only the services resolve, from the
// membership; adapters never decide one.
import { z } from "zod";

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
  // Admins only.
  "members",
  "plan",
  "policies",
  "delete_workspace",
  "brand",
] as const;
export const RoleAction = z.enum(ROLE_ACTIONS);
export type RoleAction = z.infer<typeof RoleAction>;
