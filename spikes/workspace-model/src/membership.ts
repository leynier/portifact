// How packages/services would resolve the acting user's role on an owner (plan-premium F3,
// `Actor { userId, ownerId, role }`), reading the organization plugin's `members` table with
// Drizzle. The adapter passes the owner it wants to act on; the role always comes from here.
import type { Db } from "@portifact/db";
import { and, eq } from "drizzle-orm";
import { WORKSPACE_ID_PREFIX } from "./config.ts";
import type { WorkspaceRole } from "./roles.ts";
import { members } from "./schema.ts";

export type Action =
  | "read"
  | "comment"
  | "publish"
  | "share"
  | "lifecycle"
  | "moderate"
  | "manage_members"
  | "delete_workspace";

export interface Actor {
  userId: string;
  ownerId: string;
  role: WorkspaceRole;
}

const ALLOWED: Record<WorkspaceRole, ReadonlySet<Action>> = {
  admin: new Set<Action>([
    "read",
    "comment",
    "publish",
    "share",
    "lifecycle",
    "moderate",
    "manage_members",
    "delete_workspace",
  ]),
  editor: new Set<Action>(["read", "comment", "publish", "share", "lifecycle", "moderate"]),
  member: new Set<Action>(["read", "comment"]),
};

/** Pure: whether the actor may do the action. Lives in packages/domain in the real design. */
export function can(actor: Actor, action: Action): boolean {
  return ALLOWED[actor.role].has(action);
}

export function isWorkspaceId(ownerId: string): boolean {
  return ownerId.startsWith(WORKSPACE_ID_PREFIX);
}

function isRole(value: string): value is WorkspaceRole {
  return value === "admin" || value === "editor" || value === "member";
}

/**
 * The actor for `userId` acting on `ownerId`, or null when the user has no role there. A
 * personal space is its user's, with every right. One indexed read for a workspace.
 */
export async function resolveActor(db: Db, userId: string, ownerId: string): Promise<Actor | null> {
  if (!isWorkspaceId(ownerId))
    return ownerId === userId ? { userId, ownerId, role: "admin" } : null;
  const [row] = await db
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.organizationId, ownerId), eq(members.userId, userId)))
    .limit(1);
  // The plugin stores roles as a comma-separated list; Portifact gives one role per member and
  // refuses anything else rather than guessing.
  return row && isRole(row.role) ? { userId, ownerId, role: row.role } : null;
}
