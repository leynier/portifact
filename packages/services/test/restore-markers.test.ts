// Deletions a backup restore must not undo (docs/operations.md, "Restoring a backup"): ended
// memberships, withdrawn invitations, email preferences turned off and per-artifact mutes each
// write a tombstone in the batch of the change, `applyTombstones` applies it again after a D1
// Time Travel restore, and the markers are pruned once the backup window has passed.
import { env } from "cloudflare:test";
import { regionsFromEnv, schema } from "@portifact/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { updateAccountSettings } from "../src/account-settings.ts";
import { applyTombstones, exportTombstones } from "../src/backups.ts";
import { setCommentNoticeMute } from "../src/comment-notices.ts";
import {
  declineInvitation,
  type InvitationSender,
  inviteMember,
  revokeInvitation,
} from "../src/invitations.ts";
import {
  GROUP_TOMBSTONE_RETENTION_MS,
  pruneGroupTombstones,
  WINDOW_TOMBSTONE_KINDS,
} from "../src/workspace-groups.ts";
import { createWorkspace, leaveWorkspace, removeMember } from "../src/workspaces.ts";
import { DAY, db, grantPlan, NOW, publishSite, user, value } from "./fixtures.ts";

const regions = () => regionsFromEnv(env);
const global = () => db().global;
const wm = schema.workspaceMembers;
const t = schema.tombstones;
const silent: InvitationSender = { async send() {} };

async function team() {
  const [admin, second, member] = [await user("Ada"), await user("Bo"), await user("Mia")];
  const slug = `r-${crypto.randomUUID().slice(0, 8)}`;
  const created = value(
    await createWorkspace(global(), { slug, name: "Team", adminUserId: admin.id, now: NOW }),
  );
  // Members joined well before the removals the tests make with the wall clock.
  await global()
    .insert(wm)
    .values([
      {
        workspaceId: created.id,
        userId: second.id,
        role: "admin",
        createdAt: NOW - DAY,
        updatedAt: NOW,
      },
      {
        workspaceId: created.id,
        userId: member.id,
        role: "member",
        createdAt: NOW - DAY,
        updatedAt: NOW,
      },
    ]);
  await grantPlan(created.id, "team", { seats: 10 });
  return { id: created.id, slug, admin, second, member };
}

async function membership(workspaceId: string, userId: string) {
  const [row] = await global()
    .select()
    .from(wm)
    .where(and(eq(wm.workspaceId, workspaceId), eq(wm.userId, userId)));
  return row;
}

async function marker(kind: (typeof WINDOW_TOMBSTONE_KINDS)[number], id: string) {
  const [row] = await global()
    .select()
    .from(t)
    .where(and(eq(t.kind, kind), eq(t.id, id)));
  return row;
}

/** What a restore does to the global rows: they come back, and the markers are rewound. */
async function rewind(rows: () => Promise<unknown>, markers: { kind: string; id: string }[]) {
  await rows();
  for (const m of markers) {
    await global()
      .delete(t)
      .where(and(eq(t.kind, m.kind as (typeof WINDOW_TOMBSTONE_KINDS)[number]), eq(t.id, m.id)));
  }
}

