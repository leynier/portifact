// Previous versions kept by the owner's plan (premium plan P3): two for seven days on free, as
// the privacy page says, 50 for 90 days on Pro and 100 for a year on Team, read when versions are
// listed, read, rolled back to or pruned. A lower plan prunes down to its own values on the next
// scan; retained versions count in the owner's storage until they are pruned.

import { env } from "cloudflare:test";
import { schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { pruneVersions } from "../src/maintenance.ts";
import { getVersionManifest, listVersions, rollbackArtifact } from "../src/versions.ts";
import { DAY, db, grantPlan, NOW, user, value } from "./fixtures.ts";
import { raceBeforeStatement } from "./race.ts";
import { storedBytes, versionRows, versions, workspace } from "./version-support.ts";

const HOUR = 3_600_000;

async function listed(userId: string, artifactId: string, now: number) {
  return value(await listVersions(db(), { userId, artifactId, now, limit: 100 }));
}

const numbers = (page: { items: { number: number }[] }) => page.items.map((item) => item.number);

describe("retention on free", () => {
  it("keeps the current version and the two newest previous ones, each for seven days", async () => {
    const owner = await user();
    const v = await versions(owner.id, 4);
    const artifactId = (v[0] as { artifactId: string }).artifactId;
    const last = NOW + 3 * HOUR;
    const page = await listed(owner.id, artifactId, last);
    expect(numbers(page)).toEqual([4, 3, 2]);
    expect(page.retention).toEqual({ previousVersions: 2, days: 7 });
    expect(page.versionDiff).toBe(false);
    // v3 was replaced when v4 was published; it is kept seven days from then.
    expect(page.items[1]?.expiresAt).toBe(last + 7 * DAY);
    expect(page.items[0]?.expiresAt).toBeNull();
    // v1 is no longer retained, even before the scan removes it.
    expect(
      await getVersionManifest(db(), {
        userId: owner.id,
        artifactId,
        versionId: (v[0] as { versionId: string }).versionId,
        now: last,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });

    const before = await storedBytes(owner.id);
    expect(await pruneVersions(db(), env.ARTIFACTS, last)).toMatchObject({ processed: 1 });
    expect(await versionRows(artifactId)).toEqual([2, 3, 4]);
    // The pruned version's own object is released from storage.
    expect(await storedBytes(owner.id)).toBeLessThan(before);
    // In line: the next scan does nothing.
    expect(await pruneVersions(db(), env.ARTIFACTS, last)).toEqual({ processed: 0 });

    // Seven days after v3 was replaced, only the current version is left.
    expect(numbers(await listed(owner.id, artifactId, last + 7 * DAY))).toEqual([4]);
    expect(numbers(await listed(owner.id, artifactId, last + 7 * DAY - 1))).toEqual([4, 3]);
    await pruneVersions(db(), env.ARTIFACTS, last + 7 * DAY);
    expect(await versionRows(artifactId)).toEqual([4]);
  });

  it("prunes in small batches of at most the limit", async () => {
    const owner = await user();
    const v = await versions(owner.id, 5);
    const artifactId = (v[0] as { artifactId: string }).artifactId;
    const at = NOW + 4 * HOUR + 8 * DAY;
    expect(await pruneVersions(db(), env.ARTIFACTS, at, 2)).toEqual({ processed: 2 });
    expect(await pruneVersions(db(), env.ARTIFACTS, at, 2)).toEqual({ processed: 2 });
    expect(await versionRows(artifactId)).toEqual([5]);
  });
});

describe("retention on paid plans", () => {
  it("keeps 50 previous versions for 90 days on Pro", async () => {
    const owner = await user();
    await grantPlan(owner.id, "pro");
    const v = await versions(owner.id, 5);
    const artifactId = (v[0] as { artifactId: string }).artifactId;
    const last = NOW + 4 * HOUR;
    const page = await listed(owner.id, artifactId, last + 60 * DAY);
    expect(numbers(page)).toEqual([5, 4, 3, 2, 1]);
    expect(page.retention).toEqual({ previousVersions: 50, days: 90 });
    expect(page.versionDiff).toBe(true);
    expect(page.items[1]?.expiresAt).toBe(last + 90 * DAY);
    expect(await pruneVersions(db(), env.ARTIFACTS, last + 60 * DAY)).toEqual({ processed: 0 });
    expect(await versionRows(artifactId)).toEqual([1, 2, 3, 4, 5]);
    // v1 was replaced first, at NOW + 1 hour: its 90 days end first.
    expect(numbers(await listed(owner.id, artifactId, NOW + HOUR + 90 * DAY))).toEqual([
      5, 4, 3, 2,
    ]);
  });

  it("keeps 100 previous versions for a year on Team", async () => {
    const owner = await user();
    await grantPlan(owner.id, "team");
    const v = await versions(owner.id, 3);
    const artifactId = (v[0] as { artifactId: string }).artifactId;
    const page = await listed(owner.id, artifactId, NOW + 300 * DAY);
    expect(page.retention).toEqual({ previousVersions: 100, days: 365 });
    expect(numbers(page)).toEqual([3, 2, 1]);
  });

  it("rolls back to a version weeks old, which free would have pruned, and counts it in storage", async () => {
    const owner = await user();
    await grantPlan(owner.id, "pro");
    const v = await versions(owner.id, 4);
    const [first, , , current] = v as [(typeof v)[0], unknown, unknown, (typeof v)[0]];
    const bytes = await storedBytes(owner.id);
    const later = NOW + 30 * DAY;
    const rolled = value(
      await rollbackArtifact(db(), {
        userId: owner.id,
        artifactId: first.artifactId,
        versionId: first.versionId,
        baseVersionId: current.versionId,
        now: later,
      }),
    );
    expect(rolled.fromVersionNumber).toBe(1);
    // Nothing was uploaded: the retained versions were already counted.
    expect(await storedBytes(owner.id)).toBe(bytes);
    expect(numbers(await listed(owner.id, first.artifactId, later))).toEqual([5, 4, 3, 2, 1]);
  });

  it("follows a workspace's plan for a workspace artifact, not the editor's", async () => {
    const team = await workspace(() => user());
    await grantPlan(team.editor.id, "enterprise");
    const v = await versions(team.editor.id, 4, { ownerId: team.id });
    const artifactId = (v[0] as { artifactId: string }).artifactId;
    const last = NOW + 3 * HOUR;
    expect(numbers(await listed(team.editor.id, artifactId, last))).toEqual([4, 3, 2]);
    await grantPlan(team.id, "team");
    expect(numbers(await listed(team.editor.id, artifactId, last))).toEqual([4, 3, 2, 1]);
    // A member cannot read the history; someone outside gets a missing artifact.
    expect(
      await listVersions(db(), { userId: team.member.id, artifactId, now: last, limit: 10 }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(
      await listVersions(db(), { userId: team.outsider.id, artifactId, now: last, limit: 10 }),
    ).toEqual({ ok: false, code: "not_found", message: "Artifact not found." });
  });
});

describe("plan changes", () => {
  it("lengthens retention for versions not pruned yet when the plan grows", async () => {
    const owner = await user();
    const v = await versions(owner.id, 3);
    const artifactId = (v[0] as { artifactId: string }).artifactId;
    const at = NOW + 2 * HOUR + 5 * DAY;
    await grantPlan(owner.id, "pro");
    expect(numbers(await listed(owner.id, artifactId, at + 10 * DAY))).toEqual([3, 2, 1]);
  });

  it("prunes down to the free values after a downgrade, deleting nothing else", async () => {
    const owner = await user();
    await grantPlan(owner.id, "pro");
    const v = await versions(owner.id, 5);
    const artifactId = (v[0] as { artifactId: string }).artifactId;
    const at = NOW + 4 * HOUR + DAY;
    expect(await pruneVersions(db(), env.ARTIFACTS, at)).toEqual({ processed: 0 });
    const before = await storedBytes(owner.id);
    await db()
      .update(schema.ownerPlans)
      .set({ plan: "free", updatedAt: at })
      .where(eq(schema.ownerPlans.ownerId, owner.id));
    expect(numbers(await listed(owner.id, artifactId, at))).toEqual([5, 4, 3]);
    expect(await pruneVersions(db(), env.ARTIFACTS, at)).toEqual({ processed: 2 });
    expect(await versionRows(artifactId)).toEqual([3, 4, 5]);
    expect(await storedBytes(owner.id)).toBeLessThan(before);
    expect(await pruneVersions(db(), env.ARTIFACTS, at)).toEqual({ processed: 0 });
  });

  it("prunes by the free values once the plan expires, and after the row is removed", async () => {
    const expiring = await user();
    await grantPlan(expiring.id, "pro", { validUntil: NOW + 2 * DAY });
    const a = await versions(expiring.id, 4);
    const removed = await user();
    await grantPlan(removed.id, "pro");
    const b = await versions(removed.id, 4);
    const at = NOW + DAY;
    expect(await pruneVersions(db(), env.ARTIFACTS, at)).toEqual({ processed: 0 });
    await db().delete(schema.ownerPlans).where(eq(schema.ownerPlans.ownerId, removed.id));
    expect(await pruneVersions(db(), env.ARTIFACTS, at)).toEqual({ processed: 1 });
    expect(await versionRows((b[0] as { artifactId: string }).artifactId)).toEqual([2, 3, 4]);
    expect(await versionRows((a[0] as { artifactId: string }).artifactId)).toEqual([1, 2, 3, 4]);
    expect(await pruneVersions(db(), env.ARTIFACTS, NOW + 3 * DAY)).toEqual({ processed: 1 });
    expect(await versionRows((a[0] as { artifactId: string }).artifactId)).toEqual([2, 3, 4]);
  });

  it("does not prune with stale values when the plan changes after the scan read it", async () => {
    const owner = await user();
    await grantPlan(owner.id, "pro", { overrides: { limits: { retainedPreviousVersions: 1 } } });
    const v = await versions(owner.id, 3);
    const artifactId = (v[0] as { artifactId: string }).artifactId;
    // The plan grows between the scan's read of the row and its delete.
    const raced = raceBeforeStatement(/^delete from "versions"/i, async () => {
      await db()
        .global.update(schema.ownerPlans)
        .set({ overrides: null, updatedAt: NOW + 5 })
        .where(eq(schema.ownerPlans.ownerId, owner.id));
    });
    expect(await pruneVersions(raced, env.ARTIFACTS, NOW + 2 * HOUR)).toEqual({ processed: 0 });
    expect(await versionRows(artifactId)).toEqual([1, 2, 3]);
  });
});
