// Question 2 and 4: the organization plugin on D1 through Drizzle, Portifact's three roles, and
// reading membership from the services layer.
import { env } from "cloudflare:test";
import { createDb } from "@portifact/db";
import { describe, expect, it } from "vitest";
import { type Action, can, resolveActor } from "./membership.ts";
import { createHarness, get, json, uniqueEmail } from "./test/harness.ts";

const h = createHarness();

async function userId(cookie: string): Promise<string> {
  const response = await h.raw("/get-session", get({ cookie }));
  const body = (await response.json()) as { user: { id: string } };
  return body.user.id;
}

async function createWorkspace(cookie: string, name: string) {
  const response = await h.raw(
    "/organization/create",
    json(
      {
        name,
        slug: `${name.toLowerCase().replaceAll(" ", "-")}-${crypto.randomUUID().slice(0, 6)}`,
      },
      { cookie },
    ),
  );
  const text = await response.text();
  return { response, body: (text ? JSON.parse(text) : {}) as { id: string } };
}

async function invite(cookie: string, organizationId: string, email: string, role: string) {
  return h.raw("/organization/invite-member", json({ organizationId, email, role }, { cookie }));
}

async function join(adminCookie: string, organizationId: string, role: string) {
  const email = uniqueEmail(role);
  const invited = await invite(adminCookie, organizationId, email, role);
  expect(invited.status).toBe(200);
  const { id } = (await invited.json()) as { id: string };
  const cookie = await h.signIn(email);
  const accepted = await h.raw(
    "/organization/accept-invitation",
    json({ invitationId: id }, { cookie }),
  );
  expect(accepted.status).toBe(200);
  return { cookie, id: await userId(cookie) };
}

