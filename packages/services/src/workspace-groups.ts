// Groups of a workspace (premium plan T3, decision 0014). Admins create, rename and delete groups
// and add or remove the workspace's members; editors (and service tokens with `artifacts:share`)
// list their IDs, names and member counts to use them in artifacts' access; members see nothing
// of groups. Groups and their members are global rows, next to `workspace_members`; the groups an
// artifact lists are regional rows (`artifact_groups`), so the read path asks the global
// database only which of the listed groups the viewer belongs to (`viewerGroups`).
import { WORKSPACE_GROUPS } from "@portifact/contracts";
import { type GlobalDb, type RegionalDb, schema } from "@portifact/db";
import {
  type Actor,
  actsForOwner,
  type Entitlements,
  fail,
  type GroupMatch,
  normalizeGroupName,
  ok,
  type Result,
  requireFeature,
  seesReaders,
} from "@portifact/domain";
import { and, asc, eq, inArray, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { auditEvent } from "./audit.ts";
import { ownerEntitlements } from "./plans.ts";
import { scoped, stillAdmin, type WorkspaceRow } from "./workspaces.ts";

const g = schema.workspaceGroups;
const gm = schema.workspaceGroupMembers;
const m = schema.workspaceMembers;
const ag = schema.artifactGroups;
const t = schema.tombstones;

export interface GroupRow {
  id: string;
  name: string;
  members: number;
  createdAt: number;
  /** Managed by the workspace's directory through SCIM: the dashboard does not change it. */
  directory: boolean;
}

export interface GroupMemberRow {
  userId: string;
  name: string;
  email: string;
  role: "admin" | "editor" | "member";
  addedAt: number;
}

const missingGroup = () => fail<never>("not_found", "Group not found.");
const missingMember = () => fail<never>("not_found", "Member not found.");
const changedMeanwhile = () =>
  fail<never>("version_conflict", "The group changed meanwhile. Reload and try again.");
/**
 * A group the workspace's directory manages (decision 0017, "Groups and roles") is changed only
 * by the directory: a dashboard change would be overwritten by the next sync, or would fight it.
 */
const directoryRefusal = () =>
  fail<never>(
    "forbidden",
    "Your organization's directory manages this group. Change it in the directory.",
  );
/** Holds while the group is not directory-managed, inside a write's batch. */
const notDirectory = (groupId: string) =>
  sql`not exists (select 1 from ${schema.scimGroups} where ${schema.scimGroups.groupId} = ${groupId})`;
const nameTaken = () =>
  fail<never>("invalid_input", "The workspace already has a group with this name.");

function hex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const newGroupId = () => `wg_${hex(16)}`;
const newGroupMemberId = () => `wgm_${hex(16)}`;

function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (e.message.includes("UNIQUE constraint failed")) return true;
  }
  return false;
}

// Qualified by hand: Drizzle leaves select-field columns unqualified, so `${g.id}` would bind to
// the subquery's own table.
const memberCount = sql<number>`(select count(*) from ${gm} where ${gm.groupId} = "workspace_groups"."id")`;
const directoryManaged = sql<number>`exists (select 1 from ${schema.scimGroups} where ${schema.scimGroups.groupId} = "workspace_groups"."id")`;

async function groupsOf(global: GlobalDb, workspaceId: string): Promise<GroupRow[]> {
  const rows = await global
    .select({
      id: g.id,
      name: g.name,
      members: memberCount,
      createdAt: g.createdAt,
      directory: directoryManaged,
    })
    .from(g)
    .where(eq(g.workspaceId, workspaceId))
    .orderBy(sql`lower(${g.name})`, asc(g.id));
  return rows.map((row) => ({
    ...row,
    members: Number(row.members),
    directory: Number(row.directory) === 1,
  }));
}

async function groupRow(global: GlobalDb, workspaceId: string, groupId: string) {
  const [row] = await global
    .select({
      id: g.id,
      name: g.name,
      members: memberCount,
      createdAt: g.createdAt,
      directory: directoryManaged,
    })
    .from(g)
    .where(and(eq(g.id, groupId), eq(g.workspaceId, workspaceId)))
    .limit(1);
  return row
    ? { ...row, members: Number(row.members), directory: Number(row.directory) === 1 }
    : null;
}

export interface GroupList {
  workspace: WorkspaceRow;
  groups: GroupRow[];
  /** The plan includes `workspaces`, so groups can be created and granted. */
  available: boolean;
}

