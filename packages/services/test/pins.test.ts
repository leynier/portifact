// Pinned artifacts and archive length by plan (premium plan P2): a pinned artifact stays active
// with no expiry until it is unpinned, pinning is part of a paid plan of the artifact's owner,
// unpinning always works, a plan that loses `pin` unpins in a maintenance scan, and an archive is
// kept for the months of the owner's plan when it is archived.
import { env } from "cloudflare:test";
import { planRequiredMessage } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { scheduleExpiryNotices } from "../src/expiry-notices.ts";
import {
  archiveArtifact,
  pinArtifact,
  renewArtifact,
  restoreArtifact,
  unpinArtifact,
} from "../src/lifecycle.ts";
import { archiveExpired, runMaintenance } from "../src/maintenance.ts";
import { reinstateArtifact, suspendArtifact } from "../src/moderation.ts";
import { unpinLapsedPlans } from "../src/plans.ts";
import { commitPublish, type ManifestEntry, preparePublish } from "../src/publish.ts";
import { rollbackArtifact } from "../src/versions.ts";
import {
  artifactRow,
  DAY,
  db,
  grantPlan,
  NOW,
  publishSite,
  racing,
  sha256,
  user,
  value,
} from "./fixtures.ts";

const at = (userId: string, artifactId: string, now = NOW) => ({ userId, artifactId, now });

async function events(artifactId: string) {
  return (
    await db()
      .select({ event: schema.lifecycleEvents.event, actorId: schema.lifecycleEvents.actorId })
      .from(schema.lifecycleEvents)
      .where(eq(schema.lifecycleEvents.artifactId, artifactId))
  ).map((row) => row.event);
}

/** A user on Pro with one published site. */
async function proSite() {
  const owner = await user();
  await grantPlan(owner.id, "pro");
  const { artifactId, versionId } = await publishSite(owner.id);
  return { owner, artifactId, versionId };
}

/** A user on Pro with one pinned site. */
async function pinnedSite() {
  const site = await proSite();
  value(await pinArtifact(db(), at(site.owner.id, site.artifactId)));
  return site;
}

/** Changes an owner's plan row as a later grant would, with a new `updated_at`. */
async function changePlan(ownerId: string, set: Partial<typeof schema.ownerPlans.$inferInsert>) {
  await db()
    .update(schema.ownerPlans)
    .set({ updatedAt: NOW + 1, ...set })
    .where(eq(schema.ownerPlans.ownerId, ownerId));
}