describe("ended memberships through a restore", () => {
  it("ends again a membership an admin removed, with its single sign-on block, and one its member left, without", async () => {
    const w = await team();
    const removedAt = Date.now();
    value(
      await removeMember(global(), {
        userId: w.admin.id,
        slug: w.slug,
        memberId: w.member.id,
        now: removedAt,
      }),
    );
    value(await leaveWorkspace(global(), { userId: w.second.id, slug: w.slug, now: removedAt }));
    expect(await marker("workspace_member", `${w.id}:${w.member.id}`)).toMatchObject({
      deletedAt: removedAt,
    });
    expect(await marker("workspace_member_left", `${w.id}:${w.second.id}`)).toBeDefined();
    const markers = await exportTombstones(regions());

    await rewind(async () => {
      await global()
        .insert(wm)
        .values([
          {
            workspaceId: w.id,
            userId: w.member.id,
            role: "member",
            createdAt: NOW - DAY,
            updatedAt: NOW,
          },
          {
            workspaceId: w.id,
            userId: w.second.id,
            role: "admin",
            createdAt: NOW - DAY,
            updatedAt: NOW,
          },
        ]);
      await global()
        .delete(schema.workspaceRemovals)
        .where(eq(schema.workspaceRemovals.workspaceId, w.id));
    }, [
      { kind: "workspace_member", id: `${w.id}:${w.member.id}` },
      { kind: "workspace_member_left", id: `${w.id}:${w.second.id}` },
    ]);
    expect(await membership(w.id, w.member.id)).toBeDefined();

    const applied = await applyTombstones(regions(), markers, removedAt + DAY);
    expect(applied.members).toBe(2);
    expect(await membership(w.id, w.member.id)).toBeUndefined();
    expect(await membership(w.id, w.second.id)).toBeUndefined();
    const removals = await global()
      .select({ userId: schema.workspaceRemovals.userId })
      .from(schema.workspaceRemovals)
      .where(eq(schema.workspaceRemovals.workspaceId, w.id));
    // Only the admin's removal blocks single sign-on; leaving never did.
    expect(removals).toEqual([{ userId: w.member.id }]);
    expect((await applyTombstones(regions(), markers, removedAt + DAY)).members).toBe(0);
  });

  it("keeps a membership that started after the removal", async () => {
    const w = await team();
    const removedAt = Date.now();
    value(
      await removeMember(global(), {
        userId: w.admin.id,
        slug: w.slug,
        memberId: w.member.id,
        now: removedAt,
      }),
    );
    // Invited again and joined later: a newer membership survives.
    await global()
      .insert(wm)
      .values({
        workspaceId: w.id,
        userId: w.member.id,
        role: "member",
        createdAt: removedAt + 1,
        updatedAt: removedAt,
      });
    const applied = await applyTombstones(
      regions(),
      await exportTombstones(regions()),
      removedAt + DAY,
    );
    expect(applied.members).toBe(0);
    expect(await membership(w.id, w.member.id)).toBeDefined();
  });

  it("never ends a workspace's last admin, and leaves the rest of the restore to run", async () => {
    const w = await team();
    const leftAt = Date.now();
    // The original admin leaves while a second admin is there.
    value(await leaveWorkspace(global(), { userId: w.admin.id, slug: w.slug, now: leftAt }));
    const markers = await exportTombstones(regions());
    // The restore point is before both: the admin is back, the second admin's membership is not.
    await rewind(async () => {
      await global()
        .insert(wm)
        .values({
          workspaceId: w.id,
          userId: w.admin.id,
          role: "admin",
          createdAt: NOW - 2 * DAY,
          updatedAt: NOW,
        });
      await global()
        .delete(wm)
        .where(and(eq(wm.workspaceId, w.id), eq(wm.userId, w.second.id)));
    }, [{ kind: "workspace_member_left", id: `${w.id}:${w.admin.id}` }]);
    const applied = await applyTombstones(regions(), markers, leftAt + DAY);
    expect(applied.members).toBe(0);
    expect(await membership(w.id, w.admin.id)).toMatchObject({ role: "admin" });
  });
});

