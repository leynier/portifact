// SCIM groups and roles (decision 0017, "Groups and roles"): the findings of the security review
// of the second delivery, each reproduced. The directory only takes back what it gave; a hand
// change makes a role the admin's; concurrent mapping changes and a mapping racing a group delete
// answer a conflict; setting a mapping is gated on the plan; every join path gets the groups'
// role; a restore does not bring back a role the directory took away; a directory group can
// always stop syncing; the admin confirmation counts pending people.
import { env } from "cloudflare:test";
import { regionsFromEnv, schema } from "@portifact/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { applyTombstones, exportTombstones } from "../src/backups.ts";
import { acceptInvitation, inviteMember } from "../src/invitations.ts";
import {
  claimDirectoryMemberships,
  createScimToken,
  createScimUser,
  getScimOverview,
  operatorRevokeScimToken,
  replaceScimUser,
  type ScimCaller,
  type ScimDeps,
  updateScimSettings,
} from "../src/scim.ts";
import {
  createScimGroup,
  deleteScimGroup,
  getScimGroup,
  replaceScimGroup,
  stopDirectorySync,
} from "../src/scim-groups.ts";
import { joinWorkspaceThroughSso } from "../src/sso.ts";
import { renameWorkspaceGroup } from "../src/workspace-groups.ts";
import { changeMemberRole, leaveWorkspace } from "../src/workspaces.ts";
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

async function team(plan: "enterprise" | "team" = "enterprise"): Promise<Team> {
  const id = `ws_${hex()}`;
  const slug = `v${hex().slice(0, 20)}`;
  const domain = `rev${hex().slice(0, 10)}.com`;
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
  await grantPlan(id, "enterprise", { seats: 50 });
  const token = value(
    await createScimToken(global(), {
      userId: admin,
      slug,
      body: { label: "Okta", expiresInDays: 365 },
      now: NOW,
    }),
  );
  if (plan !== "enterprise") {
    await global().update(schema.ownerPlans).set({ plan }).where(eq(schema.ownerPlans.ownerId, id));
  }
  return { id, slug, domain, admin, caller: { tokenId: token.token.id, workspaceId: id } };
}

function ok<T>(result: { ok: true; value: T } | { ok: false; error: { detail: string } }): T {
  if (!result.ok) throw new Error(result.error.detail);
  return result.value;
}

const user = (userName: string, active = true) => ({
  userName,
  externalId: null,
  active,
  names: {},
});
const group = (displayName: string, members: string[]) => ({
  displayName,
  externalId: null,
  members,
});

/** A member with an account and a directory user linked to it: [directory user, account]. */
async function linked(t: Team, local: string, role: "admin" | "editor" | "member" = "member") {
  const account = await person(`${local}@${t.domain}`);
  await global()
    .insert(schema.workspaceMembers)
    .values({ workspaceId: t.id, userId: account, role, updatedAt: NOW });
  const created = ok(
    await createScimUser(global(), DEPS, t.caller, user(`${local}@${t.domain}`), NOW),
  );
  return [created.user.id, account] as const;
}

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

const settings = (
  t: Team,
  body: Parameters<typeof updateScimSettings>[1]["body"],
  userId = t.admin,
) => updateScimSettings(global(), { userId, slug: t.slug, body, now: NOW });

describe("finding 1: the directory only takes back what it gave", () => {
  it("never demotes a hand-set admin through the editor mapping", async () => {
    const t = await team();
    const eds = ok(await createScimGroup(global(), t.caller, group("Eds", []), NOW));
    value(await settings(t, { editorGroup: eds.id }));
    const [boss, bossAccount] = await linked(t, "boss", "admin");
    ok(await replaceScimGroup(global(), t.caller, eds.id, group("Eds", [boss]), NOW + 1));
    expect(await role(t, bossAccount)).toBe("admin");
    ok(await replaceScimGroup(global(), t.caller, eds.id, group("Eds", []), NOW + 2));
    expect(await role(t, bossAccount)).toBe("admin");
  });

  it("raises past a hand-set role and takes back only the role it gave", async () => {
    const t = await team();
    const admins = ok(await createScimGroup(global(), t.caller, group("Admins", []), NOW));
    value(await settings(t, { adminGroup: admins.id, confirmAdminGroup: admins.id }));
    const [ada, adaAccount] = await linked(t, "ada", "editor");
    ok(await replaceScimGroup(global(), t.caller, admins.id, group("Admins", [ada]), NOW + 1));
    expect(await role(t, adaAccount)).toBe("admin");
    ok(await replaceScimGroup(global(), t.caller, admins.id, group("Admins", []), NOW + 2));
    expect(await role(t, adaAccount)).toBe("member");
  });
});

