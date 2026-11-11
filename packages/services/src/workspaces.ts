// Workspaces (premium plan T1, decision 0004): naming an owner by its slug, the caller's
// workspaces, members and roles, and the operator's create, show, list and delete. Every role
// comes from `actorOn`; a user who is not a member of a workspace gets exactly what a missing one
// gives. Membership writes are D1 batches conditioned on the state the request read, and the
// triggers of the workspace_members_invitations migration refuse leaving a workspace without an admin even when a race slips past.
import {
  type AuditDetail,
  DEFAULT_POLICY,
  DEFAULT_REGION,
  isServiceTokenId,
  isWorkspaceId,
  type OwnerView,
  type Region,
  type RequestRefusal,
  type WorkspacePolicy,
  type WorkspacePolicyShown,
  type WorkspaceRole,
} from "@portifact/contracts";
import {
  bothSides,
  type Db,
  type GlobalDb,
  isRegion,
  type RegionalDb,
  type Regions,
  sameDatabase,
  schema,
} from "@portifact/db";
import {
  type Actor,
  authorize,
  checkNewWorkspace,
  checkRemoval,
  checkRoleChange,
  fail,
  ok,
  personalActor,
  policyOf,
  type RequestCaller,
  type Result,
  requestRefusal,
  seesNetworks,
  shownPolicy,
  ssoOffered,
} from "@portifact/domain";
import { and, asc, eq, gt, inArray, type SQL, sql } from "drizzle-orm";
import { claimArtifacts } from "./account-data.ts";
import { actorOn } from "./actors.ts";
import { type AuditActor, auditEvent, eraseOwnerAuditEvents } from "./audit.ts";
import { deleteOwnerAuditStreams } from "./audit-streams.ts";
import { eraseOwnerBrand } from "./branding.ts";
import { domainDbsOf, releaseOwnerDomains } from "./custom-domains.ts";
import { deleteOwnerConnections } from "./integrations.ts";
import { releaseOrphans } from "./maintenance.ts";
import { closeJobs } from "./outbox.ts";
import { ownerEntitlements } from "./plans.ts";
import { directoryRoleHolders } from "./scim-groups.ts";
import { ssoRequirementColumns, usableSsoProvider } from "./sso-required.ts";

const w = schema.workspaces;
const m = schema.workspaceMembers;
const inv = schema.workspaceInvitations;
const gm = schema.workspaceGroupMembers;

export const missingWorkspace = () => fail<never>("not_found", "Workspace not found.");

export interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  region: Region;
  createdAt: number;
  /** Its policies in effect (decision 0015). */
  policy: WorkspacePolicy;
}

export function regionOf(row: { id: string; region: string }): Region {
  if (!isRegion(row.region)) throw new Error(`Workspace ${row.id} is in an unknown region`);
  return row.region;
}

/** A workspace by its slug, or null. */
export async function workspaceBySlug(
  global: GlobalDb,
  slug: string,
): Promise<WorkspaceRow | null> {
  const [row] = await global
    .select({
      id: w.id,
      slug: w.slug,
      name: w.name,
      region: w.region,
      createdAt: w.createdAt,
      policy: w.policy,
    })
    .from(w)
    .where(eq(w.slug, slug))
    .limit(1);
  return row ? { ...row, region: regionOf(row), policy: policyOf(row.policy) } : null;
}

/**
 * The actor for the space a request names: the user's personal space without a slug, or the
 * workspace with that slug. A slug the user is not a member of answers exactly like one that does
 * not exist.
 */
export async function resolveOwnerScope(
  global: GlobalDb,
  userId: string,
  slug: string | undefined,
): Promise<Result<Actor>> {
  // A service token has no personal space: without a slug it acts on its own workspace.
  if (isServiceTokenId(userId)) return tokenScope(global, userId, slug);
  if (slug === undefined) return ok(personalActor(userId));
  const workspace = await workspaceBySlug(global, slug);
  if (!workspace) return missingWorkspace();
  const actor = await actorOn(global, userId, workspace.id);
  if (!actor.ok) return actor;
  return actor.value ? ok(actor.value) : missingWorkspace();
}

async function tokenScope(
  global: GlobalDb,
  tokenId: string,
  slug: string | undefined,
): Promise<Result<Actor>> {
  const [token] = await global
    .select({ workspaceId: schema.serviceTokens.workspaceId, slug: w.slug })
    .from(schema.serviceTokens)
    .innerJoin(w, eq(w.id, schema.serviceTokens.workspaceId))
    .where(eq(schema.serviceTokens.id, tokenId))
    .limit(1);
  if (!token || (slug !== undefined && slug !== token.slug)) return missingWorkspace();
  const actor = await actorOn(global, tokenId, token.workspaceId);
  if (!actor.ok) return actor;
  return actor.value ? ok(actor.value) : missingWorkspace();
}