describe("pinning", () => {
  it("refuses an owner without a plan with plan_required, exactly as before plans", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    const before = await artifactRow(artifactId);
    expect(await pinArtifact(db(), at(owner.id, artifactId))).toEqual({
      ok: false,
      code: "plan_required",
      message: planRequiredMessage("pin"),
    });
    expect(await artifactRow(artifactId)).toEqual(before);
    // Unpinning what is not pinned changes nothing and needs no plan.
    expect(await unpinArtifact(db(), at(owner.id, artifactId))).toEqual({
      ok: true,
      value: { state: "active", expiresAt: before?.expiresAt, purgeAt: null, pinned: false },
    });
    expect(await artifactRow(artifactId)).toEqual(before);
  });

  it("pins on Pro: no expiry, a new generation and a lifecycle event", async () => {
    const { owner, artifactId } = await proSite();
    const before = await artifactRow(artifactId);
    expect(await pinArtifact(db(), at(owner.id, artifactId, NOW + DAY))).toEqual({
      ok: true,
      value: { state: "active", expiresAt: null, purgeAt: null, pinned: true },
    });
    expect(await artifactRow(artifactId)).toMatchObject({
      state: "active",
      pinned: true,
      expiresAt: null,
      lifecycleGeneration: (before?.lifecycleGeneration ?? 0) + 1,
      updatedAt: NOW + DAY,
    });
    expect(await events(artifactId)).toContain("pinned");
  });

  it("is idempotent: a retried pin answers the same and writes nothing", async () => {
    const { owner, artifactId } = await pinnedSite();
    const before = await artifactRow(artifactId);
    const again = await pinArtifact(db(), at(owner.id, artifactId, NOW + 5));
    expect(again).toEqual({
      ok: true,
      value: { state: "active", expiresAt: null, purgeAt: null, pinned: true },
    });
    expect(await artifactRow(artifactId)).toEqual(before);
    expect((await events(artifactId)).filter((event) => event === "pinned")).toHaveLength(1);
  });

  it("pins only what is active now", async () => {
    const { owner, artifactId } = await proSite();
    // Past its 30 days the artifact is archived for delivery even before the scan runs.
    expect(await pinArtifact(db(), at(owner.id, artifactId, NOW + 30 * DAY))).toMatchObject({
      ok: false,
      code: "artifact_archived",
    });
    value(await archiveArtifact(db(), at(owner.id, artifactId)));
    expect(await pinArtifact(db(), at(owner.id, artifactId))).toMatchObject({
      ok: false,
      code: "artifact_archived",
    });
  });

  it("answers a stranger exactly like a missing artifact", async () => {
    const { artifactId } = await proSite();
    const stranger = await user();
    await grantPlan(stranger.id, "enterprise");
    for (const action of [pinArtifact, unpinArtifact]) {
      expect(await action(db(), at(stranger.id, artifactId))).toEqual({
        ok: false,
        code: "not_found",
        message: "Artifact not found.",
      });
      expect(await action(db(), at(stranger.id, "zzzzzzzzzz"))).toEqual({
        ok: false,
        code: "not_found",
        message: "Artifact not found.",
      });
    }
  });

  it("refuses a conflicting change with version_conflict", async () => {
    const { owner, artifactId } = await proSite();
    // Another request bumps the generation between the read and the guarded update.
    const real = db();
    const raced = new Proxy(real, {
      get(target, property, receiver) {
        if (property !== "update") return Reflect.get(target, property, receiver);
        return (table: typeof schema.artifacts) => {
          const builder = target.update(table);
          return {
            set: (values: Parameters<typeof builder.set>[0]) => {
              const statement = builder.set(values);
              return {
                where: (condition: Parameters<typeof statement.where>[0]) => {
                  const guarded = statement.where(condition);
                  return {
                    returning: async (fields: Parameters<typeof guarded.returning>[0]) => {
                      await target
                        .update(schema.artifacts)
                        .set({ lifecycleGeneration: 999 })
                        .where(eq(schema.artifacts.id, artifactId));
                      return guarded.returning(fields);
                    },
                  };
                },
              };
            },
          };
        };
      },
    }) as typeof real;
    expect(await pinArtifact(raced, at(owner.id, artifactId))).toMatchObject({
      ok: false,
      code: "version_conflict",
    });
    expect((await artifactRow(artifactId))?.pinned).toBe(false);
  });

  it("never leaves an archived artifact pinned when pin and archive race", async () => {
    const { owner, artifactId } = await proSite();
    const [pinned, archived] = await Promise.all([
      pinArtifact(db(), at(owner.id, artifactId)),
      archiveArtifact(db(), at(owner.id, artifactId)),
    ]);
    expect(archived.ok || pinned.ok).toBe(true);
    const row = await artifactRow(artifactId);
    if (row?.state === "archived") expect(row.pinned).toBe(false);
    else expect(row).toMatchObject({ state: "active", pinned: true, expiresAt: null });
  });
});

