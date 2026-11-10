// Groups of a workspace (premium plan T3, decision 0014): managing them, listing them on a
// restricted artifact, reading and commenting through them, revocation, the plan, transfers,
// races, the maintenance scan and a restore.
import { env } from "cloudflare:test";
import type { AnnotationTarget, CommentScope } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getAccess, updateAccess } from "../src/access.ts";
import { exportAccount } from "../src/account-data.ts";
import {
  createAnnotationThread,
  exportAnnotations,
  getAnnotationThread,
  type HumanCheck,
  listAnnotations,
  replyToAnnotationThread,
  setAnnotationMode,
} from "../src/annotations.ts";
import { getAuditLog } from "../src/audit.ts";
import { applyTombstones, exportTombstones } from "../src/backups.ts";
import { listOpenFeedback } from "../src/feedback.ts";
import { commitPublish, preparePublish } from "../src/publish.ts";
import {
  checkReadAccess,
  issueReadHandoff,
  redeemReadHandoff,
  refreshReadSession,
} from "../src/read-access.ts";
import { createServiceToken } from "../src/service-tokens.ts";
import { transferArtifact } from "../src/transfer.ts";
import {
  addGroupMember,
  createWorkspaceGroup,
  deleteWorkspaceGroup,
  GROUP_TOMBSTONE_RETENTION_MS,
  getWorkspaceGroup,
  listWorkspaceGroups,
  pruneArtifactGroups,
  pruneGroupTombstones,
  removeGroupMember,
  renameWorkspaceGroup,
} from "../src/workspace-groups.ts";
import {
  changeMemberRole,
  leaveWorkspace,
  removeMember,
  resolveOwnerScope,
} from "../src/workspaces.ts";
import { DAY, db, grantPlan, NOW, session, sha256, value } from "./fixtures.ts";
import { raceBeforeFirstWrite, raceGlobalBeforeFirstWrite } from "./race.ts";

const HUMAN: HumanCheck = { token: "solved", verify: async () => "passed" };
const DOC: AnnotationTarget = { schema: 1, path: "index.html", anchor: { kind: "document" } };
const HOUR = 3_600_000;
const hex = () => crypto.randomUUID().replaceAll("-", "");

async function person(name: string) {
  const id = `u_${hex()}`;
  const email = `${name.toLowerCase()}-${hex().slice(0, 8)}@example.test`;
  await db()
    .insert(schema.users)
    .values({
      id,
      name,
      email,
      emailVerified: true,
      createdAt: new Date(NOW - 30 * DAY),
      updatedAt: new Date(NOW),
    });
  return { id, email };
}

async function team(plan: "team" | "free" = "team") {
  const id = `ws_${hex()}`;
  const slug = `g${hex().slice(0, 20)}`;
  const t = {
    id,
    slug,
    admin: await person("Admin"),
    editor: await person("Editor"),
    member: await person("Member"),
    other: await person("Other"),
    outsider: await person("Outsider"),
  };
  await db()
    .insert(schema.workspaces)
    .values({ id, slug, name: "Team", createdBy: t.admin.id, updatedAt: NOW });
  await db()
    .insert(schema.workspaceMembers)
    .values([
      { workspaceId: id, userId: t.admin.id, role: "admin", updatedAt: NOW },
      { workspaceId: id, userId: t.editor.id, role: "editor", updatedAt: NOW },
      { workspaceId: id, userId: t.member.id, role: "member", updatedAt: NOW },
      { workspaceId: id, userId: t.other.id, role: "member", updatedAt: NOW },
    ]);
  if (plan === "team") await grantPlan(id, "team", { seats: 10 });
  return t;
}
type Team = Awaited<ReturnType<typeof team>>;

async function publishIn(userId: string, ownerId: string) {
  const id = await publishOnly(userId, ownerId);
  value(await setAnnotationMode(db(), { userId, artifactId: id, mode: "open", now: NOW }));
  return id;
}

async function publishOnly(userId: string, ownerId: string) {
  const body = `<p>${crypto.randomUUID()}</p>`;
  const prepared = value(
    await preparePublish(db(), {
      userId,
      targetOwnerId: ownerId,
      type: "site",
      name: "Plan",
      entrypoint: "index.html",
      baseVersionId: null,
      files: [
        {
          path: "index.html",
          kind: "published",
          sha256: await sha256(body),
          size: body.length,
          contentType: "text/html",
        },
      ],
      now: NOW,
    }),
  );
  await env.ARTIFACTS.put(`objects/${ownerId}/${await sha256(body)}`, body);
  return value(
    await commitPublish(db(), env.ARTIFACTS, { userId, sessionId: prepared.sessionId, now: NOW }),
  ).artifactId;
}

const create = (t: Team, name: string, userId = t.admin.id) =>
  createWorkspaceGroup(db().global, { userId, slug: t.slug, name, now: NOW });