export interface UserWorkspace extends WorkspaceRow {
  role: WorkspaceRole;
  /**
   * The workspace's request policies refuse the request listing it (decision 0020): its screens
   * explain that instead of failing one by one. Listing one's own workspaces is not acting on
   * them, so the list itself is never refused.
   */
  blocked?: boolean;
  /** Which request policy refuses it (decisions 0020 and 0021); null when none does. */
  blockedBy?: RequestRefusal | null;
  /**
   * The policy as this caller sees it (`shownPolicy`): the networks only to an admin the network
   * policy admits, so a stolen admin session used from elsewhere never learns them. Absent where
   * the list was not built for a caller; adapters then show the networks to nobody.
   */
  shown?: WorkspacePolicyShown;
}

/** The workspaces the user is a member of, with their role, by name. */
export async function listUserWorkspaces(
  global: GlobalDb,
  userId: string,
): Promise<UserWorkspace[]> {
  // A service token belongs to one workspace, with its own role, and is nobody's member.
  if (isServiceTokenId(userId)) {
    const t = schema.serviceTokens;
    const rows = await global
      .select({
        id: w.id,
        slug: w.slug,
        name: w.name,
        region: w.region,
        createdAt: w.createdAt,
        policy: w.policy,
        role: t.role,
      })
      .from(t)
      .innerJoin(w, eq(w.id, t.workspaceId))
      .where(eq(t.id, userId))
      .limit(1);
    return rows.map((row) => listed(global, { ...row, userId }, "token"));
  }
  const rows = await global
    .select({
      id: w.id,
      slug: w.slug,
      name: w.name,
      region: w.region,
      createdAt: w.createdAt,
      policy: w.policy,
      role: m.role,
      ...ssoRequirementColumns(),
    })
    .from(m)
    .innerJoin(w, eq(w.id, m.workspaceId))
    .where(eq(m.userId, userId))
    .orderBy(asc(w.name), asc(w.slug));
  return rows.map((row) => listed(global, { ...row, userId }, "person"));
}

function listed(
  global: GlobalDb,
  row: Omit<UserWorkspace, "policy" | "region" | "blocked" | "blockedBy" | "shown"> & {
    region: string;
    policy: unknown;
    /** "SSO required": the provider and plan columns, read only for a person's list. */
    ssoProvider?: string | null;
    ssoPlan?: string | null;
    /** Who is listing: the sign-in policies apply the request's credential only to them. */
    userId: string;
  },
  caller: RequestCaller,
): UserWorkspace {
  const policy = policyOf(row.policy);
  // The policy came with the row: deciding it reads nothing more.
  const now = Date.now();
  const blockedBy = requestRefusal(policy, global.request, caller, {
    userId: row.userId,
    now,
    ssoProvider: usableSsoProvider(
      { ssoProvider: row.ssoProvider ?? null, ssoPlan: row.ssoPlan ?? null },
      now,
    ),
  });
  const blocked = blockedBy !== null;
  const shown = shownPolicy(policy, seesNetworks(row.role, blocked), ssoOffered(global.request));
  const { userId: _, ssoProvider: _p, ssoPlan: _q, ...rest } = row;
  return { ...rest, region: regionOf(row), policy, blocked, blockedBy, shown };
}

/**
 * Where each owner lives, as artifact views show it. A personal space is `personal`; a workspace
 * shows its slug and name. A workspace that is gone (being deleted) shows as `personal` never: it
 * is left out, and callers only ask for owners of artifacts they may see.
 */
export async function ownerViews(
  global: GlobalDb,
  ownerIds: readonly string[],
): Promise<Map<string, OwnerView>> {
  const views = new Map<string, OwnerView>();
  const workspaceIds = [...new Set(ownerIds.filter((id) => isWorkspaceId(id)))];
  for (const id of ownerIds) if (!isWorkspaceId(id)) views.set(id, { kind: "personal" });
  for (let i = 0; i < workspaceIds.length; i += 80) {
    const rows = await global
      .select({ id: w.id, slug: w.slug, name: w.name })
      .from(w)
      .where(inArray(w.id, workspaceIds.slice(i, i + 80)));
    for (const row of rows)
      views.set(row.id, { kind: "workspace", slug: row.slug, name: row.name });
  }
  return views;
}

/** The owner view of one owner; a workspace that no longer exists reads as its bare ID's space. */
export async function ownerView(global: GlobalDb, ownerId: string): Promise<OwnerView> {
  return (await ownerViews(global, [ownerId])).get(ownerId) ?? { kind: "personal" };
}

// Members ------------------------------------------------------------------------------------

export interface MemberRow {
  userId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  joinedAt: number;
  /** In a directory group mapped to a role: the directory sets the role (decision 0017). */
  directoryRole?: boolean;
}

export interface Seats {
  used: number;
  limit: number;
}

/** Members plus pending invitations that have not expired, against the plan's seats. */
export async function workspaceSeats(
  global: GlobalDb,
  workspaceId: string,
  now: number,
): Promise<Seats> {
  const [row] = await global.all<{ used: number }>(
    sql`select ${seatsUsedSql(workspaceId, now, true)} as used`,
  );
  return {
    used: Number(row?.used ?? 0),
    limit: (await ownerEntitlements(global, workspaceId, now)).seats,
  };
}

/**
 * SQL for the seats in use, to condition a write that takes one. Pending invitations count once
 * per address, and not at all for a member's address: an admin's invitation and a directory's
 * pending membership for the same person hold one seat (decision 0017).
 */