describe("finding 2: a hand change or a removal makes the role the admin's", () => {
  it("does not demote through a stale mapped role after a hand change", async () => {
    const t = await team();
    const eds = ok(await createScimGroup(global(), t.caller, group("Eds", []), NOW));
    value(await settings(t, { editorGroup: eds.id }));
    const [cy, cyAccount] = await linked(t, "cy");
    ok(await replaceScimGroup(global(), t.caller, eds.id, group("Eds", [cy]), NOW + 1));
    expect(await role(t, cyAccount)).toBe("editor");
    value(
      await changeMemberRole(global(), {
        userId: t.admin,
        slug: t.slug,
        memberId: cyAccount,
        role: "admin",
        now: NOW + 2,
      }),
    );
    value(
      await changeMemberRole(global(), {
        userId: t.admin,
        slug: t.slug,
        memberId: cyAccount,
        role: "editor",
        now: NOW + 3,
      }),
    );
    ok(await replaceScimGroup(global(), t.caller, eds.id, group("Eds", []), NOW + 4));
    expect(await role(t, cyAccount)).toBe("editor");
  });

  it("forgets the mapped role when the person leaves, so a later admin role is the admin's", async () => {
    const t = await team();
    const eds = ok(await createScimGroup(global(), t.caller, group("Eds", []), NOW));
    const other = ok(await createScimGroup(global(), t.caller, group("Other", []), NOW));
    value(await settings(t, { editorGroup: eds.id }));
    const [cy, cyAccount] = await linked(t, "cy");
    ok(await replaceScimGroup(global(), t.caller, eds.id, group("Eds", [cy]), NOW + 1));
    value(await leaveWorkspace(global(), { userId: cyAccount, slug: t.slug, now: NOW + 2 }));
    // Back as an admin by hand, then pushed through an unmapped group.
    await global()
      .insert(schema.workspaceMembers)
      .values({ workspaceId: t.id, userId: cyAccount, role: "editor", updatedAt: NOW });
    ok(await replaceScimGroup(global(), t.caller, other.id, group("Other", [cy]), NOW + 3));
    expect(await role(t, cyAccount)).toBe("editor");
    const [row] = await global()
      .select({ mapped: schema.scimUsers.mappedRole })
      .from(schema.scimUsers)
      .where(eq(schema.scimUsers.id, cy));
    expect(row?.mapped).toBeNull();
  });
});

describe("finding 3: concurrent mapping changes", () => {
  it("answers version_conflict to the loser and leaves no stale admin", async () => {
    const t = await team();
    const [ada, adaAccount] = await linked(t, "ada");
    const a = ok(await createScimGroup(global(), t.caller, group("A", [ada]), NOW));
    const b = ok(await createScimGroup(global(), t.caller, group("B", []), NOW));
    const raced = raceGlobalBeforeFirstWrite(async () => {
      value(await settings(t, { adminGroup: a.id, confirmAdminGroup: a.id }));
    });
    const loser = await updateScimSettings(raced, {
      userId: t.admin,
      slug: t.slug,
      body: { adminGroup: b.id, confirmAdminGroup: b.id },
      now: NOW + 1,
    });
    expect(loser).toMatchObject({ ok: false, code: "version_conflict" });
    expect(await role(t, adaAccount)).toBe("admin");
    value(await settings(t, { adminGroup: b.id, confirmAdminGroup: b.id }));
    expect(await role(t, adaAccount)).toBe("member");
  });
});

describe("finding 4: a mapping that races a group delete", () => {
  it("is neither audited nor reported as done", async () => {
    const t = await team();
    const eds = ok(await createScimGroup(global(), t.caller, group("Eds", []), NOW));
    const raced = raceGlobalBeforeFirstWrite(async () => {
      ok(await deleteScimGroup(global(), t.caller, eds.id, NOW + 1));
    });
    const result = await updateScimSettings(raced, {
      userId: t.admin,
      slug: t.slug,
      body: { editorGroup: eds.id },
      now: NOW + 2,
    });
    expect(result).toMatchObject({ ok: false, code: "version_conflict" });
    const events = await global()
      .select()
      .from(schema.auditEvents)
      .where(
        and(eq(schema.auditEvents.ownerId, t.id), eq(schema.auditEvents.kind, "scim.changed")),
      );
    expect(events).toEqual([]);
  });
});

describe("finding 5: setting a mapping needs the plan", () => {
  it("refuses a mapping to a group without scim, and keeps unmapping and the email switch open", async () => {
    const t = await team();
    const eds = ok(await createScimGroup(global(), t.caller, group("Eds", []), NOW));
    value(await settings(t, { editorGroup: eds.id }));
    await global()
      .update(schema.ownerPlans)
      .set({ plan: "team" })
      .where(eq(schema.ownerPlans.ownerId, t.id));
    expect(await settings(t, { adminGroup: eds.id, confirmAdminGroup: eds.id })).toMatchObject({
      ok: false,
      code: "plan_required",
    });
    expect(await settings(t, { editorGroup: null })).toMatchObject({ ok: true });
    expect(await settings(t, { invitationEmails: true })).toMatchObject({ ok: true });
  });
});

