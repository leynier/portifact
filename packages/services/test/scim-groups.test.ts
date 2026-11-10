// SCIM groups and the group-to-role mapping (decision 0017, "Groups and roles"): directory-managed
// groups, members resolved inside the workspace, pending people who join later, the caps at their
// limits, the dashboard refusing directory groups, roles from the mapping (never from a payload),
// hand-set roles, the last admin, tombstones, other workspaces and races.
import { schema } from "@portifact/db";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  claimDirectoryMemberships,
  createScimToken,
  createScimUser,
  patchScimUser,
  type ScimCaller,
  type ScimDeps,
  updateScimSettings,
} from "../src/scim.ts";
import {
  createScimGroup,
  deleteScimGroup,
  getScimGroup,
  listScimGroups,
  patchScimGroup,
  replaceScimGroup,
} from "../src/scim-groups.ts";
import {
  addGroupMember,
  createWorkspaceGroup,
  deleteWorkspaceGroup,
  listWorkspaceGroups,
  removeGroupMember,
  renameWorkspaceGroup,
} from "../src/workspace-groups.ts";
import { changeMemberRole, listMembers, removeMember } from "../src/workspaces.ts";
import { db, grantPlan, NOW, value } from "./fixtures.ts";
import { raceGlobalBeforeFirstWrite } from "./race.ts";

const hex = () => crypto.randomUUID().replaceAll("-", "");
const global = () => db().global;
const DEPS: ScimDeps = { sender: null, endSessions: async () => {} };

async function person(email: string) {
  const id = `u_${hex()}`;
  await global()
    .insert(schema.users)
    .values({
      id,
      name: "Someone",
      email,
      emailVerified: true,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    });
  return id;
}

interface Team {
  id: string;
  slug: string;
  domain: string;
  admin: string;
  caller: ScimCaller;
}

async function team(seats = 600): Promise<Team> {
  const id = `ws_${hex()}`;
  const slug = `g${hex().slice(0, 20)}`;
  const domain = `grp${hex().slice(0, 10)}.com`;
  const admin = await person(`admin@${domain}`);
  await global()
    .insert(schema.workspaces)
    .values({ id, slug, name: "Corp", createdBy: admin, updatedAt: NOW });
  await global()
    .insert(schema.workspaceMembers)
    .values({ workspaceId: id, userId: admin, role: "admin", updatedAt: NOW });
  await global()
    .insert(schema.workspaceDomains)
    .values({
      id: `wd_${hex()}`,
      workspaceId: id,
      domain,
      token: hex(),
      state: "verified",
      createdAt: NOW,
      expiresAt: NOW,
      verifiedAt: NOW,
    });
  await grantPlan(id, "enterprise", { seats });
  const token = value(
    await createScimToken(global(), {
      userId: admin,
      slug,
      body: { label: "Okta", expiresInDays: 365 },
      now: NOW,
    }),
  );
  return { id, slug, domain, admin, caller: { tokenId: token.token.id, workspaceId: id } };
}

function ok<T>(result: { ok: true; value: T } | { ok: false; error: { detail: string } }): T {
  if (!result.ok) throw new Error(result.error.detail);
  return result.value;
}

/** A directory user with an account that is a workspace member: [directory user ID, account]. */
async function memberUser(t: Team, local: string) {
  const account = await person(`${local}@${t.domain}`);
  const created = ok(
    await createScimUser(
      global(),
      DEPS,
      t.caller,
      {
        userName: `${local}@${t.domain}`,
        externalId: null,
        active: true,
        names: {},
      },
      NOW,
    ),
  );
  return [created.user.id, account] as const;
}

async function pendingUser(t: Team, local: string) {
  return ok(
    await createScimUser(
      global(),
      DEPS,
      t.caller,
      {
        userName: `${local}@${t.domain}`,
        externalId: null,
        active: true,
        names: {},
      },
      NOW,
    ),
  ).user.id;
}

const group = (displayName: string, members: string[], externalId: string | null = null) => ({
  displayName,
  externalId,
  members,
});

async function role(t: Team, userId: string) {
  const [row] = await global()
    .select({ role: schema.workspaceMembers.role })
    .from(schema.workspaceMembers)
    .where(
      and(
        eq(schema.workspaceMembers.workspaceId, t.id),
        eq(schema.workspaceMembers.userId, userId),
      ),
    );
  return row?.role ?? null;
}