export function seatsUsedSql(workspaceId: string, now: number, countInvitations: boolean): SQL {
  const members = sql`(select count(*) from ${m} where ${m.workspaceId} = ${workspaceId})`;
  if (!countInvitations) return members;
  return sql`(${members} + (select count(distinct ${inv.email}) from ${inv} where ${inv.workspaceId} = ${workspaceId} and ${inv.expiresAt} > ${now} and ${inv.email} not in (select lower(${schema.users.email}) from ${m} as "seated" inner join ${schema.users} on ${schema.users.id} = "seated"."user_id" where "seated"."workspace_id" = ${workspaceId})))`;
}

async function members(global: GlobalDb, workspaceId: string): Promise<MemberRow[]> {
  return global
    .select({
      userId: m.userId,
      name: schema.users.name,
      email: schema.users.email,
      role: m.role,
      joinedAt: m.createdAt,
    })
    .from(m)
    .innerJoin(schema.users, eq(schema.users.id, m.userId))
    .where(eq(m.workspaceId, workspaceId))
    .orderBy(asc(schema.users.name), asc(m.userId));
}

/** The workspace a request names, with the caller's actor allowed to do `action` there. */
export async function scoped(
  global: GlobalDb,
  userId: string,
  slug: string,
  action: Parameters<typeof authorize>[1],
): Promise<Result<{ workspace: WorkspaceRow; actor: Actor }>> {
  const workspace = await workspaceBySlug(global, slug);
  if (!workspace) return missingWorkspace();
  const resolved = await actorOn(global, userId, workspace.id);
  if (!resolved.ok) return resolved;
  const actor = resolved.value;
  if (!actor) return missingWorkspace();
  const allowed = authorize(actor, action);
  if (!allowed.ok) return allowed;
  return ok({ workspace, actor });
}

export interface MemberList {
  workspace: UserWorkspace;
  members: MemberRow[];
  seats: Seats;
}

/** A workspace's members, for any member of it. */
export async function listMembers(
  global: GlobalDb,
  input: { userId: string; slug: string; now: number },
): Promise<Result<MemberList>> {
  const found = await scoped(global, input.userId, input.slug, "read");
  if (!found.ok) return found;
  const { workspace, actor } = found.value;
  const holders = await directoryRoleHolders(global, workspace.id);
  return ok({
    workspace: { ...workspace, role: actor.role },
    members: (await members(global, workspace.id)).map((row) => ({
      ...row,
      directoryRole: holders.has(row.userId),
    })),
    seats: await workspaceSeats(global, workspace.id, input.now),
  });
}

const missingMember = () => fail<never>("not_found", "Member not found.");

function causeIncludes(error: unknown, text: string): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (e.message.includes(text)) return true;
  }
  return false;
}

/** Runs a membership batch, answering the last-admin trigger's refusal as `sole_workspace_admin`. */
async function guardedBatch<T>(
  run: () => Promise<T>,
  refusal: () => Result<never>,
): Promise<Result<T>> {
  try {
    return ok(await run());
  } catch (error) {
    if (causeIncludes(error, "sole_workspace_admin")) return refusal();
    throw error;
  }
}

async function adminCount(global: GlobalDb, workspaceId: string): Promise<number> {
  const [row] = await global
    .select({ count: sql<number>`count(*)` })
    .from(m)
    .where(and(eq(m.workspaceId, workspaceId), eq(m.role, "admin")));
  return Number(row?.count ?? 0);
}

async function membership(global: GlobalDb, workspaceId: string, userId: string) {
  const [row] = await global
    .select({ role: m.role })
    .from(m)
    .where(and(eq(m.workspaceId, workspaceId), eq(m.userId, userId)))
    .limit(1);
  return row ?? null;
}

/**
 * Changes a member's role, for an admin. The last admin cannot be demoted; the write is
 * conditioned on the role the request read, so of two concurrent changes the later one finds a
 * different role and is refused as a conflict, and the trigger refuses whatever leaves no admin.
 */
/**
 * The caller is still an admin of the workspace: member writes are conditioned on it inside their
 * batch, so an admin demoted or removed after the read changes nothing.
 */
export function stillAdmin(workspaceId: string, userId: string): SQL {
  return sql`exists (select 1 from ${m} as "caller" where "caller"."workspace_id" = ${workspaceId} and "caller"."user_id" = ${userId} and "caller"."role" = 'admin')`;
}

/** After a write that changed nothing: the caller's current answer, or a conflict. */
async function refusedWrite(
  global: GlobalDb,
  userId: string,
  slug: string,
  action: Parameters<typeof authorize>[1],
  conflict: () => Result<never>,
): Promise<Result<never>> {
  const again = await scoped(global, userId, slug, action);
  return again.ok ? conflict() : again;
}

