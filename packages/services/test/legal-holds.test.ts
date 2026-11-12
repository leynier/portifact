// Legal holds (docs/operations.md, "Legal holds"): every way an artifact can be deleted, moved,
// pruned, brought back into service or read is tried on a held one, and each must leave it as it
// was until the hold is released; then the deletions that waited go on.
import { env } from "cloudflare:test";
import type { JobMessage } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { HELD_MESSAGE } from "@portifact/domain";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  advanceAccountDeletion,
  processAccountDeletions,
  requestAccountDeletion,
} from "../src/account-data.ts";
import { applyTombstones } from "../src/backups.ts";
import {
  applyLegalHolds,
  exportLegalHolds,
  isHeld,
  listLegalHolds,
  placeLegalHold,
  releaseDueHolds,
  releaseLegalHold,
} from "../src/legal-holds.ts";
import { deleteArtifact } from "../src/lifecycle.ts";
import { archiveExpired, pruneVersions, purgeArchived } from "../src/maintenance.ts";
import {
  reinstateAccount,
  reinstateArtifact,
  suspendAccount,
  suspendArtifact,
} from "../src/moderation.ts";
import { runJob } from "../src/outbox.ts";
import { transferArtifact } from "../src/transfer.ts";
import { compareVersions } from "../src/version-diff.ts";
import { getVersionDownload } from "../src/versions.ts";
import { advanceWorkspaceDeletion, createWorkspace, deleteWorkspace } from "../src/workspaces.ts";
import { artifactRow, DAY, db, NOW, publishSite, session, user, value } from "./fixtures.ts";

const regions = () => regionsFromEnv(env);

async function heldArtifact(ownerId: string, publishedAt = NOW) {
  const published = await publishSite(ownerId, undefined, publishedAt);
  value(
    await suspendArtifact(db(), {
      artifactId: published.artifactId,
      reason: "child_safety",
      now: NOW,
    }),
  );
  const hold = value(
    await placeLegalHold(db(), {
      artifactId: published.artifactId,
      ground: "Preservation request of an authority, case 123",
      releaseAt: null,
      now: NOW,
    }),
  );
  return { ...published, hold: hold.hold };
}

/** Runs every purge job in the outbox until none is left. */
async function drainPurges(now: number) {
  for (let round = 0; round < 5; round += 1) {
    const rows = await db()
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.topic, "purge_artifact"));
    if (rows.length === 0) return;
    for (const row of rows) {
      await runJob(db(), env.ARTIFACTS, { id: row.id, topic: row.topic } as JobMessage, now, {
        access: regions().get("default").accessDb,
      });
    }
  }
}

