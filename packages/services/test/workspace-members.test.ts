// Members and invitations of a workspace (premium plan T1): the role matrix of every operation, the
// last admin, seats with pending invitations and concurrent accepts, and the invitation email's
// guards (suppression, the month's capacity, rate limits, a failed send).
import type { WorkspaceRole } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { NOTICE_EMAILS_PER_CYCLE } from "@portifact/domain";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { exportAccount } from "../src/account-data.ts";
import { updateAccountSettings } from "../src/account-settings.ts";
import { actorOn } from "../src/actors.ts";
import { RecipientSuppressedError, suppressEmail } from "../src/email.ts";
import {
  acceptInvitation,
  declineInvitation,
  type InvitationMessage,
  type InvitationSender,
  invitationTokenHash,
  inviteMember,
  listIncomingInvitations,
  listInvitations,
  pruneExpiredInvitations,
  revokeInvitation,
} from "../src/invitations.ts";
import {
  changeMemberRole,
  createWorkspace,
  leaveWorkspace,
  listMembers,
  listUserWorkspaces,
  ownerView,
  ownerViews,
  removeMember,
  resolveOwnerScope,
  workspaceSeats,
} from "../src/workspaces.ts";
import { DAY, db, grantPlan, NOW, user, value } from "./fixtures.ts";

const global = () => db().global;
type User = { id: string; email: string };

interface Team {
  id: string;
  slug: string;
  admin: User;
  editor: User;
  member: User;
  outsider: User;
}

/** A workspace created like the operator does, with one user per role and one outsider. */
async function team(seats = 10): Promise<Team> {
  const [admin, editor, member, outsider] = [
    await user("Ada"),
    await user("Ed"),
    await user("Mia"),
    await user("Otto"),
  ];
  const slug = `t-${crypto.randomUUID().slice(0, 8)}`;
  const created = value(
    await createWorkspace(global(), { slug, name: "Team", adminUserId: admin.id, now: NOW }),
  );
  await db()
    .insert(schema.workspaceMembers)
    .values([
      { workspaceId: created.id, userId: editor.id, role: "editor", updatedAt: NOW },
      { workspaceId: created.id, userId: member.id, role: "member", updatedAt: NOW },
    ]);
  await grantPlan(created.id, "team", { seats });
  return { id: created.id, slug, admin, editor, member, outsider };
}

function recorder(): InvitationSender & { sent: InvitationMessage[] } {
  const sent: InvitationMessage[] = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
    },
  };
}

const missingWorkspace = { ok: false, code: "not_found", message: "Workspace not found." };

async function invite(
  t: Team,
  email: string,
  role: WorkspaceRole = "member",
  options: { by?: User; now?: number; sender?: InvitationSender } = {},
) {
  // Typed as a recorder: tests read `sent` only when they pass none or a recorder.
  const sender = (options.sender ?? recorder()) as ReturnType<typeof recorder>;
  const result = await inviteMember(
    global(),
    {
      userId: (options.by ?? t.admin).id,
      slug: t.slug,
      email,
      role,
      now: options.now ?? NOW,
    },
    sender,
  );
  return { result, sender };
}

/** Invites a new account's address and returns the account and the token from the email. */
async function invited(t: Team, role: WorkspaceRole = "editor", now = NOW) {
  const invitee = await user("Grace");
  const sender = recorder();
  value((await invite(t, invitee.email, role, { sender, now })).result);
  return { invitee, token: (sender.sent[0] as InvitationMessage).token };
}

const roleOf = async (t: Team, userId: string) => {
  const actor = await actorOn(global(), userId, t.id);
  return actor.ok ? (actor.value?.role ?? null) : null;
};

describe("naming a workspace", () => {
  it("resolves a slug to the member's actor, and anything else like a missing workspace", async () => {
    const t = await team();
    expect(value(await resolveOwnerScope(global(), t.editor.id, t.slug))).toMatchObject({
      ownerId: t.id,
      role: "editor",
    });
    expect(value(await resolveOwnerScope(global(), t.editor.id, undefined))).toMatchObject({
      ownerId: t.editor.id,
      role: "admin",
    });
    expect(await resolveOwnerScope(global(), t.outsider.id, t.slug)).toEqual(missingWorkspace);
    expect(await resolveOwnerScope(global(), t.admin.id, "no-such-slug")).toEqual(missingWorkspace);
  });

  it("lists the user's workspaces with their role", async () => {
    const t = await team();
    expect((await listUserWorkspaces(global(), t.member.id)).map((w) => [w.slug, w.role])).toEqual([
      [t.slug, "member"],
    ]);
    expect(await listUserWorkspaces(global(), t.outsider.id)).toEqual([]);
  });
});