export async function changeMemberRole(
  global: GlobalDb,
  input: { userId: string; slug: string; memberId: string; role: WorkspaceRole; now: number },
): Promise<Result<MemberRow>> {
  const found = await scoped(global, input.userId, input.slug, "members");
  if (!found.ok) return found;
  const { workspace } = found.value;
  const current = await membership(global, workspace.id, input.memberId);
  if (!current) return missingMember();
  const allowed = checkRoleChange(current.role, input.role, await adminCount(global, workspace.id));
  if (!allowed.ok) return allowed;
  if (current.role !== input.role) {
    const where = and(
      eq(m.workspaceId, workspace.id),
      eq(m.userId, input.memberId),
      eq(m.role, current.role),
      stillAdmin(workspace.id, input.userId),
    ) as SQL;
    const updated = await guardedBatch(
      async () =>
        (
          await global.batch([
            memberEvent(
              global,
              {
                workspaceId: workspace.id,
                memberId: input.memberId,
                now: input.now,
                actor: { type: "user", id: input.userId },
              },
              "member.role_changed",
              { from: current.role, to: input.role },
              sql`exists (select 1 from ${m} where ${where})`,
            ),
            global
              .update(m)
              .set({ role: input.role, updatedAt: input.now })
              .where(where)
              .returning({ userId: m.userId }),
            // A hand change makes the role the admin's, not the directory's (decision 0017).
            global
              .update(schema.scimUsers)
              .set({ mappedRole: null })
              .where(
                and(
                  eq(schema.scimUsers.workspaceId, workspace.id),
                  eq(schema.scimUsers.userId, input.memberId),
                  stillAdmin(workspace.id, input.userId),
                ) as SQL,
              ),
          ])
        )[1],
      () => checkRoleChange("admin", input.role, 1) as Result<never>,
    );
    if (!updated.ok) return updated;
    if (updated.value.length === 0) {
      return refusedWrite(global, input.userId, input.slug, "members", () =>
        fail("version_conflict", "The member changed meanwhile. Reload and try again."),
      );
    }
  }
  const row = (await members(global, workspace.id)).find((one) => one.userId === input.memberId);
  return row ? ok(row) : missingMember();
}

/** Removes a member, for an admin; the last admin cannot be removed. */
export async function removeMember(
  global: GlobalDb,
  input: { userId: string; slug: string; memberId: string; now?: number | undefined },
): Promise<Result<{ removed: true }>> {
  const found = await scoped(global, input.userId, input.slug, "members");
  if (!found.ok) return found;
  const workspaceId = found.value.workspace.id;
  const removed = await dropMember(
    global,
    workspaceId,
    input.memberId,
    input.memberId === input.userId,
    stillAdmin(workspaceId, input.userId),
    { userId: input.userId, now: input.now ?? Date.now() },
  );
  if (removed.ok || removed.code !== "not_found") return removed;
  // Nothing removed: the caller may have lost the role meanwhile.
  return refusedWrite(global, input.userId, input.slug, "members", () => removed);
}

/** Leaves a workspace, for any member; the last admin cannot leave. */
export async function leaveWorkspace(
  global: GlobalDb,
  input: { userId: string; slug: string; now?: number | undefined },
): Promise<Result<{ removed: true }>> {
  // Leaving only reduces access, so the request policies, which bind acting on the workspace, do
  // not stop it (decision 0020): someone refused from elsewhere can still leave. No role is
  // decided here, only whether the membership exists; the last-admin rule applies as always.
  const workspace = await workspaceBySlug(global, input.slug);
  if (!workspace || !(await membership(global, workspace.id, input.userId))) {
    return missingWorkspace();
  }
  return dropMember(global, workspace.id, input.userId, true, sql`1`, {
    userId: input.userId,
    now: input.now ?? Date.now(),
  });
}

async function dropMember(
  global: GlobalDb,
  workspaceId: string,
  memberId: string,
  leaving: boolean,
  callerGuard: SQL,
  by: { userId: string; now: number },
): Promise<Result<{ removed: true }>> {
  const current = await membership(global, workspaceId, memberId);
  if (!current) return missingMember();
  const allowed = checkRemoval(current.role, await adminCount(global, workspaceId), leaving);
  if (!allowed.ok) return allowed;
  const where = and(eq(m.workspaceId, workspaceId), eq(m.userId, memberId), callerGuard) as SQL;
  const self = memberId === by.userId;
  const removed = await guardedBatch(
    async () =>
      (
        await global.batch([
          memberEvent(
            global,
            { workspaceId, memberId, now: by.now, actor: { type: "user", id: by.userId } },
            self ? "member.left" : "member.removed",
            { role: current.role },
            sql`exists (select 1 from ${m} where ${where})`,
          ),
          // Their groups go with the membership by cascade; a restore must not bring them back.
          groupMembershipTombstones(
            global,
            workspaceId,
            memberId,
            sql`exists (select 1 from ${m} where ${where})`,
            by.now,
          ),
          // The directory's copy of the person (decision 0017) is marked, so a routine SCIM sync
          // does not bring back someone removed by hand or who left.
          global
            .update(schema.scimUsers)
            // The role the directory gave them goes with the membership (decision 0017).
            .set({ removedAt: by.now, removal: self ? "self" : "admin", mappedRole: null })
            .where(
              sql`${schema.scimUsers.workspaceId} = ${workspaceId} and (${schema.scimUsers.userId} = ${memberId} or ${schema.scimUsers.email} = (select lower(${schema.users.email}) from ${schema.users} where ${schema.users.id} = ${memberId})) and exists (select 1 from ${m} where ${where})`,
            ),
          // An admin's removal holds against single sign-on until they invite them again
          // (decision 0016); leaving by oneself records none.
          global
            .insert(schema.workspaceRemovals)
            .select(
              sql`select ${workspaceId}, ${memberId}, ${by.now} where ${self ? sql`0` : sql`1`} and exists (select 1 from ${m} where ${where})`,
            )
            .onConflictDoUpdate({
              target: [schema.workspaceRemovals.workspaceId, schema.workspaceRemovals.userId],
              set: { removedAt: by.now },
            }),
          global.delete(m).where(where).returning({ userId: m.userId }),
        ])
      )[4],
    () => checkRemoval("admin", 1, leaving) as Result<never>,
  );
  if (!removed.ok) return removed;
  if (removed.value.length === 0) return missingMember();
  return ok({ removed: true });
}