describe("finding 6: every join path gets the groups' role", () => {
  async function editorGroupWith(t: Team, ids: string[]) {
    const eds = ok(await createScimGroup(global(), t.caller, group("Eds", ids), NOW));
    value(await settings(t, { editorGroup: eds.id }));
    return eds;
  }

  it("on accepting an admin's invitation", async () => {
    const t = await team();
    const email = `inv@${t.domain}`;
    const invited = value(
      await inviteMember(
        global(),
        { userId: t.admin, slug: t.slug, email, role: "member", now: NOW },
        { send: async () => {} },
      ),
    );
    const pending = ok(await createScimUser(global(), DEPS, t.caller, user(email), NOW));
    await editorGroupWith(t, [pending.user.id]);
    // The directory's own row is withdrawn by an admin; the person accepts the admin's invitation.
    await global()
      .delete(schema.workspaceInvitations)
      .where(
        and(
          eq(schema.workspaceInvitations.email, email),
          eq(schema.workspaceInvitations.source, "directory"),
        ),
      );
    const account = await person(email);
    value(
      await acceptInvitation(global(), {
        userId: account,
        key: { invitationId: invited.id },
        now: NOW + 1,
      }),
    );
    expect(await role(t, account)).toBe("editor");
  });

  it("on joining through single sign-on", async () => {
    const t = await team();
    const email = `sso@${t.domain}`;
    const pending = ok(await createScimUser(global(), DEPS, t.caller, user(email), NOW));
    await editorGroupWith(t, [pending.user.id]);
    const account = await person(email);
    const joined = await joinWorkspaceThroughSso(global(), {
      workspaceId: t.id,
      userId: account,
      email,
      now: NOW + 1,
      consumeInvitation: true,
    });
    expect(joined).toMatchObject({ ok: true });
    expect(await role(t, account)).toBe("editor");
  });

  it("on the directory's own claim, and when a push inserts a group row for someone already in its list", async () => {
    const t = await team();
    const email = `claim@${t.domain}`;
    const pending = ok(await createScimUser(global(), DEPS, t.caller, user(email), NOW));
    const eds = await editorGroupWith(t, [pending.user.id]);
    const account = await person(email);
    expect(await claimDirectoryMemberships(global(), { userId: account, now: NOW + 1 })).toBe(1);
    expect(await role(t, account)).toBe("editor");
    // A member who joined by hand and whom the directory links later.
    const late = await person(`late@${t.domain}`);
    await global()
      .insert(schema.workspaceMembers)
      .values({ workspaceId: t.id, userId: late, role: "member", updatedAt: NOW });
    const lateUser = ok(
      await createScimUser(global(), DEPS, t.caller, { ...user(`late-x@${t.domain}`) }, NOW),
    );
    ok(
      await replaceScimGroup(
        global(),
        t.caller,
        eds.id,
        group("Eds", [pending.user.id, lateUser.user.id]),
        NOW + 2,
      ),
    );
    await global()
      .update(schema.scimUsers)
      .set({ userId: late })
      .where(eq(schema.scimUsers.id, lateUser.user.id));
    ok(
      await replaceScimGroup(
        global(),
        t.caller,
        eds.id,
        group("Eds", [pending.user.id, lateUser.user.id]),
        NOW + 3,
      ),
    );
    expect(await role(t, late)).toBe("editor");
  });
});

describe("finding 7: a restore does not bring back a role the directory took away", () => {
  it("recomputes roles after applying tombstones", async () => {
    const t = await team();
    const [ada, adaAccount] = await linked(t, "ada");
    const admins = ok(await createScimGroup(global(), t.caller, group("Admins", [ada]), NOW));
    value(await settings(t, { adminGroup: admins.id, confirmAdminGroup: admins.id }));
    expect(await role(t, adaAccount)).toBe("admin");
    const [row] = await global()
      .select()
      .from(schema.workspaceGroupMembers)
      .where(eq(schema.workspaceGroupMembers.groupId, admins.id));
    ok(await replaceScimGroup(global(), t.caller, admins.id, group("Admins", []), NOW + 1));
    expect(await role(t, adaAccount)).toBe("member");
    const markers = await exportTombstones(regionsFromEnv(env));
    // A D1 Time Travel restore to before the removal: the admin role and the group row come back.
    await global().delete(schema.tombstones);
    await global()
      .update(schema.workspaceMembers)
      .set({ role: "admin" })
      .where(
        and(
          eq(schema.workspaceMembers.workspaceId, t.id),
          eq(schema.workspaceMembers.userId, adaAccount),
        ),
      );
    await global()
      .update(schema.scimUsers)
      .set({ mappedRole: "admin" })
      .where(eq(schema.scimUsers.id, ada));
    if (row) await global().insert(schema.workspaceGroupMembers).values(row);
    const result = await applyTombstones(db(), markers, NOW + 2);
    expect(result.directoryRoles).toBeGreaterThanOrEqual(1);
    expect(await role(t, adaAccount)).toBe("member");
  });
});