const join = (t: Team, groupId: string, memberId: string, now = NOW) =>
  addGroupMember(db().global, { userId: t.admin.id, slug: t.slug, groupId, memberId, now });
const reads = async (artifactId: string, userId: string, now = NOW) =>
  (await checkReadAccess(db(), { artifactId, userId, now })).ok;
const change = (
  userId: string,
  artifactId: string,
  body: Parameters<typeof updateAccess>[1]["change"],
  now = NOW,
) => updateAccess(db(), { userId, artifactId, change: body, now });

/** A team with a group holding the member, and a restricted artifact listing it. */
async function listed() {
  const t = await team();
  const group = value(await create(t, "Design"));
  value(await join(t, group.id, t.member.id));
  const artifactId = await publishIn(t.admin.id, t.id);
  value(await change(t.admin.id, artifactId, { addGroups: [group.id] }));
  return { t, group, artifactId };
}

async function token(t: Team, scopes: ("artifacts:read" | "artifacts:share")[]) {
  return value(
    await createServiceToken(db().global, {
      userId: t.admin.id,
      slug: t.slug,
      body: {
        label: "CI",
        role: "editor",
        scopes,
        expiresInDays: 30,
        restriction: { kind: "none" },
      },
      now: NOW,
    }),
  ).token.id;
}