describe("withdrawn invitations through a restore", () => {
  it("withdraws again an invitation an admin revoked or its invitee declined", async () => {
    const w = await team();
    const invitee = await user("Ivy");
    const declining = await user("Dee");
    const invite = async (email: string) =>
      value(
        await inviteMember(
          global(),
          { userId: w.admin.id, slug: w.slug, email, role: "member", now: NOW },
          silent,
        ),
      );
    await invite(invitee.email);
    await invite(declining.email);
    const rows = await global()
      .select()
      .from(schema.workspaceInvitations)
      .where(eq(schema.workspaceInvitations.workspaceId, w.id));
    const revoked = rows.find((row) => row.email === invitee.email);
    const declined = rows.find((row) => row.email === declining.email);
    if (!revoked || !declined) throw new Error("missing invitation");
    value(
      await revokeInvitation(global(), {
        userId: w.admin.id,
        slug: w.slug,
        invitationId: revoked.id,
        now: NOW,
      }),
    );
    value(
      await declineInvitation(global(), {
        userId: declining.id,
        key: { invitationId: declined.id },
        now: NOW,
      }),
    );
    expect(await marker("workspace_invitation", revoked.id)).toBeDefined();
    expect(await marker("workspace_invitation", declined.id)).toBeDefined();
    const markers = await exportTombstones(regions());

    await rewind(
      () => global().insert(schema.workspaceInvitations).values([revoked, declined]),
      [
        { kind: "workspace_invitation", id: revoked.id },
        { kind: "workspace_invitation", id: declined.id },
      ],
    );
    const applied = await applyTombstones(regions(), markers, NOW + DAY);
    expect(applied.invitations).toBe(2);
    expect(
      await global()
        .select()
        .from(schema.workspaceInvitations)
        .where(eq(schema.workspaceInvitations.workspaceId, w.id)),
    ).toEqual([]);
  });

  it("writes no marker when the revocation is refused", async () => {
    const w = await team();
    const invitee = await user("Ivy");
    value(
      await inviteMember(
        global(),
        { userId: w.admin.id, slug: w.slug, email: invitee.email, role: "member", now: NOW },
        silent,
      ),
    );
    const [row] = await global()
      .select()
      .from(schema.workspaceInvitations)
      .where(eq(schema.workspaceInvitations.workspaceId, w.id));
    if (!row) throw new Error("missing invitation");
    const refused = await revokeInvitation(global(), {
      userId: w.member.id,
      slug: w.slug,
      invitationId: row.id,
      now: NOW,
    });
    expect(refused.ok).toBe(false);
    expect(await marker("workspace_invitation", row.id)).toBeUndefined();
  });
});