describe("organization plugin on D1", () => {
  it("creates a workspace with a ws_ ID and its creator as admin", async () => {
    const cookie = await h.signIn(uniqueEmail("owner"));
    const { response, body } = await createWorkspace(cookie, "Acme");
    expect(response.status).toBe(200);
    expect(body.id).toMatch(/^ws_[0-9a-f]{32}$/);
    const actor = await resolveActor(createDb(env.DB), await userId(cookie), body.id);
    expect(actor?.role).toBe("admin");
  });

  it("gives editors and members their role through invitations", async () => {
    const admin = await h.signIn(uniqueEmail("admin"));
    const { body: ws } = await createWorkspace(admin, "Roles");
    const editor = await join(admin, ws.id, "editor");
    const member = await join(admin, ws.id, "member");
    const db = createDb(env.DB);
    expect((await resolveActor(db, editor.id, ws.id))?.role).toBe("editor");
    expect((await resolveActor(db, member.id, ws.id))?.role).toBe("member");
  });

  it("refuses invitations from editors and members", async () => {
    const admin = await h.signIn(uniqueEmail("admin"));
    const { body: ws } = await createWorkspace(admin, "Invites");
    const editor = await join(admin, ws.id, "editor");
    const member = await join(admin, ws.id, "member");
    expect((await invite(editor.cookie, ws.id, uniqueEmail("x"), "member")).status).toBe(403);
    expect((await invite(member.cookie, ws.id, uniqueEmail("x"), "member")).status).toBe(403);
  });

  it("refuses a role nobody defined", async () => {
    const admin = await h.signIn(uniqueEmail("admin"));
    const { body: ws } = await createWorkspace(admin, "Unknown role");
    expect((await invite(admin, ws.id, uniqueEmail("x"), "viewer")).status).toBe(400);
  });

  it("still accepts its built-in owner role and role lists next to custom roles", async () => {
    const admin = await h.signIn(uniqueEmail("admin"));
    const { body: ws } = await createWorkspace(admin, "Built-in roles");
    // `owner` is always valid in 1.7.18 (defaultRoles are merged with custom roles), and an admin
    // may grant it because only the creator role is protected. Portifact must not trust it.
    const owner = await join(admin, ws.id, "owner");
    expect(await resolveActor(createDb(env.DB), owner.id, ws.id)).toBeNull();
    expect((await invite(admin, ws.id, uniqueEmail("x"), "editor,member")).status).toBe(200);
  });

  it("gives a user of another workspace no role, like a missing owner", async () => {
    const a = await h.signIn(uniqueEmail("a"));
    const b = await h.signIn(uniqueEmail("b"));
    const { body: ws } = await createWorkspace(a, "Private");
    const db = createDb(env.DB);
    expect(await resolveActor(db, await userId(b), ws.id)).toBeNull();
    expect(await resolveActor(db, await userId(b), "ws_missing")).toBeNull();
  });

  it("does not create the workspace and its admin atomically on D1", async () => {
    const cookie = await h.signIn(uniqueEmail("fault"));
    const { response } = await createWorkspace(cookie, "Spike fault");
    expect(response.ok).toBe(false);
    const orphans = await env.DB.prepare(
      "SELECT o.id, (SELECT count(*) FROM members m WHERE m.organization_id = o.id) AS n FROM organizations o WHERE o.name = 'Spike fault'",
    ).all<{ id: string; n: number }>();
    // The organization row is committed and its admin row is not: a workspace nobody manages.
    expect(orphans.results).toHaveLength(1);
    expect(orphans.results[0]?.n).toBe(0);
  });

  it("creates duplicate memberships under concurrent adds, since members has no unique key", async () => {
    const admin = await h.signIn(uniqueEmail("admin"));
    const { body: ws } = await createWorkspace(admin, "Race");
    const target = await userId(await h.signIn(uniqueEmail("target")));
    const add = () =>
      h.auth.api.addMember({ body: { userId: target, organizationId: ws.id, role: "member" } });
    await Promise.allSettled([add(), add(), add()]);
    const rows = await env.DB.prepare(
      "SELECT count(*) AS n FROM members WHERE organization_id = ? AND user_id = ?",
    )
      .bind(ws.id, target)
      .first<{ n: number }>();
    // The plugin checks for an existing member, then inserts, with no transaction and no unique
    // (organization_id, user_id) index: all three checks pass before any insert lands.
    expect(rows?.n).toBe(3);
  });

  it("refuses to let the only admin leave", async () => {
    const admin = await h.signIn(uniqueEmail("solo"));
    const { body: ws } = await createWorkspace(admin, "Solo");
    const left = await h.raw(
      "/organization/leave",
      json({ organizationId: ws.id }, { cookie: admin }),
    );
    expect(left.status).toBe(400);
  });

  it("removes memberships with the user through the foreign key", async () => {
    const admin = await h.signIn(uniqueEmail("admin"));
    const { body: ws } = await createWorkspace(admin, "Cascade");
    const member = await join(admin, ws.id, "member");
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(member.id).run();
    expect(await resolveActor(createDb(env.DB), member.id, ws.id)).toBeNull();
  });

  it("reads a role with one indexed lookup", async () => {
    const plan = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT role FROM members WHERE organization_id = ? AND user_id = ? LIMIT 1",
    )
      .bind("ws_x", "u")
      .all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join(" ")).toMatch(
      /USING INDEX members_(user|organization)_id_idx/,
    );
  });
});

describe("personal space and role table", () => {
  it("makes a user the admin of their own space and nobody else's", async () => {
    const db = createDb(env.DB);
    expect(await resolveActor(db, "u1", "u1")).toEqual({
      userId: "u1",
      ownerId: "u1",
      role: "admin",
    });
    expect(await resolveActor(db, "u1", "u2")).toBeNull();
  });

  it("refuses a stored role Portifact does not know", async () => {
    const admin = await h.signIn(uniqueEmail("admin"));
    const { body: ws } = await createWorkspace(admin, "Odd role");
    const id = await userId(admin);
    await env.DB.prepare(
      "UPDATE members SET role = 'admin,owner' WHERE organization_id = ? AND user_id = ?",
    )
      .bind(ws.id, id)
      .run();
    expect(await resolveActor(createDb(env.DB), id, ws.id)).toBeNull();
  });

  const matrix: [Action, boolean, boolean, boolean][] = [
    ["read", true, true, true],
    ["comment", true, true, true],
    ["publish", true, true, false],
    ["share", true, true, false],
    ["lifecycle", true, true, false],
    ["moderate", true, true, false],
    ["manage_members", true, false, false],
    ["delete_workspace", true, false, false],
  ];
  it.each(matrix)("%s: admin %s, editor %s, member %s", (action, admin, editor, member) => {
    const actor = (role: "admin" | "editor" | "member") => ({ userId: "u", ownerId: "ws_1", role });
    expect([
      can(actor("admin"), action),
      can(actor("editor"), action),
      can(actor("member"), action),
    ]).toEqual([admin, editor, member]);
  });
});