/**
 * Tombstones of every group membership `memberId` has in the workspace, for the batch that removes
 * them from the workspace (the cascade deletes the rows): a restore must not put them back.
 */
export function groupMembershipTombstones(
  global: GlobalDb,
  workspaceId: string,
  memberId: string,
  condition: SQL,
  now: number,
) {
  return global
    .insert(schema.tombstones)
    .select(
      sql`select 'workspace_group_member', ${gm.id}, ${now} from ${gm} where ${gm.workspaceId} = ${workspaceId} and ${gm.userId} = ${memberId} and ${condition}`,
    )
    .onConflictDoNothing();
}

/** The audit event of a membership change, in the global batch of that change. */
export function memberEvent<
  K extends "member.joined" | "member.role_changed" | "member.removed" | "member.left",
>(
  global: GlobalDb,
  input: { workspaceId: string; memberId: string; now: number; actor: AuditActor },
  kind: K,
  detail: AuditDetail<K>,
  condition: SQL,
) {
  return auditEvent(
    global,
    {
      ownerId: input.workspaceId,
      kind,
      actor: input.actor,
      targetId: input.memberId,
      detail,
      now: input.now,
    },
    condition,
  );
}

// The operator's workspace commands ---------------------------------------------------------

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function newWorkspaceId(): string {
  return `ws_${randomHex(16)}`;
}

/** The account exists and is not being deleted. */
function activeUser(userId: string): SQL {
  return sql`exists (select 1 from ${schema.users} where ${schema.users.id} = ${userId}) and not exists (select 1 from ${schema.accountDeletions} where ${schema.accountDeletions.userId} = ${userId})`;
}

/**
 * Creates a workspace with its first admin, in one batch (operator only: no web route, API
 * endpoint, MCP tool or CLI command creates one while there is no billing). The region is the
 * default one. A taken slug is refused; the admin must be an account that exists.
 */
export async function createWorkspace(
  global: GlobalDb,
  input: {
    slug: string;
    name: string;
    adminUserId: string;
    now: number;
    id?: string;
    /** Fixed at creation (decision 0005); the default region without one. */
    region?: Region;
  },
): Promise<Result<WorkspaceRow>> {
  const region = input.region ?? DEFAULT_REGION;
  const checked = checkNewWorkspace(input);
  if (!checked.ok) return checked;
  const { slug, name } = checked.value;
  if (await workspaceBySlug(global, slug)) {
    return fail("invalid_input", `The slug ${slug} is taken.`);
  }
  const id = input.id ?? newWorkspaceId();
  const guard = activeUser(input.adminUserId);
  const [created] = (await global.batch([
    global
      .insert(w)
      // Columns in schema order: id, slug, name, region, created by, created at, updated at,
      // policy (the defaults), policy revision.
      .select(
        sql`select ${id}, ${slug}, ${name}, ${region}, ${input.adminUserId}, ${input.now}, ${input.now}, null, 0 where ${guard}`,
      )
      .onConflictDoNothing()
      .returning({ id: w.id }),
    // The first admin joins with the operator as the actor, once even if the command is retried.
    memberEvent(
      global,
      { workspaceId: id, memberId: input.adminUserId, now: input.now, actor: { type: "operator" } },
      "member.joined",
      { role: "admin" },
      sql`exists (select 1 from ${w} where ${w.id} = ${id} and ${w.createdBy} = ${input.adminUserId}) and not exists (select 1 from ${m} where ${m.workspaceId} = ${id} and ${m.userId} = ${input.adminUserId})`,
    ),
    global
      .insert(m)
      // Columns in schema order: workspace, user, role, created at, updated at.
      .select(
        sql`select ${id}, ${input.adminUserId}, 'admin', ${input.now}, ${input.now} where exists (select 1 from ${w} where ${w.id} = ${id} and ${w.createdBy} = ${input.adminUserId})`,
      )
      .onConflictDoNothing(),
  ])) as [unknown[], unknown, unknown];
  if (created.length === 0) {
    return (await workspaceBySlug(global, slug))
      ? fail("invalid_input", `The slug ${slug} is taken.`)
      : fail("not_found", "Account not found.");
  }
  return ok({
    id,
    slug,
    name,
    region,
    createdAt: input.now,
    policy: DEFAULT_POLICY,
  });
}