describe("email preferences and mutes through a restore", () => {
  const settingsOf = async (userId: string) =>
    (
      await global()
        .select()
        .from(schema.accountSettings)
        .where(eq(schema.accountSettings.userId, userId))
    )[0];

  it("turns off again the notices a person turned off, and forgets the marker once they turn them on", async () => {
    const person = await user();
    const other = await user();
    value(
      await updateAccountSettings(global(), {
        userId: person.id,
        update: { commentNotices: false, expiryNotices: false },
        now: NOW,
      }),
    );
    value(
      await updateAccountSettings(global(), {
        userId: other.id,
        update: { commentNotices: false },
        now: NOW,
      }),
    );
    value(
      await updateAccountSettings(global(), {
        userId: other.id,
        update: { commentNotices: true },
        now: NOW + 1,
      }),
    );
    expect(await marker("notice_opt_out", `${person.id}:comment_notices`)).toBeDefined();
    expect(await marker("notice_opt_out", `${person.id}:expiry_notices`)).toBeDefined();
    expect(await marker("notice_opt_out", `${other.id}:comment_notices`)).toBeUndefined();
    const markers = await exportTombstones(regions());

    // The restore point is before any settings row of the person, and of the other's last change.
    await rewind(
      () =>
        global().delete(schema.accountSettings).where(eq(schema.accountSettings.userId, person.id)),
      [
        { kind: "notice_opt_out", id: `${person.id}:comment_notices` },
        { kind: "notice_opt_out", id: `${person.id}:expiry_notices` },
      ],
    );
    await global()
      .update(schema.accountSettings)
      .set({ commentNotices: false })
      .where(eq(schema.accountSettings.userId, other.id));
    const applied = await applyTombstones(regions(), markers, NOW + DAY);
    expect(applied.noticeOptOuts).toBe(2);
    expect(await settingsOf(person.id)).toMatchObject({
      commentNotices: false,
      expiryNotices: false,
      commentNoticesChangedAt: NOW,
      defaultAccessMode: "restricted",
    });
    // A marker the person removed by turning notices back on applies nothing.
    expect(await settingsOf(other.id)).toMatchObject({ commentNotices: false });
    expect((await applyTombstones(regions(), markers, NOW + DAY)).noticeOptOuts).toBe(0);
  });

  it("sets again a per-artifact mute the restore lost, and drops the marker with an unmute", async () => {
    const owner = await user();
    const site = await publishSite(owner.id, { "index.html": "<p>Plan</p>" });
    const id = site.artifactId;
    value(
      await setCommentNoticeMute(db(), { userId: owner.id, artifactId: id, muted: true, now: NOW }),
    );
    expect(await marker("comment_notice_mute", `${id}:${owner.id}`)).toBeDefined();
    const markers = await exportTombstones(regions());
    await rewind(
      () =>
        db().delete(schema.commentNoticeMutes).where(eq(schema.commentNoticeMutes.artifactId, id)),
      [{ kind: "comment_notice_mute", id: `${id}:${owner.id}` }],
    );
    const applied = await applyTombstones(regions(), markers, NOW + DAY);
    expect(applied.noticeMutes).toBe(1);
    const mutes = await db()
      .select({ userId: schema.commentNoticeMutes.userId })
      .from(schema.commentNoticeMutes)
      .where(eq(schema.commentNoticeMutes.artifactId, id));
    expect(mutes).toEqual([{ userId: owner.id }]);

    value(
      await setCommentNoticeMute(db(), {
        userId: owner.id,
        artifactId: id,
        muted: false,
        now: NOW,
      }),
    );
    expect(await marker("comment_notice_mute", `${id}:${owner.id}`)).toBeUndefined();
  });

  it("does not mute again for an account deleted since, nor on an artifact that is gone", async () => {
    const owner = await user();
    const site = await publishSite(owner.id, { "index.html": "<p>Plan</p>" });
    const ghost = `u_${crypto.randomUUID()}`;
    const markers = [
      { kind: "comment_notice_mute" as const, id: `${site.artifactId}:${ghost}`, deletedAt: NOW },
      { kind: "account" as const, id: ghost, deletedAt: NOW },
      { kind: "comment_notice_mute" as const, id: `missingartifact:${owner.id}`, deletedAt: NOW },
    ];
    const applied = await applyTombstones(regions(), markers, NOW + DAY);
    expect(applied.noticeMutes).toBe(0);
  });
});

describe("pruning restore markers", () => {
  it("prunes every window kind after the backup window and keeps the permanent kinds", async () => {
    const old = NOW - GROUP_TOMBSTONE_RETENTION_MS - DAY;
    const tag = crypto.randomUUID();
    await global()
      .insert(t)
      .values([
        ...WINDOW_TOMBSTONE_KINDS.map((kind) => ({ kind, id: `${tag}:old`, deletedAt: old })),
        ...WINDOW_TOMBSTONE_KINDS.map((kind) => ({ kind, id: `${tag}:recent`, deletedAt: NOW })),
        { kind: "artifact" as const, id: `${tag}:old`, deletedAt: old },
      ]);
    for (let run = 0; run < 20; run++) {
      if ((await pruneGroupTombstones(global(), NOW)).deleted === 0) break;
    }
    const left = await global()
      .select({ kind: t.kind, id: t.id })
      .from(t)
      .where(eq(t.id, `${tag}:old`));
    expect(left).toEqual([{ kind: "artifact", id: `${tag}:old` }]);
    const recent = await global()
      .select({ kind: t.kind })
      .from(t)
      .where(eq(t.id, `${tag}:recent`));
    expect(recent).toHaveLength(WINDOW_TOMBSTONE_KINDS.length);
  });
});