describe("managing groups", () => {
  it("lets admins create, rename, fill and delete groups, with their audit events", async () => {
    const t = await team();
    const group = value(await create(t, "  Design  "));
    expect(group).toMatchObject({ name: "Design", members: 0 });
    expect(group.id).toMatch(/^wg_[0-9a-f]{32}$/);
    const members = value(await join(t, group.id, t.member.id));
    expect(members.map((m) => m.userId)).toEqual([t.member.id]);
    // Adding the same person twice changes nothing.
    expect(value(await join(t, group.id, t.member.id))).toHaveLength(1);
    const renamed = value(
      await renameWorkspaceGroup(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        groupId: group.id,
        name: "Product design",
        now: NOW + 1,
      }),
    );
    expect(renamed).toMatchObject({ name: "Product design", members: 1 });
    value(
      await removeGroupMember(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        groupId: group.id,
        memberId: t.member.id,
        now: NOW + 2,
      }),
    );
    value(
      await deleteWorkspaceGroup(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        groupId: group.id,
        now: NOW + 3,
      }),
    );
    const events = await db()
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.ownerId, t.id));
    expect(events.map((e) => e.kind).sort()).toEqual([
      "group.created",
      "group.deleted",
      "group.member_added",
      "group.member_removed",
      "group.renamed",
    ]);
    // The name is owner-chosen text: never stored in an event.
    expect(JSON.stringify(events)).not.toContain("Design");
    const added = events.find((e) => e.kind === "group.member_added");
    expect(added).toMatchObject({ targetId: t.member.id, detail: { group: group.id } });
    // Shown with the current name, or none once the group is gone.
    const actor = value(await resolveOwnerScope(db().global, t.admin.id, t.slug));
    await grantPlan(t.id, "team", { seats: 10 });
    const log = value(await getAuditLog(db(), { actor, filters: {}, limit: 10, now: NOW + 4 }));
    expect(log.events.find((e) => e.kind === "group.created")?.group).toEqual({
      id: group.id,
      name: null,
    });
  });

  it("refuses a name that normalization lengthens past the limit, on create and rename", async () => {
    const t = await team();
    const long = "\u0958".repeat(80);
    expect(await create(t, long)).toMatchObject({ ok: false, code: "invalid_input" });
    const group = value(await create(t, "Design"));
    expect(
      await renameWorkspaceGroup(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        groupId: group.id,
        name: long,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    // Forty of them normalize to exactly eighty characters.
    expect(value(await create(t, "\u0958".repeat(40))).name).toHaveLength(80);
  });

  it("refuses a name the workspace already has, whatever the case", async () => {
    const t = await team();
    value(await create(t, "Design"));
    expect(await create(t, "DESIGN")).toMatchObject({
      ok: false,
      code: "invalid_input",
      message: "The workspace already has a group with this name.",
    });
    const other = value(await create(t, "Research"));
    expect(
      await renameWorkspaceGroup(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        groupId: other.id,
        name: "design",
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("caps groups per workspace and members per group", async () => {
    const t = await team();
    for (let chunk = 0; chunk < 5; chunk++) {
      await db()
        .insert(schema.workspaceGroups)
        .values(
          Array.from({ length: 10 }, (_, i) => ({
            id: `wg_${hex()}`,
            workspaceId: t.id,
            name: `Group ${chunk * 10 + i}`,
            createdAt: NOW,
            updatedAt: NOW,
          })),
        );
    }
    expect(await create(t, "One more")).toMatchObject({
      ok: false,
      code: "quota_exceeded",
      message: "A workspace can have at most 50 groups.",
    });
  });

  it("answers by role: admins manage, editors list names and counts, members nothing", async () => {
    const t = await team();
    const group = value(await create(t, "Design"));
    value(await join(t, group.id, t.member.id));
    const list = (userId: string) =>
      listWorkspaceGroups(db().global, { userId, slug: t.slug, now: NOW });
    expect(value(await list(t.editor.id))).toMatchObject({
      available: true,
      groups: [{ id: group.id, name: "Design", members: 1 }],
    });
    expect(JSON.stringify(value(await list(t.editor.id)))).not.toContain(t.member.email);
    expect(await list(t.member.id)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await list(t.outsider.id)).toMatchObject({
      ok: false,
      code: "not_found",
      message: "Workspace not found.",
    });
    const detail = (userId: string) =>
      getWorkspaceGroup(db().global, { userId, slug: t.slug, groupId: group.id });
    expect(value(await detail(t.admin.id)).members[0]).toMatchObject({
      userId: t.member.id,
      email: t.member.email,
      role: "member",
    });
    expect(await detail(t.editor.id)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await detail(t.outsider.id)).toMatchObject({ ok: false, code: "not_found" });
    for (const userId of [t.editor.id, t.member.id]) {
      expect(await create(t, "Mine", userId)).toMatchObject({ ok: false, code: "forbidden" });
    }
    expect(await create(t, "Mine", t.outsider.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(
      await addGroupMember(db().global, {
        userId: t.editor.id,
        slug: t.slug,
        groupId: group.id,
        memberId: t.other.id,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    // Only members of the workspace can be in its groups.
    expect(await join(t, group.id, t.outsider.id)).toMatchObject({
      ok: false,
      code: "not_found",
      message: "Member not found.",
    });
    expect(await join(t, `wg_${hex()}`, t.other.id)).toMatchObject({
      ok: false,
      code: "not_found",
      message: "Group not found.",
    });
  });

  it("lets a service token list groups only with artifacts:share, and never manage them", async () => {
    const t = await team();
    value(await create(t, "Design"));
    const reader = await token(t, ["artifacts:read"]);
    const sharer = await token(t, ["artifacts:read", "artifacts:share"]);
    const list = (userId: string) =>
      listWorkspaceGroups(db().global, { userId, slug: t.slug, now: NOW });
    expect(await list(reader)).toMatchObject({ ok: false, code: "forbidden" });
    expect(value(await list(sharer)).groups).toHaveLength(1);
    expect(await create(t, "Bots", sharer)).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("needs the plan to create groups and add members, never to rename, empty or delete", async () => {
    const t = await team();
    const group = value(await create(t, "Design"));
    value(await join(t, group.id, t.member.id));
    await grantPlan(t.id, "free");
    expect(await create(t, "Research")).toMatchObject({ ok: false, code: "plan_required" });
    expect(await join(t, group.id, t.other.id)).toMatchObject({ ok: false, code: "plan_required" });
    expect(
      value(await listWorkspaceGroups(db().global, { userId: t.admin.id, slug: t.slug, now: NOW }))
        .available,
    ).toBe(false);
    value(
      await renameWorkspaceGroup(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        groupId: group.id,
        name: "Old design",
        now: NOW,
      }),
    );
    value(
      await removeGroupMember(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        groupId: group.id,
        memberId: t.member.id,
        now: NOW,
      }),
    );
    value(
      await deleteWorkspaceGroup(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        groupId: group.id,
        now: NOW,
      }),
    );
  });

  it("takes people out of the workspace's groups when they leave or are removed", async () => {
    const t = await team();
    const group = value(await create(t, "Design"));
    value(await join(t, group.id, t.member.id));
    value(await join(t, group.id, t.other.id));
    value(await leaveWorkspace(db().global, { userId: t.member.id, slug: t.slug, now: NOW }));
    value(
      await removeMember(db().global, { userId: t.admin.id, slug: t.slug, memberId: t.other.id }),
    );
    const left = await db()
      .select()
      .from(schema.workspaceGroupMembers)
      .where(eq(schema.workspaceGroupMembers.groupId, group.id));
    expect(left).toEqual([]);
    // Both memberships are tombstoned, so a restore cannot bring them back.
    const markers = (await exportTombstones(db())).filter(
      (m) => m.kind === "workspace_group_member",
    );
    expect(markers.length).toBeGreaterThanOrEqual(2);
    // The database refuses a member of another workspace or none outright.
    await expect(
      db()
        .insert(schema.workspaceGroupMembers)
        .values({
          id: `wgm_${hex()}`,
          groupId: group.id,
          workspaceId: t.id,
          userId: t.outsider.id,
          createdAt: NOW,
        }),
    ).rejects.toThrow();
  });
});

describe("the account export", () => {
  it("lists the groups the account is in, never the other members", async () => {
    const t = await team();
    const group = value(await create(t, "Design"));
    value(await join(t, group.id, t.member.id));
    value(await join(t, group.id, t.other.id));
    const exported = value(await exportAccount(db(), { userId: t.member.id, now: NOW }));
    const space = exported.workspaces.find((w) => w.slug === t.slug);
    expect(space?.groups).toEqual([{ name: "Design", addedAt: new Date(NOW).toISOString() }]);
    expect(JSON.stringify(exported)).not.toContain(t.other.id);
    const admin = value(await exportAccount(db(), { userId: t.admin.id, now: NOW }));
    expect(admin.workspaces.find((w) => w.slug === t.slug)?.groups).toEqual([]);
  });
});

describe("groups on an artifact", () => {
  it("lets the members of a listed group read a restricted artifact, and nobody else", async () => {
    const { t, group, artifactId } = await listed();
    expect(await reads(artifactId, t.member.id)).toBe(true);
    expect(await reads(artifactId, t.other.id)).toBe(false);
    expect(await reads(artifactId, t.outsider.id)).toBe(false);
    const view = value(await getAccess(db(), { userId: t.editor.id, artifactId, now: NOW }));
    expect(view.groups).toEqual([
      { id: group.id, name: "Design", members: 1, commentVisibility: null },
    ]);
    expect(view.policyGeneration).toBe(2);
    // In another mode the group grants nothing more than the mode does.
    value(await change(t.admin.id, artifactId, { mode: "authenticated" }));
    expect(await reads(artifactId, t.outsider.id)).toBe(true);
  });

  it("refuses groups on a personal artifact and groups of another workspace", async () => {
    const t = await team();
    const elsewhere = await team();
    const foreign = value(await create(elsewhere, "Theirs"));
    const own = value(await create(t, "Ours"));
    const personal = await publishIn(t.admin.id, t.admin.id);
    expect(await change(t.admin.id, personal, { addGroups: [own.id] })).toMatchObject({
      ok: false,
      code: "invalid_input",
      message: "Only workspace artifacts can list groups.",
    });
    const artifactId = await publishIn(t.admin.id, t.id);
    expect(await change(t.admin.id, artifactId, { addGroups: [foreign.id] })).toMatchObject({
      ok: false,
      code: "invalid_input",
      message: `${foreign.id} is not a group of this workspace.`,
    });
    expect(
      await change(t.admin.id, artifactId, {
        groupCommentVisibility: [{ group: own.id, commentVisibility: "all" }],
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("counts only groups that still exist toward the cap, and drops the stale rows", async () => {
    const t = await team();
    const artifactId = await publishIn(t.admin.id, t.id);
    const ids: string[] = [];
    for (let i = 0; i < 21; i++) ids.push(value(await create(t, `G${i}`)).id);
    value(await change(t.admin.id, artifactId, { addGroups: ids.slice(0, 20) }));
    for (const id of ids.slice(0, 5)) {
      value(
        await deleteWorkspaceGroup(db().global, {
          userId: t.admin.id,
          slug: t.slug,
          groupId: id,
          now: NOW,
        }),
      );
    }
    const view = value(await change(t.admin.id, artifactId, { addGroups: [ids[20] as string] }));
    expect(view.groups).toHaveLength(16);
    const rows = await db()
      .select({ groupId: schema.artifactGroups.groupId })
      .from(schema.artifactGroups)
      .where(eq(schema.artifactGroups.artifactId, artifactId));
    expect(rows).toHaveLength(16);
  });

  it("caps the groups an artifact lists", async () => {
    const t = await team();
    const artifactId = await publishIn(t.admin.id, t.id);
    const ids = [];
    for (let i = 0; i < 21; i++) ids.push(value(await create(t, `G${i}`)).id);
    value(await change(t.admin.id, artifactId, { addGroups: ids.slice(0, 20) }));
    expect(await change(t.admin.id, artifactId, { addGroups: [ids[20] as string] })).toMatchObject({
      ok: false,
      code: "quota_exceeded",
    });
  });

  it("lets only the owner side change an artifact's groups, and tokens only with the scope", async () => {
    const t = await team();
    const group = value(await create(t, "Design"));
    const artifactId = await publishIn(t.admin.id, t.id);
    expect(await change(t.member.id, artifactId, { addGroups: [group.id] })).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect(await change(t.outsider.id, artifactId, { addGroups: [group.id] })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    value(await change(t.editor.id, artifactId, { addGroups: [group.id] }));
    const sharer = await token(t, ["artifacts:read", "artifacts:share"]);
    value(await change(sharer, artifactId, { removeGroups: [group.id] }));
    value(await change(sharer, artifactId, { addGroups: [group.id] }));
    expect(
      await change(sharer, artifactId, {
        groupCommentVisibility: [{ group: group.id, commentVisibility: "all" }],
      }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    const reader = await token(t, ["artifacts:read"]);
    expect(value(await getAccess(db(), { userId: reader, artifactId, now: NOW })).groups).toEqual(
      [],
    );
    expect(
      value(await getAccess(db(), { userId: sharer, artifactId, now: NOW })).groups,
    ).toHaveLength(1);
  });

  it("records group changes as counts in access.changed", async () => {
    const { t, group, artifactId } = await listed();
    value(
      await change(t.admin.id, artifactId, {
        groupCommentVisibility: [{ group: group.id, commentVisibility: "all" }],
      }),
    );
    const events = await db()
      .select({ detail: schema.auditEvents.detail })
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.artifactId, artifactId),
          eq(schema.auditEvents.kind, "access.changed"),
        ),
      );
    expect(events.map((e) => e.detail)).toEqual(
      expect.arrayContaining([{ groupsAdded: 1 }, { groupExceptions: 1 }]),
    );
  });

  it("needs the plan to add a group, never to remove one, and grants nothing while it lapsed", async () => {
    const { t, group, artifactId } = await listed();
    const second = value(await create(t, "Research"));
    await grantPlan(t.id, "team", { seats: 10, validUntil: NOW + HOUR });
    expect(await reads(artifactId, t.member.id, NOW)).toBe(true);
    const later = NOW + 2 * HOUR;
    expect(await reads(artifactId, t.member.id, later)).toBe(false);
    expect(await change(t.admin.id, artifactId, { addGroups: [second.id] }, later)).toMatchObject({
      ok: false,
      code: "plan_required",
    });
    // The plan comes back: the group grants again.
    await grantPlan(t.id, "team", { seats: 10 });
    expect(await reads(artifactId, t.member.id, later)).toBe(true);
    await grantPlan(t.id, "free");
    value(await change(t.admin.id, artifactId, { removeGroups: [group.id] }, later));
  });

  it("drops the groups when the artifact leaves the workspace", async () => {
    const { t, artifactId } = await listed();
    const target = await team();
    await db()
      .insert(schema.workspaceMembers)
      .values({ workspaceId: target.id, userId: t.admin.id, role: "admin", updatedAt: NOW });
    value(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: t.admin.id,
        artifactId,
        workspace: target.slug,
        now: NOW,
      }),
    );
    const rows = await db()
      .select()
      .from(schema.artifactGroups)
      .where(eq(schema.artifactGroups.artifactId, artifactId));
    expect(rows).toEqual([]);
    expect(await reads(artifactId, t.member.id)).toBe(false);
  });
});

describe("revocation", () => {
  async function openSession(artifactId: string, userId: string) {
    const authSessionId = await session(userId);
    const code = value(
      await issueReadHandoff(db(), {
        artifactId,
        userId,
        authSessionId,
        state: "s",
        now: NOW,
        customDomains: true,
        confirmed: false,
        requestedHost: null,
        contentDomain: "portifact.dev",
      }),
    ).code;
    const host = `${artifactId}.portifact.dev`;
    return value(
      await redeemReadHandoff(db(), {
        code,
        artifactId,
        states: ["s"],
        now: NOW,
        host,
        devHost: host,
      }),
    );
  }
  const refresh = (sessionId: string, artifactId: string, now = NOW + 61_000) =>
    refreshReadSession(db(), { sessionId, artifactId, now });

  it("ends a read session at the next claim renewal when the person leaves the group", async () => {
    const { t, group, artifactId } = await listed();
    const opened = await openSession(artifactId, t.member.id);
    expect((await refresh(opened.sessionId, artifactId)).ok).toBe(true);
    value(
      await removeGroupMember(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        groupId: group.id,
        memberId: t.member.id,
        now: NOW,
      }),
    );
    // New sessions are refused at once; the open one at its next renewal (60 seconds at most).
    expect(await reads(artifactId, t.member.id)).toBe(false);
    expect(await refresh(opened.sessionId, artifactId)).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("ends it when the group is deleted, without touching the artifact's generation", async () => {
    const { t, group, artifactId } = await listed();
    const opened = await openSession(artifactId, t.member.id);
    value(
      await deleteWorkspaceGroup(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        groupId: group.id,
        now: NOW,
      }),
    );
    // The regional row stays until the scan, and grants nothing.
    expect(
      await db()
        .select()
        .from(schema.artifactGroups)
        .where(eq(schema.artifactGroups.artifactId, artifactId)),
    ).toHaveLength(1);
    expect(await refresh(opened.sessionId, artifactId)).toMatchObject({ ok: false });
    expect(
      value(await getAccess(db(), { userId: t.admin.id, artifactId, now: NOW })),
    ).toMatchObject({ groups: [], policyGeneration: 2 });
  });

  it("moves the generation when the group is removed from the artifact, so sessions end at once", async () => {
    const { t, group, artifactId } = await listed();
    const opened = await openSession(artifactId, t.member.id);
    value(await change(t.admin.id, artifactId, { removeGroups: [group.id] }));
    const renewed = await refresh(opened.sessionId, artifactId, NOW + 1);
    expect(renewed.ok).toBe(false);
    expect(opened.policyGeneration).toBe(2);
    const [row] = await db()
      .select({ generation: schema.artifacts.policyGeneration })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, artifactId));
    expect(row?.generation).toBe(3);
  });

  it("ends it when the person leaves the workspace", async () => {
    const { t, artifactId } = await listed();
    const opened = await openSession(artifactId, t.member.id);
    value(await leaveWorkspace(db().global, { userId: t.member.id, slug: t.slug, now: NOW }));
    expect(await refresh(opened.sessionId, artifactId)).toMatchObject({ ok: false });
  });
});

describe("comment visibility by group agrees on every read path", () => {
  type Row = {
    name: string;
    visibility: "owner" | "everyone";
    reader: CommentScope | null | "none";
    groups: (CommentScope | null)[];
    sees: CommentScope;
  };
  const rows: Row[] = [
    { name: "setting only", visibility: "owner", reader: "none", groups: [null], sees: "own" },
    { name: "group all", visibility: "owner", reader: "none", groups: ["all"], sees: "all" },
    { name: "group own", visibility: "everyone", reader: "none", groups: ["own"], sees: "own" },
    {
      name: "widest group",
      visibility: "owner",
      reader: "none",
      groups: ["own", "all"],
      sees: "all",
    },
    {
      name: "inherit widens",
      visibility: "everyone",
      reader: "none",
      groups: ["own", null],
      sees: "all",
    },
    { name: "reader row first", visibility: "owner", reader: "own", groups: ["all"], sees: "own" },
    { name: "reader row all", visibility: "owner", reader: "all", groups: ["own"], sees: "all" },
    {
      name: "reader row inherits",
      visibility: "owner",
      reader: null,
      groups: ["all"],
      sees: "all",
    },
  ];

  it.each(rows)("$name", async (row) => {
    const t = await team();
    const artifactId = await publishIn(t.admin.id, t.id);
    const groups = [];
    for (const [i, exception] of row.groups.entries()) {
      const group = value(await create(t, `G${i}`));
      value(await join(t, group.id, t.member.id));
      groups.push({ id: group.id, exception });
    }
    value(
      await change(t.admin.id, artifactId, {
        commentVisibility: row.visibility,
        addGroups: groups.map((g) => g.id),
        ...(row.reader === "none" ? {} : { addReaders: [t.member.email] }),
      }),
    );
    const exceptions = groups.flatMap((g) =>
      g.exception === null ? [] : [{ group: g.id, commentVisibility: g.exception }],
    );
    if (exceptions.length > 0 || (row.reader !== "none" && row.reader !== null)) {
      value(
        await change(t.admin.id, artifactId, {
          ...(exceptions.length > 0 ? { groupCommentVisibility: exceptions } : {}),
          ...(row.reader !== "none" && row.reader !== null
            ? {
                readerCommentVisibility: [{ email: t.member.email, commentVisibility: row.reader }],
              }
            : {}),
        }),
      );
    }
    // Someone else's thread: the other member reads through the editor's reader entry.
    value(await change(t.admin.id, artifactId, { addReaders: [t.other.email] }));
    const [current] = await db()
      .select({ versionId: schema.artifacts.currentVersionId })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, artifactId));
    const versionId = current?.versionId as string;
    const theirs = value(
      await createAnnotationThread(db(), {
        userId: t.other.id,
        artifactId,
        versionId,
        target: DOC,
        body: "Theirs",
        humanCheck: HUMAN,
        now: NOW,
      }),
    );
    const input = { userId: t.member.id, artifactId, now: NOW };
    const listedThreads = value(
      await listAnnotations(db(), { ...input, limit: 50, version: "current" }),
    );
    const exported = value(await exportAnnotations(db(), { ...input, version: "current" }));
    const one = await getAnnotationThread(db(), { ...input, threadId: theirs.id });
    const reply = await replyToAnnotationThread(db(), {
      ...input,
      threadId: theirs.id,
      body: "Reply",
      humanCheck: HUMAN,
    });
    const feedback = value(
      await listOpenFeedback(db(), {
        actor: value(await resolveOwnerScope(db().global, t.member.id, t.slug)),
        limit: 50,
        now: NOW,
      }),
    );
    const sees = row.sees === "all";
    expect(listedThreads.commentScope).toBe(row.sees);
    expect(listedThreads.threads.some((th) => th.id === theirs.id)).toBe(sees);
    expect(exported.threads.some((th) => th.id === theirs.id)).toBe(sees);
    expect(one.ok).toBe(sees);
    expect(reply.ok).toBe(sees);
    expect(feedback.items.some((item) => item.thread.id === theirs.id)).toBe(sees);
    // The account export shows the thread (its state and date) exactly when the scope does; the
    // member wrote in it only when they could see it.
    const exportedThread = value(
      await exportAccount(db(), { userId: t.member.id, now: NOW }),
    ).commentsElsewhere.find((thread) => thread.id === theirs.id);
    if (sees) {
      expect(exportedThread && "state" in exportedThread).toBe(true);
    } else {
      expect(exportedThread).toBeUndefined();
    }
  });

  it("lists a restricted artifact's threads in the space's feedback only through a group that grants", async () => {
    const { t, artifactId } = await listed();
    const [current] = await db()
      .select({ versionId: schema.artifacts.currentVersionId })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, artifactId));
    value(
      await createAnnotationThread(db(), {
        userId: t.member.id,
        artifactId,
        versionId: current?.versionId as string,
        target: DOC,
        body: "Mine",
        humanCheck: HUMAN,
        now: NOW,
      }),
    );
    const page = async (userId: string, now = NOW) =>
      value(
        await listOpenFeedback(db(), {
          actor: value(await resolveOwnerScope(db().global, userId, t.slug)),
          limit: 50,
          now,
        }),
      ).items.length;
    expect(await page(t.member.id)).toBe(1);
    expect(await page(t.other.id)).toBe(0);
  });
});

describe("races", () => {
  it("creates nothing when the admin is demoted before the write", async () => {
    const t = await team();
    const raced = raceGlobalBeforeFirstWrite(async () => {
      await db()
        .update(schema.workspaceMembers)
        .set({ role: "editor" })
        .where(
          and(
            eq(schema.workspaceMembers.workspaceId, t.id),
            eq(schema.workspaceMembers.userId, t.admin.id),
          ),
        );
    });
    // A second admin keeps the workspace valid.
    await db()
      .update(schema.workspaceMembers)
      .set({ role: "admin" })
      .where(
        and(
          eq(schema.workspaceMembers.workspaceId, t.id),
          eq(schema.workspaceMembers.userId, t.editor.id),
        ),
      );
    expect(
      await createWorkspaceGroup(raced, { userId: t.admin.id, slug: t.slug, name: "X", now: NOW }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(
      await db()
        .select()
        .from(schema.workspaceGroups)
        .where(eq(schema.workspaceGroups.workspaceId, t.id)),
    ).toEqual([]);
  });

  it("adds nobody who left the workspace between the check and the write", async () => {
    const t = await team();
    const group = value(await create(t, "Design"));
    const raced = raceGlobalBeforeFirstWrite(async () => {
      value(await leaveWorkspace(db().global, { userId: t.member.id, slug: t.slug, now: NOW }));
    });
    expect(
      await addGroupMember(raced, {
        userId: t.admin.id,
        slug: t.slug,
        groupId: group.id,
        memberId: t.member.id,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
    expect(
      await db()
        .select()
        .from(schema.workspaceGroupMembers)
        .where(eq(schema.workspaceGroupMembers.groupId, group.id)),
    ).toEqual([]);
    expect(
      await db()
        .select()
        .from(schema.auditEvents)
        .where(
          and(
            eq(schema.auditEvents.ownerId, t.id),
            eq(schema.auditEvents.kind, "group.member_added"),
          ),
        ),
    ).toEqual([]);
  });

  it("removes nobody when the admin is demoted before the write", async () => {
    const t = await team();
    const group = value(await create(t, "Design"));
    value(await join(t, group.id, t.member.id));
    await changeMemberRole(db().global, {
      userId: t.admin.id,
      slug: t.slug,
      memberId: t.editor.id,
      role: "admin",
      now: NOW,
    });
    const raced = raceGlobalBeforeFirstWrite(async () => {
      value(
        await changeMemberRole(db().global, {
          userId: t.editor.id,
          slug: t.slug,
          memberId: t.admin.id,
          role: "member",
          now: NOW,
        }),
      );
    });
    expect(
      await removeGroupMember(raced, {
        userId: t.admin.id,
        slug: t.slug,
        groupId: group.id,
        memberId: t.member.id,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(
      value(
        await getWorkspaceGroup(db().global, {
          userId: t.editor.id,
          slug: t.slug,
          groupId: group.id,
        }),
      ).members,
    ).toHaveLength(1);
  });

  it("lists no group when the artifact moved to another owner in between", async () => {
    const t = await team();
    const group = value(await create(t, "Design"));
    const artifactId = await publishIn(t.admin.id, t.id);
    const raced = raceBeforeFirstWrite(async () => {
      value(
        await transferArtifact(db(), env.ARTIFACTS, {
          userId: t.admin.id,
          artifactId,
          workspace: null,
          now: NOW,
        }),
      );
    });
    expect(
      await updateAccess(raced, {
        userId: t.admin.id,
        artifactId,
        change: { addGroups: [group.id] },
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "version_conflict" });
    expect(
      await db()
        .select()
        .from(schema.artifactGroups)
        .where(eq(schema.artifactGroups.artifactId, artifactId)),
    ).toEqual([]);
  });
});

describe("the scan and a restore", () => {
  it("removes artifact rows whose group is gone and keeps the others", async () => {
    const { t, group, artifactId } = await listed();
    const kept = value(await create(t, "Kept"));
    value(await change(t.admin.id, artifactId, { addGroups: [kept.id] }));
    value(
      await deleteWorkspaceGroup(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        groupId: group.id,
        now: NOW,
      }),
    );
    // Other tests' rows share the database: scan until this artifact's rows were all checked.
    for (let i = 0; i < 20; i++) {
      const { checked } = await pruneArtifactGroups(db(), NOW + 10 + i);
      if (checked === 0) break;
    }
    const rows = await db()
      .select({
        groupId: schema.artifactGroups.groupId,
        checkedAt: schema.artifactGroups.checkedAt,
      })
      .from(schema.artifactGroups)
      .where(eq(schema.artifactGroups.artifactId, artifactId));
    expect(rows.map((r) => r.groupId)).toEqual([kept.id]);
    expect(rows[0]?.checkedAt).not.toBeNull();
  });

  it("keeps a deleted group and a removed membership gone after a restore", async () => {
    const { t, group, artifactId } = await listed();
    const second = value(await create(t, "Research"));
    value(await join(t, second.id, t.other.id));
    value(await change(t.admin.id, artifactId, { addGroups: [second.id] }));
    const [groupRow] = await db()
      .select()
      .from(schema.workspaceGroups)
      .where(eq(schema.workspaceGroups.id, group.id));
    const [membership] = await db()
      .select()
      .from(schema.workspaceGroupMembers)
      .where(eq(schema.workspaceGroupMembers.groupId, group.id));
    const [otherMembership] = await db()
      .select()
      .from(schema.workspaceGroupMembers)
      .where(eq(schema.workspaceGroupMembers.groupId, second.id));
    value(
      await deleteWorkspaceGroup(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        groupId: group.id,
        now: NOW,
      }),
    );
    value(
      await removeGroupMember(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        groupId: second.id,
        memberId: t.other.id,
        now: NOW,
      }),
    );
    const markers = await exportTombstones(db());
    // A restore from before the deletions brings the rows back (and the tombstones go).
    await db().delete(schema.tombstones).where(eq(schema.tombstones.id, group.id));
    await db()
      .insert(schema.workspaceGroups)
      .values(groupRow as typeof schema.workspaceGroups.$inferInsert);
    await db()
      .insert(schema.workspaceGroupMembers)
      .values([
        membership,
        otherMembership,
      ] as (typeof schema.workspaceGroupMembers.$inferInsert)[]);
    expect(await reads(artifactId, t.member.id)).toBe(true);
    expect(await reads(artifactId, t.other.id)).toBe(true);
    const applied = await applyTombstones(db(), markers, NOW + 1);
    expect(applied.groups).toBeGreaterThanOrEqual(1);
    expect(applied.groupMembers).toBeGreaterThanOrEqual(1);
    expect(await reads(artifactId, t.member.id)).toBe(false);
    expect(await reads(artifactId, t.other.id)).toBe(false);
    // Adding the person again makes a new row, which a later restore keeps.
    value(await join(t, second.id, t.other.id));
    await applyTombstones(db(), markers, NOW + 2);
    expect(await reads(artifactId, t.other.id)).toBe(true);
  });
});

describe("pruning group tombstones", () => {
  it("deletes only group tombstones older than the restore window, in bounded rounds", async () => {
    const old = NOW - GROUP_TOMBSTONE_RETENTION_MS - DAY;
    const recent = NOW - GROUP_TOMBSTONE_RETENTION_MS + DAY;
    const tag = hex().slice(0, 8);
    const rows = [
      { kind: "workspace_group" as const, id: `wg_old_${tag}`, deletedAt: old },
      { kind: "workspace_group_member" as const, id: `wgm_old_${tag}`, deletedAt: old },
      { kind: "workspace_group_member" as const, id: `wgm_new_${tag}`, deletedAt: recent },
      { kind: "workspace_domain" as const, id: `wd_old_${tag}`, deletedAt: old },
      { kind: "account" as const, id: `u_old_${tag}`, deletedAt: old },
    ];
    await db().insert(schema.tombstones).values(rows);
    // Small rounds: the cursor moves through every old row across rounds and runs.
    for (let run = 0; run < 50; run++) {
      const result = await pruneGroupTombstones(db().global, NOW, { batch: 1, rounds: 2 });
      expect(result.queries).toBeLessThanOrEqual(2);
      if (result.deleted === 0) break;
    }
    const left = new Set(
      (await db().select({ id: schema.tombstones.id }).from(schema.tombstones)).map((r) => r.id),
    );
    expect(left.has(`wg_old_${tag}`)).toBe(false);
    expect(left.has(`wgm_old_${tag}`)).toBe(false);
    expect(left.has(`wgm_new_${tag}`)).toBe(true);
    expect(left.has(`wd_old_${tag}`)).toBe(true);
    expect(left.has(`u_old_${tag}`)).toBe(true);
  });
});
