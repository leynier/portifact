// SCIM groups and the group-to-role mapping (premium plan E2, decision 0017, "Groups and roles").
// A directory's groups are workspace groups (decision 0014) marked as directory-managed
// (`scim_groups`); who the directory says is in each, pending people included, is
// `scim_group_members`, and `workspace_group_members` holds the members among them who are
// workspace members. A person who joins later gets their group rows from there in the batch of
// the join (`joinGroupStatements`). A group push never creates a workspace membership, lifts a
// removal or changes `active`: it only maps directory users to members the workspace already has.
//
// Roles: the workspace's admins map at most one directory-managed group to `editor` and one to
// `admin` (`workspace_scim`). A person's role is the highest their mapped groups give, else
// `member`, recomputed in the same batch as every change of their groups or of the mapping
// (`roleSyncStatements`). A role is changed only for someone the mapping gives one to now, or gave
// one to before (`scim_users.mapped_role`), so a role an admin set by hand for anyone else is
// never touched; for someone in a mapped group, the directory wins at the next change of their
// groups. The last-admin trigger refuses a batch that would leave no admin, so nothing is
// half-applied. Every table here is global.
import { SCIM, type ScimSettingsUpdate, WORKSPACE_GROUPS } from "@portifact/contracts";
import { type GlobalDb, schema } from "@portifact/db";
import {
  applyScimGroupPatch,
  fail,
  ok,
  type Result,
  type ScimGroupFilter,
  type ScimGroupInput,
  type ScimGroupRecord,
  type ScimResult,
  scimFail,
} from "@portifact/domain";
import { and, asc, eq, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { type AuditActor, auditEvent } from "./audit.ts";
import { hex } from "./objects.ts";
import type { ScimCaller } from "./scim.ts";

const g = schema.workspaceGroups;
const gm = schema.workspaceGroupMembers;
const m = schema.workspaceMembers;
const su = schema.scimUsers;
const sg = schema.scimGroups;
const sgm = schema.scimGroupMembers;
const ws = schema.workspaceScim;
const st = schema.scimTokens;
const t = schema.tombstones;

const randomHex = (bytes: number) => hex(crypto.getRandomValues(new Uint8Array(bytes)).buffer);
const newGroupId = () => `wg_${randomHex(16)}`;

/** A JSON list bound as one parameter and read back with `json_each`, whatever its length. */
const jsonList = (values: readonly string[]) =>
  sql`(select value from json_each(${JSON.stringify(values)}))`;

function causeIncludes(error: unknown, text: string): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (e.message.includes(text)) return true;
  }
  return false;
}

const LAST_ADMIN =
  "This change would leave the workspace without an admin: it is the last admin's role. Make another member an admin in Portifact first.";

// Roles ---------------------------------------------------------------------------------------

/**
 * The role the mapping gives `user` (an SQL expression naming a user ID) in workspace `W`:
 * `admin` when they are in the group mapped to admin, else `editor` when in the editor group,
 * else `member`. `excluding` leaves one group out, for a batch that is about to delete it.
 */
function desiredRoleSql(W: string, user: SQL, excluding: string | null): SQL {
  const inMapped = (column: "admin_group_id" | "editor_group_id") =>
    sql`exists (select 1 from ${gm} as "dg" inner join ${ws} as "dm" on "dm"."workspace_id" = "dg"."workspace_id" where "dg"."workspace_id" = ${W} and "dg"."user_id" = ${user} and "dg"."group_id" = "dm".${sql.raw(`"${column}"`)}${excluding === null ? sql`` : sql` and "dg"."group_id" <> ${excluding}`})`;
  return sql`(case when ${inMapped("admin_group_id")} then 'admin' when ${inMapped("editor_group_id")} then 'editor' else 'member' end)`;
}

/**
 * Recomputes the role of the workspace's members among `who` (a subquery of user IDs) from the
 * mapping, in the batch of the change that may move it: the audit event (`member.role_changed`)
 * from the row, the role, then `scim_users.mapped_role`. Only for someone the mapping gives a role
 * to now or gave one to before.
 */
