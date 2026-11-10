// The only place a role is decided (premium plan F3, decisions 0004 and 0005). A user acts on an
// owner: their personal space, where they are the admin, or a workspace, where the membership
// gives the role. A user who is not a member of an owner gets exactly what a missing owner or
// artifact gives. Adapters never decide a role: they pass the user and the owner (or the
// artifact) and the services resolve the actor here.
import {
  DEFAULT_REGION,
  isServiceTokenId,
  isWorkspaceId,
  type RoleAction,
} from "@portifact/contracts";
import {
  type GlobalDb,
  isRegion,
  type RegionalDb,
  type RegionHandles,
  type Regions,
  schema,
} from "@portifact/db";
import {
  type Actor,
  authorize,
  fail,
  ok,
  personalActor,
  policyOf,
  type Result,
  restrictionAllows,
  restrictionOf,
  storedTokenScopes,
} from "@portifact/domain";
import { and, eq, inArray, sql } from "drizzle-orm";

/**
 * Whether the workspace has a verified email domain, evaluated only when its policy's default
 * access is `domain` (1 otherwise), in the membership's own query: the publish path needs it and
 * no other path pays for it.
 */
const domainVerifiedSql = sql<number>`case when json_extract(${schema.workspaces.policy}, '$.defaultAccess') = 'domain' then exists (select 1 from ${schema.workspaceDomains} where ${schema.workspaceDomains.workspaceId} = ${schema.workspaces.id} and ${schema.workspaceDomains.state} = 'verified') else 1 end`;

/**
 * An artifact a role is asked about: its owner, and what a service token's restriction is checked
 * against (decision 0011). Owner-scoped questions (listing, usage, a new artifact) pass the
 * owner's ID instead.
 */
export interface ArtifactSubject {
  ownerId: string;
  createdBy: string | null;
  externalKey: string | null;
}

export type ActorTarget = string | ArtifactSubject;

function ownerOfTarget(target: ActorTarget): string {
  return typeof target === "string" ? target : target.ownerId;
}

/**
 * The actor for `userId` on an owner (or on an artifact's owner), or null when the user has no
 * role there. A personal space needs no read; a workspace, one indexed read of the membership and
 * the workspace's region. A service token's ID (decision 0011) has a role only on its own
 * workspace, from its row, and only on the artifacts its restriction reaches; it has no personal
 * space.
 */
export async function actorOn(
  global: GlobalDb,
  userId: string,
  target: ActorTarget,
): Promise<Actor | null> {
  if (isServiceTokenId(userId)) return tokenActorOn(global, userId, target);
  const ownerId = ownerOfTarget(target);
  if (!isWorkspaceId(ownerId)) return ownerId === userId ? personalActor(userId) : null;
  const [row] = await global
    .select({
      role: schema.workspaceMembers.role,
      region: schema.workspaces.region,
      // The policies come with the membership, so applying them costs no read (decision 0015).
      policy: schema.workspaces.policy,
      domainVerified: domainVerifiedSql,
    })
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
  return {
    userId,
    ownerId,
    role: row.role,
    region: row.region,
    policy: policyOf(row.policy),
    domainVerified: Number(row.domainVerified) === 1,
  };
}

async function tokenActorOn(
  global: GlobalDb,
  tokenId: string,
  target: ActorTarget,
): Promise<Actor | null> {
  const ownerId = ownerOfTarget(target);
  if (!isWorkspaceId(ownerId)) return null;
  const t = schema.serviceTokens;
  const [row] = await global
    .select({
      role: t.role,
      restriction: t.restriction,
      keyPrefix: t.keyPrefix,
      scopes: t.scopes,
      createdAt: t.createdAt,
      label: t.label,
      region: schema.workspaces.region,
      policy: schema.workspaces.policy,
      domainVerified: domainVerifiedSql,
    })
    .from(t)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, t.workspaceId))
    .where(and(eq(t.id, tokenId), eq(t.workspaceId, ownerId)))
    .limit(1);
  if (!row) return null;
  if (!isRegion(row.region)) throw new Error(`Workspace ${ownerId} is in an unknown region`);
  const restriction = restrictionOf(row.restriction, row.keyPrefix);
  if (typeof target !== "string" && !restrictionAllows(tokenId, restriction, target)) return null;
  return {
    userId: tokenId,
    ownerId,
    role: row.role,
    region: row.region,
    policy: policyOf(row.policy),
    domainVerified: Number(row.domainVerified) === 1,
    token: {
      restriction,
      scopes: storedTokenScopes(row.scopes),
      createdAt: row.createdAt,
      label: row.label,
    },
  };
}

/**
 * The actor for `userId` on `ownerId`. `not_found` when the user has no role there, the same
 * answer as an owner that does not exist.
 */
export async function resolveActor(
  global: GlobalDb,
  userId: string,
  target: ActorTarget,
): Promise<Result<Actor>> {
  const actor = await actorOn(global, userId, target);
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
  target: ActorTarget,
  action: RoleAction,
  missing: () => Result<never>,
): Promise<Result<Actor>> {
  const actor = await actorOn(db.global, userId, target);
  if (!actor) return missing();
  return authorize(actor, action);
}

/**
 * `authorizeOn` for an upload session: a service token's restriction is checked against the
 * artifact the upload publishes to (prepare already wrote its row), at the cost of one read that
 * people's requests do not pay.
 */
export async function authorizeUploadOn(
  db: RegionalDb,
  userId: string,
  session: { ownerId: string; artifactId: string },
  action: RoleAction,
  missing: () => Result<never>,
): Promise<Result<Actor>> {
  if (!isServiceTokenId(userId)) return authorizeOn(db, userId, session.ownerId, action, missing);
  const [artifact] = await db
    .select({ createdBy: schema.artifacts.createdBy, externalKey: schema.artifacts.externalKey })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, session.artifactId))
    .limit(1);
  if (!artifact) return missing();
  return authorizeOn(db, userId, { ownerId: session.ownerId, ...artifact }, action, missing);
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
