// Member and invitation writes decided on a state another request changes before their batch:
// the caller demoted, the seats lowered, a re-invitation refused, and invitation email abuse.
import type { WorkspaceRole } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { suppressEmail } from "../src/email.ts";
import {
  acceptInvitation,
  type InvitationMessage,
  type InvitationSender,
  inviteMember,
  revokeInvitation,
} from "../src/invitations.ts";
import { changeMemberRole, createWorkspace, removeMember } from "../src/workspaces.ts";
import { db, grantPlan, NOW, user, value } from "./fixtures.ts";
import { raceGlobalBeforeFirstWrite } from "./race.ts";

type User = { id: string; email: string };

function recorder(): InvitationSender & { sent: InvitationMessage[] } {
  const sent: InvitationMessage[] = [];
  return { sent, send: async (message) => void sent.push(message) };
}

async function team(seats = 10) {
  const [admin, other, member] = [await user("Ada"), await user("Bo"), await user("Mia")];
  const slug = `r-${crypto.randomUUID().slice(0, 8)}`;
  const ws = value(
    await createWorkspace(db().global, { slug, name: "Team", adminUserId: admin.id, now: NOW }),
  );
  await db()
    .insert(schema.workspaceMembers)
    .values([
      { workspaceId: ws.id, userId: other.id, role: "admin", updatedAt: NOW },
      { workspaceId: ws.id, userId: member.id, role: "member", updatedAt: NOW },
    ]);
  await grantPlan(ws.id, "team", { seats });
  const demote = (who: User) => async () => {
    await db()
      .update(schema.workspaceMembers)
      .set({ role: "member" })
      .where(
        and(
          eq(schema.workspaceMembers.workspaceId, ws.id),
          eq(schema.workspaceMembers.userId, who.id),
        ),
      );
  };
  const setSeats = (n: number) => async () => {
    await db()
      .update(schema.ownerPlans)
      .set({ seats: n, updatedAt: NOW + 1 })
      .where(eq(schema.ownerPlans.ownerId, ws.id));
  };
  return { ws, slug, admin, other, member, demote, setSeats };
}

const roleOf = async (workspaceId: string, userId: string) =>
  (
    await db()
      .select({ role: schema.workspaceMembers.role })
      .from(schema.workspaceMembers)
      .where(
        and(
          eq(schema.workspaceMembers.workspaceId, workspaceId),
          eq(schema.workspaceMembers.userId, userId),
        ),
      )
  )[0]?.role;

const pending = (workspaceId: string) =>
  db()
    .select()
    .from(schema.workspaceInvitations)
    .where(eq(schema.workspaceInvitations.workspaceId, workspaceId));

const invite = (
  global: ReturnType<typeof db>["global"],
  t: Awaited<ReturnType<typeof team>>,
  email: string,
  role: WorkspaceRole = "member",
  sender: InvitationSender = recorder(),
  now = NOW,
) => inviteMember(global, { userId: t.admin.id, slug: t.slug, email, role, now }, sender);

describe("a caller demoted before the batch", () => {
  it("changes no role", async () => {
    const t = await team();
    const result = await changeMemberRole(raceGlobalBeforeFirstWrite(t.demote(t.admin)), {
      userId: t.admin.id,
      slug: t.slug,
      memberId: t.member.id,
      role: "editor",
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, code: "forbidden" });
    expect(await roleOf(t.ws.id, t.member.id)).toBe("member");
  });

  it("removes nobody", async () => {
    const t = await team();
    const result = await removeMember(raceGlobalBeforeFirstWrite(t.demote(t.admin)), {
      userId: t.admin.id,
      slug: t.slug,
      memberId: t.member.id,
    });
    expect(result).toMatchObject({ ok: false, code: "forbidden" });
    expect(await roleOf(t.ws.id, t.member.id)).toBe("member");
  });

  it("invites nobody and revokes nothing", async () => {
    const t = await team();
    const sender = recorder();
    const result = await invite(
      raceGlobalBeforeFirstWrite(t.demote(t.admin)),
      t,
      "x@example.test",
      "member",
      sender,
    );
    expect(result).toMatchObject({ ok: false, code: "forbidden" });
    expect(sender.sent).toEqual([]);
    expect(await pending(t.ws.id)).toEqual([]);

    const u = await team();
    const sent = value(await invite(db().global, u, "y@example.test"));
    const revoked = await revokeInvitation(raceGlobalBeforeFirstWrite(u.demote(u.admin)), {
      userId: u.admin.id,
      slug: u.slug,
      invitationId: sent.id,
    });
    expect(revoked).toMatchObject({ ok: false, code: "forbidden" });
    expect((await pending(u.ws.id)).map((row) => row.id)).toEqual([sent.id]);
  });
});