export function roleSyncStatements(
  global: GlobalDb,
  input: {
    workspaceId: string;
    who: SQL;
    actor: AuditActor;
    now: number;
    condition: SQL;
    excluding?: string | null;
  },
): BatchItem<"sqlite">[] {
  const W = input.workspaceId;
  const excluding = input.excluding ?? null;
  const eligible = (user: SQL, role: SQL) => {
    const desired = desiredRoleSql(W, user, excluding);
    return sql`${user} in ${input.who} and ${role} <> ${desired} and (${desired} <> 'member' or exists (select 1 from ${su} as "ds" where "ds"."workspace_id" = ${W} and "ds"."user_id" = ${user} and "ds"."mapped_role" is not null)) and ${input.condition}`;
  };
  const actorType = input.actor.type;
  const actorId =
    input.actor.type === "user" || input.actor.type === "directory" ? input.actor.id : null;
  const row = sql`"rm"."user_id"`;
  const self = sql`"workspace_members"."user_id"`;
  const linked = sql`"scim_users"."user_id"`;
  return [
    // Columns in schema order: id, owner, at, kind, actor type, actor, target, artifact, detail.
    global
      .insert(schema.auditEvents)
      .select(
        sql`select 'ae_' || lower(hex(randomblob(12))), ${W}, ${input.now}, 'member.role_changed', ${actorType}, ${actorId}, ${row}, null, json_object('from', "rm"."role", 'to', ${desiredRoleSql(W, row, excluding)}) from ${m} as "rm" where "rm"."workspace_id" = ${W} and ${eligible(row, sql`"rm"."role"`)}`,
      ),
    global
      .update(m)
      .set({ role: sql`${desiredRoleSql(W, self, excluding)}`, updatedAt: input.now })
      .where(
        sql`"workspace_members"."workspace_id" = ${W} and ${eligible(self, sql`"workspace_members"."role"`)}`,
      ),
    global
      .update(su)
      .set({
        mappedRole: sql`(case ${desiredRoleSql(W, linked, excluding)} when 'member' then null else ${desiredRoleSql(W, linked, excluding)} end)`,
      })
      .where(
        sql`"scim_users"."workspace_id" = ${W} and ${linked} in ${input.who} and exists (select 1 from ${m} as "sm" where "sm"."workspace_id" = ${W} and "sm"."user_id" = ${linked}) and ${input.condition}`,
      ),
  ];
}

/**
 * The statements that give a person who just became a workspace member the groups the directory
 * listed them in (as a directory user linked to their account), with their events, and the role
 * those groups map to. For the batch of the join, after the membership insert and the link.
 */
export function joinGroupStatements(
  global: GlobalDb,
  input: { workspaceId: string; userId: string; actor: AuditActor; now: number; condition: SQL },
): BatchItem<"sqlite">[] {
  const W = input.workspaceId;
  const listed = sql`from ${sgm} as "jg" inner join ${su} as "js" on "js"."id" = "jg"."scim_user_id" where "js"."workspace_id" = ${W} and "js"."user_id" = ${input.userId} and exists (select 1 from ${m} as "jm" where "jm"."workspace_id" = ${W} and "jm"."user_id" = ${input.userId}) and not exists (select 1 from ${gm} as "jw" where "jw"."group_id" = "jg"."group_id" and "jw"."user_id" = ${input.userId}) and ${input.condition}`;
  const actorId =
    input.actor.type === "user" || input.actor.type === "directory" ? input.actor.id : null;
  return [
    global
      .insert(schema.auditEvents)
      .select(
        sql`select 'ae_' || lower(hex(randomblob(12))), ${W}, ${input.now}, 'group.member_added', ${input.actor.type}, ${actorId}, ${input.userId}, null, json_object('group', "jg"."group_id") ${listed}`,
      ),
    global
      .insert(gm)
      // Columns in schema order: id, group, workspace, user, created.
      .select(
        sql`select 'wgm_' || lower(hex(randomblob(16))), "jg"."group_id", ${W}, ${input.userId}, ${input.now} ${listed}`,
      )
      .onConflictDoNothing(),
    ...roleSyncStatements(global, {
      workspaceId: W,
      who: sql`(select ${input.userId})`,
      actor: input.actor,
      now: input.now,
      condition: input.condition,
    }),
  ];
}

