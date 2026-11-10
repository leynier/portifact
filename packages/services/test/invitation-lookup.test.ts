// The invitation page's lookup by the link's token: the invitee sees the invitation, another
// account only the invited address, and a missing, expired, revoked or used one nothing.
import { schema } from "@portifact/db";
import { MISSING_INVITATION } from "@portifact/domain";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { lookupInvitation } from "../src/invitation-lookup.ts";
import {
  acceptInvitation,
  type InvitationMessage,
  type InvitationSender,
  inviteMember,
  revokeInvitation,
} from "../src/invitations.ts";
import { createWorkspace } from "../src/workspaces.ts";
import { DAY, db, grantPlan, NOW, user, value } from "./fixtures.ts";

const global = () => db().global;
const missing = { ok: false, code: "not_found", message: MISSING_INVITATION };

async function invitation() {
  const admin = await user("Ada Admin");
  const invitee = await user("Grace");
  const slug = `l-${crypto.randomUUID().slice(0, 8)}`;
  const workspace = value(
    await createWorkspace(global(), { slug, name: "Lookup team", adminUserId: admin.id, now: NOW }),
  );
  await grantPlan(workspace.id, "team", { seats: 5 });
  const sent: InvitationMessage[] = [];
  const sender: InvitationSender = {
    async send(message) {
      sent.push(message);
    },
  };
  const created = value(
    await inviteMember(
      global(),
      { userId: admin.id, slug, email: invitee.email, role: "editor", now: NOW },
      sender,
    ),
  );
  return { admin, invitee, slug, id: created.id, token: (sent[0] as InvitationMessage).token };
}

describe("lookupInvitation", () => {
  it("shows the invitee the workspace, the role, who sent it and when it expires", async () => {
    const t = await invitation();
    expect(
      await lookupInvitation(global(), { userId: t.invitee.id, token: t.token, now: NOW }),
    ).toEqual({
      ok: true,
      value: {
        status: "invited",
        invitation: {
          id: t.id,
          workspace: { slug: t.slug, name: "Lookup team" },
          role: "editor",
          invitedBy: "Ada Admin",
          expiresAt: NOW + 7 * DAY,
        },
      },
    });
  });

  it("tells another account only which address was invited", async () => {
    const t = await invitation();
    const other = await user("Otto");
    const result = await lookupInvitation(global(), { userId: other.id, token: t.token, now: NOW });
    expect(result).toEqual({
      ok: true,
      value: { status: "other_account", email: t.invitee.email },
    });
    expect(JSON.stringify(result)).not.toContain("Lookup team");
  });

  it("treats the invited address without a verified email as another account", async () => {
    const t = await invitation();
    await db()
      .update(schema.users)
      .set({ emailVerified: false })
      .where(eq(schema.users.id, t.invitee.id));
    expect(
      await lookupInvitation(global(), { userId: t.invitee.id, token: t.token, now: NOW }),
    ).toEqual({ ok: true, value: { status: "other_account", email: t.invitee.email } });
  });

  it("answers an unknown token, an expired, revoked or used invitation like a missing one", async () => {
    const t = await invitation();
    const look = (token: string, now = NOW, userId = t.invitee.id) =>
      lookupInvitation(global(), { userId, token, now });
    expect(await look("A".repeat(43))).toEqual(missing);
    expect(await look(t.token, NOW + 7 * DAY)).toEqual(missing);
    expect(await look(t.token, NOW + 7 * DAY - 1)).toMatchObject({ ok: true });

    value(
      await acceptInvitation(global(), { userId: t.invitee.id, key: { token: t.token }, now: NOW }),
    );
    expect(await look(t.token)).toEqual(missing);

    const revoked = await invitation();
    value(
      await revokeInvitation(global(), {
        userId: revoked.admin.id,
        slug: revoked.slug,
        invitationId: revoked.id,
      }),
    );
    expect(await look(revoked.token, NOW, revoked.invitee.id)).toEqual(missing);
  });

  it("answers an account that no longer exists like a missing invitation", async () => {
    const t = await invitation();
    expect(
      await lookupInvitation(global(), { userId: "u_gone", token: t.token, now: NOW }),
    ).toEqual(missing);
  });

  it("leaves the inviter unnamed once their account is gone", async () => {
    const t = await invitation();
    await db()
      .update(schema.workspaceInvitations)
      .set({ invitedBy: null })
      .where(eq(schema.workspaceInvitations.id, t.id));
    expect(
      await lookupInvitation(global(), { userId: t.invitee.id, token: t.token, now: NOW }),
    ).toMatchObject({ ok: true, value: { invitation: { invitedBy: null } } });
  });
});