/**
 * A workspace's groups by name, with member counts and never members: for admins and editors (the
 * `access` action), and for a service token only with `artifacts:share`, which is what using them
 * in access takes. A member gets `forbidden`, anyone else what a missing workspace gives.
 */
export async function listWorkspaceGroups(
  global: GlobalDb,
  input: { userId: string; slug: string; now: number },
): Promise<Result<GroupList>> {
  const found = await scoped(global, input.userId, input.slug, "access");
  if (!found.ok) return found;
  const { workspace, actor } = found.value;
  if (!seesReaders(actor.token)) {
    return fail("forbidden", "Listing groups needs the artifacts:share scope.");
  }
  const owner = await ownerEntitlements(global, workspace.id, input.now);
  return ok({
    workspace,
    groups: await groupsOf(global, workspace.id),
    available: requireFeature(owner, "workspaces").ok,
  });
}

/** One group with its members' names and addresses, for admins (dashboard session only). */
export async function getWorkspaceGroup(
  global: GlobalDb,
  input: { userId: string; slug: string; groupId: string },
): Promise<Result<{ group: GroupRow; members: GroupMemberRow[] }>> {
  const found = await scoped(global, input.userId, input.slug, "members");
  if (!found.ok) return found;
  const group = await groupRow(global, found.value.workspace.id, input.groupId);
  if (!group) return missingGroup();
  const members = await global
    .select({
      userId: gm.userId,
      name: schema.users.name,
      email: schema.users.email,
      role: m.role,
      addedAt: gm.createdAt,
    })
    .from(gm)
    .innerJoin(m, and(eq(m.workspaceId, gm.workspaceId), eq(m.userId, gm.userId)))
    .innerJoin(schema.users, eq(schema.users.id, gm.userId))
    .where(eq(gm.groupId, group.id))
    .orderBy(asc(schema.users.name), asc(gm.userId));
  return ok({ group, members });
}

function groupEvent(
  global: GlobalDb,
  input: { workspaceId: string; groupId: string; userId: string; now: number },
  kind: "group.created" | "group.renamed" | "group.deleted",
  condition: SQL,
) {
  return auditEvent(
    global,
    {
      ownerId: input.workspaceId,
      kind,
      actor: { type: "user", id: input.userId },
      targetId: input.groupId,
      detail: {},
      now: input.now,
    },
    condition,
  );
}

function groupMemberEvent(
  global: GlobalDb,
  input: { workspaceId: string; groupId: string; memberId: string; userId: string; now: number },
  kind: "group.member_added" | "group.member_removed",
  condition: SQL,
) {
  return auditEvent(
    global,
    {
      ownerId: input.workspaceId,
      kind,
      actor: { type: "user", id: input.userId },
      targetId: input.memberId,
      detail: { group: input.groupId },
      now: input.now,
    },
    condition,
  );
}

/**
 * Creates a group, for an admin on a plan with `workspaces`. The insert checks the cap and the
 * caller's role itself; the unique index refuses a name the workspace already has.
 */