export interface WorkspaceDetail extends WorkspaceRow {
  createdBy: string;
  members: MemberRow[];
  invitations: { id: string; email: string; role: WorkspaceRole; expiresAt: number }[];
  seats: Seats;
  artifacts: number;
}

/** One workspace by slug or ID, for the operator; its artifacts are counted in its region. */
export async function getWorkspaceDetail(
  regions: Regions,
  slugOrId: string,
  now: number,
): Promise<WorkspaceDetail | null> {
  const global = regions.global;
  const [row] = await global
    .select()
    .from(w)
    .where(isWorkspaceId(slugOrId) ? eq(w.id, slugOrId) : eq(w.slug, slugOrId))
    .limit(1);
  if (!row) return null;
  const [count] = await regions
    .get(regionOf(row))
    .db.select({ count: sql<number>`count(*)` })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.ownerId, row.id));
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    region: regionOf(row),
    createdAt: row.createdAt,
    policy: policyOf(row.policy),
    createdBy: row.createdBy,
    members: await members(global, row.id),
    invitations: await global
      .select({ id: inv.id, email: inv.email, role: inv.role, expiresAt: inv.expiresAt })
      .from(inv)
      .where(and(eq(inv.workspaceId, row.id), gt(inv.expiresAt, now)))
      .orderBy(asc(inv.email)),
    seats: await workspaceSeats(global, row.id, now),
    artifacts: Number(count?.count ?? 0),
  };
}

/** Every workspace by slug, for the operator, with its member count. */
export async function listAllWorkspaces(
  global: GlobalDb,
): Promise<(WorkspaceRow & { members: number })[]> {
  const rows = await global
    .select({
      id: w.id,
      slug: w.slug,
      name: w.name,
      region: w.region,
      createdAt: w.createdAt,
      policy: w.policy,
      members: sql<number>`(select count(*) from ${m} where ${m.workspaceId} = ${w.id})`,
    })
    .from(w)
    .orderBy(asc(w.slug));
  return rows.map((row) => ({
    ...row,
    region: regionOf(row),
    policy: policyOf(row.policy),
    members: Number(row.members),
  }));
}

/** Inserts a `workspace_deletion` job for `workspaceId` when `condition` holds. */
export function workspaceDeletionJob(db: Db, workspaceId: string, condition: SQL, now: number) {
  return db
    .insert(schema.outbox)
    .select(
      sql`select null, 'workspace_deletion', '{}', ${now}, null, 0, ${now}, ${workspaceId}, null where ${condition}`,
    );
}

/**
 * Deletes a workspace (operator only), the way an account is deleted. With its region's database
 * being the global one (one region, production today), one batch records the deletion with its
 * job, claims every artifact for purging (they stop being served at once), stops its webhooks,
 * removes the identities of its single sign-on and deletes the workspace row, which removes its
 * memberships and invitations: as it always was. With a separate regional database (decision
 * 0005) the global batch goes first (after it no one can act on the workspace), then the
 * regional claim, retried inline; an error left after the attempts reaches the caller and the job
 * finishes the claim in every region. A retry finds the row gone and claims again everywhere.
 */
export async function deleteWorkspace(
  regions: Regions,
  input: { workspaceId: string; now: number },
): Promise<Result<{ deleted: boolean }>> {
  const global = regions.global;
  const [row] = await global
    .select({ id: w.id, region: w.region })
    .from(w)
    .where(eq(w.id, input.workspaceId))
    .limit(1);
  const home = row ? regions.get(regionOf(row)).db : undefined;
  const both = home ? bothSides(home) : null;
  const on = both ?? global;
  const exists = sql`exists (select 1 from ${w} where ${w.id} = ${input.workspaceId})`;
  const results = (await on.batch([
    workspaceDeletionJob(on, input.workspaceId, exists, input.now),
    on
      .insert(schema.workspaceDeletions)
      .select(sql`select ${input.workspaceId}, ${input.now} where ${exists}`)
      .onConflictDoNothing(),
    ...(both ? claimOwnerStatements(both, input.workspaceId, input.now) : []),
    // The identities linked through its single sign-on: no foreign key ties them to the provider,
    // which the workspace row takes with it below (decision 0016).
    on
      .delete(schema.accounts)
      .where(
        sql`${schema.accounts.providerId} in (select 'sso:' || ${schema.workspaceSso.id} from ${schema.workspaceSso} where ${schema.workspaceSso.workspaceId} = ${input.workspaceId})`,
      ),
    on.delete(w).where(eq(w.id, input.workspaceId)).returning({ id: w.id }),
  ])) as unknown[];
  const deleted = (results.at(-1) as unknown[]).length === 1;
  if (deleted) {
    if (home && !both) await retried(() => claimOwnerInRegion(home, input.workspaceId, input.now));
    return ok({ deleted: true });
  }
  const [pending] = await global
    .select({ id: schema.workspaceDeletions.workspaceId })
    .from(schema.workspaceDeletions)
    .where(eq(schema.workspaceDeletions.workspaceId, input.workspaceId))
    .limit(1);
  if (!pending) return missingWorkspace();
  // A retry after the global batch: the row and its region are gone, so every region is claimed
  // again (idempotent; a region without the workspace's artifacts changes nothing).
  for (const handles of regions.all()) {
    await retried(() => claimOwnerInRegion(handles.db, input.workspaceId, input.now));
  }
  return ok({ deleted: false });
}

