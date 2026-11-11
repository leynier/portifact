// The only place a role is decided (premium plan F3, decisions 0004 and 0005). A user acts on an
// owner: their personal space, where they are the admin, or a workspace, where the membership
// gives the role. A user who is not a member of an owner gets exactly what a missing owner or
// artifact gives. Adapters never decide a role: they pass the user and the owner (or the
// artifact) and the services resolve the actor here.
//
// It is also the one choke point of a workspace's request policies (decision 0020): the global
// handle carries the request context the Worker built (`GlobalDb.request`), the policy comes
// with the membership in the same query, and a request the policy refuses gets `policy_refused`
// here, whatever interface, service or role it came through. Every caller handles that answer:
// `actorOn` returns a `Result`, so none can mistake a refusal for a missing role.
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
  checkRequestPolicy,
  fail,
  type OwnerPlanRecord,
  ok,
  personalActor,
  policyOf,
  type Result,
  requestVerdict,
  restrictionAllows,
  restrictionOf,
  storedTokenScopes,
} from "@portifact/domain";
import { and, eq, inArray, sql } from "drizzle-orm";
import { ownerPlanQuery, ownerPlanRecord } from "./plans.ts";

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
 * The actor for `userId` on an owner (or on an artifact's owner): `ok(null)` when the user has no
 * role there, and `policy_refused` when they have one but the workspace's request policies refuse
 * this request (decision 0020). A personal space needs no read and is never bound by a
 * workspace's policy; a workspace, one indexed read of the membership, the workspace's region and
 * its policy. A service token's ID (decision 0011) has a role only on its own workspace, from its
 * row, and only on the artifacts its restriction reaches; it has no personal space.
 */
export async function actorOn(
  global: GlobalDb,
  userId: string,
  target: ActorTarget,
): Promise<Result<Actor | null>> {
  if (isServiceTokenId(userId)) {
    return bound(global, await tokenActorOn(global, userId, target), "token");
  }
  const ownerId = ownerOfTarget(target);
  if (!isWorkspaceId(ownerId)) return ok(ownerId === userId ? personalActor(userId) : null);
  const [row] = await memberQuery(global, userId, ownerId);
  return bound(global, memberActor(userId, ownerId, row), "person");
}

/** The workspaces this isolate already reported an unreadable network list for. */
const reportedUnreadable = new Set<string>();
const REPORTED_UNREADABLE_MAX = 1_000;

/**
 * Says once per isolate and workspace that its stored network list does not parse (the request
 * is refused, fail closed): the workspace's ID only, never an address or a range. Every refused
 * request, and on the artifact origin every subresource, would otherwise write a line.
 */
export function reportUnreadablePolicy(workspaceId: string): void {
  if (reportedUnreadable.has(workspaceId)) return;
  if (reportedUnreadable.size >= REPORTED_UNREADABLE_MAX) reportedUnreadable.clear();
  reportedUnreadable.add(workspaceId);
  console.error(JSON.stringify({ event: "workspace_network_policy_unreadable", workspaceId }));
}

/**
 * The actor, if the workspace's request policies admit the request the handle answers. Only an
 * actor is checked: someone with no role learns nothing about the workspace's policies.
 */
function bound(
  global: GlobalDb,
  actor: Actor | null,
  caller: "person" | "token",
): Result<Actor | null> {
  if (!actor) return ok(null);
  const allowed = checkRequestPolicy(actor.policy, global.request, caller);
  if (!allowed.ok && requestVerdict(actor.policy, global.request, caller) === "unreadable") {
    reportUnreadablePolicy(actor.ownerId);
  }
  return allowed.ok ? ok(actor) : allowed;
}

/** The membership read `actorOn` makes for a workspace, for a batch of the global database. */
function memberQuery(global: GlobalDb, userId: string, ownerId: string) {
  return global
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
}

type MemberRow = Awaited<ReturnType<typeof memberQuery>>[number];

function memberActor(userId: string, ownerId: string, row: MemberRow | undefined): Actor | null {
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

/**
 * The actor on an owner and the owner's plan row, for the services that need both while
 * working on regional data (decision 0005: plans are global, so no regional query joins them).
 * For a member of a workspace both come in one batch of the global database, the round trip the
 * membership already took; a personal space needs no read for its actor, so it costs one for
 * the plan.
 */
export async function actorAndPlanOn(
  global: GlobalDb,
  userId: string,
  target: ActorTarget,
): Promise<Result<{ actor: Actor | null; plan: OwnerPlanRecord | null }>> {
  const ownerId = ownerOfTarget(target);
  if (isServiceTokenId(userId) || !isWorkspaceId(ownerId)) {
    const [actor, plan] = await Promise.all([
      actorOn(global, userId, target),
      ownerPlanRecord(global, ownerId),
    ]);
    return actor.ok ? ok({ actor: actor.value, plan }) : actor;
  }
  const [members, plans] = await global.batch([
    memberQuery(global, userId, ownerId),
    ownerPlanQuery(global, ownerId),
  ]);
  const actor = bound(global, memberActor(userId, ownerId, members[0]), "person");
  return actor.ok ? ok({ actor: actor.value, plan: plans[0] ?? null }) : actor;
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
 * answer as an owner that does not exist; `policy_refused` when a request policy refuses it.
 */
export async function resolveActor(
  global: GlobalDb,
  userId: string,
  target: ActorTarget,
): Promise<Result<Actor>> {
  const actor = await actorOn(global, userId, target);
  if (!actor.ok) return actor;
  return actor.value ? ok(actor.value) : fail("not_found", "Not found.");
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
  if (!actor.ok) return actor;
  if (!actor.value) return missing();
  return authorize(actor.value, action);
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