export async function createWorkspaceGroup(
  global: GlobalDb,
  input: { userId: string; slug: string; name: string; now: number },
): Promise<Result<GroupRow>> {
  const found = await scoped(global, input.userId, input.slug, "members");
  if (!found.ok) return found;
  const { workspace } = found.value;
  const gate = requireFeature(
    await ownerEntitlements(global, workspace.id, input.now),
    "workspaces",
  );
  if (!gate.ok) return gate;
  const name = normalizeGroupName(input.name);
  if (!name.ok) return name;
  const id = newGroupId();
  const cap = WORKSPACE_GROUPS.perWorkspace;
  try {
    await global.batch([
      global
        .insert(g)
        // Columns in schema order: id, workspace, name, created, updated.
        .select(
          sql`select ${id}, ${workspace.id}, ${name.value}, ${input.now}, ${input.now} where (select count(*) from ${g} where ${g.workspaceId} = ${workspace.id}) < ${cap} and ${stillAdmin(workspace.id, input.userId)}`,
        ),
      groupEvent(
        global,
        { workspaceId: workspace.id, groupId: id, userId: input.userId, now: input.now },
        "group.created",
        sql`exists (select 1 from ${g} where ${g.id} = ${id})`,
      ),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) return nameTaken();
    throw error;
  }
  const row = await groupRow(global, workspace.id, id);
  if (row) return ok(row);
  const again = await scoped(global, input.userId, input.slug, "members");
  if (!again.ok) return again;
  if ((await groupsOf(global, workspace.id)).length >= cap) {
    return fail("quota_exceeded", `A workspace can have at most ${cap} groups.`);
  }
  return changedMeanwhile();
}

/** Renames a group, for an admin. Never gated on the plan: a name grants nothing. */
export async function renameWorkspaceGroup(
  global: GlobalDb,
  input: { userId: string; slug: string; groupId: string; name: string; now: number },
): Promise<Result<GroupRow>> {
  const found = await scoped(global, input.userId, input.slug, "members");
  if (!found.ok) return found;
  const { workspace } = found.value;
  const name = normalizeGroupName(input.name);
  if (!name.ok) return name;
  const current = await groupRow(global, workspace.id, input.groupId);
  if (!current) return missingGroup();
  if (current.directory) return directoryRefusal();
  if (current.name === name.value) return ok(current);
  const where = and(
    eq(g.id, current.id),
    eq(g.workspaceId, workspace.id),
    eq(g.name, current.name),
    stillAdmin(workspace.id, input.userId),
    notDirectory(current.id),
  ) as SQL;
  let updated: unknown[];
  try {
    [, updated] = await global.batch([
      groupEvent(
        global,
        { workspaceId: workspace.id, groupId: current.id, userId: input.userId, now: input.now },
        "group.renamed",
        sql`exists (select 1 from ${g} where ${where})`,
      ),
      global
        .update(g)
        .set({ name: name.value, updatedAt: input.now })
        .where(where)
        .returning({ id: g.id }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) return nameTaken();
    throw error;
  }
  if (updated.length === 0) {
    const again = await scoped(global, input.userId, input.slug, "members");
    return again.ok ? changedMeanwhile() : again;
  }
  const row = await groupRow(global, workspace.id, current.id);
  return row ? ok(row) : missingGroup();
}

/**
 * Deletes a group, for an admin, whatever the plan. Its memberships go by cascade in the same
 * statement, and a `workspace_group` tombstone keeps a restore from bringing it back. Artifacts in
 * other regions may still list it: those rows grant nothing (`viewerGroups` reads the global
 * membership) and the maintenance scan removes them (`pruneArtifactGroups`).
 */
export async function deleteWorkspaceGroup(
  global: GlobalDb,
  input: { userId: string; slug: string; groupId: string; now: number },
): Promise<Result<true>> {
  const found = await scoped(global, input.userId, input.slug, "members");
  if (!found.ok) return found;
  const { workspace } = found.value;
  const current = await groupRow(global, workspace.id, input.groupId);
  if (!current) return missingGroup();
  if (current.directory) return directoryRefusal();
  const target = and(
    eq(g.id, current.id),
    eq(g.workspaceId, workspace.id),
    stillAdmin(workspace.id, input.userId),
    notDirectory(current.id),
  ) as SQL;
  const [, , deleted] = await global.batch([
    groupEvent(
      global,
      { workspaceId: workspace.id, groupId: current.id, userId: input.userId, now: input.now },
      "group.deleted",
      sql`exists (select 1 from ${g} where ${target})`,
    ),
    global
      .insert(t)
      .select(sql`select 'workspace_group', ${g.id}, ${input.now} from ${g} where ${target}`)
      .onConflictDoNothing(),
    global.delete(g).where(target).returning({ id: g.id }),
  ]);
  if (deleted.length > 0) return ok(true);
  const again = await scoped(global, input.userId, input.slug, "members");
  return again.ok ? missingGroup() : again;
}

/**
 * Adds a member of the workspace to a group, for an admin on a plan with `workspaces` (adding
 * someone widens what they read). The insert itself checks that the caller is still an admin,
 * that the person is still a member (the composite foreign key refuses anyone else) and the cap.
 */
export async function addGroupMember(
  global: GlobalDb,
  input: { userId: string; slug: string; groupId: string; memberId: string; now: number },
): Promise<Result<GroupMemberRow[]>> {
  const found = await scoped(global, input.userId, input.slug, "members");
  if (!found.ok) return found;
  const { workspace } = found.value;
  const gate = requireFeature(
    await ownerEntitlements(global, workspace.id, input.now),
    "workspaces",
  );
  if (!gate.ok) return gate;
  const group = await groupRow(global, workspace.id, input.groupId);
  if (!group) return missingGroup();
  if (group.directory) return directoryRefusal();
  const [member] = await global
    .select({ userId: m.userId })
    .from(m)
    .where(and(eq(m.workspaceId, workspace.id), eq(m.userId, input.memberId)))
    .limit(1);
  if (!member) return missingMember();
  const id = newGroupMemberId();
  const cap = WORKSPACE_GROUPS.membersPerGroup;
  const insertable = sql`exists (select 1 from ${m} where ${m.workspaceId} = ${workspace.id} and ${m.userId} = ${input.memberId}) and exists (select 1 from ${g} where ${g.id} = ${group.id} and ${g.workspaceId} = ${workspace.id}) and (select count(*) from ${gm} where ${gm.groupId} = ${group.id}) < ${cap} and ${stillAdmin(workspace.id, input.userId)} and ${notDirectory(group.id)}`;
  await global.batch([
    global
      .insert(gm)
      // Columns in schema order: id, group, workspace, user, created.
      .select(
        sql`select ${id}, ${group.id}, ${workspace.id}, ${input.memberId}, ${input.now} where ${insertable}`,
      )
      .onConflictDoNothing(),
    groupMemberEvent(
      global,
      {
        workspaceId: workspace.id,
        groupId: group.id,
        memberId: input.memberId,
        userId: input.userId,
        now: input.now,
      },
      "group.member_added",
      sql`exists (select 1 from ${gm} where ${gm.id} = ${id})`,
    ),
  ]);
  const detail = await getWorkspaceGroup(global, input);
  if (!detail.ok) return detail;
  if (detail.value.members.some((row) => row.userId === input.memberId)) {
    return ok(detail.value.members);
  }
  if (detail.value.group.members >= cap) {
    return fail("quota_exceeded", `A group can have at most ${cap} members.`);
  }
  return missingMember();
}

/**
 * Removes a person from a group, for an admin, whatever the plan, with a tombstone of the row so a
 * restore cannot bring it back. Their read sessions renew against the new membership within the
 * claims' 60 seconds; new sessions are refused at once.
 */
export async function removeGroupMember(
  global: GlobalDb,
  input: { userId: string; slug: string; groupId: string; memberId: string; now: number },
): Promise<Result<true>> {
  const found = await scoped(global, input.userId, input.slug, "members");
  if (!found.ok) return found;
  const { workspace } = found.value;
  const group = await groupRow(global, workspace.id, input.groupId);
  if (!group) return missingGroup();
  if (group.directory) return directoryRefusal();
  const target = and(
    eq(gm.groupId, group.id),
    eq(gm.workspaceId, workspace.id),
    eq(gm.userId, input.memberId),
    stillAdmin(workspace.id, input.userId),
    notDirectory(group.id),
  ) as SQL;
  const [, , deleted] = await global.batch([
    groupMemberEvent(
      global,
      {
        workspaceId: workspace.id,
        groupId: group.id,
        memberId: input.memberId,
        userId: input.userId,
        now: input.now,
      },
      "group.member_removed",
      sql`exists (select 1 from ${gm} where ${target})`,
    ),
    global
      .insert(t)
      .select(
        sql`select 'workspace_group_member', ${gm.id}, ${input.now} from ${gm} where ${target}`,
      )
      .onConflictDoNothing(),
    global.delete(gm).where(target).returning({ id: gm.id }),
  ]);
  if (deleted.length > 0) return ok(true);
  const again = await scoped(global, input.userId, input.slug, "members");
  return again.ok ? missingMember() : again;
}

/**
 * SQL for the scope the listed groups among `groupIds` give on the artifact `artifactId` (a column
 * or value), or null when none of them is listed: the widest of each group's exception, else the
 * artifact's `setting` (`commentScope`, decision 0014). Evaluated on the live regional rows, in
 * the same statement as the read or write it guards.
 */
export function groupScopeSql(
  artifactId: SQL | SQLiteColumn,
  groupIds: readonly string[],
  setting: SQL,
): SQL {
  if (groupIds.length === 0) return sql`null`;
  const ids = sql.join(
    groupIds.map((id) => sql`${id}`),
    sql`, `,
  );
  return sql`(select case when count(*) = 0 then null when max(coalesce(${ag.commentVisibility}, ${setting}) = 'all') = 1 then 'all' else 'own' end from ${ag} where ${ag.artifactId} = ${artifactId} and ${ag.groupId} in (${ids}))`;
}

/** The group IDs an artifact lists, from its region. */
export async function artifactGroupRows(db: RegionalDb, artifactId: string) {
  return db
    .select({ groupId: ag.groupId, commentVisibility: ag.commentVisibility })
    .from(ag)
    .where(eq(ag.artifactId, artifactId))
    .orderBy(asc(ag.groupId));
}

/**
 * The listed groups `actor` belongs to, for `canRead` and `commentScope` (decision 0014). Reads
 * nothing for a personal artifact, for someone who is not a member of the owning workspace, for
 * the owner side (the role admits them and they see every comment), without the plan's
 * `workspaces` (groups then grant nothing) or when the artifact lists no group: one bounded
 * global read otherwise. A listed group that was deleted, or belongs to another workspace, never
 * matches.
 */
export async function viewerGroups(
  global: GlobalDb,
  input: {
    ownerId: string;
    actor: Actor | null;
    listed: readonly { groupId: string; commentVisibility: "all" | "own" | null }[];
    entitlements: Entitlements;
  },
): Promise<GroupMatch | undefined> {
  const { actor } = input;
  if (actor === null || actor.ownerId !== input.ownerId || actor.token) return undefined;
  const featureAvailable = requireFeature(input.entitlements, "workspaces").ok;
  if (!featureAvailable || input.listed.length === 0 || actsForOwner(actor, input.ownerId)) {
    return { featureAvailable, matched: [] };
  }
  const ids = await viewerGroupIds(
    global,
    input.ownerId,
    actor.userId,
    input.listed.map((row) => row.groupId),
  );
  return {
    featureAvailable,
    matched: input.listed
      .filter((row) => ids.has(row.groupId))
      .map((row) => ({ id: row.groupId, commentVisibility: row.commentVisibility })),
  };
}

/**
 * Which of `groupIds` (all of the workspace's when omitted) the user is a member of in the
 * workspace: one indexed read of the global database.
 */
export async function viewerGroupIds(
  global: GlobalDb,
  workspaceId: string,
  userId: string,
  groupIds?: readonly string[],
): Promise<Set<string>> {
  if (groupIds?.length === 0) return new Set();
  const rows = await global
    .select({ groupId: gm.groupId })
    .from(gm)
    .where(
      and(
        eq(gm.workspaceId, workspaceId),
        eq(gm.userId, userId),
        groupIds === undefined ? undefined : inArray(gm.groupId, [...groupIds]),
      ),
    );
  return new Set(rows.map((row) => row.groupId));
}

/**
 * Which of `groupIds` each of `userIds` belongs to in the workspace, in one batched global read
 * (approval reviews' `participation`, decision 0014). Reads nothing when either list is empty.
 */
export async function groupMembershipsOf(
  global: GlobalDb,
  workspaceId: string,
  userIds: readonly string[],
  groupIds: readonly string[],
): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  if (userIds.length === 0 || groupIds.length === 0) return found;
  const rows = await global
    .select({ userId: gm.userId, groupId: gm.groupId })
    .from(gm)
    .where(
      and(
        eq(gm.workspaceId, workspaceId),
        inArray(gm.userId, [...userIds]),
        inArray(gm.groupId, [...groupIds]),
      ),
    );
  for (const row of rows) found.set(row.userId, [...(found.get(row.userId) ?? []), row.groupId]);
  return found;
}

/** Names and member counts of the owner's groups among `groupIds`, for the access view. */
export async function groupSummaries(
  global: GlobalDb,
  workspaceId: string,
  groupIds: readonly string[],
): Promise<Map<string, { name: string; members: number }>> {
  const summaries = new Map<string, { name: string; members: number }>();
  if (groupIds.length === 0) return summaries;
  const rows = await global
    .select({ id: g.id, name: g.name, members: memberCount })
    .from(g)
    .where(and(eq(g.workspaceId, workspaceId), inArray(g.id, [...groupIds])));
  for (const row of rows) summaries.set(row.id, { name: row.name, members: Number(row.members) });
  return summaries;
}

/**
 * The maintenance scan of artifact group rows (decision 0014, "Regions"): takes up to `limit`
 * rows least recently checked, asks the global database which of their groups still exist in the
 * artifact owner's workspace, deletes the rows whose group is gone and marks the others checked.
 * Every row is reached in turn, and no batch spans the two databases.
 */
export async function pruneArtifactGroups(
  db: RegionalDb,
  now: number,
  limit: number = WORKSPACE_GROUPS.scanBatch,
): Promise<{ checked: number; removed: number }> {
  const rows = await db
    .select({ artifactId: ag.artifactId, groupId: ag.groupId, ownerId: schema.artifacts.ownerId })
    .from(ag)
    .innerJoin(schema.artifacts, eq(schema.artifacts.id, ag.artifactId))
    .where(or(isNull(ag.checkedAt), lt(ag.checkedAt, now)))
    .orderBy(sql`${ag.checkedAt} is not null`, asc(ag.checkedAt))
    .limit(limit);
  if (rows.length === 0) return { checked: 0, removed: 0 };
  const alive = new Set<string>();
  const ids = [...new Set(rows.map((row) => row.groupId))];
  for (let i = 0; i < ids.length; i += 90) {
    const found = await db.global
      .select({ id: g.id, workspaceId: g.workspaceId })
      .from(g)
      .where(inArray(g.id, ids.slice(i, i + 90)));
    for (const row of found) alive.add(`${row.workspaceId}/${row.id}`);
  }
  const gone = rows.filter((row) => !alive.has(`${row.ownerId}/${row.groupId}`));
  const kept = rows.filter((row) => alive.has(`${row.ownerId}/${row.groupId}`));
  const pair = (row: { artifactId: string; groupId: string }) =>
    and(eq(ag.artifactId, row.artifactId), eq(ag.groupId, row.groupId)) as SQL;
  let removed = 0;
  for (let i = 0; i < gone.length; i += 40) {
    const deleted = await db
      .delete(ag)
      .where(or(...gone.slice(i, i + 40).map(pair)))
      .returning({ groupId: ag.groupId });
    removed += deleted.length;
  }
  for (let i = 0; i < kept.length; i += 40) {
    await db
      .update(ag)
      .set({ checkedAt: now })
      .where(or(...kept.slice(i, i + 40).map(pair)));
  }
  return { checked: rows.length, removed };
}

/**
 * How long tombstones of deleted groups and removed group memberships are kept: the D1 Time
 * Travel window. A restore cannot go further back, so a membership removed before then is
 * already gone at every point a restore can reach, and its tombstone guards nothing.
 */
export const GROUP_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const PRUNE_TOMBSTONES = { batch: 500, rounds: 4 } as const;

/**
 * The maintenance scan of group tombstones (decision 0014, "Restores"): deletes `workspace_group`
 * and `workspace_group_member` tombstones older than `GROUP_TOMBSTONE_RETENTION_MS`, oldest
 * first, `batch` rows per statement and at most `rounds` statements per run, each round after
 * the last key the previous one deleted. No other kind of tombstone is ever pruned.
 */
export async function pruneGroupTombstones(
  global: GlobalDb,
  now: number,
  limits: { batch: number; rounds: number } = PRUNE_TOMBSTONES,
): Promise<{ deleted: number; queries: number }> {
  const before = now - GROUP_TOMBSTONE_RETENTION_MS;
  let cursor: { deletedAt: number; kind: string; id: string } | null = null;
  let deleted = 0;
  let queries = 0;
  for (let round = 0; round < limits.rounds; round++) {
    const after: SQL = cursor
      ? sql`and (${t.deletedAt}, ${t.kind}, ${t.id}) > (${cursor.deletedAt}, ${cursor.kind}, ${cursor.id})`
      : sql``;
    const rows: { kind: string; id: string; deleted_at: number }[] = await global.all(
      sql`delete from ${t} where (${t.kind}, ${t.id}) in (select ${t.kind}, ${t.id} from ${t} where ${t.kind} in ('workspace_group', 'workspace_group_member', 'comment_thread') and ${t.deletedAt} < ${before} ${after} order by ${t.deletedAt}, ${t.kind}, ${t.id} limit ${limits.batch}) returning ${t.kind}, ${t.id}, ${t.deletedAt}`,
    );
    queries++;
    deleted += rows.length;
    const key = (row: { kind: string; id: string; deleted_at: number }) =>
      `${String(row.deleted_at).padStart(16, "0")}\u0000${row.kind}\u0000${row.id}`;
    const last = rows.toSorted((x, y) => (key(x) < key(y) ? -1 : 1)).at(-1);
    if (!last || rows.length < limits.batch) break;
    cursor = { deletedAt: last.deleted_at, kind: last.kind, id: last.id };
  }
  return { deleted, queries };
}
