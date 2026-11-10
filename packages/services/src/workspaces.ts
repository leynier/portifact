// Workspaces (premium plan T1, decision 0004): naming an owner by its slug, the caller's
// workspaces, members and roles, and the operator's create, show, list and delete. Every role
// comes from `actorOn`; a user who is not a member of a workspace gets exactly what a missing one
// gives. Membership writes are D1 batches conditioned on the state the request read, and the
// triggers of the workspace_members_invitations migration refuse leaving a workspace without an admin even when a race slips past.
import {
  type AuditDetail,
  DEFAULT_REGION,
  isServiceTokenId,
  isWorkspaceId,
  type OwnerView,
  type Region,
  type WorkspaceRole,
} from "@portifact/contracts";
import { type Db, type GlobalDb, isRegion, type RegionalDb, schema } from "@portifact/db";
import {
  type Actor,
  authorize,
  checkNewWorkspace,
  checkRemoval,
  checkRoleChange,
  fail,
  ok,
  personalActor,
  type Result,
} from "@portifact/domain";
import { and, asc, eq, gt, inArray, type SQL, sql } from "drizzle-orm";
import { claimArtifacts } from "./account-data.ts";
import { actorOn } from "./actors.ts";
import { type AuditActor, auditEvent, eraseOwnerAuditEvents } from "./audit.ts";
import { eraseOwnerBrand } from "./branding.ts";
import { domainDbsOf, releaseOwnerDomains } from "./custom-domains.ts";
import { releaseOrphans } from "./maintenance.ts";
import { closeJobs } from "./outbox.ts";
import { ownerEntitlements } from "./plans.ts";

const w = schema.workspaces;
const m = schema.workspaceMembers;
const inv = schema.workspaceInvitations;

export const missingWorkspace = () => fail<never>("not_found", "Workspace not found.");

export interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  region: Region;
  createdAt: number;
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
    .select({ id: w.id, slug: w.slug, name: w.name, region: w.region, createdAt: w.createdAt })
    .from(w)
    .where(eq(w.slug, slug))
    .limit(1);
  return row ? { ...row, region: regionOf(row) } : null;
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
  return actor ? ok(actor) : missingWorkspace();
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
  return actor ? ok(actor) : missingWorkspace();
}

export interface UserWorkspace extends WorkspaceRow {
  role: WorkspaceRole;
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
        role: t.role,
      })
      .from(t)
      .innerJoin(w, eq(w.id, t.workspaceId))
      .where(eq(t.id, userId))
      .limit(1);
    return rows.map((row) => ({ ...row, region: regionOf(row) }));
  }
  const rows = await global
    .select({
      id: w.id,
      slug: w.slug,
      name: w.name,
      region: w.region,
      createdAt: w.createdAt,
      role: m.role,
    })
    .from(m)
    .innerJoin(w, eq(w.id, m.workspaceId))
    .where(eq(m.userId, userId))
    .orderBy(asc(w.name), asc(w.slug));
  return rows.map((row) => ({ ...row, region: regionOf(row) }));
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

