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
  requireFeature,
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
import { ownerEntitlements } from "./plans.ts";
import type { ScimCaller } from "./scim.ts";
import { scoped, stillAdmin } from "./workspaces.ts";

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

const rank = (role: SQL) => sql`(case ${role} when 'admin' then 2 when 'editor' then 1 else 0 end)`;

/**
 * Recomputes the role of the workspace's members among `who` (a subquery of user IDs) from the
 * mapping, in the batch of the change that may move it (decision 0017, "Groups and roles"). The
 * directory only takes back what it gave: a role is raised when the mapped groups give more than
 * the current one, and lowered only when `scim_users.mapped_role` equals the current role (the
 * directory set it and nobody changed it since). A role set by hand is never lowered by a sync.
 * In order: the audit event (`member.role_changed`) from the row; `mapped_role` set to the new
 * role of everyone who changes (`member` as a marker for a lowering to member); the roles of
 * exactly those people; then the marker cleared. The last-admin trigger refuses the whole batch
 * if a lowering would leave no admin.
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
  const mappedOf = (user: SQL) =>
    sql`(select "ds"."mapped_role" from ${su} as "ds" where "ds"."workspace_id" = ${W} and "ds"."user_id" = ${user} limit 1)`;
  /** Whether a sync changes this person's role, from the state before the batch's writes. */
  const changes = (user: SQL, role: SQL, mapped: SQL) => {
    const desired = desiredRoleSql(W, user, excluding);
    return sql`${user} in ${input.who} and ${role} <> ${desired} and (${rank(desired)} > ${rank(role)} or ${mapped} = ${role}) and ${input.condition}`;
  };
  const actorType = input.actor.type;
  const actorId =
    input.actor.type === "user" || input.actor.type === "directory" ? input.actor.id : null;
  const row = sql`"rm"."user_id"`;
  const self = sql`"workspace_members"."user_id"`;
  const linked = sql`"scim_users"."user_id"`;
  return [
    // Columns in schema order: id, owner, at, kind, actor type, actor, target, artifact, detail,
    // recorded (the database's clock, decision 0019).
    global
      .insert(schema.auditEvents)
      .select(
        sql`select 'ae_' || lower(hex(randomblob(12))), ${W}, ${input.now}, 'member.role_changed', ${actorType}, ${actorId}, ${row}, null, json_object('from', "rm"."role", 'to', ${desiredRoleSql(W, row, excluding)}), ${schema.recordedNow} from ${m} as "rm" where "rm"."workspace_id" = ${W} and ${changes(row, sql`"rm"."role"`, mappedOf(row))}`,
      ),
    global
      .update(su)
      .set({ mappedRole: sql`${desiredRoleSql(W, linked, excluding)}` })
      .where(
        sql`"scim_users"."workspace_id" = ${W} and exists (select 1 from ${m} as "sm" where "sm"."workspace_id" = ${W} and "sm"."user_id" = ${linked} and ${changes(linked, sql`"sm"."role"`, sql`"scim_users"."mapped_role"`)})`,
      ),
    global
      .update(m)
      .set({ role: sql`${desiredRoleSql(W, self, excluding)}`, updatedAt: input.now })
      .where(
        sql`"workspace_members"."workspace_id" = ${W} and ${self} in ${input.who} and "workspace_members"."role" <> ${desiredRoleSql(W, self, excluding)} and ${mappedOf(self)} = ${desiredRoleSql(W, self, excluding)} and ${input.condition}`,
      ),
    global
      .update(su)
      .set({ mappedRole: null })
      .where(sql`"scim_users"."workspace_id" = ${W} and "scim_users"."mapped_role" = 'member'`),
  ];
}

/**
 * Links a person's directory user to their account when it is not linked yet, through the
 * address only while its domain is one the workspace verified, for a batch that just made them a
 * member through another path (an admin's invitation, single sign-on).
 */