describe("seats lowered before the batch", () => {
  it("refuse the accept that would pass the new limit", async () => {
    const t = await team(5);
    const invitee = await user("Grace");
    const sender = recorder();
    value(await invite(db().global, t, invitee.email, "member", sender));
    const token = (sender.sent[0] as InvitationMessage).token;
    const result = await acceptInvitation(raceGlobalBeforeFirstWrite(t.setSeats(3)), {
      userId: invitee.id,
      key: { token },
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, code: "seats_exhausted" });
    expect(await roleOf(t.ws.id, invitee.id)).toBeUndefined();
  });

  it("refuse the invitation that would pass the new limit", async () => {
    const t = await team(4);
    const result = await invite(raceGlobalBeforeFirstWrite(t.setSeats(3)), t, "late@example.test");
    expect(result).toMatchObject({ ok: false, code: "seats_exhausted" });
    expect(await pending(t.ws.id)).toEqual([]);
  });

  it("keep the earlier invitation when a re-invitation is refused", async () => {
    const t = await team(5);
    const first = value(await invite(db().global, t, "again@example.test", "member"));
    const result = await invite(
      raceGlobalBeforeFirstWrite(t.setSeats(3)),
      t,
      "again@example.test",
      "editor",
    );
    expect(result).toMatchObject({ ok: false, code: "seats_exhausted" });
    expect((await pending(t.ws.id)).map((row) => [row.id, row.role])).toEqual([
      [first.id, "member"],
    ]);
  });
});

describe("invitation email abuse", () => {
  it("limits how many invitations one address gets a day, across workspaces, keyed by a hash", async () => {
    const day = Date.UTC(2026, 11, 2, 8);
    const target = `flood-${crypto.randomUUID().slice(0, 6)}@example.test`;
    for (let i = 0; i < 5; i += 1) {
      const t = await team();
      value(await invite(db().global, t, target, "member", recorder(), day + i));
    }
    const t = await team();
    const sender = recorder();
    expect(await invite(db().global, t, target, "member", sender, day + 10)).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
    expect(sender.sent).toEqual([]);
    const keys = await db().$client.prepare("select key from rate_limits").all<{ key: string }>();
    expect(keys.results.some((row) => row.key.includes(target))).toBe(false);
  });

  it("answers the same for a suppressed address, sends nothing and keeps the invitation", async () => {
    const t = await team();
    await suppressEmail(db().global, { email: "gone@example.test", reason: "complaint", now: NOW });
    const sender = recorder();
    const suppressed = value(await invite(db().global, t, "gone@example.test", "member", sender));
    const normal = value(await invite(db().global, t, "fine@example.test", "member", recorder()));
    expect(Object.keys(suppressed).sort()).toEqual(Object.keys(normal).sort());
    expect(sender.sent).toEqual([]);
    expect((await pending(t.ws.id)).map((row) => row.email).sort()).toEqual([
      "fine@example.test",
      "gone@example.test",
    ]);
  });
});

describe("the last admin, decided by the database", () => {
  it("refuses demoting oneself once the other admin was demoted meanwhile", async () => {
    const t = await team();
    const result = await changeMemberRole(raceGlobalBeforeFirstWrite(t.demote(t.other)), {
      userId: t.admin.id,
      slug: t.slug,
      memberId: t.admin.id,
      role: "member",
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, code: "sole_workspace_admin" });
    expect(await roleOf(t.ws.id, t.admin.id)).toBe("admin");
  });

  it("refuses leaving once the other admin was demoted meanwhile", async () => {
    const t = await team();
    const result = await removeMember(raceGlobalBeforeFirstWrite(t.demote(t.other)), {
      userId: t.admin.id,
      slug: t.slug,
      memberId: t.admin.id,
    });
    expect(result).toMatchObject({
      ok: false,
      code: "sole_workspace_admin",
      message: expect.stringContaining("before you leave"),
    });
    expect(await roleOf(t.ws.id, t.admin.id)).toBe("admin");
  });

  it("answers a refused write with a conflict when the caller is still an admin", async () => {
    const t = await team();
    const result = await changeMemberRole(
      raceGlobalBeforeFirstWrite(async () => {
        await db()
          .update(schema.workspaceMembers)
          .set({ role: "editor" })
          .where(
            and(
              eq(schema.workspaceMembers.workspaceId, t.ws.id),
              eq(schema.workspaceMembers.userId, t.member.id),
            ),
          );
      }),
      { userId: t.admin.id, slug: t.slug, memberId: t.member.id, role: "admin", now: NOW },
    );
    expect(result).toEqual({
      ok: false,
      code: "version_conflict",
      message: "The member changed meanwhile. Reload and try again.",
    });
  });

  it("answers an accept that lost to a seat change, with seats still free, as a conflict", async () => {
    const t = await team(10);
    const invitee = await user("Hal");
    const sender = recorder();
    value(await invite(db().global, t, invitee.email, "member", sender));
    const token = (sender.sent[0] as InvitationMessage).token;
    const result = await acceptInvitation(raceGlobalBeforeFirstWrite(t.setSeats(9)), {
      userId: invitee.id,
      key: { token },
      now: NOW,
    });
    expect(result).toEqual({
      ok: false,
      code: "version_conflict",
      message: "The workspace changed meanwhile. Try again.",
    });
  });
});