/** SQL for the seats in use, to condition a write that takes one. */
export function seatsUsedSql(workspaceId: string, now: number, countInvitations: boolean): SQL {
  const members = sql`(select count(*) from ${m} where ${m.workspaceId} = ${workspaceId})`;
  if (!countInvitations) return members;
  return sql`(${members} + (select count(*) from ${inv} where ${inv.workspaceId} = ${workspaceId} and ${inv.expiresAt} > ${now}))`;
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
  const actor = await actorOn(global, userId, workspace.id);
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
  return ok({
    workspace: { ...workspace, role: actor.role },
    members: await members(global, workspace.id),
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
  const found = await scoped(global, input.userId, input.slug, "read");
  if (!found.ok) return found;
  return dropMember(global, found.value.workspace.id, input.userId, true, sql`1`, {
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
          global.delete(m).where(where).returning({ userId: m.userId }),
        ])
      )[1],
    () => checkRemoval("admin", 1, leaving) as Result<never>,
  );
  if (!removed.ok) return removed;
  if (removed.value.length === 0) return missingMember();
  return ok({ removed: true });
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
  input: { slug: string; name: string; adminUserId: string; now: number; id?: string },
): Promise<Result<WorkspaceRow>> {
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
      // Columns in schema order: id, slug, name, region, created by, created at, updated at.
      .select(
        sql`select ${id}, ${slug}, ${name}, ${DEFAULT_REGION}, ${input.adminUserId}, ${input.now}, ${input.now} where ${guard}`,
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
  return ok({ id, slug, name, region: DEFAULT_REGION, createdAt: input.now });
}

export interface WorkspaceDetail extends WorkspaceRow {
  createdBy: string;
  members: MemberRow[];
  invitations: { id: string; email: string; role: WorkspaceRole; expiresAt: number }[];
  seats: Seats;
  artifacts: number;
}

/** One workspace by slug or ID, for the operator. */
export async function getWorkspaceDetail(
  global: GlobalDb,
  regional: RegionalDb,
  slugOrId: string,
  now: number,
): Promise<WorkspaceDetail | null> {
  const [row] = await global
    .select()
    .from(w)
    .where(isWorkspaceId(slugOrId) ? eq(w.id, slugOrId) : eq(w.slug, slugOrId))
    .limit(1);
  if (!row) return null;
  const [count] = await regional
    .select({ count: sql<number>`count(*)` })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.ownerId, row.id));
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    region: regionOf(row),
    createdAt: row.createdAt,
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
      members: sql<number>`(select count(*) from ${m} where ${m.workspaceId} = ${w.id})`,
    })
    .from(w)
    .orderBy(asc(w.slug));
  return rows.map((row) => ({ ...row, region: regionOf(row), members: Number(row.members) }));
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
 * Deletes a workspace (operator only), the way an account is deleted: in one batch it records the
 * deletion with its job, claims every artifact for purging (they stop being served at once) and
 * deletes the workspace row, which removes its memberships and invitations. The jobs finish it
 * (`advanceWorkspaceDeletion`). A retry finds nothing left to change.
 */
export async function deleteWorkspace(
  db: RegionalDb,
  input: { workspaceId: string; now: number },
): Promise<Result<{ deleted: boolean }>> {
  const global = db.global;
  const exists = sql`exists (select 1 from ${w} where ${w.id} = ${input.workspaceId})`;
  // One batch while the workspace and its artifacts share a database, as account deletion does;
  // a second region (E5) splits it into the global claim and a regional job (decision 0005).
  const results = (await db.batch([
    workspaceDeletionJob(db, input.workspaceId, exists, input.now),
    db
      .insert(schema.workspaceDeletions)
      .select(sql`select ${input.workspaceId}, ${input.now} where ${exists}`)
      .onConflictDoNothing(),
    ...claimArtifacts(db, input.workspaceId, input.now),
    // Its webhooks stop at once, as an account's do: no foreign key ties them to their owner,
    // and their pending events and delivery log cascade from them.
    db.delete(schema.webhooks).where(and(eq(schema.webhooks.ownerId, input.workspaceId), exists)),
    db.delete(w).where(eq(w.id, input.workspaceId)).returning({ id: w.id }),
  ])) as unknown[];
  const deleted = (results.at(-1) as unknown[]).length === 1;
  if (deleted) return ok({ deleted: true });
  const [pending] = await global
    .select({ id: schema.workspaceDeletions.workspaceId })
    .from(schema.workspaceDeletions)
    .where(eq(schema.workspaceDeletions.workspaceId, input.workspaceId))
    .limit(1);
  return pending ? ok({ deleted: false }) : missingWorkspace();
}