describe("placing a hold", () => {
  it("holds only a suspended artifact, once, and records the owner's address", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    const refused = await placeLegalHold(db(), {
      artifactId,
      ground: "Authority request",
      releaseAt: null,
      now: NOW,
    });
    expect(refused).toMatchObject({ ok: false, code: "invalid_input" });
    value(await suspendArtifact(db(), { artifactId, reason: "child_safety", now: NOW }));
    expect(
      await placeLegalHold(db(), { artifactId, ground: "x", releaseAt: NOW, now: NOW }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    expect(
      await placeLegalHold(db(), { artifactId, ground: "  ", releaseAt: null, now: NOW }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    const placed = value(
      await placeLegalHold(db(), {
        artifactId,
        ground: "Authority request",
        releaseAt: null,
        now: NOW,
      }),
    );
    expect(placed.changed).toBe(true);
    expect(placed.hold).toMatchObject({
      ownerId: owner.id,
      ownerEmail: owner.email,
      reason: "child_safety",
    });
    const again = value(
      await placeLegalHold(db(), { artifactId, ground: "Another", releaseAt: null, now: NOW + 1 }),
    );
    expect(again).toMatchObject({ changed: false, hold: { id: placed.hold.id } });
    expect(await isHeld(db(), artifactId)).toBe(true);
    expect(
      await placeLegalHold(db(), {
        artifactId: "zzzzzzzzzz",
        ground: "x",
        releaseAt: null,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
  });

  it("lists open holds, and released ones with --all, and releases at the release date", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    value(await suspendArtifact(db(), { artifactId, reason: "malware", now: NOW }));
    value(
      await placeLegalHold(db(), {
        artifactId,
        ground: "Until a date",
        releaseAt: NOW + DAY,
        now: NOW,
      }),
    );
    expect(
      (await listLegalHolds(db(), { all: false, limit: 500 })).map((h) => h.artifactId),
    ).toContain(artifactId);
    expect(await releaseDueHolds(db(), NOW + DAY - 1)).toBeGreaterThanOrEqual(0);
    expect(await isHeld(db(), artifactId)).toBe(true);
    await releaseDueHolds(db(), NOW + DAY);
    expect(await isHeld(db(), artifactId)).toBe(false);
    const all = await listLegalHolds(db(), { all: true, limit: 500 });
    expect(all.find((h) => h.artifactId === artifactId)).toMatchObject({
      releasedAt: NOW + DAY,
      ownerEmail: null,
    });
    expect(
      (await listLegalHolds(db(), { all: false, limit: 500 })).some(
        (h) => h.artifactId === artifactId,
      ),
    ).toBe(false);
  });
});

describe("while an artifact is held", () => {
  it("refuses the owner's deletion without saying why, and allows it after the release", async () => {
    const owner = await user();
    const { artifactId } = await heldArtifact(owner.id);
    const refused = await deleteArtifact(db(), env.ARTIFACTS, {
      userId: owner.id,
      artifactId,
      now: NOW,
    });
    expect(refused).toEqual({ ok: false, code: "forbidden", message: HELD_MESSAGE });
    expect(HELD_MESSAGE).not.toMatch(/hold|legal|authorit/i);
    expect(await artifactRow(artifactId)).toMatchObject({ state: "suspended" });
    expect(await releaseLegalHold(db(), { artifactId, now: NOW + 1 })).toEqual({ released: true });
    expect(await releaseLegalHold(db(), { artifactId, now: NOW + 1 })).toEqual({ released: false });
    expect(
      (await deleteArtifact(db(), env.ARTIFACTS, { userId: owner.id, artifactId, now: NOW + 2 }))
        .ok,
    ).toBe(true);
  });

  it("serves its content to nobody, its owner included", async () => {
    const owner = await user();
    const { artifactId, versionId } = await heldArtifact(owner.id);
    expect(
      await getVersionDownload(db(), {
        userId: owner.id,
        artifactId,
        versionId,
        kind: "published",
        now: NOW,
      }),
    ).toEqual({ ok: false, code: "forbidden", message: HELD_MESSAGE });
    expect(
      await compareVersions(db(), {
        userId: owner.id,
        artifactId,
        fromVersionId: versionId,
        toVersionId: versionId,
        limit: 10,
        now: NOW,
      }),
    ).toEqual({ ok: false, code: "forbidden", message: HELD_MESSAGE });
    // A suspended artifact that is not held still downloads for its owner.
    const other = await publishSite(owner.id);
    value(await suspendArtifact(db(), { artifactId: other.artifactId, reason: "spam", now: NOW }));
    expect(
      (
        await getVersionDownload(db(), {
          userId: owner.id,
          artifactId: other.artifactId,
          versionId: other.versionId,
          kind: "published",
          now: NOW,
        })
      ).ok,
    ).toBe(true);
  });

  it("is not reinstated, alone or with its account, until released", async () => {
    const owner = await user();
    const { artifactId } = await heldArtifact(owner.id);
    expect(await reinstateArtifact(db(), { artifactId, now: NOW + 1 })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    const other = await publishSite(owner.id);
    value(await suspendAccount(db(), { userId: owner.id, reason: "spam", now: NOW + 2 }));
    const back = value(await reinstateAccount(db(), { userId: owner.id, now: NOW + 3 }));
    expect(back).toMatchObject({ artifacts: 1, held: 0 });
    expect(await artifactRow(other.artifactId)).toMatchObject({ state: "active" });
    expect(await artifactRow(artifactId)).toMatchObject({ state: "suspended" });
    await releaseLegalHold(db(), { artifactId, now: NOW + 4 });
    expect(value(await reinstateArtifact(db(), { artifactId, now: NOW + 5 }))).toMatchObject({
      changed: true,
    });
  });

  it("keeps a held child of an account suspension suspended when the account comes back", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    value(await suspendAccount(db(), { userId: owner.id, reason: "child_safety", now: NOW }));
    value(
      await placeLegalHold(db(), { artifactId, ground: "Authority", releaseAt: null, now: NOW }),
    );
    const back = value(await reinstateAccount(db(), { userId: owner.id, now: NOW + 1 }));
    expect(back).toEqual({ artifacts: 0, changed: true, held: 1 });
    expect(await artifactRow(artifactId)).toMatchObject({ state: "suspended" });
  });

  it("is not moved to another space", async () => {
    const owner = await user();
    const { artifactId } = await heldArtifact(owner.id);
    const slug = `h-${crypto.randomUUID().slice(0, 8)}`;
    value(
      await createWorkspace(db().global, {
        slug,
        name: "Elsewhere",
        adminUserId: owner.id,
        now: NOW,
      }),
    );
    const moved = await transferArtifact(db(), env.ARTIFACTS, {
      userId: owner.id,
      artifactId,
      workspace: slug,
      now: NOW,
    });
    expect(moved.ok).toBe(false);
    expect(await artifactRow(artifactId)).toMatchObject({ ownerId: owner.id });
  });

  it("is never archived, purged or pruned by maintenance", async () => {
    const owner = await user();
    const first = await publishSite(owner.id, undefined, NOW - 200 * DAY);
    await publishSite(owner.id, { "index.html": "<p>second</p>" }, NOW - 199 * DAY, first);
    value(
      await suspendArtifact(db(), { artifactId: first.artifactId, reason: "malware", now: NOW }),
    );
    value(
      await placeLegalHold(db(), {
        artifactId: first.artifactId,
        ground: "Authority",
        releaseAt: null,
        now: NOW,
      }),
    );
    await archiveExpired(db(), NOW + 400 * DAY);
    await purgeArchived(db(), env.ARTIFACTS, NOW + 400 * DAY);
    await pruneVersions(db(), env.ARTIFACTS, NOW + 400 * DAY, 500);
    expect(await artifactRow(first.artifactId)).toMatchObject({ state: "suspended" });
    const [kept] = await db()
      .select({ id: schema.versions.id })
      .from(schema.versions)
      .where(eq(schema.versions.id, first.versionId));
    expect(kept?.id).toBe(first.versionId);
    // Released, the old version is pruned again.
    await releaseLegalHold(db(), { artifactId: first.artifactId, now: NOW + 400 * DAY });
    await pruneVersions(db(), env.ARTIFACTS, NOW + 400 * DAY, 500);
    const [gone] = await db()
      .select({ id: schema.versions.id })
      .from(schema.versions)
      .where(eq(schema.versions.id, first.versionId));
    expect(gone).toBeUndefined();
  });

  it("is protected by the database even from a path the services miss", async () => {
    const owner = await user();
    const { artifactId, versionId } = await heldArtifact(owner.id);
    const a = schema.artifacts;
    await expect(
      db().update(a).set({ state: "purging" }).where(eq(a.id, artifactId)),
    ).rejects.toThrow();
    await expect(
      db().update(a).set({ ownerId: "someone" }).where(eq(a.id, artifactId)),
    ).rejects.toThrow();
    await expect(db().delete(a).where(eq(a.id, artifactId))).rejects.toThrow();
    await expect(
      db().delete(schema.versions).where(eq(schema.versions.id, versionId)),
    ).rejects.toThrow();
    // An artifact that is not suspended cannot be held at all.
    const served = await publishSite(owner.id);
    await expect(
      db().run(
        sql`insert into legal_holds (id, artifact_id, owner_id, reason, ground) values ('hold_x', ${served.artifactId}, ${owner.id}, 'spam', 'x')`,
      ),
    ).rejects.toThrow();
    expect(await artifactRow(artifactId)).toMatchObject({ state: "suspended", ownerId: owner.id });
  });
});

describe("deleting an account or a workspace with a held artifact", () => {
  it("deletes the account at once but keeps the held artifact until the release, then finishes", async () => {
    const owner = await user();
    const held = await heldArtifact(owner.id);
    const other = await publishSite(owner.id);
    const sessionId = await session(owner.id);
    value(
      await requestAccountDeletion(regions(), {
        userId: owner.id,
        sessionId,
        confirmEmail: owner.email,
        now: NOW,
      }),
    );
    // The person's account, sessions and other content go as usual.
    const [account] = await db()
      .global.select()
      .from(schema.users)
      .where(eq(schema.users.id, owner.id));
    expect(account).toBeUndefined();
    expect(await artifactRow(other.artifactId)).toMatchObject({ state: "purging" });
    expect(await artifactRow(held.artifactId)).toMatchObject({ state: "suspended" });
    await drainPurges(NOW);
    expect(await advanceAccountDeletion(regions(), owner.id, NOW + 1)).toBe("pending");
    expect(await artifactRow(held.artifactId)).toMatchObject({ state: "suspended" });

    await releaseLegalHold(db(), { artifactId: held.artifactId, now: NOW + 2 });
    expect(await advanceAccountDeletion(regions(), owner.id, NOW + 3)).toBe("pending");
    expect(await artifactRow(held.artifactId)).toMatchObject({ state: "purging" });
    await drainPurges(NOW + 3);
    let state = await advanceAccountDeletion(regions(), owner.id, NOW + 4);
    for (let i = 0; i < 3 && state !== "finished"; i += 1) {
      await drainPurges(NOW + 4);
      state = await advanceAccountDeletion(regions(), owner.id, NOW + 5);
    }
    expect(state).toBe("finished");
  });

  it("tries a waiting deletion last, so it never stops the others", async () => {
    const waiting = await user();
    await heldArtifact(waiting.id);
    value(
      await requestAccountDeletion(regions(), {
        userId: waiting.id,
        sessionId: await session(waiting.id),
        confirmEmail: waiting.email,
        now: NOW - 10 * DAY,
      }),
    );
    await processAccountDeletions(regions(), NOW + 10, 500);
    const d = schema.accountDeletions;
    const [tried] = await db().global.select().from(d).where(eq(d.userId, waiting.id));
    expect(tried?.attemptedAt).toBe(NOW + 10);
    const next = await user();
    value(
      await requestAccountDeletion(regions(), {
        userId: next.id,
        sessionId: await session(next.id),
        confirmEmail: next.email,
        now: NOW + 1,
      }),
    );
    const before = await db().global.select().from(d);
    const order = before
      .map((row) => ({ id: row.userId, at: row.attemptedAt ?? row.requestedAt }))
      .sort((x, y) => x.at - y.at || x.id.localeCompare(y.id));
    expect(order.findIndex((row) => row.id === next.id)).toBeLessThan(
      order.findIndex((row) => row.id === waiting.id),
    );
  });

  it("keeps a workspace's held artifact through its deletion until the release", async () => {
    const admin = await user();
    const slug = `w-${crypto.randomUUID().slice(0, 8)}`;
    const ws = value(
      await createWorkspace(db().global, { slug, name: "Held", adminUserId: admin.id, now: NOW }),
    );
    const published = await publishSite(admin.id);
    value(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: admin.id,
        artifactId: published.artifactId,
        workspace: slug,
        now: NOW,
      }),
    );
    value(
      await suspendArtifact(db(), {
        artifactId: published.artifactId,
        reason: "child_safety",
        now: NOW,
      }),
    );
    value(
      await placeLegalHold(db(), {
        artifactId: published.artifactId,
        ground: "Authority",
        releaseAt: null,
        now: NOW,
      }),
    );
    value(await deleteWorkspace(regions(), { workspaceId: ws.id, now: NOW }));
    expect(await artifactRow(published.artifactId)).toMatchObject({
      state: "suspended",
      ownerId: ws.id,
    });
    expect(await advanceWorkspaceDeletion(regions(), ws.id, NOW + 1)).toBe("pending");
    expect(await artifactRow(published.artifactId)).toMatchObject({ state: "suspended" });
    await releaseLegalHold(db(), { artifactId: published.artifactId, now: NOW + 2 });
    await advanceWorkspaceDeletion(regions(), ws.id, NOW + 3);
    expect(await artifactRow(published.artifactId)).toMatchObject({ state: "purging" });
  });
});

describe("a restore", () => {
  it("puts holds back before tombstones, suspends a held artifact the restore served, and keeps a release", async () => {
    const owner = await user();
    const held = await heldArtifact(owner.id);
    const released = await heldArtifact(owner.id);
    await releaseLegalHold(db(), { artifactId: released.artifactId, now: NOW + 1 });
    const lines = (await exportLegalHolds(regions())).filter((line) =>
      [held.artifactId, released.artifactId].includes(line.legalHold.artifactId),
    );
    expect(lines).toHaveLength(2);

    // The restore rewinds to before the hold and the suspension, and before the release.
    const h = schema.legalHolds;
    await db().delete(h).where(eq(h.artifactId, held.artifactId));
    await db().update(h).set({ releasedAt: null }).where(eq(h.artifactId, released.artifactId));
    await db()
      .update(schema.suspensions)
      .set({ liftedAt: NOW })
      .where(eq(schema.suspensions.targetId, held.artifactId));
    await db()
      .update(schema.artifacts)
      .set({ state: "active", suspensionReason: null })
      .where(eq(schema.artifacts.id, held.artifactId));

    const result = await applyLegalHolds(regions(), lines, NOW + 2);
    expect(result).toMatchObject({ restored: 2, suspended: 1, missing: [] });
    expect(await isHeld(db(), held.artifactId)).toBe(true);
    expect(await artifactRow(held.artifactId)).toMatchObject({ state: "suspended" });
    expect(await isHeld(db(), released.artifactId)).toBe(false);
    // Running it again changes nothing.
    expect(await applyLegalHolds(regions(), lines, NOW + 3)).toMatchObject({
      restored: 0,
      suspended: 0,
    });

    // A re-applied account deletion leaves the held artifact alone.
    await applyTombstones(regions(), [{ kind: "account", id: owner.id, deletedAt: NOW }], NOW + 4);
    expect(await artifactRow(held.artifactId)).toMatchObject({ state: "suspended" });
    expect(await artifactRow(released.artifactId)).toMatchObject({ state: "purging" });
  });

  it("reopens a hold the file has open, and reports one whose artifact is being purged", async () => {
    const owner = await user();
    const held = await heldArtifact(owner.id);
    const [line] = (await exportLegalHolds(regions())).filter(
      (l) => l.legalHold.artifactId === held.artifactId,
    );
    if (!line) throw new Error("no line");
    await releaseLegalHold(db(), { artifactId: held.artifactId, now: NOW + 1 });
    expect(await applyLegalHolds(regions(), [line], NOW + 2)).toMatchObject({ restored: 1 });
    expect(await isHeld(db(), held.artifactId)).toBe(true);

    const gone = await publishSite(owner.id);
    await db()
      .update(schema.artifacts)
      .set({ state: "purging" })
      .where(eq(schema.artifacts.id, gone.artifactId));
    const result = await applyLegalHolds(
      regions(),
      [
        {
          legalHold: {
            ...line.legalHold,
            id: `hold_${"1".repeat(32)}`,
            artifactId: gone.artifactId,
          },
        },
      ],
      NOW,
    );
    expect(result.missing).toEqual([gone.artifactId]);
    expect(
      await placeLegalHold(db(), {
        artifactId: held.artifactId,
        ground: "x".repeat(501),
        releaseAt: null,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("reports a held artifact the restore cannot bring back", async () => {
    const result = await applyLegalHolds(
      regions(),
      [
        {
          legalHold: {
            id: `hold_${"0".repeat(32)}`,
            artifactId: "zzzzzzzzzz",
            ownerId: "u_gone",
            ownerEmail: null,
            reason: "spam",
            ground: "Authority",
            createdAt: NOW,
            releaseAt: null,
            releasedAt: null,
          },
        },
      ],
      NOW,
    );
    expect(result.missing).toEqual(["zzzzzzzzzz"]);
  });
});