describe("finding 8: a directory group can always stop syncing", () => {
  async function frozen(t: Team) {
    const [ada, adaAccount] = await linked(t, "ada");
    const [bob, bobAccount] = await linked(t, "bob");
    const eds = ok(await createScimGroup(global(), t.caller, group("Eds", [ada]), NOW));
    const ads = ok(await createScimGroup(global(), t.caller, group("Ads", [bob]), NOW));
    value(await settings(t, { editorGroup: eds.id }));
    value(await settings(t, { adminGroup: ads.id, confirmAdminGroup: ads.id }));
    expect(await role(t, adaAccount)).toBe("editor");
    expect(await role(t, bobAccount)).toBe("admin");
    return { eds, adaAccount, bobAccount };
  }

  it.each(["token revoked", "plan lapsed", "switched off"])("works with the %s", async (state) => {
    const t = await team();
    const { eds, adaAccount, bobAccount } = await frozen(t);
    if (state === "token revoked") await operatorRevokeScimToken(global(), t.caller.tokenId, NOW);
    if (state === "plan lapsed") {
      await global()
        .update(schema.ownerPlans)
        .set({ plan: "team" })
        .where(eq(schema.ownerPlans.ownerId, t.id));
    }
    // (Switched off is the app's concern: the services never read SCIM_ENABLED; the app test
    // covers the routes.) Unmapping lowers what the mapping gave.
    expect(await settings(t, { adminGroup: null })).toMatchObject({ ok: true });
    expect(await role(t, bobAccount)).toBe("member");
    // Stopping the sync keeps the roles the group gave, as set by hand.
    value(
      await stopDirectorySync(global(), {
        userId: t.admin,
        slug: t.slug,
        groupId: eds.id,
        now: NOW + 1,
      }),
    );
    expect(await role(t, adaAccount)).toBe("editor");
    const [mapped] = await global()
      .select({ m: schema.scimUsers.mappedRole })
      .from(schema.scimUsers)
      .where(eq(schema.scimUsers.userId, adaAccount));
    expect(mapped?.m).toBeNull();
    // An ordinary group now: admins edit it, and SCIM no longer sees it.
    value(
      await renameWorkspaceGroup(global(), {
        userId: t.admin,
        slug: t.slug,
        groupId: eds.id,
        name: "Editors",
        now: NOW + 2,
      }),
    );
    expect(await getScimGroup(global(), t.caller, eds.id)).toMatchObject({
      error: { status: 404 },
    });
  });

  it("clears the group's mapping in the same batch and refuses others", async () => {
    const t = await team();
    const { eds } = await frozen(t);
    const [, editorAccount] = await linked(t, "ed", "editor");
    expect(
      await stopDirectorySync(global(), {
        userId: editorAccount,
        slug: t.slug,
        groupId: eds.id,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    value(
      await stopDirectorySync(global(), {
        userId: t.admin,
        slug: t.slug,
        groupId: eds.id,
        now: NOW + 1,
      }),
    );
    const overview = value(
      await getScimOverview(global(), { userId: t.admin, slug: t.slug, now: NOW, baseUrl: "x" }),
    );
    expect(overview.roleMapping.editor).toBeNull();
    expect(
      await stopDirectorySync(global(), {
        userId: t.admin,
        slug: t.slug,
        groupId: eds.id,
        now: NOW + 2,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
    expect(await createScimGroup(global(), t.caller, group("eds", []), NOW + 3)).toMatchObject({
      ok: false,
      error: { status: 409 },
    });
  });
});

describe("finding 9: the admin confirmation counts pending people", () => {
  it("offers the members now and the people who will be when they sign in", async () => {
    const t = await team();
    const [ada] = await linked(t, "ada");
    const pending = ok(await createScimUser(global(), DEPS, t.caller, user(`p@${t.domain}`), NOW));
    const admins = ok(
      await createScimGroup(global(), t.caller, group("Admins", [ada, pending.user.id]), NOW),
    );
    const overview = value(
      await getScimOverview(global(), { userId: t.admin, slug: t.slug, now: NOW, baseUrl: "x" }),
    );
    expect(overview.groups.find((g) => g.id === admins.id)).toMatchObject({
      members: 1,
      pending: 1,
    });
    void replaceScimUser;
  });
});