describe("members", () => {
  it("are listed to every member with the seats in use, and to nobody else", async () => {
    const t = await team(5);
    for (const who of [t.admin, t.editor, t.member]) {
      const list = value(await listMembers(global(), { userId: who.id, slug: t.slug, now: NOW }));
      expect(list.members.map((m) => m.role).sort()).toEqual(["admin", "editor", "member"]);
      expect(list.seats).toEqual({ used: 3, limit: 5 });
    }
    expect(await listMembers(global(), { userId: t.outsider.id, slug: t.slug, now: NOW })).toEqual(
      missingWorkspace,
    );
  });

  it("change role only by an admin", async () => {
    const t = await team();
    const change = (by: User) =>
      changeMemberRole(global(), {
        userId: by.id,
        slug: t.slug,
        memberId: t.member.id,
        role: "editor",
        now: NOW,
      });
    expect(await change(t.editor)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await change(t.member)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await change(t.outsider)).toEqual(missingWorkspace);
    expect(value(await change(t.admin))).toMatchObject({ userId: t.member.id, role: "editor" });
    expect(await roleOf(t, t.member.id)).toBe("editor");
    // The same role again changes nothing and answers the member.
    expect(value(await change(t.admin)).role).toBe("editor");
    expect(
      await changeMemberRole(global(), {
        userId: t.admin.id,
        slug: t.slug,
        memberId: t.outsider.id,
        role: "admin",
        now: NOW,
      }),
    ).toEqual({ ok: false, code: "not_found", message: "Member not found." });
  });

  it("never lose the last admin: demote, remove or leave", async () => {
    const t = await team();
    const sole = { ok: false, code: "sole_workspace_admin" };
    expect(
      await changeMemberRole(global(), {
        userId: t.admin.id,
        slug: t.slug,
        memberId: t.admin.id,
        role: "editor",
        now: NOW,
      }),
    ).toMatchObject(sole);
    expect(
      await removeMember(global(), { userId: t.admin.id, slug: t.slug, memberId: t.admin.id }),
    ).toMatchObject(sole);
    expect(await leaveWorkspace(global(), { userId: t.admin.id, slug: t.slug })).toMatchObject({
      ...sole,
      message: expect.stringContaining("before you leave"),
    });
    expect(await roleOf(t, t.admin.id)).toBe("admin");
  });

  it("of two concurrent demotions of two admins lets exactly one through", async () => {
    const t = await team();
    value(
      await changeMemberRole(global(), {
        userId: t.admin.id,
        slug: t.slug,
        memberId: t.editor.id,
        role: "admin",
        now: NOW,
      }),
    );
    const [first, second] = await Promise.all([
      changeMemberRole(global(), {
        userId: t.admin.id,
        slug: t.slug,
        memberId: t.editor.id,
        role: "member",
        now: NOW,
      }),
      changeMemberRole(global(), {
        userId: t.editor.id,
        slug: t.slug,
        memberId: t.admin.id,
        role: "member",
        now: NOW,
      }),
    ]);
    const outcomes = [first, second].map((r) => (r.ok ? "ok" : r.code)).sort();
    // The second finds its caller demoted by the first (or, from the database, no admin left).
    expect(outcomes.filter((o) => o === "ok")).toHaveLength(1);
    expect(["forbidden", "sole_workspace_admin"]).toContain(outcomes.find((o) => o !== "ok"));
    const roles = [await roleOf(t, t.admin.id), await roleOf(t, t.editor.id)].sort();
    expect(roles).toEqual(["admin", "member"]);
  });

  it("are removed by an admin, and leave by themselves", async () => {
    const t = await team();
    expect(
      await removeMember(global(), { userId: t.editor.id, slug: t.slug, memberId: t.member.id }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(
      value(
        await removeMember(global(), { userId: t.admin.id, slug: t.slug, memberId: t.member.id }),
      ),
    ).toEqual({ removed: true });
    expect(await roleOf(t, t.member.id)).toBeNull();
    expect(
      await removeMember(global(), { userId: t.admin.id, slug: t.slug, memberId: t.member.id }),
    ).toEqual({ ok: false, code: "not_found", message: "Member not found." });
    expect(value(await leaveWorkspace(global(), { userId: t.editor.id, slug: t.slug }))).toEqual({
      removed: true,
    });
    expect(await leaveWorkspace(global(), { userId: t.editor.id, slug: t.slug })).toEqual(
      missingWorkspace,
    );
  });
});

describe("invitations", () => {
  it("email the address a link token, store only its hash, and count the email", async () => {
    const t = await team();
    value(
      await updateAccountSettings(global(), {
        userId: t.admin.id,
        update: { locale: "es" },
        now: NOW,
      }),
    );
    const before = await sentEmails();
    const { result, sender } = await invite(t, "  Grace@Example.TEST ", "editor");
    const invitation = value(result);
    expect(invitation).toMatchObject({
      email: "grace@example.test",
      role: "editor",
      invitedBy: "Ada",
      expiresAt: NOW + 7 * DAY,
    });
    expect(sender.sent).toEqual([
      {
        to: "grace@example.test",
        token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        workspaceName: "Team",
        inviterName: "Ada",
        role: "editor",
        expiresAt: NOW + 7 * DAY,
        locale: "es",
      },
    ]);
    const [row] = await db()
      .select()
      .from(schema.workspaceInvitations)
      .where(eq(schema.workspaceInvitations.id, invitation.id));
    const token = (sender.sent[0] as InvitationMessage).token;
    expect(row?.tokenHash).toBe(await invitationTokenHash(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(await sentEmails()).toBe(before + 1);
  });

  it("are sent only by admins", async () => {
    const t = await team();
    for (const by of [t.editor, t.member]) {
      const { result, sender } = await invite(t, "x@example.test", "member", { by });
      expect(result).toMatchObject({ ok: false, code: "forbidden" });
      expect(sender.sent).toEqual([]);
    }
    expect((await invite(t, "x@example.test", "member", { by: t.outsider })).result).toEqual(
      missingWorkspace,
    );
  });

  it("refuse a member's address, and send nothing to a suppressed one while answering the same", async () => {
    const t = await team();
    const member = await invite(t, t.member.email.toUpperCase());
    expect(member.result).toEqual({
      ok: false,
      code: "invalid_input",
      message: "That address already belongs to a member.",
    });
    await suppressEmail(global(), {
      email: "bounced@example.test",
      reason: "hard_bounce",
      now: NOW,
    });
    const before = await sentEmails();
    const suppressed = await invite(t, "bounced@example.test");
    expect(suppressed.result).toMatchObject({ ok: true, value: { email: "bounced@example.test" } });
    expect([...member.sender.sent, ...suppressed.sender.sent]).toEqual([]);
    expect(await sentEmails()).toBe(before);
  });

  it("stop with the month's email capacity, like expiry notices", async () => {
    const t = await team();
    const later = Date.UTC(2027, 2, 15);
    await db()
      .insert(schema.emailCounters)
      .values({ day: Date.UTC(2027, 2, 1), sent: NOTICE_EMAILS_PER_CYCLE });
    const { result, sender } = await invite(t, "late@example.test", "member", { now: later });
    expect(result).toMatchObject({ ok: false, code: "capacity_unavailable" });
    expect(sender.sent).toEqual([]);
  });

  it("are withdrawn when the email cannot be sent, and kept when the provider refuses the address", async () => {
    const t = await team();
    const failing: InvitationSender = {
      send: async () => Promise.reject(new Error("email delivery failed")),
    };
    await expect(invite(t, "lost@example.test", "member", { sender: failing })).rejects.toThrow(
      "email delivery failed",
    );
    const refusing: InvitationSender = {
      send: async () => Promise.reject(new RecipientSuppressedError()),
    };
    const refused = await invite(t, "gone@example.test", "member", { sender: refusing });
    expect(refused.result).toMatchObject({ ok: true });
    expect(
      value(
        await listInvitations(global(), { userId: t.admin.id, slug: t.slug, now: NOW }),
      ).items.map((i) => i.email),
    ).toEqual(["gone@example.test"]);
    // The provider's refusal suppresses the address here too: the next one sends nothing.
    const again = await invite(t, "gone@example.test");
    expect(again.result).toMatchObject({ ok: true });
    expect(again.sender.sent).toEqual([]);
  });

  it("are limited per admin", async () => {
    const t = await team(100);
    const hour = Date.UTC(2026, 10, 12, 9);
    for (let i = 0; i < 20; i += 1) {
      value((await invite(t, `bulk${i}@example.test`, "member", { now: hour })).result);
    }
    const { result, sender } = await invite(t, "bulk20@example.test", "member", { now: hour });
    expect(result).toEqual({
      ok: false,
      code: "rate_limited",
      message: "Too many invitations. Wait a while and try again.",
    });
    expect(sender.sent).toEqual([]);
  });

  it("take a seat while pending, and a new one to the same address replaces the old", async () => {
    const t = await team(4);
    const first = await invite(t, "seat@example.test", "member");
    value(first.result);
    expect((await invite(t, "other@example.test")).result).toMatchObject({
      ok: false,
      code: "seats_exhausted",
    });
    const again = await invite(t, "seat@example.test", "editor");
    expect(value(again.result).role).toBe("editor");
    const listed = value(
      await listInvitations(global(), { userId: t.admin.id, slug: t.slug, now: NOW }),
    );
    expect(listed.items.map((i) => [i.email, i.role])).toEqual([["seat@example.test", "editor"]]);
    expect(listed.seats).toEqual({ used: 4, limit: 4 });
    // The first link stopped working.
    const invitee = await user();
    await db()
      .update(schema.users)
      .set({ email: "seat@example.test" })
      .where(eq(schema.users.id, invitee.id));
    const oldToken = (first.sender.sent[0] as InvitationMessage).token;
    expect(
      await acceptInvitation(global(), { userId: invitee.id, key: { token: oldToken }, now: NOW }),
    ).toMatchObject({ ok: false, code: "not_found" });
  });

  it("are listed and revoked by admins only", async () => {
    const t = await team();
    const sent = value((await invite(t, "rev@example.test")).result);
    expect(
      await listInvitations(global(), { userId: t.editor.id, slug: t.slug, now: NOW }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(
      await revokeInvitation(global(), {
        userId: t.member.id,
        slug: t.slug,
        invitationId: sent.id,
      }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(
      value(
        await revokeInvitation(global(), {
          userId: t.admin.id,
          slug: t.slug,
          invitationId: sent.id,
        }),
      ),
    ).toEqual({ revoked: true });
    expect(
      await revokeInvitation(global(), { userId: t.admin.id, slug: t.slug, invitationId: sent.id }),
    ).toEqual({ ok: false, code: "not_found", message: "Invitation not found." });
  });

  it("are accepted once, by the invited verified address, with the invited role", async () => {
    const t = await team();
    const { invitee, token } = await invited(t, "editor");
    const someone = await user();
    const missing = { ok: false, code: "not_found" };
    expect(
      await acceptInvitation(global(), { userId: someone.id, key: { token }, now: NOW }),
    ).toMatchObject(missing);
    expect(
      await acceptInvitation(global(), { userId: t.admin.id, key: { token }, now: NOW }),
    ).toMatchObject(missing);
    expect(
      value(await acceptInvitation(global(), { userId: invitee.id, key: { token }, now: NOW })),
    ).toMatchObject({ slug: t.slug, role: "editor" });
    expect(await roleOf(t, invitee.id)).toBe("editor");
    expect(
      await acceptInvitation(global(), { userId: invitee.id, key: { token }, now: NOW }),
    ).toMatchObject(missing);
  });

  it("are refused once expired or revoked, and for an unverified address", async () => {
    const t = await team();
    const late = await invited(t);
    expect(
      await acceptInvitation(global(), {
        userId: late.invitee.id,
        key: { token: late.token },
        now: NOW + 7 * DAY,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
    const revoked = await invited(t);
    const [row] = await listIncomingInvitations(global(), { userId: revoked.invitee.id, now: NOW });
    value(
      await revokeInvitation(global(), {
        userId: t.admin.id,
        slug: t.slug,
        invitationId: (row as { id: string }).id,
      }),
    );
    expect(
      await acceptInvitation(global(), {
        userId: revoked.invitee.id,
        key: { token: revoked.token },
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
    const unverified = await invited(t);
    await db()
      .update(schema.users)
      .set({ emailVerified: false })
      .where(eq(schema.users.id, unverified.invitee.id));
    expect(
      await acceptInvitation(global(), {
        userId: unverified.invitee.id,
        key: { token: unverified.token },
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
    expect(
      await listIncomingInvitations(global(), { userId: unverified.invitee.id, now: NOW }),
    ).toEqual([]);
  });

  it("are listed to the invitee and answered by ID, or declined", async () => {
    const t = await team();
    const { invitee } = await invited(t, "member");
    const [incoming] = await listIncomingInvitations(global(), { userId: invitee.id, now: NOW });
    expect(incoming).toMatchObject({
      workspace: { slug: t.slug, name: "Team" },
      role: "member",
      invitedBy: "Ada",
      expiresAt: NOW + 7 * DAY,
    });
    const id = (incoming as { id: string }).id;
    expect(
      value(
        await declineInvitation(global(), {
          userId: invitee.id,
          key: { invitationId: id },
          now: NOW,
        }),
      ),
    ).toEqual({ declined: true });
    expect(await roleOf(t, invitee.id)).toBeNull();
    expect(
      await acceptInvitation(global(), { userId: invitee.id, key: { invitationId: id }, now: NOW }),
    ).toMatchObject({ ok: false, code: "not_found" });

    const second = await invited(t, "member");
    const [again] = await listIncomingInvitations(global(), {
      userId: second.invitee.id,
      now: NOW,
    });
    expect(
      value(
        await acceptInvitation(global(), {
          userId: second.invitee.id,
          key: { invitationId: (again as { id: string }).id },
          now: NOW,
        }),
      ).role,
    ).toBe("member");
  });

  it("let exactly one of two concurrent accepts take the last seat", async () => {
    const t = await team(5);
    const a = await invited(t);
    const b = await invited(t);
    // The plan is lowered after both were sent: one seat is left for two invitations.
    await db()
      .update(schema.ownerPlans)
      .set({ seats: 4 })
      .where(eq(schema.ownerPlans.ownerId, t.id));
    const results = await Promise.all([
      acceptInvitation(global(), { userId: a.invitee.id, key: { token: a.token }, now: NOW }),
      acceptInvitation(global(), { userId: b.invitee.id, key: { token: b.token }, now: NOW }),
    ]);
    expect(results.map((r) => (r.ok ? "ok" : r.code)).sort()).toEqual(["ok", "seats_exhausted"]);
    const members = value(
      await listMembers(global(), { userId: t.admin.id, slug: t.slug, now: NOW }),
    );
    expect(members.members).toHaveLength(4);
  });

  it("add nobody once the plan expired, and remove nobody", async () => {
    const t = await team(5);
    const pending = await invited(t);
    await db()
      .update(schema.ownerPlans)
      .set({ validUntil: NOW + DAY })
      .where(eq(schema.ownerPlans.ownerId, t.id));
    const later = NOW + 2 * DAY;
    expect(
      await acceptInvitation(global(), {
        userId: pending.invitee.id,
        key: { token: pending.token },
        now: later,
      }),
    ).toMatchObject({ ok: false, code: "seats_exhausted" });
    expect((await invite(t, "new@example.test", "member", { now: later })).result).toMatchObject({
      ok: false,
      code: "seats_exhausted",
    });
    const list = value(
      await listMembers(global(), { userId: t.member.id, slug: t.slug, now: later }),
    );
    expect(list.members).toHaveLength(3);
    expect(list.seats.limit).toBe(1);
  });

  it("are pruned once expired", async () => {
    const t = await team();
    await invited(t);
    expect(await pruneExpiredInvitations(global(), NOW + 7 * DAY)).toBeGreaterThanOrEqual(1);
    expect(
      await db()
        .select()
        .from(schema.workspaceInvitations)
        .where(and(eq(schema.workspaceInvitations.workspaceId, t.id))),
    ).toEqual([]);
  });

  it("and memberships are in the account export, never other people's addresses", async () => {
    const t = await team();
    const { invitee } = await invited(t, "member");
    const exported = value(await exportAccount(db(), { userId: t.editor.id, now: NOW }));
    expect(exported.workspaces).toEqual([
      { slug: t.slug, name: "Team", role: "editor", joinedAt: expect.any(String), groups: [] },
    ]);
    const theirs = value(await exportAccount(db(), { userId: invitee.id, now: NOW }));
    expect(theirs.workspaces).toEqual([]);
    expect(theirs.invitations).toEqual([
      {
        workspace: { slug: t.slug, name: "Team" },
        role: "member",
        invitedBy: "Ada",
        expiresAt: new Date(NOW + 7 * DAY).toISOString(),
      },
    ]);
    expect(JSON.stringify(exported)).not.toContain(invitee.email);
  });
});

describe("edges", () => {
  it("shows where owners live: personal spaces, workspaces, and nothing for an unknown one", async () => {
    const [a, b] = [await team(), await team()];
    const views = await ownerViews(global(), [a.admin.id, a.id, b.id, "ws_unknown"]);
    expect(Object.fromEntries(views)).toEqual({
      [a.admin.id]: { kind: "personal" },
      [a.id]: { kind: "workspace", slug: a.slug, name: "Team" },
      [b.id]: { kind: "workspace", slug: b.slug, name: "Team" },
    });
    expect(await ownerView(global(), a.id)).toEqual({
      kind: "workspace",
      slug: a.slug,
      name: "Team",
    });
    expect(await ownerView(global(), "ws_unknown")).toEqual({ kind: "personal" });
    const many = await ownerViews(
      global(),
      Array.from({ length: 85 }, (_, i) => `ws_${String(i).padStart(32, "0")}`).concat([b.id]),
    );
    expect(many.get(b.id)).toMatchObject({ slug: b.slug });
  });

  it("limits invitations per workspace a day, and per admin over the whole hour", async () => {
    const t = await team(200);
    const start = Date.UTC(2026, 10, 20, 0);
    let sent = 0;
    for (let hour = 0; sent < 50; hour += 1) {
      for (let i = 0; i < 20 && sent < 50; i += 1) {
        value(
          (await invite(t, `day${sent}@example.test`, "member", { now: start + hour * 3_600_000 }))
            .result,
        );
        sent += 1;
      }
    }
    expect(
      (await invite(t, "day50@example.test", "member", { now: start + 5 * 3_600_000 })).result,
    ).toMatchObject({ ok: false, code: "rate_limited" });

    const u = await team(200);
    const hour = Date.UTC(2026, 10, 21, 9);
    for (let i = 0; i < 20; i += 1) {
      value((await invite(u, `h${i}@example.test`, "member", { now: hour })).result);
    }
    expect(
      (await invite(u, "h20@example.test", "member", { now: hour + 30 * 60_000 })).result,
    ).toMatchObject({ ok: false, code: "rate_limited" });
    value((await invite(u, "h21@example.test", "member", { now: hour + 3_600_000 })).result);
  });

  it("removing oneself as the only admin answers like leaving", async () => {
    const t = await team();
    expect(
      await removeMember(global(), { userId: t.admin.id, slug: t.slug, memberId: t.admin.id }),
    ).toEqual({
      ok: false,
      code: "sole_workspace_admin",
      message:
        "You are the workspace's only admin. Make another member an admin before you leave, or ask Portifact at hello@portifact.com to delete the workspace.",
    });
  });

  it("gives a member (one a directory added) the role of an admin's invitation they accept", async () => {
    const t = await team();
    const { invitee, token } = await invited(t, "editor");
    await db()
      .insert(schema.workspaceMembers)
      .values({ workspaceId: t.id, userId: invitee.id, role: "member", updatedAt: NOW });
    expect(
      value(await acceptInvitation(global(), { userId: invitee.id, key: { token }, now: NOW }))
        .role,
    ).toBe("editor");
    expect(await listIncomingInvitations(global(), { userId: invitee.id, now: NOW })).toEqual([]);
  });

  it("never lowers an existing member's role through an invitation", async () => {
    const t = await team();
    const { invitee, token } = await invited(t, "member");
    await db()
      .insert(schema.workspaceMembers)
      .values({ workspaceId: t.id, userId: invitee.id, role: "editor", updatedAt: NOW });
    expect(
      value(await acceptInvitation(global(), { userId: invitee.id, key: { token }, now: NOW }))
        .role,
    ).toBe("editor");
  });

  it("counts seats as members plus invitations that have not expired", async () => {
    const t = await team(10);
    await invited(t);
    expect(await workspaceSeats(global(), t.id, NOW)).toEqual({ used: 4, limit: 10 });
    expect(await workspaceSeats(global(), t.id, NOW + 7 * DAY)).toEqual({ used: 3, limit: 10 });
  });
});

async function sentEmails(): Promise<number> {
  const rows = await db().select().from(schema.emailCounters);
  return rows.reduce((sum, row) => sum + row.sent, 0);
}