describe("a pinned artifact", () => {
  it("is never archived by the scan and gets no expiry notice", async () => {
    const { artifactId } = await pinnedSite();
    await scheduleExpiryNotices(db(), NOW + 29 * DAY);
    await archiveExpired(db(), NOW + 3650 * DAY, 500);
    expect(await artifactRow(artifactId)).toMatchObject({
      state: "active",
      pinned: true,
      expiryNoticeFor: null,
    });
  });

  it("has nothing to renew", async () => {
    const { owner, artifactId } = await pinnedSite();
    const before = await artifactRow(artifactId);
    expect(await renewArtifact(db(), at(owner.id, artifactId, NOW + DAY))).toEqual({
      ok: true,
      value: { state: "active", expiresAt: null, purgeAt: null, pinned: true },
    });
    expect(await artifactRow(artifactId)).toEqual(before);
  });

  it("stays pinned through a publish and a rollback", async () => {
    const { owner, artifactId, versionId } = await pinnedSite();
    const published = await publishSite(owner.id, { "index.html": "<p>second</p>" }, NOW + DAY, {
      artifactId,
      versionId,
    });
    expect(await artifactRow(artifactId)).toMatchObject({ pinned: true, expiresAt: null });
    const rolled = value(
      await rollbackArtifact(db(), {
        userId: owner.id,
        artifactId,
        versionId,
        baseVersionId: published.versionId,
        now: NOW + 2 * DAY,
      }),
    );
    expect(rolled.expiresAt).toBeNull();
    expect(await artifactRow(artifactId)).toMatchObject({ pinned: true, expiresAt: null });
  });

  it("answers a publish with no expiry", async () => {
    const { owner, artifactId, versionId } = await pinnedSite();
    const body = "<p>third</p>";
    const files: ManifestEntry[] = [
      {
        path: "index.html",
        kind: "published",
        sha256: await sha256(body),
        size: body.length,
        contentType: "text/html",
      },
    ];
    const prepared = value(
      await preparePublish(db(), {
        userId: owner.id,
        artifactId,
        type: "site",
        name: "Plan",
        entrypoint: "index.html",
        baseVersionId: versionId,
        files,
        now: NOW + DAY,
      }),
    );
    await env.ARTIFACTS.put(`objects/${owner.id}/${await sha256(body)}`, body);
    const input = { userId: owner.id, sessionId: prepared.sessionId, now: NOW + DAY };
    expect(value(await commitPublish(db(), env.ARTIFACTS, input)).expiresAt).toBeNull();
    // A retried commit answers the same.
    expect(value(await commitPublish(db(), env.ARTIFACTS, input)).expiresAt).toBeNull();
  });

  it("loses the pin when archived by hand, and comes back unpinned with 30 days", async () => {
    const { owner, artifactId } = await pinnedSite();
    expect(await archiveArtifact(db(), at(owner.id, artifactId, NOW + DAY))).toMatchObject({
      ok: true,
      value: { state: "archived", pinned: false },
    });
    expect(await artifactRow(artifactId)).toMatchObject({
      state: "archived",
      pinned: false,
      archivedAt: NOW + DAY,
    });
    expect(await restoreArtifact(db(), at(owner.id, artifactId, NOW + 2 * DAY))).toEqual({
      ok: true,
      value: { state: "active", expiresAt: NOW + 32 * DAY, purgeAt: null, pinned: false },
    });
  });

  it("keeps the pin through a suspension and a reinstatement", async () => {
    const { artifactId } = await pinnedSite();
    value(await suspendArtifact(db(), { artifactId, reason: "spam", now: NOW + 1 }));
    expect(await artifactRow(artifactId)).toMatchObject({ state: "suspended", pinned: true });
    value(await reinstateArtifact(db(), { artifactId, now: NOW + 2 }));
    expect(await artifactRow(artifactId)).toMatchObject({
      state: "active",
      pinned: true,
      expiresAt: null,
    });
  });

  it("refuses to unpin while suspended", async () => {
    const { owner, artifactId } = await pinnedSite();
    value(await suspendArtifact(db(), { artifactId, reason: "spam", now: NOW + 1 }));
    expect(await unpinArtifact(db(), at(owner.id, artifactId))).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
  });
});