// Reading -------------------------------------------------------------------------------------

type GroupRow = {
  id: string;
  name: string;
  externalId: string | null;
  writeId: string;
  createdAt: number;
  updatedAt: number;
};

async function groupRow(global: GlobalDb, caller: ScimCaller, id: string) {
  const [row] = await global
    .select({
      id: g.id,
      name: g.name,
      externalId: sg.externalId,
      writeId: sg.writeId,
      createdAt: sg.createdAt,
      updatedAt: sg.updatedAt,
    })
    .from(sg)
    .innerJoin(g, eq(g.id, sg.groupId))
    .where(and(eq(sg.groupId, id), eq(sg.workspaceId, caller.workspaceId)))
    .limit(1);
  return (row as GroupRow | undefined) ?? null;
}

async function membersOf(global: GlobalDb, groupIds: readonly string[]) {
  if (groupIds.length === 0) return new Map<string, { id: string; email: string }[]>();
  const rows = await global
    .select({ groupId: sgm.groupId, id: su.id, email: su.email })
    .from(sgm)
    .innerJoin(su, eq(su.id, sgm.scimUserId))
    .where(sql`${sgm.groupId} in ${jsonList(groupIds)}`)
    .orderBy(asc(sgm.createdAt), asc(su.id));
  const byGroup = new Map<string, { id: string; email: string }[]>();
  for (const row of rows) {
    const list = byGroup.get(row.groupId) ?? [];
    list.push({ id: row.id, email: row.email });
    byGroup.set(row.groupId, list);
  }
  return byGroup;
}