export function linkDirectoryUser(
  global: GlobalDb,
  input: { workspaceId: string; userId: string; condition: SQL },
) {
  const W = input.workspaceId;
  return global
    .update(su)
    .set({ userId: input.userId })
    .where(
      sql`"scim_users"."workspace_id" = ${W} and "scim_users"."user_id" is null and "scim_users"."email" = (select lower(${schema.users.email}) from ${schema.users} where ${schema.users.id} = ${input.userId}) and exists (select 1 from ${schema.workspaceDomains} as "ld" where "ld"."workspace_id" = ${W} and "ld"."state" = 'verified' and "ld"."domain" = substr("scim_users"."email", instr("scim_users"."email", '@') + 1)) and exists (select 1 from ${m} as "lm" where "lm"."workspace_id" = ${W} and "lm"."user_id" = ${input.userId}) and ${input.condition}`,
    );
}

/**
 * The statements that give a person who just became a workspace member the groups the directory
 * listed them in (as a directory user linked to their account), with their events, and the role
 * those groups map to. For the batch of every join (the directory's claim, an admin's invitation,
 * single sign-on), after the membership insert and the link.
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
        sql`select 'ae_' || lower(hex(randomblob(12))), ${W}, ${input.now}, 'group.member_added', ${input.actor.type}, ${actorId}, ${input.userId}, null, json_object('group', "jg"."group_id"), ${schema.recordedNow} ${listed}`,
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
        sql`select 'ae_' || lower(hex(randomblob(12))), ${W}, ${input.now}, 'group.member_removed', 'directory', ${input.caller.tokenId}, ${gm.userId}, null, json_object('group', ${G}), ${schema.recordedNow} from ${gm} where ${leaving}`,
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
        sql`select 'ae_' || lower(hex(randomblob(12))), ${W}, ${input.now}, 'group.member_added', 'directory', ${input.caller.tokenId}, "nu"."user_id", null, json_object('group', ${G}), ${schema.recordedNow} ${joining}`,
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
      // Everyone whose groups this write changed: the directory users it added or removed, and
      // anyone whose group row it inserted (a person linked since the last push).
      who: sql`(select ${su.userId} from ${su} where ${su.workspaceId} = ${W} and ${su.userId} is not null and ${su.id} in ${jsonList(input.affected)} union select "ig"."user_id" from ${gm} as "ig" where "ig"."group_id" = ${G} and "ig"."created_at" = ${input.now})`,
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
 * batch: only directory-managed groups of the workspace; setting a mapping to a group needs `scim`
 * in the plan (unmapping never does); mapping a group to `admin` needs the confirmation naming it.
 * The write is conditioned on the mapping revision read, so of two concurrent changes the later
 * one changes nothing, and on the groups still being directory-managed. `applied` holds only when
 * the write happened: every other statement of the batch is conditioned on it. Roles are
 * recomputed, inside the batch, for everyone the directory gave a role to (`mapped_role`) and
 * everyone in the groups being mapped and unmapped, with the admin who changed it as the actor.
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
): Promise<
  Result<{
    statements: BatchItem<"sqlite">[];
    changed: RoleMappingChange;
    applied: SQL;
    writeId: string;
  }>
> {
  const W = input.workspaceId;
  const [current] = await global
    .select({ editor: ws.editorGroupId, admin: ws.adminGroupId, revision: ws.mappingRevision })
    .from(ws)
    .where(eq(ws.workspaceId, W))
    .limit(1);
  const changed: RoleMappingChange = {};
  for (const mapped of ["editor", "admin"] as const) {
    const wanted = mapped === "editor" ? input.body.editorGroup : input.body.adminGroup;
    if (wanted === undefined || wanted === (current?.[mapped] ?? null)) continue;
    if (mapped === "editor") changed.editorGroup = wanted;
    else changed.adminGroup = wanted;
  }
  const writeId = randomHex(16);
  const applied = sql`exists (select 1 from ${ws} where ${ws.workspaceId} = ${W} and ${ws.mappingWriteId} = ${writeId})`;
  if (changed.editorGroup === undefined && changed.adminGroup === undefined) {
    return ok({ statements: [], changed, applied: sql`1`, writeId });
  }
  const setting = [changed.editorGroup, changed.adminGroup].some((id) => typeof id === "string");
  if (setting) {
    const gate = requireFeature(await ownerEntitlements(global, W, input.now), "scim");
    if (!gate.ok) return gate;
  }
  for (const mapped of ["editor", "admin"] as const) {
    const wanted = mapped === "editor" ? changed.editorGroup : changed.adminGroup;
    if (typeof wanted !== "string") continue;
    const [managed] = await global
      .select({ id: sg.groupId })
      .from(sg)
      .where(and(eq(sg.groupId, wanted), eq(sg.workspaceId, W)))
      .limit(1);
    if (!managed) {
      return fail("invalid_input", "Only a group the directory manages can be mapped to a role.");
    }
    if (mapped === "admin" && input.body.confirmAdminGroup !== wanted) {
      return fail(
        "invalid_input",
        "Mapping a group to admin needs a confirmation that names the group.",
      );
    }
  }
  const before = [current?.editor, current?.admin].filter(
    (id): id is string => typeof id === "string",
  );
  const valid = (id: string | null | undefined) =>
    typeof id === "string"
      ? sql`exists (select 1 from ${sg} where ${sg.workspaceId} = ${W} and ${sg.groupId} = ${id})`
      : sql`1`;
  const revisionHolds = current
    ? sql`(select ${ws.mappingRevision} from ${ws} where ${ws.workspaceId} = ${W}) = ${current.revision}`
    : sql`not exists (select 1 from ${ws} where ${ws.workspaceId} = ${W})`;
  const writes = sql`${input.condition} and ${revisionHolds} and ${valid(changed.editorGroup)} and ${valid(changed.adminGroup)}`;
  const statements: BatchItem<"sqlite">[] = [
    global
      .insert(ws)
      // Columns in schema order: workspace, invitation emails, editor group, admin group,
      // mapping revision, mapping write ID, updated.
      .select(
        sql`select ${W}, 0, ${changed.editorGroup ?? null}, ${changed.adminGroup ?? null}, 1, ${writeId}, ${input.now} where ${writes}`,
      )
      .onConflictDoUpdate({
        target: ws.workspaceId,
        set: {
          ...(changed.editorGroup === undefined ? {} : { editorGroupId: changed.editorGroup }),
          ...(changed.adminGroup === undefined ? {} : { adminGroupId: changed.adminGroup }),
          mappingRevision: sql`${ws.mappingRevision} + 1`,
          mappingWriteId: writeId,
          updatedAt: input.now,
        },
      }),
    ...roleSyncStatements(global, {
      workspaceId: W,
      who: sql`(select ${su.userId} from ${su} where ${su.workspaceId} = ${W} and ${su.mappedRole} is not null and ${su.userId} is not null union select ${gm.userId} from ${gm} where ${gm.workspaceId} = ${W} and (${gm.groupId} in (select ${ws.editorGroupId} from ${ws} where ${ws.workspaceId} = ${W} union select ${ws.adminGroupId} from ${ws} where ${ws.workspaceId} = ${W}) or ${gm.groupId} in ${jsonList(before)}))`,
      actor: { type: "user", id: input.userId },
      now: input.now,
      condition: applied,
    }),
  ];
  return ok({ statements, changed, applied, writeId });
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

/**
 * The directory-managed groups of a workspace, for the dashboard's mapping choices: how many of
 * their people are members now, and how many are pending (active in the directory, no membership
 * yet), who get the group's role when they sign in.
 */