describe("unpinning", () => {
  it("gives a fresh 30 days, after which the usual notice and archive follow", async () => {
    const { owner, artifactId } = await pinnedSite();
    const unpinAt = NOW + 100 * DAY;
    expect(await unpinArtifact(db(), at(owner.id, artifactId, unpinAt))).toEqual({
      ok: true,
      value: { state: "active", expiresAt: unpinAt + 30 * DAY, purgeAt: null, pinned: false },
    });
    expect(await events(artifactId)).toContain("unpinned");
    await scheduleExpiryNotices(db(), unpinAt + 28 * DAY);
    expect((await artifactRow(artifactId))?.expiryNoticeFor).toBe(unpinAt + 30 * DAY);
    await archiveExpired(db(), unpinAt + 30 * DAY, 500);
    expect((await artifactRow(artifactId))?.state).toBe("archived");
  });

  it("works with no plan at all, so an owner can always undo a pin", async () => {
    const { owner, artifactId } = await pinnedSite();
    await db().delete(schema.ownerPlans).where(eq(schema.ownerPlans.ownerId, owner.id));
    expect(await unpinArtifact(db(), at(owner.id, artifactId))).toMatchObject({
      ok: true,
      value: { pinned: false, expiresAt: NOW + 30 * DAY },
    });
    // A retried unpin keeps the expiry it got.
    expect(await unpinArtifact(db(), at(owner.id, artifactId, NOW + DAY))).toMatchObject({
      ok: true,
      value: { pinned: false, expiresAt: NOW + 30 * DAY },
    });
  });
});

describe("the scan for plans that lost pin", () => {
  it("writes nothing for owners that still have the feature", async () => {
    const { artifactId } = await pinnedSite();
    const before = await artifactRow(artifactId);
    expect(await unpinLapsedPlans(db(), NOW + DAY)).toEqual({ processed: 0 });
    expect(await artifactRow(artifactId)).toEqual(before);
  });

  it("unpins when the plan expires, with 30 days from the scan, once", async () => {
    const { owner, artifactId } = await pinnedSite();
    const second = await publishSite(owner.id);
    value(await pinArtifact(db(), at(owner.id, second.artifactId)));
    await changePlan(owner.id, { validUntil: NOW + 10 * DAY });
    expect(await unpinLapsedPlans(db(), NOW + 5 * DAY)).toEqual({ processed: 0 });

    const scan = NOW + 10 * DAY;
    expect(await unpinLapsedPlans(db(), scan)).toEqual({ processed: 2 });
    for (const id of [artifactId, second.artifactId]) {
      expect(await artifactRow(id)).toMatchObject({
        state: "active",
        pinned: false,
        expiresAt: scan + 30 * DAY,
      });
      expect(await events(id)).toContain("unpinned");
    }
    // A second run finds nothing, and nothing was archived or deleted on the spot.
    expect(await unpinLapsedPlans(db(), scan + 1)).toEqual({ processed: 0 });
    await scheduleExpiryNotices(db(), scan + 28 * DAY);
    expect((await artifactRow(artifactId))?.expiryNoticeFor).toBe(scan + 30 * DAY);
  });

  it("unpins when the plan is removed or lowered, in batches of the limit", async () => {
    const { owner, artifactId } = await pinnedSite();
    const second = await publishSite(owner.id);
    value(await pinArtifact(db(), at(owner.id, second.artifactId)));
    await changePlan(owner.id, { overrides: { features: { pin: false } } });
    expect(await unpinLapsedPlans(db(), NOW, 1)).toEqual({ processed: 1 });
    expect(await unpinLapsedPlans(db(), NOW, 1)).toEqual({ processed: 1 });
    expect(await unpinLapsedPlans(db(), NOW, 1)).toEqual({ processed: 0 });
    for (const id of [artifactId, second.artifactId]) {
      expect((await artifactRow(id))?.pinned).toBe(false);
    }

    const other = await pinnedSite();
    await db().delete(schema.ownerPlans).where(eq(schema.ownerPlans.ownerId, other.owner.id));
    expect(await unpinLapsedPlans(db(), NOW)).toEqual({ processed: 1 });
    expect((await artifactRow(other.artifactId))?.pinned).toBe(false);
  });

  it("keeps the pins when a grant lands between its read and its write", async () => {
    const { owner, artifactId } = await pinnedSite();
    await changePlan(owner.id, { validUntil: NOW });
    const raced = racing(() => changePlan(owner.id, { validUntil: null, updatedAt: NOW + 7 }));
    expect(await unpinLapsedPlans(raced, NOW + DAY)).toEqual({ processed: 0 });
    expect(await artifactRow(artifactId)).toMatchObject({ pinned: true, expiresAt: null });
  });

  it("leaves suspended pinned artifacts until they are reinstated", async () => {
    const { owner, artifactId } = await pinnedSite();
    value(await suspendArtifact(db(), { artifactId, reason: "spam", now: NOW + 1 }));
    await changePlan(owner.id, { validUntil: NOW + 2 });
    expect(await unpinLapsedPlans(db(), NOW + 3)).toEqual({ processed: 0 });
    value(await reinstateArtifact(db(), { artifactId, now: NOW + 4 }));
    expect(await unpinLapsedPlans(db(), NOW + 5)).toEqual({ processed: 1 });
    expect(await artifactRow(artifactId)).toMatchObject({
      pinned: false,
      expiresAt: NOW + 5 + 30 * DAY,
    });
  });

  it("runs with the maintenance jobs", async () => {
    const { owner, artifactId } = await pinnedSite();
    await changePlan(owner.id, { validUntil: NOW });
    const result = await runMaintenance(db(), env.ARTIFACTS, NOW + DAY);
    expect(result.unpinned).toBeGreaterThanOrEqual(1);
    expect((await artifactRow(artifactId))?.pinned).toBe(false);
  });
});