async function groupMembers(groupId: string) {
  const rows = await global()
    .select({ userId: schema.workspaceGroupMembers.userId })
    .from(schema.workspaceGroupMembers)
    .where(eq(schema.workspaceGroupMembers.groupId, groupId));
  return rows.map((row) => row.userId).sort();
}

async function events(t: Team, kind: string) {
  return global()
    .select({
      actorType: schema.auditEvents.actorType,
      actorId: schema.auditEvents.actorId,
      targetId: schema.auditEvents.targetId,
      detail: schema.auditEvents.detail,
    })
    .from(schema.auditEvents)
    .where(and(eq(schema.auditEvents.ownerId, t.id), eq(schema.auditEvents.kind, kind)));
}

const settings = (
  t: Team,
  body: Parameters<typeof updateScimSettings>[1]["body"],
  userId = t.admin,
) => updateScimSettings(global(), { userId, slug: t.slug, body, now: NOW });

describe("directory-managed groups", () => {
  it("creates a workspace group whose members are the directory users that are members", async () => {
    const t = await team();
    const [ada, adaAccount] = await memberUser(t, "ada");
    const bea = await pendingUser(t, "bea");
    const created = ok(
      await createScimGroup(global(), t.caller, group("Design", [ada, bea], "x1"), NOW),
    );
    expect(created.id).toMatch(/^wg_[0-9a-f]{32}$/);
    expect(created.members.map((m) => m.id).sort()).toEqual([ada, bea].sort());
    expect(await groupMembers(created.id)).toEqual([adaAccount]);
    const listed = value(
      await listWorkspaceGroups(global(), { userId: t.admin, slug: t.slug, now: NOW }),
    );
    expect(listed.groups).toEqual([
      expect.objectContaining({ name: "Design", directory: true, members: 1 }),
    ]);
    expect(await events(t, "group.created")).toEqual([
      expect.objectContaining({
        actorType: "directory",
        actorId: t.caller.tokenId,
        targetId: created.id,
      }),
    ]);
    expect(await events(t, "group.member_added")).toEqual([
      expect.objectContaining({ actorType: "directory", targetId: adaAccount }),
    ]);
    // The pending person joins the group in the batch of their join.
    const beaAccount = await person(`bea@${t.domain}`);
    expect(await claimDirectoryMemberships(global(), { userId: beaAccount, now: NOW + 1 })).toBe(1);
    expect(await groupMembers(created.id)).toEqual([adaAccount, beaAccount].sort());
  });

  it("refuses another workspace's IDs the same way as unknown ones", async () => {
    const t = await team();
    const other = await team();
    const [foreign] = await memberUser(other, "eve");
    expect(await createScimGroup(global(), t.caller, group("G", [foreign]), NOW)).toMatchObject({
      ok: false,
      error: { status: 400, scimType: "invalidValue" },
    });
    expect(
      await createScimGroup(global(), t.caller, group("G", [`su_${"0".repeat(32)}`]), NOW),
    ).toMatchObject({ ok: false, error: { status: 400, scimType: "invalidValue" } });
    const theirs = ok(await createScimGroup(global(), other.caller, group("Theirs", []), NOW));
    expect(await getScimGroup(global(), t.caller, theirs.id)).toMatchObject({
      error: { status: 404 },
    });
    expect(
      await patchScimGroup(
        global(),
        t.caller,
        theirs.id,
        { Operations: [{ op: "replace", path: "displayName", value: "x" }] },
        NOW,
      ),
    ).toMatchObject({ error: { status: 404 } });
    expect(
      await replaceScimGroup(global(), t.caller, theirs.id, group("x", []), NOW),
    ).toMatchObject({ error: { status: 404 } });
    expect(await deleteScimGroup(global(), t.caller, theirs.id, NOW)).toMatchObject({
      error: { status: 404 },
    });
  });

  it("never takes over a dashboard group, and the dashboard never changes a directory group", async () => {
    const t = await team();
    const mine = value(
      await createWorkspaceGroup(global(), {
        userId: t.admin,
        slug: t.slug,
        name: "Sales",
        now: NOW,
      }),
    );
    expect(await createScimGroup(global(), t.caller, group("sales", []), NOW)).toMatchObject({
      ok: false,
      error: { status: 409, scimType: "uniqueness" },
    });
    expect(
      (
        await listScimGroups(global(), t.caller, {
          filter: null,
          startIndex: 1,
          count: 10,
          members: true,
        })
      ).total,
    ).toBe(0);
    expect(await getScimGroup(global(), t.caller, mine.id)).toMatchObject({
      error: { status: 404 },
    });
    const [, adaAccount] = await memberUser(t, "ada");
    const theirs = ok(await createScimGroup(global(), t.caller, group("Engineering", []), NOW));
    const input = { userId: t.admin, slug: t.slug, groupId: theirs.id, now: NOW };
    for (const refused of [
      await renameWorkspaceGroup(global(), { ...input, name: "Eng" }),
      await deleteWorkspaceGroup(global(), input),
      await addGroupMember(global(), { ...input, memberId: adaAccount }),
      await removeGroupMember(global(), { ...input, memberId: adaAccount }),
    ]) {
      expect(refused).toMatchObject({ ok: false, code: "forbidden" });
    }
    // Renaming onto a dashboard group's name is refused too.
    expect(
      await patchScimGroup(
        global(),
        t.caller,
        theirs.id,
        { Operations: [{ op: "Replace", path: "displayName", value: "SALES" }] },
        NOW,
      ),
    ).toMatchObject({ ok: false, error: { status: 409, scimType: "uniqueness" } });
  });

  it("refuses a group over the workspace's cap without writing it", async () => {
    const t = await team();
    for (let i = 0; i < 50; i += 1) {
      await global()
        .insert(schema.workspaceGroups)
        .values({
          id: `wg_${hex()}`,
          workspaceId: t.id,
          name: `g${i}`,
          createdAt: NOW,
          updatedAt: NOW,
        });
    }
    expect(await createScimGroup(global(), t.caller, group("One more", []), NOW)).toMatchObject({
      ok: false,
      error: { status: 400 },
    });
    const [count] = await global()
      .select({ n: sql<number>`count(*)` })
      .from(schema.workspaceGroups)
      .where(eq(schema.workspaceGroups.workspaceId, t.id));
    expect(Number(count?.n)).toBe(50);
  });

  it("replaces a group at its maximum size in one PUT, within D1's bounds", async () => {
    const t = await team();
    // 1,000 directory users with accounts that are members, written in a few statements.
    const ids = Array.from({ length: 1000 }, () => hex());
    const users = JSON.stringify(ids);
    await global().run(
      sql`insert into users (id, name, email, email_verified, created_at, updated_at) select 'u_' || value, 'P', value || '@' || ${t.domain}, 1, ${NOW}, ${NOW} from json_each(${users})`,
    );
    await global().run(
      sql`insert into workspace_members (workspace_id, user_id, role, created_at, updated_at) select ${t.id}, 'u_' || value, 'member', ${NOW}, ${NOW} from json_each(${users})`,
    );
    await global().run(
      sql`insert into scim_users (id, workspace_id, email, external_id, names, active, user_id, removed_at, removal, sessions_pending, mapped_role, created_at, updated_at, write_id) select 'su_' || value, ${t.id}, value || '@' || ${t.domain}, null, null, 1, 'u_' || value, null, null, 0, null, ${NOW}, ${NOW}, 'w' from json_each(${users})`,
    );
    const first = ids.slice(0, 500).map((id) => `su_${id}`);
    const second = ids.slice(500).map((id) => `su_${id}`);
    const created = ok(await createScimGroup(global(), t.caller, group("Everyone", first), NOW));
    expect(await groupMembers(created.id)).toHaveLength(500);
    // Mapped to editor, so the PUT also moves 1,000 roles in the same batch.
    value(await settings(t, { editorGroup: created.id }));
    const replaced = ok(
      await replaceScimGroup(global(), t.caller, created.id, group("Everyone", second), NOW + 1),
    );
    expect(replaced.members).toHaveLength(500);
    expect(await groupMembers(created.id)).toEqual(second.map((id) => `u_${id.slice(3)}`).sort());
    expect(await role(t, `u_${ids[0]}`)).toBe("member");
    expect(await role(t, `u_${ids[999]}`)).toBe("editor");
    // One over the cap is refused before anything is written.
    expect(
      await patchScimGroup(
        global(),
        t.caller,
        created.id,
        { Operations: [{ op: "add", path: "members", value: [{ value: first[0] }] }] },
        NOW + 2,
      ),
    ).toMatchObject({ ok: false, error: { status: 400, scimType: "invalidValue" } });
    expect(await groupMembers(created.id)).toHaveLength(500);
  });

  it("never creates a membership, lifts a removal or changes active through a group push", async () => {
    const t = await team();
    const [ada, adaAccount] = await memberUser(t, "ada");
    const [eve, eveAccount] = await memberUser(t, "eve");
    const [ivy] = await memberUser(t, "ivy");
    value(
      await removeMember(global(), {
        userId: t.admin,
        slug: t.slug,
        memberId: adaAccount,
        now: NOW,
      }),
    );
    ok(
      await patchScimUser(
        global(),
        DEPS,
        t.caller,
        ivy,
        { Operations: [{ op: "replace", path: "active", value: false }] },
        NOW,
      ),
    );
    const created = ok(
      await createScimGroup(global(), t.caller, group("All", [ada, eve, ivy]), NOW + 1),
    );
    expect(await groupMembers(created.id)).toEqual([eveAccount]);
    expect(await role(t, adaAccount)).toBeNull();
    const [row] = await global()
      .select({ active: schema.scimUsers.active })
      .from(schema.scimUsers)
      .where(eq(schema.scimUsers.id, ivy));
    expect(row?.active).toBe(false);
  });

  it("removes through SCIM with the dashboard's tombstones, and reading ends with the membership", async () => {
    const t = await team();
    const [ada, adaAccount] = await memberUser(t, "ada");
    const created = ok(await createScimGroup(global(), t.caller, group("Ops", [ada]), NOW));
    const [row] = await global()
      .select({ id: schema.workspaceGroupMembers.id })
      .from(schema.workspaceGroupMembers)
      .where(eq(schema.workspaceGroupMembers.groupId, created.id));
    ok(
      await patchScimGroup(
        global(),
        t.caller,
        created.id,
        { Operations: [{ op: "remove", path: `members[value eq "${ada}"]` }] },
        NOW + 1,
      ),
    );
    expect(await groupMembers(created.id)).toEqual([]);
    const tombstones = await global()
      .select()
      .from(schema.tombstones)
      .where(eq(schema.tombstones.id, row?.id ?? ""));
    expect(tombstones).toEqual([expect.objectContaining({ kind: "workspace_group_member" })]);
    expect(await events(t, "group.member_removed")).toEqual([
      expect.objectContaining({ actorType: "directory", targetId: adaAccount }),
    ]);
    ok(await deleteScimGroup(global(), t.caller, created.id, NOW + 2));
    const gone = await global()
      .select()
      .from(schema.tombstones)
      .where(eq(schema.tombstones.id, created.id));
    expect(gone).toEqual([expect.objectContaining({ kind: "workspace_group" })]);
    expect(await deleteScimGroup(global(), t.caller, created.id, NOW + 3)).toMatchObject({
      error: { status: 404 },
    });
  });

  it("lists by name without case, by externalId, and pages", async () => {
    const t = await team();
    ok(await createScimGroup(global(), t.caller, group("Alpha", [], "e1"), NOW));
    ok(await createScimGroup(global(), t.caller, group("Beta", [], "e2"), NOW + 1));
    const page = (
      filter: Parameters<typeof listScimGroups>[2]["filter"],
      startIndex = 1,
      count = 10,
    ) => listScimGroups(global(), t.caller, { filter, startIndex, count, members: false });
    expect(
      (await page({ attribute: "displayName", value: "alpha" })).groups.map((g) => g.displayName),
    ).toEqual(["Alpha"]);
    expect(
      (await page({ attribute: "externalId", value: "e2" })).groups.map((g) => g.displayName),
    ).toEqual(["Beta"]);
    const second = await page(null, 2, 1);
    expect(second.total).toBe(2);
    expect(second.groups.map((g) => g.displayName)).toEqual(["Beta"]);
    expect((await page(null, 1, 0)).groups).toEqual([]);
  });
});