/**
 * The regional half of a workspace's deletion: claims its artifacts for purging and stops its
 * webhooks (no foreign key ties them to their owner; their pending events and delivery log
 * cascade from them). Idempotent.
 */
function claimOwnerStatements(db: Db, ownerId: string, now: number) {
  return [
    ...claimArtifacts(db, ownerId, now),
    db.delete(schema.webhooks).where(eq(schema.webhooks.ownerId, ownerId)),
    // Its issue connections and their sealed credentials (decision 0018), the same way.
    deleteOwnerConnections(db, ownerId),
    // Its audit streams and their delivery log (decision 0019), the same way.
    deleteOwnerAuditStreams(db, ownerId),
  ] as const;
}

async function claimOwnerInRegion(db: RegionalDb, ownerId: string, now: number): Promise<void> {
  await db.batch(claimOwnerStatements(db, ownerId, now));
}

/**
 * Deletes identities linked through a single sign-on provider that no longer exists
 * (`accounts.provider_id` is `sso:<id>`, with no foreign key to the provider).
 */
export function deleteOrphanSsoIdentities(db: Db) {
  return db
    .delete(schema.accounts)
    .where(
      sql`${schema.accounts.providerId} like 'sso:%' and substr(${schema.accounts.providerId}, 5) not in (select ${schema.workspaceSso.id} from ${schema.workspaceSso})`,
    );
}

/** Every region a deletion has to reach, with its bucket. */
export interface DeletionRegions {
  global: GlobalDb;
  all(): readonly { db: RegionalDb; bucket: R2Bucket | undefined; region: Region }[];
}

/**
 * The region whose database is the global database (`sameDatabase`), if any: the default region
 * in every deployment. A deletion keeps its statements for that region in the global batch, so
 * with one database it is one batch, as it always was (decision 0005, "Two-region audit").
 */
export function sharedRegion(regions: DeletionRegions) {
  return regions.all().find((handles) => sameDatabase(handles.db, regions.global));
}

/** The regions with a database of their own, where a deletion's half runs after the global one. */
export function separateRegions(regions: DeletionRegions) {
  return regions.all().filter((handles) => !sameDatabase(handles.db, regions.global));
}

/**
 * Where a deletion's final batch runs and the condition that keeps it from finishing while the
 * owner still has an artifact. The shared region's artifacts are checked by SQL inside that
 * batch (one database: atomic, as it always was), so an artifact a request authorized just
 * before inserts in the gap stops the batch, and the next run claims it. A separate region is
 * counted again right before the batch; null when one still holds an artifact. What remains
 * there is a window of one round trip between that count and the batch, which the directory
 * claim closes for new artifacts (`claimArtifactId` refuses an owner being deleted).
 */
export async function finalDeletionStep(
  regions: DeletionRegions,
  ownerId: string,
): Promise<{ on: Db; nothingLeft: SQL } | null> {
  for (const { db } of separateRegions(regions)) {
    const [count] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.ownerId, ownerId));
    if (Number(count?.count ?? 0) > 0) return null;
  }
  const shared = sharedRegion(regions);
  const both = shared ? bothSides(shared.db) : null;
  if (!both) return { on: regions.global, nothingLeft: sql`1` };
  return {
    on: both,
    nothingLeft: sql`not exists (select 1 from ${schema.artifacts} where ${schema.artifacts.ownerId} = ${ownerId})`,
  };
}

/** Inline attempts of a deletion's regional half before the error reaches the caller. */
export const REGIONAL_ATTEMPTS = 3;

/**
 * Runs a deletion's regional half, retried inline. The global batch already wrote the job, so
 * an error that is left after the attempts reaches the caller (never swallowed) and the job or
 * the scan finishes it: the window in which the owner's artifacts are still served is one
 * request's attempts, or until the job runs (decision 0005, "Two-region audit").
 */
export async function retried<T>(run: () => Promise<T>, attempts = REGIONAL_ATTEMPTS): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

/** One region and its bucket as every region, for a deployment with one region and for tests. */
export function singleRegion(db: RegionalDb, bucket: R2Bucket): DeletionRegions {
  return { global: db.global, all: () => [{ db, bucket, region: DEFAULT_REGION }] };
}

function regionBucket(handles: { bucket: R2Bucket | undefined; region: Region }): R2Bucket {
  if (!handles.bucket) throw new Error(`Region ${handles.region} has no bucket binding`);
  return handles.bucket;
}

/** Advances pending workspace deletions, oldest first. */
export async function processWorkspaceDeletions(
  regions: DeletionRegions,
  now: number,
  limit = 5,
): Promise<{ processed: number; finished: number }> {
  const pending = await regions.global
    .select({ workspaceId: schema.workspaceDeletions.workspaceId })
    .from(schema.workspaceDeletions)
    .orderBy(asc(schema.workspaceDeletions.requestedAt))
    .limit(limit);
  let finished = 0;
  for (const deletion of pending) {
    if ((await advanceWorkspaceDeletion(regions, deletion.workspaceId, now)) === "finished") {
      finished += 1;
    }
  }
  return { processed: pending.length, finished };
}