describe("archive length by plan", () => {
  const months = (from: number, n: number) => {
    const date = new Date(from);
    date.setUTCMonth(date.getUTCMonth() + n);
    return date.getTime();
  };

  it("keeps a free owner's archive six months and a Pro owner's twelve", async () => {
    const free = await user();
    const freeSite = await publishSite(free.id);
    expect(
      value(await archiveArtifact(db(), at(free.id, freeSite.artifactId, NOW + DAY))).purgeAt,
    ).toBe(months(NOW + DAY, 6));

    const { owner, artifactId } = await proSite();
    expect(value(await archiveArtifact(db(), at(owner.id, artifactId, NOW + DAY))).purgeAt).toBe(
      months(NOW + DAY, 12),
    );
  });

  it("uses the plan's months in the archive scan, from the expiry", async () => {
    const { artifactId } = await proSite();
    const free = await user();
    const freeSite = await publishSite(free.id);
    await archiveExpired(db(), NOW + 31 * DAY, 500);
    expect((await artifactRow(artifactId))?.purgeAt).toBe(months(NOW + 30 * DAY, 12));
    expect((await artifactRow(freeSite.artifactId))?.purgeAt).toBe(months(NOW + 30 * DAY, 6));
  });

  it("never shortens a purge date when the plan is lowered later", async () => {
    const { owner, artifactId } = await proSite();
    value(await archiveArtifact(db(), at(owner.id, artifactId)));
    await changePlan(owner.id, { plan: "free" });
    // Seven months later is past a free archive but inside the twelve set when archived.
    const later = months(NOW, 7);
    expect((await artifactRow(artifactId))?.purgeAt).toBe(months(NOW, 12));
    expect(await restoreArtifact(db(), at(owner.id, artifactId, later))).toMatchObject({
      ok: true,
      value: { state: "active" },
    });
  });

  it("does not extend a purge date set on a lower plan", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    value(await archiveArtifact(db(), at(owner.id, artifactId)));
    await grantPlan(owner.id, "pro");
    expect((await artifactRow(artifactId))?.purgeAt).toBe(months(NOW, 6));
    expect(await restoreArtifact(db(), at(owner.id, artifactId, months(NOW, 7)))).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("uses the plan's months when a reinstated artifact goes back to the archive", async () => {
    const { owner, artifactId } = await pinnedSite();
    value(await suspendArtifact(db(), { artifactId, reason: "spam", now: NOW + 1 }));
    // No free active slot: the artifact goes to the archive instead, and loses its pin.
    await db()
      .update(schema.accountUsage)
      .set({ activeArtifacts: 500, activeLimit: 500 })
      .where(eq(schema.accountUsage.ownerId, owner.id));
    expect(await reinstateArtifact(db(), { artifactId, now: NOW + 2 })).toMatchObject({
      ok: true,
      value: { state: "archived" },
    });
    expect(await artifactRow(artifactId)).toMatchObject({
      state: "archived",
      pinned: false,
      purgeAt: months(NOW + 2, 12),
    });
  });
});

describe("pins in a workspace", () => {
  async function team() {
    const id = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
    const [admin, editor, member, outsider] = [
      await user(),
      await user(),
      await user(),
      await user(),
    ];
    await db()
      .insert(schema.workspaces)
      .values({ id, slug: id.slice(3, 23), name: "Team", createdBy: admin.id, updatedAt: NOW });
    await db()
      .insert(schema.workspaceMembers)
      .values([
        { workspaceId: id, userId: admin.id, role: "admin", updatedAt: NOW },
        { workspaceId: id, userId: editor.id, role: "editor", updatedAt: NOW },
        { workspaceId: id, userId: member.id, role: "member", updatedAt: NOW },
      ]);
    const body = `<p>${crypto.randomUUID()}</p>`;
    const prepared = value(
      await preparePublish(db(), {
        userId: editor.id,
        targetOwnerId: id,
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
    await env.ARTIFACTS.put(`objects/${id}/${await sha256(body)}`, body);
    const { artifactId } = value(
      await commitPublish(db(), env.ARTIFACTS, {
        userId: editor.id,
        sessionId: prepared.sessionId,
        now: NOW,
      }),
    );
    return { id, admin, editor, member, outsider, artifactId };
  }

  it("follows the workspace's plan and the caller's role", async () => {
    const t = await team();
    // The editor's own Pro plan does not reach a free workspace's artifact.
    await grantPlan(t.editor.id, "pro");
    expect(await pinArtifact(db(), at(t.editor.id, t.artifactId))).toMatchObject({
      code: "plan_required",
    });

    await grantPlan(t.id, "team");
    expect(await pinArtifact(db(), at(t.member.id, t.artifactId))).toMatchObject({
      code: "forbidden",
    });
    expect(await pinArtifact(db(), at(t.outsider.id, t.artifactId))).toEqual({
      ok: false,
      code: "not_found",
      message: "Artifact not found.",
    });
    expect(await pinArtifact(db(), at(t.editor.id, t.artifactId))).toMatchObject({
      ok: true,
      value: { pinned: true },
    });
    expect(await unpinArtifact(db(), at(t.member.id, t.artifactId))).toMatchObject({
      code: "forbidden",
    });
    expect(await unpinArtifact(db(), at(t.admin.id, t.artifactId))).toMatchObject({
      ok: true,
      value: { pinned: false },
    });

    // The workspace loses the feature: the scan unpins its artifacts, not the editor's.
    value(await pinArtifact(db(), at(t.admin.id, t.artifactId)));
    const mine = await pinnedSite();
    await changePlan(t.id, { plan: "free" });
    expect(await unpinLapsedPlans(db(), NOW + DAY)).toEqual({ processed: 1 });
    expect(
      await db()
        .select({ pinned: schema.artifacts.pinned })
        .from(schema.artifacts)
        .where(and(eq(schema.artifacts.id, mine.artifactId), eq(schema.artifacts.pinned, true))),
    ).toHaveLength(1);
    expect((await artifactRow(t.artifactId))?.pinned).toBe(false);
  });
});
