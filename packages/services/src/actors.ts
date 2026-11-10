// The only place a role is decided (premium plan F3, decisions 0004 and 0005). A user acts on an
// owner: their personal space, where they are the admin, or a workspace, where the membership
// gives the role. A user who is not a member of an owner gets exactly what a missing owner or
// artifact gives. Adapters never decide a role: they pass the user and the owner (or the
// artifact) and the services resolve the actor here.
import { DEFAULT_REGION, isWorkspaceId, type RoleAction } from "@portifact/contracts";
import {
  type GlobalDb,
  isRegion,
  type RegionalDb,
  type RegionHandles,
  type Regions,
  schema,
} from "@portifact/db";
import { type Actor, authorize, fail, ok, personalActor, type Result } from "@portifact/domain";
import { and, eq, inArray } from "drizzle-orm";

/**
 * The actor for `userId` on `ownerId`, or null when the user has no role there. A personal space
 * needs no read; a workspace, one indexed read of the membership and the workspace's region.
 */
export async function actorOn(
  global: GlobalDb,
  userId: string,
  ownerId: string,
): Promise<Actor | null> {
  if (!isWorkspaceId(ownerId)) return ownerId === userId ? personalActor(userId) : null;
  const [row] = await global
    .select({ role: schema.workspaceMembers.role, region: schema.workspaces.region })
    .from(schema.workspaceMembers)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceMembers.workspaceId))
    .where(
      and(
        eq(schema.workspaceMembers.workspaceId, ownerId),
        eq(schema.workspaceMembers.userId, userId),
      ),
    )
    .limit(1);
  if (!row) return null;
  if (!isRegion(row.region)) throw new Error(`Workspace ${ownerId} is in an unknown region`);
  return { userId, ownerId, role: row.role, region: row.region };
}

/**
 * The actor for `userId` on `ownerId`. `not_found` when the user has no role there, the same
 * answer as an owner that does not exist.
 */
export async function resolveActor(
  global: GlobalDb,
  userId: string,
  ownerId: string,
): Promise<Result<Actor>> {
  const actor = await actorOn(global, userId, ownerId);
  return actor ? ok(actor) : fail("not_found", "Not found.");
}

/**
 * The actor for `userId` on the owner of an artifact, if the role allows `action`. A user with
 * no role on the owner gets `missing`, exactly what a missing artifact gives; a role that does
 * not allow the action, `forbidden`.
 */
export async function authorizeOn(
  db: RegionalDb,
  userId: string,
  ownerId: string,
  action: RoleAction,
  missing: () => Result<never>,
): Promise<Result<Actor>> {
  const actor = await actorOn(db.global, userId, ownerId);
  if (!actor) return missing();
  return authorize(actor, action);
}

/**
 * Who acts for an owner in the rules that say "the owner" (comment visibility, the threads
 * counted as the owner's): the user of a personal space, or a workspace's admins and editors.
 */
export async function ownerSide(global: GlobalDb, ownerId: string): Promise<string[]> {
  if (!isWorkspaceId(ownerId)) return [ownerId];
  const rows = await global
    .select({ userId: schema.workspaceMembers.userId })
    .from(schema.workspaceMembers)
    .where(
      and(
        eq(schema.workspaceMembers.workspaceId, ownerId),
        inArray(schema.workspaceMembers.role, ["admin", "editor"]),
      ),
    )
    .orderBy(schema.workspaceMembers.userId);
  return rows.map((row) => row.userId);
}

/**
 * Who receives what is sent to an owner (expiry notices): the user of a personal space, or a
 * workspace's admins.
 */
export async function ownerRecipients(global: GlobalDb, ownerId: string): Promise<string[]> {
  if (!isWorkspaceId(ownerId)) return [ownerId];
  const rows = await global
    .select({ userId: schema.workspaceMembers.userId })
    .from(schema.workspaceMembers)
    .where(
      and(
        eq(schema.workspaceMembers.workspaceId, ownerId),
        eq(schema.workspaceMembers.role, "admin"),
      ),
    )
    .orderBy(schema.workspaceMembers.userId);
  return rows.map((row) => row.userId);
}

/** The handles of the actor's owner. */
export function actorHandles(regions: Regions, actor: Actor): RegionHandles {
  return regions.get(actor.region);
}

/**
 * The handles of the region that holds an artifact, from the global directory. With one region
 * there is nothing to look up. Null for an ID the directory does not know, which callers answer
 * like a missing artifact.
 */
export async function artifactHandles(
  regions: Regions,
  artifactId: string,
): Promise<RegionHandles | null> {
  const all = regions.all();
  if (all.length === 1) return all[0] ?? null;
  const [row] = await regions.global
    .select({ region: schema.artifactDirectory.region })
    .from(schema.artifactDirectory)
    .where(eq(schema.artifactDirectory.id, artifactId))
    .limit(1);
  if (!row || !isRegion(row.region)) return null;
  return regions.get(row.region);
}

/** The handles of a user's personal space, which is always in the default region. */
export function personalHandles(regions: Regions): RegionHandles {
  return regions.get(DEFAULT_REGION);
}