/**
 * Advances one workspace deletion, in every region (the workspace row, and with it its region,
 * is gone; claiming in a region where it never had anything costs one read): claims artifacts
 * that appeared since (an upload in flight), leaves the claimed ones to their purge jobs, and
 * once no region has any left deletes each region's stored objects, counters and upload
 * sessions, then, in one global batch, the plan row, and replaces the deletion row with a
 * `workspace` tombstone. Idempotent and safe to run concurrently. `absent` when none is pending.
 */
export async function advanceWorkspaceDeletion(
  regions: DeletionRegions,
  workspaceId: string,
  now: number,
): Promise<"absent" | "pending" | "finished"> {
  const global = regions.global;
  const [deletion] = await global
    .select({ id: schema.workspaceDeletions.workspaceId })
    .from(schema.workspaceDeletions)
    .where(eq(schema.workspaceDeletions.workspaceId, workspaceId));
  if (!deletion) return "absent";
  let left = 0;
  for (const { db } of regions.all()) {
    // Its custom domains and claims go first, as an account's do: they are global, and its
    // artifacts are being purged (each purge also releases its own).
    await releaseOwnerDomains(domainDbsOf(db), workspaceId, "operator", now);
    await claimOwnerInRegion(db, workspaceId, now);
    const [count] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.ownerId, workspaceId));
    left += Number(count?.count ?? 0);
  }
  if (left > 0) return "pending";
  // Its member and plan events in the global database go before the batches that end the
  // deletion, so a crash in between leaves a step that runs again, never events nothing erases.
  await global.batch([eraseOwnerAuditEvents(global, workspaceId)]);

  for (const handles of regions.all()) {
    const db = handles.db;
    const bucket = regionBucket(handles);
    const objects = await db
      .select({ ownerId: schema.objects.ownerId, sha256: schema.objects.sha256 })
      .from(schema.objects)
      .where(eq(schema.objects.ownerId, workspaceId));
    await releaseOrphans(db, bucket, objects, now);
    // Its brand and logo, as an account's: no foreign key ties a brand to its owner.
    await eraseOwnerBrand(db, bucket, workspaceId);
    const nothingLeft = sql`not exists (select 1 from ${schema.artifacts} where ${schema.artifacts.ownerId} = ${workspaceId})`;
    await db.batch([
      db
        .delete(schema.uploadSessions)
        .where(and(eq(schema.uploadSessions.ownerId, workspaceId), nothingLeft)),
      db
        .delete(schema.usageEvents)
        .where(and(eq(schema.usageEvents.ownerId, workspaceId), nothingLeft)),
      db
        .delete(schema.trafficCounters)
        .where(and(eq(schema.trafficCounters.ownerId, workspaceId), nothingLeft)),
      db
        .delete(schema.annotationUsage)
        .where(and(eq(schema.annotationUsage.ownerId, workspaceId), nothingLeft)),
      eraseOwnerAuditEvents(db, workspaceId, nothingLeft),
      // Any webhook a restore or a race brought back since the deletion was requested.
      db.delete(schema.webhooks).where(and(eq(schema.webhooks.ownerId, workspaceId), nothingLeft)),
      deleteOwnerConnections(db, workspaceId, nothingLeft),
      deleteOwnerAuditStreams(db, workspaceId, nothingLeft),
      db
        .delete(schema.accountUsage)
        .where(
          and(
            eq(schema.accountUsage.ownerId, workspaceId),
            nothingLeft,
            sql`not exists (select 1 from ${schema.objects} where ${schema.objects.ownerId} = ${workspaceId})`,
          ),
        ),
    ]);
  }

  // The final batch holds only while nothing is left (`finalDeletionStep`).
  const step = await finalDeletionStep(regions, workspaceId);
  if (!step) return "pending";
  const { on, nothingLeft } = step;
  const tombstoned = sql`exists (select 1 from ${schema.tombstones} where ${schema.tombstones.kind} = 'workspace' and ${schema.tombstones.id} = ${workspaceId})`;
  const results = (await on.batch([
    on
      .delete(schema.ownerPlans)
      .where(and(eq(schema.ownerPlans.ownerId, workspaceId), nothingLeft)),
    // Single sign-on identities a restore or a race left without their provider.
    deleteOrphanSsoIdentities(on),
    on
      .insert(schema.tombstones)
      .select(sql`select 'workspace', ${workspaceId}, ${now} where ${nothingLeft}`)
      .onConflictDoNothing(),
    closeJobs(on, "workspace_deletion", workspaceId, and(nothingLeft, tombstoned) as SQL),
    on
      .delete(schema.workspaceDeletions)
      .where(and(eq(schema.workspaceDeletions.workspaceId, workspaceId), nothingLeft, tombstoned))
      .returning({ id: schema.workspaceDeletions.workspaceId }),
  ])) as unknown[];
  return (results.at(-1) as unknown[]).length === 1 ? "finished" : "pending";
}