function record(row: GroupRow, members: { id: string; email: string }[]): ScimGroupRecord {
  return {
    id: row.id,
    displayName: row.name,
    externalId: row.externalId,
    members,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const notFound = () => scimFail<never>(404, "Resource not found.");

/** One of this workspace's directory-managed groups; any other ID answers like a missing one. */
export async function getScimGroup(
  global: GlobalDb,
  caller: ScimCaller,
  id: string,
): Promise<ScimResult<ScimGroupRecord>> {
  const row = await groupRow(global, caller, id);
  if (!row) return notFound();
  const members = await membersOf(global, [row.id]);
  return { ok: true, value: record(row, members.get(row.id) ?? []) };
}

/**
 * A page of the workspace's directory-managed groups, oldest first, optionally filtered. Groups
 * made in the dashboard are not SCIM resources: the directory neither sees nor changes them.
 * Bounded by the groups cap and the page size.
 */
export async function listScimGroups(
  global: GlobalDb,
  caller: ScimCaller,
  input: { filter: ScimGroupFilter | null; startIndex: number; count: number; members: boolean },
): Promise<{ groups: ScimGroupRecord[]; total: number }> {
  const where = and(
    eq(sg.workspaceId, caller.workspaceId),
    input.filter === null
      ? undefined
      : input.filter.attribute === "displayName"
        ? sql`lower(${g.name}) = lower(${input.filter.value})`
        : eq(sg.externalId, input.filter.value),
  );
  const [total] = await global
    .select({ count: sql<number>`count(*)` })
    .from(sg)
    .innerJoin(g, eq(g.id, sg.groupId))
    .where(where);
  const rows =
    input.count === 0
      ? []
      : ((await global
          .select({
            id: g.id,
            name: g.name,
            externalId: sg.externalId,
            writeId: sg.writeId,
            createdAt: sg.createdAt,
            updatedAt: sg.updatedAt,
          })
          .from(sg)
          .innerJoin(g, eq(g.id, sg.groupId))
          .where(where)
          .orderBy(asc(sg.createdAt), asc(sg.groupId))
          .limit(input.count)
          .offset(input.startIndex - 1)) as GroupRow[]);
  const members = input.members
    ? await membersOf(
        global,
        rows.map((row) => row.id),
      )
    : new Map();
  return {
    groups: rows.map((row) => record(row, members.get(row.id) ?? [])),
    total: Number(total?.count ?? 0),
  };
}

// Writing -------------------------------------------------------------------------------------

/** The token still exists and has not expired: every directory write is conditioned on it. */
function tokenHolds(caller: ScimCaller, now: number): SQL {
  return sql`exists (select 1 from ${st} where ${st.id} = ${caller.tokenId} and ${st.workspaceId} = ${caller.workspaceId} and ${st.expiresAt} > ${now})`;
}

/**
 * The membership statements of one group write, after the claim, in this order (decision 0017,
 * "Groups and roles", bounds): the directory's list replaced (`scim_group_members`), then the
 * workspace group rows brought in line with it (only for directory users linked to an account
 * that is a workspace member: a push never creates a membership), each removal with its event and
 * a `workspace_group_member` tombstone and each addition with its event, then the roles of
 * everyone whose groups changed. Every statement binds the member list as one JSON parameter, so
 * a list at the cap (500 IDs) is one bound parameter, never 500; with the claim and a rename
 * the batch is at most 13 statements whatever the list's length, each with a few dozen bound
 * parameters at most (D1 allows 100).
 */
function membershipStatements(
  global: GlobalDb,
  input: {
    caller: ScimCaller;
    groupId: string;
    members: string[];
    affected: string[];
    claim: SQL;
    now: number;
  },
): BatchItem<"sqlite">[] {
  const W = input.caller.workspaceId;
  const G = input.groupId;
  const actor: AuditActor = { type: "directory", id: input.caller.tokenId };
  const desiredUsers = sql`(select "du"."user_id" from ${sgm} as "dg" inner join ${su} as "du" on "du"."id" = "dg"."scim_user_id" where "dg"."group_id" = ${G} and "du"."user_id" is not null and exists (select 1 from ${m} as "dm" where "dm"."workspace_id" = ${W} and "dm"."user_id" = "du"."user_id"))`;
  const leaving = sql`${gm.groupId} = ${G} and ${gm.userId} not in ${desiredUsers} and ${input.claim}`;
  const joining = sql`from ${sgm} as "ng" inner join ${su} as "nu" on "nu"."id" = "ng"."scim_user_id" where "ng"."group_id" = ${G} and "nu"."user_id" is not null and exists (select 1 from ${m} as "nm" where "nm"."workspace_id" = ${W} and "nm"."user_id" = "nu"."user_id") and not exists (select 1 from ${gm} as "ngm" where "ngm"."group_id" = ${G} and "ngm"."user_id" = "nu"."user_id") and ${input.claim}`;
  return [
    global
      .delete(sgm)
      .where(
        sql`${sgm.groupId} = ${G} and ${sgm.scimUserId} not in ${jsonList(input.members)} and ${input.claim}`,
      ),
    global
      .insert(sgm)
      // Columns in schema order: group, directory user, workspace, created. Only this
      // workspace's directory users: an ID of another workspace never lands here.
      .select(
        sql`select ${G}, "value", ${W}, ${input.now} from json_each(${JSON.stringify(input.members)}) where "value" in (select ${su.id} from ${su} where ${su.workspaceId} = ${W}) and ${input.claim}`,
      )
      .onConflictDoNothing(),
    global
      .insert(schema.auditEvents)
      .select(
        sql`select 'ae_' || lower(hex(randomblob(12))), ${W}, ${input.now}, 'group.member_removed', 'directory', ${input.caller.tokenId}, ${gm.userId}, null, json_object('group', ${G}) from ${gm} where ${leaving}`,
      ),
    global
      .insert(t)
      .select(
        sql`select 'workspace_group_member', ${gm.id}, ${input.now} from ${gm} where ${leaving}`,
      )
      .onConflictDoNothing(),
    global.delete(gm).where(leaving),
    global
      .insert(schema.auditEvents)
      .select(
        sql`select 'ae_' || lower(hex(randomblob(12))), ${W}, ${input.now}, 'group.member_added', 'directory', ${input.caller.tokenId}, "nu"."user_id", null, json_object('group', ${G}) ${joining}`,
      ),
    global
      .insert(gm)
      // Columns in schema order: id, group, workspace, user, created.
      .select(
        sql`select 'wgm_' || lower(hex(randomblob(16))), ${G}, ${W}, "nu"."user_id", ${input.now} ${joining}`,
      )
      .onConflictDoNothing(),
    ...roleSyncStatements(global, {
      workspaceId: W,
      who: sql`(select ${su.userId} from ${su} where ${su.workspaceId} = ${W} and ${su.userId} is not null and ${su.id} in ${jsonList(input.affected)})`,
      actor,
      now: input.now,
      condition: input.claim,
    }),
  ];
}

/** This workspace's directory users among `ids`; anything else is refused the same way. */
async function knownUsers(global: GlobalDb, caller: ScimCaller, ids: readonly string[]) {
  if (ids.length === 0) return true;
  const [row] = await global
    .select({ count: sql<number>`count(*)` })
    .from(su)
    .where(sql`${su.workspaceId} = ${caller.workspaceId} and ${su.id} in ${jsonList(ids)}`);
  return Number(row?.count ?? 0) === ids.length;
}

const UNKNOWN_MEMBER = () =>
  scimFail<never>(400, "A member is not one of this directory's users.", "invalidValue");

/** Runs a group write's batch; the name index and the last-admin trigger become SCIM errors. */
async function runBatch(global: GlobalDb, statements: BatchItem<"sqlite">[]) {
  try {
    await global.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
    return null;
  } catch (error) {
    if (causeIncludes(error, "sole_workspace_admin")) {
      return scimFail<never>(400, LAST_ADMIN, "mutability");
    }
    if (causeIncludes(error, "UNIQUE constraint failed: workspace_groups")) {
      return scimFail<never>(
        409,
        "The workspace already has a group with this name.",
        "uniqueness",
      );
    }
    throw error;
  }
}

async function nameTaken(
  global: GlobalDb,
  workspaceId: string,
  name: string,
  except: string | null,
) {
  const [row] = await global
    .select({ id: g.id })
    .from(g)
    .where(
      and(
        eq(g.workspaceId, workspaceId),
        sql`lower(${g.name}) = lower(${name})`,
        except === null ? undefined : sql`${g.id} <> ${except}`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * `POST /Groups`: a new directory-managed workspace group. A name the workspace already has (a
 * dashboard group included, without regard to case) answers 409 `uniqueness`, so the directory
 * never takes over a group made in the dashboard. Over the groups cap answers 400 and writes
 * nothing.
 */
export async function createScimGroup(
  global: GlobalDb,
  caller: ScimCaller,
  input: ScimGroupInput,
  now: number,
): Promise<ScimResult<ScimGroupRecord>> {
  const W = caller.workspaceId;
  if (await nameTaken(global, W, input.displayName, null)) {
    return scimFail(409, "The workspace already has a group with this name.", "uniqueness");
  }
  if (!(await knownUsers(global, caller, input.members))) return UNKNOWN_MEMBER();
  const id = newGroupId();
  const writeId = randomHex(16);
  const cap = WORKSPACE_GROUPS.perWorkspace;
  const claim = sql`exists (select 1 from ${sg} where ${sg.groupId} = ${id} and ${sg.writeId} = ${writeId})`;
  const statements: BatchItem<"sqlite">[] = [
    global
      .insert(g)
      // Columns in schema order: id, workspace, name, created, updated.
      .select(
        sql`select ${id}, ${W}, ${input.displayName}, ${now}, ${now} where (select count(*) from ${g} where ${g.workspaceId} = ${W}) < ${cap} and ${tokenHolds(caller, now)}`,
      ),
    global
      .insert(sg)
      // Columns in schema order: group, workspace, external ID, created, updated, write ID.
      .select(
        sql`select ${id}, ${W}, ${input.externalId}, ${now}, ${now}, ${writeId} where exists (select 1 from ${g} where ${g.id} = ${id})`,
      ),
    auditEvent(
      global,
      {
        ownerId: W,
        kind: "group.created",
        actor: { type: "directory", id: caller.tokenId },
        targetId: id,
        detail: {},
        now,
      },
      claim,
    ),
    ...membershipStatements(global, {
      caller,
      groupId: id,
      members: input.members,
      affected: input.members,
      claim,
      now,
    }),
  ];
  const refused = await runBatch(global, statements);
  if (refused) return refused;
  const row = await groupRow(global, caller, id);
  if (row) {
    const members = await membersOf(global, [id]);
    return { ok: true, value: record(row, members.get(id) ?? []) };
  }
  const [token] = await global.select({ id: st.id }).from(st).where(eq(st.id, caller.tokenId));
  if (!token) return scimFail(401, "The SCIM token is no longer valid.");
  return scimFail(
    400,
    `A workspace has at most ${cap} groups, its own and its directory's together.`,
  );
}

/**
 * Replaces what the directory says about one of its groups (PUT, and PATCH after the operations
 * are applied): the name, `externalId` and the whole member list, claimed with the group's
 * `write_id`, so of two concurrent writes only one applies (the other answers 409).
 */
async function writeScimGroup(
  global: GlobalDb,
  caller: ScimCaller,
  current: GroupRow,
  previousMembers: string[],
  next: ScimGroupInput,
  now: number,
): Promise<ScimResult<ScimGroupRecord>> {
  const W = caller.workspaceId;
  if (
    next.displayName !== current.name &&
    (await nameTaken(global, W, next.displayName, current.id))
  ) {
    return scimFail(409, "The workspace already has a group with this name.", "uniqueness");
  }
  if (!(await knownUsers(global, caller, next.members))) return UNKNOWN_MEMBER();
  const writeId = randomHex(16);
  const claim = sql`exists (select 1 from ${sg} where ${sg.groupId} = ${current.id} and ${sg.writeId} = ${writeId})`;
  const actor: AuditActor = { type: "directory", id: caller.tokenId };
  // Only the people whose groups this write changes: someone who stays in the group keeps a role
  // an admin set by hand until their own groups change (decision 0017, "Groups and roles").
  const affected = [
    ...previousMembers.filter((id) => !next.members.includes(id)),
    ...next.members.filter((id) => !previousMembers.includes(id)),
  ];
  const statements: BatchItem<"sqlite">[] = [
    global
      .update(sg)
      .set({ externalId: next.externalId, updatedAt: now, writeId })
      .where(
        and(
          eq(sg.groupId, current.id),
          eq(sg.workspaceId, W),
          eq(sg.writeId, current.writeId),
          tokenHolds(caller, now),
        ) as SQL,
      ),
  ];
  if (next.displayName !== current.name) {
    statements.push(
      auditEvent(
        global,
        { ownerId: W, kind: "group.renamed", actor, targetId: current.id, detail: {}, now },
        claim,
      ),
      global
        .update(g)
        .set({ name: next.displayName, updatedAt: now })
        .where(sql`${g.id} = ${current.id} and ${claim}`),
    );
  }
  statements.push(
    ...membershipStatements(global, {
      caller,
      groupId: current.id,
      members: next.members,
      affected,
      claim,
      now,
    }),
  );
  const refused = await runBatch(global, statements);
  if (refused) return refused;
  const row = await groupRow(global, caller, current.id);
  if (!row) return notFound();
  if (row.writeId !== writeId) {
    const [token] = await global
      .select({ id: st.id })
      .from(st)
      .where(and(eq(st.id, caller.tokenId), sql`${st.expiresAt} > ${now}`));
    if (!token) return scimFail(401, "The SCIM token is no longer valid.");
    return scimFail(409, "The group changed meanwhile. Read it again and retry.");
  }
  const members = await membersOf(global, [row.id]);
  return { ok: true, value: record(row, members.get(row.id) ?? []) };
}

/** `PUT /Groups/:id`. */
export async function replaceScimGroup(
  global: GlobalDb,
  caller: ScimCaller,
  id: string,
  input: ScimGroupInput,
  now: number,
): Promise<ScimResult<ScimGroupRecord>> {
  const current = await groupRow(global, caller, id);
  if (!current) return notFound();
  const members = (await membersOf(global, [id])).get(id) ?? [];
  return writeScimGroup(
    global,
    caller,
    current,
    members.map((member) => member.id),
    input,
    now,
  );
}

/** `PATCH /Groups/:id`: the operations applied to the stored group, then written like a PUT. */
export async function patchScimGroup(
  global: GlobalDb,
  caller: ScimCaller,
  id: string,
  body: unknown,
  now: number,
): Promise<ScimResult<ScimGroupRecord>> {
  const current = await groupRow(global, caller, id);
  if (!current) return notFound();
  const members = ((await membersOf(global, [id])).get(id) ?? []).map((member) => member.id);
  const patched = applyScimGroupPatch(
    { displayName: current.name, externalId: current.externalId, members },
    body,
    SCIM.maxOperations,
  );
  if (!patched.ok) return patched;
  return writeScimGroup(global, caller, current, members, patched.value, now);
}

/**
 * `DELETE /Groups/:id`: deletes the workspace group with a `workspace_group` tombstone, as the
 * dashboard does (its memberships go by cascade). When it is mapped to a role, the mapping is
 * cleared and its members' roles recomputed without it in the same batch; the last-admin trigger
 * refuses the whole batch if that would leave no admin.
 */
export async function deleteScimGroup(
  global: GlobalDb,
  caller: ScimCaller,
  id: string,
  now: number,
): Promise<ScimResult<true>> {
  const current = await groupRow(global, caller, id);
  if (!current) return notFound();
  const W = caller.workspaceId;
  const target = sql`${g.id} = ${id} and ${g.workspaceId} = ${W} and exists (select 1 from ${sg} where ${sg.groupId} = ${id}) and ${tokenHolds(caller, now)}`;
  const holds = sql`exists (select 1 from ${g} where ${target})`;
  const actor: AuditActor = { type: "directory", id: caller.tokenId };
  const statements: BatchItem<"sqlite">[] = [
    auditEvent(
      global,
      { ownerId: W, kind: "group.deleted", actor, targetId: id, detail: {}, now },
      holds,
    ),
    ...roleSyncStatements(global, {
      workspaceId: W,
      who: sql`(select ${gm.userId} from ${gm} where ${gm.groupId} = ${id})`,
      actor,
      now,
      condition: holds,
      excluding: id,
    }),
    global
      .update(ws)
      .set({
        editorGroupId: sql`case when ${ws.editorGroupId} = ${id} then null else ${ws.editorGroupId} end`,
        adminGroupId: sql`case when ${ws.adminGroupId} = ${id} then null else ${ws.adminGroupId} end`,
      })
      .where(sql`${ws.workspaceId} = ${W} and ${holds}`),
    global
      .insert(t)
      .select(sql`select 'workspace_group', ${g.id}, ${now} from ${g} where ${target}`)
      .onConflictDoNothing(),
    global.delete(g).where(target),
  ];
  const refused = await runBatch(global, statements);
  if (refused) return refused;
  if (await groupRow(global, caller, id)) {
    return scimFail(401, "The SCIM token is no longer valid.");
  }
  return { ok: true, value: true };
}

// The role mapping (dashboard session, admins) -----------------------------------------------

export interface RoleMappingChange {
  editorGroup?: string | null | undefined;
  adminGroup?: string | null | undefined;
}

/**
 * Validates and builds the statements that change the role mapping, for `updateScimSettings`'s
 * batch: only directory-managed groups of the workspace; mapping a group to `admin` needs the
 * confirmation naming it. The roles of everyone in the old and new mapped groups are recomputed
 * in the same batch, with the admin who changed it as the actor (they caused the change; the
 * directory did not act). `condition` is the batch's guard (`stillAdmin`).
 */
export async function roleMappingStatements(
  global: GlobalDb,
  input: {
    workspaceId: string;
    userId: string;
    body: ScimSettingsUpdate;
    now: number;
    condition: SQL;
  },
): Promise<Result<{ statements: BatchItem<"sqlite">[]; changed: RoleMappingChange }>> {
  const W = input.workspaceId;
  const [current] = await global
    .select({ editor: ws.editorGroupId, admin: ws.adminGroupId })
    .from(ws)
    .where(eq(ws.workspaceId, W))
    .limit(1);
  const changed: RoleMappingChange = {};
  for (const role of ["editor", "admin"] as const) {
    const wanted = role === "editor" ? input.body.editorGroup : input.body.adminGroup;
    if (wanted === undefined || wanted === (current?.[role] ?? null)) continue;
    if (wanted !== null) {
      const [managed] = await global
        .select({ id: sg.groupId })
        .from(sg)
        .where(and(eq(sg.groupId, wanted), eq(sg.workspaceId, W)))
        .limit(1);
      if (!managed) {
        return fail("invalid_input", "Only a group the directory manages can be mapped to a role.");
      }
      if (role === "admin" && input.body.confirmAdminGroup !== wanted) {
        return fail(
          "invalid_input",
          "Mapping a group to admin needs a confirmation that names the group.",
        );
      }
    }
    if (role === "editor") changed.editorGroup = wanted;
    else changed.adminGroup = wanted;
  }
  if (changed.editorGroup === undefined && changed.adminGroup === undefined) {
    return ok({ statements: [], changed });
  }
  const groups = [current?.editor, current?.admin, changed.editorGroup, changed.adminGroup].filter(
    (id): id is string => typeof id === "string",
  );
  const managed = sql`exists (select 1 from ${sg} where ${sg.workspaceId} = ${W} and ${sg.groupId} = `;
  const valid = (id: string | null | undefined) =>
    id === undefined || id === null ? sql`1` : sql`${managed}${id})`;
  const condition = sql`${input.condition} and ${valid(changed.editorGroup)} and ${valid(changed.adminGroup)}`;
  const statements: BatchItem<"sqlite">[] = [
    global
      .insert(ws)
      // Columns in schema order: workspace, invitation emails, editor group, admin group, updated.
      .select(
        sql`select ${W}, 0, ${changed.editorGroup ?? null}, ${changed.adminGroup ?? null}, ${input.now} where ${condition}`,
      )
      .onConflictDoUpdate({
        target: ws.workspaceId,
        set: {
          ...(changed.editorGroup === undefined ? {} : { editorGroupId: changed.editorGroup }),
          ...(changed.adminGroup === undefined ? {} : { adminGroupId: changed.adminGroup }),
          updatedAt: input.now,
        },
      }),
    ...roleSyncStatements(global, {
      workspaceId: W,
      who: sql`(select ${gm.userId} from ${gm} where ${gm.groupId} in ${jsonList(groups)})`,
      actor: { type: "user", id: input.userId },
      now: input.now,
      condition,
    }),
  ];
  return ok({ statements, changed });
}

/** Whether a mapping change failed on the last admin, for the settings' answer. */
export function lastAdminRefusal(error: unknown): Result<never> | null {
  return causeIncludes(error, "sole_workspace_admin")
    ? fail(
        "sole_workspace_admin",
        "This mapping would leave the workspace without an admin. Make another member an admin first.",
      )
    : null;
}

/** The directory-managed groups of a workspace, for the dashboard's mapping choices. */
export async function directoryGroupChoices(global: GlobalDb, workspaceId: string) {
  const rows = await global
    .select({
      id: g.id,
      name: g.name,
      members: sql<number>`(select count(*) from ${gm} where ${gm.groupId} = "workspace_groups"."id")`,
    })
    .from(sg)
    .innerJoin(g, eq(g.id, sg.groupId))
    .where(eq(sg.workspaceId, workspaceId))
    .orderBy(sql`lower(${g.name})`, asc(g.id));
  return rows.map((row) => ({ ...row, members: Number(row.members) }));
}

/** The members of `workspaceId` whose role the mapping sets (they are in a mapped group). */
export async function directoryRoleHolders(
  global: GlobalDb,
  workspaceId: string,
): Promise<Set<string>> {
  const rows = await global
    .select({ userId: gm.userId })
    .from(gm)
    .innerJoin(ws, eq(ws.workspaceId, gm.workspaceId))
    .where(
      and(
        eq(gm.workspaceId, workspaceId),
        sql`(${gm.groupId} = ${ws.editorGroupId} or ${gm.groupId} = ${ws.adminGroupId})`,
      ),
    );
  return new Set(rows.map((row) => row.userId));
}