describe("roles from groups", () => {
  it("gives the mapped role and takes it back, recording the changes", async () => {
    const t = await team();
    const [ada, adaAccount] = await memberUser(t, "ada");
    const created = ok(await createScimGroup(global(), t.caller, group("Editors", [ada]), NOW));
    expect(await role(t, adaAccount)).toBe("member");
    value(await settings(t, { editorGroup: created.id }));
    expect(await role(t, adaAccount)).toBe("editor");
    expect(await events(t, "member.role_changed")).toEqual([
      expect.objectContaining({ actorType: "user", actorId: t.admin, targetId: adaAccount }),
    ]);
    ok(
      await patchScimGroup(
        global(),
        t.caller,
        created.id,
        { schemas: [], Operations: [{ op: "Remove", path: "members", value: [{ value: ada }] }] },
        NOW + 1,
      ),
    );
    expect(await role(t, adaAccount)).toBe("member");
    const changes = await events(t, "member.role_changed");
    expect(changes.at(-1)).toMatchObject({ actorType: "directory", actorId: t.caller.tokenId });
    const members = value(await listMembers(global(), { userId: t.admin, slug: t.slug, now: NOW }));
    expect(members.members.find((m) => m.userId === adaAccount)?.directoryRole).toBe(false);
  });

  it("maps admin only with a confirmation naming the group, and only directory groups", async () => {
    const t = await team();
    const [ada, adaAccount] = await memberUser(t, "ada");
    const created = ok(await createScimGroup(global(), t.caller, group("Admins", [ada]), NOW));
    const dashboard = value(
      await createWorkspaceGroup(global(), {
        userId: t.admin,
        slug: t.slug,
        name: "Mine",
        now: NOW,
      }),
    );
    expect(await settings(t, { adminGroup: created.id })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(
      await settings(t, { adminGroup: created.id, confirmAdminGroup: dashboard.id }),
    ).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(await settings(t, { editorGroup: dashboard.id })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(await role(t, adaAccount)).toBe("member");
    value(await settings(t, { adminGroup: created.id, confirmAdminGroup: created.id }));
    expect(await role(t, adaAccount)).toBe("admin");
    const [, editor] = await memberUser(t, "ed");
    expect(await settings(t, { editorGroup: null }, editor)).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    const changed = await events(t, "scim.changed");
    expect(changed.at(-1)?.detail).toEqual({ fields: ["adminGroup"], adminGroup: created.id });
  });

  it("never sets a role from a payload, and leaves hand-set roles of others alone", async () => {
    const t = await team();
    const [ada, adaAccount] = await memberUser(t, "ada");
    const [, bobAccount] = await memberUser(t, "bob");
    value(
      await changeMemberRole(global(), {
        userId: t.admin,
        slug: t.slug,
        memberId: bobAccount,
        role: "editor",
        now: NOW,
      }),
    );
    const created = ok(
      await createScimGroup(
        global(),
        t.caller,
        { ...group("Team", [ada]), roles: ["admin"] } as never,
        NOW,
      ),
    );
    value(await settings(t, { editorGroup: created.id }));
    ok(await replaceScimGroup(global(), t.caller, created.id, group("Team", []), NOW + 1));
    expect(await role(t, adaAccount)).toBe("member");
    expect(await role(t, bobAccount)).toBe("editor");
  });

  it("lets the directory win at the next change of a hand-changed person's groups", async () => {
    const t = await team();
    const [ada, adaAccount] = await memberUser(t, "ada");
    const [cy] = await memberUser(t, "cy");
    const created = ok(await createScimGroup(global(), t.caller, group("Editors", [ada]), NOW));
    value(await settings(t, { editorGroup: created.id }));
    value(
      await changeMemberRole(global(), {
        userId: t.admin,
        slug: t.slug,
        memberId: adaAccount,
        role: "admin",
        now: NOW,
      }),
    );
    const members = value(await listMembers(global(), { userId: t.admin, slug: t.slug, now: NOW }));
    expect(members.members.find((m) => m.userId === adaAccount)?.directoryRole).toBe(true);
    // A push that does not change Ada's groups leaves her hand-set role.
    ok(
      await patchScimGroup(
        global(),
        t.caller,
        created.id,
        { Operations: [{ op: "add", path: "members", value: [{ value: cy }] }] },
        NOW + 1,
      ),
    );
    expect(await role(t, adaAccount)).toBe("admin");
    // A push that does change them: the directory wins.
    ok(
      await patchScimGroup(
        global(),
        t.caller,
        created.id,
        { Operations: [{ op: "remove", path: "members", value: [{ value: ada }] }] },
        NOW + 2,
      ),
    );
    ok(
      await patchScimGroup(
        global(),
        t.caller,
        created.id,
        { Operations: [{ op: "add", path: "members", value: [{ value: ada }] }] },
        NOW + 3,
      ),
    );
    expect(await role(t, adaAccount)).toBe("editor");
  });

  it("never demotes the last admin, through a push, a delete or an unmapping, and applies nothing", async () => {
    const t = await team();
    const [ada, adaAccount] = await memberUser(t, "ada");
    const created = ok(await createScimGroup(global(), t.caller, group("Admins", [ada]), NOW));
    value(await settings(t, { adminGroup: created.id, confirmAdminGroup: created.id }));
    expect(await role(t, adaAccount)).toBe("admin");
    // The hand-set admin leaves: Ada is the last admin.
    value(
      await changeMemberRole(global(), {
        userId: adaAccount,
        slug: t.slug,
        memberId: t.admin,
        role: "member",
        now: NOW,
      }),
    );
    const refused = { ok: false, error: { status: 400, scimType: "mutability" } };
    expect(
      await replaceScimGroup(global(), t.caller, created.id, group("Admins", []), NOW + 1),
    ).toMatchObject(refused);
    expect(await deleteScimGroup(global(), t.caller, created.id, NOW + 1)).toMatchObject(refused);
    expect(await settings(t, { adminGroup: null }, adaAccount)).toMatchObject({
      ok: false,
      code: "sole_workspace_admin",
    });
    expect(await role(t, adaAccount)).toBe("admin");
    expect(ok(await getScimGroup(global(), t.caller, created.id)).members.map((m) => m.id)).toEqual(
      [ada],
    );
  });

  it("deleting a mapped group clears the mapping and lowers its members", async () => {
    const t = await team();
    const [ada, adaAccount] = await memberUser(t, "ada");
    const created = ok(await createScimGroup(global(), t.caller, group("Editors", [ada]), NOW));
    value(await settings(t, { editorGroup: created.id }));
    ok(await deleteScimGroup(global(), t.caller, created.id, NOW + 1));
    expect(await role(t, adaAccount)).toBe("member");
    const [mapping] = await global()
      .select({ editor: schema.workspaceScim.editorGroupId })
      .from(schema.workspaceScim)
      .where(eq(schema.workspaceScim.workspaceId, t.id));
    expect(mapping?.editor).toBeNull();
  });
});

describe("races", () => {
  it("applies one of two concurrent group pushes and answers the other 409", async () => {
    const t = await team();
    const [ada] = await memberUser(t, "ada");
    const [bob] = await memberUser(t, "bob");
    const created = ok(await createScimGroup(global(), t.caller, group("G", []), NOW));
    const raced = raceGlobalBeforeFirstWrite(async () => {
      ok(await replaceScimGroup(global(), t.caller, created.id, group("G", [ada]), NOW + 1));
    });
    expect(
      await replaceScimGroup(raced, t.caller, created.id, group("G", [bob]), NOW + 2),
    ).toMatchObject({
      ok: false,
      error: { status: 409 },
    });
    expect(ok(await getScimGroup(global(), t.caller, created.id)).members.map((m) => m.id)).toEqual(
      [ada],
    );
  });

  it("leaves no group row for someone deactivated while a push ran", async () => {
    const t = await team();
    const [ada, adaAccount] = await memberUser(t, "ada");
    const created = ok(await createScimGroup(global(), t.caller, group("G", []), NOW));
    const raced = raceGlobalBeforeFirstWrite(async () => {
      ok(
        await patchScimUser(
          global(),
          DEPS,
          t.caller,
          ada,
          { Operations: [{ op: "replace", path: "active", value: false }] },
          NOW + 1,
        ),
      );
    });
    ok(await replaceScimGroup(raced, t.caller, created.id, group("G", [ada]), NOW + 2));
    expect(await role(t, adaAccount)).toBeNull();
    expect(await groupMembers(created.id)).toEqual([]);
  });

  it("recomputes from the mapping the batch sees when a mapping change races a push", async () => {
    const t = await team();
    const [ada, adaAccount] = await memberUser(t, "ada");
    const created = ok(await createScimGroup(global(), t.caller, group("G", []), NOW));
    const raced = raceGlobalBeforeFirstWrite(async () => {
      value(await settings(t, { editorGroup: created.id }));
    });
    ok(await replaceScimGroup(raced, t.caller, created.id, group("G", [ada]), NOW + 1));
    expect(await role(t, adaAccount)).toBe("editor");
  });
});