export async function directoryGroupChoices(global: GlobalDb, workspaceId: string) {
  const rows = await global
    .select({
      id: g.id,
      name: g.name,
      members: sql<number>`(select count(*) from ${gm} where ${gm.groupId} = "workspace_groups"."id")`,
      pending: sql<number>`(select count(*) from ${sgm} as "pg" inner join ${su} as "pu" on "pu"."id" = "pg"."scim_user_id" where "pg"."group_id" = "workspace_groups"."id" and "pu"."active" = 1 and "pu"."removed_at" is null and not exists (select 1 from ${m} as "pm" where "pm"."workspace_id" = "pu"."workspace_id" and "pm"."user_id" = "pu"."user_id"))`,
    })
    .from(sg)
    .innerJoin(g, eq(g.id, sg.groupId))
    .where(eq(sg.workspaceId, workspaceId))
    .orderBy(sql`lower(${g.name})`, asc(g.id));
  return rows.map((row) => ({
    ...row,
    members: Number(row.members),
    pending: Number(row.pending),
  }));
}

/**
 * Stops syncing a directory-managed group (decision 0017, "Groups and roles"), for an admin,
 * whatever the plan, the token or the switch: it becomes an ordinary group admins edit. In one
 * batch, conditioned on the caller still being an admin: its mapping is cleared, the people it
 * gave a role keep that role as set by hand (`mapped_role` cleared; nothing is lowered), the event
 * is recorded and the directory's marker and member list are deleted. A later push of a group
 * with the same name answers 409, and SCIM requests for this one 404.
 */
