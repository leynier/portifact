// Who acts on an owner, and what each role may do (premium plan F3, decision 0004). The role
// comes only from `resolveActor` in packages/services, from the membership (or, in a personal
// space, from the user being its owner); this module only decides what a role allows.
import type {
  Region,
  RoleAction,
  ServiceTokenRestriction,
  ServiceTokenScope,
  WorkspaceRole,
} from "@portifact/contracts";
import { fail, ok, type Result } from "./result.ts";

/** What a service token acting on its workspace may reach (decision 0011). */
export interface TokenReach {
  restriction: ServiceTokenRestriction;
  /** The scopes its admin chose, for the few rules a scope narrows inside one action. */
  scopes: readonly ServiceTokenScope[];
  /** When the token was created: its age stands for an account's age in the rules that use one. */
  createdAt: number;
  label: string;
}

/**
 * A user, or a service token, acting with a role on an owner, in the owner's region. For a token
 * `userId` is the token's ID and `token` is set.
 */
export interface Actor {
  userId: string;
  /** The user's own ID for their personal space, or a workspace ID. */
  ownerId: string;
  role: WorkspaceRole;
  region: Region;
  token?: TokenReach;
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
  "domains",
  // Content search reads every artifact of the owner, so only roles that read them all (decision 0012).
  "search",
];
const ADMIN: readonly RoleAction[] = [
  ...EDITOR,
  "transfer_out",
  "members",
  "plan",
  "policies",
  "delete_workspace",
  // Webhooks send the owner's activity to a destination outside Portifact (decision 0009).
  "webhooks",
  // The owner's brand on the viewer's bar (premium plan P9): what visitors see as the owner.
  "brand",
  // The audit log (premium plan T10): what every member did.
  "audit",
  // Service tokens of a workspace (decision 0011).
  "tokens",
];

/**
 * What a service token may ever do, whatever its role (decision 0011): publishing and managing
 * artifacts. Never comments, moderation, transfers, the access log and analytics (visitors'
 * data), members, plans, policies, webhooks, branding or tokens.
 */
export const TOKEN_ACTIONS: ReadonlySet<RoleAction> = new Set<RoleAction>([
  "read",
  "manage",
  "list",
  "publish",
  "update",
  "access",
  "lifecycle",
  "versions",
  "rollback",
  "usage",
  // A token already downloads every version it reaches; its search is limited to the same reach.
  "search",
]);

const ALLOWED: Record<WorkspaceRole, ReadonlySet<RoleAction>> = {
  admin: new Set(ADMIN),
  editor: new Set(EDITOR),
  member: new Set(MEMBER),
};

/** Whether the role allows the action. */
export function roleAllows(role: WorkspaceRole, action: RoleAction): boolean {
  return ALLOWED[role].has(action);
}

/** Whether the actor may do the action on its owner: its role, and for a token its allowlist. */
export function can(actor: Actor, action: RoleAction): boolean {
  if (actor.token && !TOKEN_ACTIONS.has(action)) return false;
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