/** Advances pending workspace deletions, oldest first. */
export async function processWorkspaceDeletions(
  db: RegionalDb,
  bucket: R2Bucket,
  now: number,
  limit = 5,
): Promise<{ processed: number; finished: number }> {
  const pending = await db.global
    .select({ workspaceId: schema.workspaceDeletions.workspaceId })
    .from(schema.workspaceDeletions)
    .orderBy(asc(schema.workspaceDeletions.requestedAt))
    .limit(limit);
  let finished = 0;
  for (const deletion of pending) {
    if ((await advanceWorkspaceDeletion(db, bucket, deletion.workspaceId, now)) === "finished") {
      finished += 1;
    }
  }
  return { processed: pending.length, finished };
}

/**
 * Advances one workspace deletion: claims artifacts that appeared since (an upload in flight),
 * leaves the claimed ones to their purge jobs, and once none is left deletes the stored objects,
 * counters, plan row and upload sessions and replaces the deletion row with a `workspace`
 * tombstone. Idempotent and safe to run concurrently. `absent` when none is pending.
 */
export async function advanceWorkspaceDeletion(
  db: RegionalDb,
  bucket: R2Bucket,
  workspaceId: string,
  now: number,
): Promise<"absent" | "pending" | "finished"> {
  const [deletion] = await db.global
    .select({ id: schema.workspaceDeletions.workspaceId })
    .from(schema.workspaceDeletions)
    .where(eq(schema.workspaceDeletions.workspaceId, workspaceId));
  if (!deletion) return "absent";
  // Its custom domains and claims go first, as an account's do: they are global, and its
  // artifacts are being purged (each purge also releases its own).
  await releaseOwnerDomains(domainDbsOf(db), workspaceId, "operator", now);
  await db.batch([...claimArtifacts(db, workspaceId, now)]);
  const [left] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.ownerId, workspaceId));
  if (Number(left?.count ?? 0) > 0) return "pending";
  // Its member and plan events in the global database go before the batch that ends the
  // deletion, so a crash in between leaves a step that runs again, never events nothing erases.
  await db.global.batch([eraseOwnerAuditEvents(db.global, workspaceId)]);

  const objects = await db
    .select({ ownerId: schema.objects.ownerId, sha256: schema.objects.sha256 })
    .from(schema.objects)
    .where(eq(schema.objects.ownerId, workspaceId));
  await releaseOrphans(db, bucket, objects, now);
  // Its brand and logo, as an account's: no foreign key ties a brand to its owner.
  await eraseOwnerBrand(db, bucket, workspaceId);

  const nothingLeft = sql`not exists (select 1 from ${schema.artifacts} where ${schema.artifacts.ownerId} = ${workspaceId})`;
  const tombstoned = sql`exists (select 1 from ${schema.tombstones} where ${schema.tombstones.kind} = 'workspace' and ${schema.tombstones.id} = ${workspaceId})`;
  const results = (await db.batch([
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
    db
      .delete(schema.ownerPlans)
      .where(and(eq(schema.ownerPlans.ownerId, workspaceId), nothingLeft)),
    eraseOwnerAuditEvents(db, workspaceId, nothingLeft),
    // Any webhook a restore or a race brought back since the deletion was requested.
    db.delete(schema.webhooks).where(and(eq(schema.webhooks.ownerId, workspaceId), nothingLeft)),
    db
      .delete(schema.accountUsage)
      .where(
        and(
          eq(schema.accountUsage.ownerId, workspaceId),
          nothingLeft,
          sql`not exists (select 1 from ${schema.objects} where ${schema.objects.ownerId} = ${workspaceId})`,
        ),
      ),
    db
      .insert(schema.tombstones)
      .select(sql`select 'workspace', ${workspaceId}, ${now} where ${nothingLeft}`)
      .onConflictDoNothing(),
    closeJobs(db, "workspace_deletion", workspaceId, and(nothingLeft, tombstoned) as SQL),
    db
      .delete(schema.workspaceDeletions)
      .where(and(eq(schema.workspaceDeletions.workspaceId, workspaceId), nothingLeft, tombstoned))
      .returning({ id: schema.workspaceDeletions.workspaceId }),
  ])) as unknown[];
  return (results.at(-1) as unknown[]).length === 1 ? "finished" : "pending";
}