export async function stopDirectorySync(
  global: GlobalDb,
  input: { userId: string; slug: string; groupId: string; now: number },
): Promise<Result<true>> {
  const found = await scoped(global, input.userId, input.slug, "scim");
  if (!found.ok) return found;
  const W = found.value.workspace.id;
  const G = input.groupId;
  const managed = sql`exists (select 1 from ${sg} where ${sg.groupId} = ${G} and ${sg.workspaceId} = ${W})`;
  const holds = sql`${managed} and ${stillAdmin(W, input.userId)}`;
  const [, , , deleted] = (await global.batch([
    auditEvent(
      global,
      {
        ownerId: W,
        kind: "group.sync_stopped",
        actor: { type: "user", id: input.userId },
        targetId: G,
        detail: {},
        now: input.now,
      },
      holds,
    ),
    global
      .update(su)
      .set({ mappedRole: null })
      .where(
        sql`${su.workspaceId} = ${W} and ${su.userId} in (select ${gm.userId} from ${gm} where ${gm.groupId} = ${G}) and ${holds}`,
      ),
    global
      .update(ws)
      .set({
        editorGroupId: sql`case when ${ws.editorGroupId} = ${G} then null else ${ws.editorGroupId} end`,
        adminGroupId: sql`case when ${ws.adminGroupId} = ${G} then null else ${ws.adminGroupId} end`,
        mappingRevision: sql`${ws.mappingRevision} + 1`,
      })
      .where(
        sql`${ws.workspaceId} = ${W} and (${ws.editorGroupId} = ${G} or ${ws.adminGroupId} = ${G}) and ${holds}`,
      ),
    global
      .delete(sg)
      .where(and(eq(sg.groupId, G), eq(sg.workspaceId, W), stillAdmin(W, input.userId)) as SQL)
      .returning({ id: sg.groupId }),
  ])) as [unknown, unknown, unknown, unknown[]];
  if (deleted.length === 1) return ok(true);
  const again = await scoped(global, input.userId, input.slug, "scim");
  return again.ok ? fail("not_found", "This group is not synced from your directory.") : again;
}

/**
 * After a D1 Time Travel restore (`applyTombstones`): recomputes roles from the current directory
 * groups for every workspace with a mapping, with the same statements a sync runs, so a role the
 * directory took away does not come back. One batch per workspace over that workspace's members;
 * at most `limit` workspaces a run (`more` says to run it again; it is idempotent). A workspace
 * whose recompute would leave no admin is skipped and counted in `refused`.
 */
export async function recomputeDirectoryRoles(
  global: GlobalDb,
  now: number,
  limit = 500,
): Promise<{ workspaces: number; refused: number; more: boolean }> {
  const rows = await global
    .select({ id: ws.workspaceId })
    .from(ws)
    .where(sql`${ws.editorGroupId} is not null or ${ws.adminGroupId} is not null`)
    .orderBy(asc(ws.workspaceId))
    .limit(limit + 1);
  let refused = 0;
  for (const { id } of rows.slice(0, limit)) {
    try {
      await global.batch(
        roleSyncStatements(global, {
          workspaceId: id,
          who: sql`(select ${m.userId} from ${m} where ${m.workspaceId} = ${id})`,
          actor: { type: "system" },
          now,
          condition: sql`1`,
        }) as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]],
      );
    } catch (error) {
      if (!causeIncludes(error, "sole_workspace_admin")) throw error;
      refused += 1;
    }
  }
  return { workspaces: Math.min(rows.length, limit), refused, more: rows.length > limit };
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
