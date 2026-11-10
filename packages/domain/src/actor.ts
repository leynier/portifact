// Who acts on an owner, and what each role may do (premium plan F3, decision 0004). The role
// comes only from `resolveActor` in packages/services, from the membership (or, in a personal
// space, from the user being its owner); this module only decides what a role allows.
import type { Region, RoleAction, WorkspaceRole } from "@portifact/contracts";
import { fail, ok, type Result } from "./result.ts";

/** A user acting with a role on an owner, in the owner's region. */
export interface Actor {
  userId: string;
  /** The user's own ID for their personal space, or a workspace ID. */
  ownerId: string;
  role: WorkspaceRole;
  region: Region;
}

const MEMBER: readonly RoleAction[] = ["read", "comment"];
const EDITOR: readonly RoleAction[] = [
  ...MEMBER,
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
];
const ADMIN: readonly RoleAction[] = [
  ...EDITOR,
  "transfer_out",
  "members",
  "plan",
  "policies",
  "delete_workspace",
];

const ALLOWED: Record<WorkspaceRole, ReadonlySet<RoleAction>> = {
  admin: new Set(ADMIN),
  editor: new Set(EDITOR),
  member: new Set(MEMBER),
};

/** Whether the role allows the action. */
export function roleAllows(role: WorkspaceRole, action: RoleAction): boolean {
  return ALLOWED[role].has(action);
}

/** Whether the actor may do the action on its owner. */
export function can(actor: Actor, action: RoleAction): boolean {
  return roleAllows(actor.role, action);
}

/**
 * Whether the actor stands for the owner in the rules that used to say "the owner": an admin or
 * editor reads every artifact of the owner, sees every comment and is the owner in the viewer.
 * False without an actor or for an actor of another owner.
 */
export function actsForOwner(actor: Actor | null, ownerId: string): boolean {
  return actor !== null && actor.ownerId === ownerId && can(actor, "manage");
}

/**
 * The actor, if it may do the action. Without an actor (the user has no role on the owner) the
 * answer is `not_found`, exactly what a missing owner or artifact gives; with a role that does
 * not allow it, `forbidden`.
 */
export function authorize(actor: Actor | null, action: RoleAction): Result<Actor> {
  if (actor === null) return fail("not_found", "Artifact not found.");
  if (!can(actor, action)) {
    return fail("forbidden", "Your role on this workspace does not allow this.");
  }
  return ok(actor);
}

/** The personal space of a user: they are its admin, and it is always in the default region. */
export function personalActor(userId: string): Actor {
  return { userId, ownerId: userId, role: "admin", region: "default" };
}
