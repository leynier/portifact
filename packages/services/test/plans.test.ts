// Plans in the services (premium plan section 3, F1): an owner without a row is exactly today's
// free account, and an owner's plan row raises or lowers the limits the domain rules apply.
import { PLANS } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { fail, personalActor } from "@portifact/domain";
import { describe, expect, it } from "vitest";
import { authorizeOn } from "../src/actors.ts";
import { ownerEntitlements, planView, requireOwnerFeature } from "../src/plans.ts";
import { type ManifestEntry, preparePublish } from "../src/publish.ts";
import { getAccountUsage } from "../src/usage.ts";
import { DAY, db, grantPlan, NOW, user, value } from "./fixtures.ts";

/** A site of two 200 MB files: 400 MB, over free's 250 MB per version and under Pro's 2 GB. */
function bigSite(): ManifestEntry[] {
  return ["a.bin", "b.bin"].map((path, i) => ({
    path,
    kind: "published",
    sha256: String(i).repeat(64),
    size: 200_000_000,
    contentType: "application/octet-stream",
  }));
}

const prepare = (ownerId: string, files: ManifestEntry[], now = NOW) =>
  preparePublish(db(), {
    userId: ownerId,
    type: "site",
    name: "Large dataset",
    entrypoint: "a.bin",
    baseVersionId: null,
    files,
    now,
  });

describe("owner entitlements", () => {
  it("reads an owner without a row as free", async () => {
    const owner = await user();
    expect(await ownerEntitlements(db().global, owner.id, NOW)).toEqual({
      plan: "free",
      seats: 1,
      validUntil: null,
      limits: PLANS.free.limits,
      features: [],
      data: PLANS.free.data,
    });
  });

  it("reads the owner's row, its seats and overrides, and only that owner's", async () => {
    const owner = await user();
    const other = await user();
    await grantPlan(owner.id, "team", {
      seats: 2,
      overrides: { limits: { activeArtifacts: 3_000 }, features: { sso: true } },
    });
    const team = await ownerEntitlements(db().global, owner.id, NOW);
    expect(team).toMatchObject({ plan: "team", seats: 2 });
    expect(team.limits).toMatchObject({ activeArtifacts: 3_000, accountBytes: 60_000_000_000 });
    expect(team.features).toContain("sso");
    expect((await ownerEntitlements(db().global, other.id, NOW)).plan).toBe("free");
  });

  it("reads an expired row and invalid overrides safely", async () => {
    const owner = await user();
    await grantPlan(owner.id, "pro", { validUntil: NOW });
    expect((await ownerEntitlements(db().global, owner.id, NOW)).plan).toBe("free");
    expect((await ownerEntitlements(db().global, owner.id, NOW - 1)).plan).toBe("pro");
    await grantPlan(owner.id, "pro", { overrides: { limits: { activeArtifacts: -5 } } });
    expect((await ownerEntitlements(db().global, owner.id, NOW)).limits).toEqual(PLANS.pro.limits);
  });

  it("shows the plan with ISO dates", async () => {
    const owner = await user();
    await grantPlan(owner.id, "pro", { validUntil: Date.UTC(2027, 0, 1) });
    expect(planView(await ownerEntitlements(db().global, owner.id, NOW))).toEqual({
      name: "pro",
      validUntil: "2027-01-01T00:00:00.000Z",
      seats: 1,
      limits: PLANS.pro.limits,
      features: [...PLANS.pro.features],
      grace: null,
    });
  });
});

describe("publishing with a plan", () => {
  it("refuses a 400 MB version without a plan, with today's code and message", async () => {
    const owner = await user();
    expect(await prepare(owner.id, bigSite())).toEqual({
      ok: false,
      code: "quota_exceeded",
      message: "An artifact version can be at most 250 MB.",
    });
  });

  it("accepts it on Pro, and refuses it again once the plan expires", async () => {
    const owner = await user();
    await grantPlan(owner.id, "pro", { validUntil: NOW + DAY });
    const prepared = await prepare(owner.id, bigSite());
    expect(prepared.ok).toBe(true);
    expect(await prepare(owner.id, bigSite(), NOW + DAY)).toMatchObject({
      ok: false,
      code: "quota_exceeded",
    });
  });

  it("applies a plan's lower override with the plan's numbers in the message", async () => {
    const owner = await user();
    await grantPlan(owner.id, "enterprise", { overrides: { limits: { artifactBytes: 1_000 } } });
    expect(
      await prepare(owner.id, [
        {
          path: "a.bin",
          kind: "published",
          sha256: "c".repeat(64),
          size: 1_001,
          contentType: "text/plain",
        },
      ]),
    ).toEqual({
      ok: false,
      code: "quota_exceeded",
      message: "An artifact version can be at most 1000 bytes.",
    });
  });
});

describe("usage with a plan", () => {
  it("reports free and today's limits without a row", async () => {
    const owner = await user();
    const report = value(await getAccountUsage(db(), { actor: personalActor(owner.id), now: NOW }));
    expect(report.plan.plan).toBe("free");
    expect(report.activeArtifacts.limit).toBe(50);
    expect(report.storage.limit).toBe(2_500_000_000);
    expect(report.trafficThisMonth.requests.limit).toBe(1_000_000);
    expect(report.trafficThisMonth.bytes.limit).toBe(25_000_000_000);
    expect(report.versionLimits.publishedBytes).toBe(250_000_000);
  });

  it("reports the owner's plan limits, never another account's", async () => {
    const owner = await user();
    const other = await user();
    await grantPlan(owner.id, "pro");
    const pro = value(await getAccountUsage(db(), { actor: personalActor(owner.id), now: NOW }));
    expect(pro.plan.plan).toBe("pro");
    expect(pro.activeArtifacts.limit).toBe(500);
    expect(pro.storage.limit).toBe(25_000_000_000);
    expect(pro.trafficThisMonth.requests.limit).toBe(2_000_000);
    expect(pro.trafficThisMonth.bytes.limit).toBe(250_000_000_000);
    expect(pro.versionLimits.publishedBytes).toBe(2_000_000_000);
    expect(
      value(await getAccountUsage(db(), { actor: personalActor(other.id), now: NOW })).plan.plan,
    ).toBe("free");
  });
});

describe("requireOwnerFeature", () => {
  it("refuses a free owner with plan_required and gives a paid owner its entitlements", async () => {
    const owner = await user();
    expect(await requireOwnerFeature(db().global, { ownerId: owner.id }, "pin", NOW)).toEqual({
      ok: false,
      code: "plan_required",
      message: "Pinning artifacts is part of the Pro plan.",
    });
    await grantPlan(owner.id, "pro");
    const granted = await requireOwnerFeature(db().global, { ownerId: owner.id }, "pin", NOW);
    expect(granted).toEqual({
      ok: true,
      value: await ownerEntitlements(db().global, owner.id, NOW),
    });
    expect(
      await requireOwnerFeature(db().global, { ownerId: owner.id }, "workspaces", NOW),
    ).toEqual({
      ok: false,
      code: "plan_required",
      message: "Using workspaces is part of the Team plan.",
    });
  });

  it("reads an expired plan as free", async () => {
    const owner = await user();
    await grantPlan(owner.id, "pro", { validUntil: NOW });
    expect((await requireOwnerFeature(db().global, { ownerId: owner.id }, "pin", NOW)).ok).toBe(
      false,
    );
    expect((await requireOwnerFeature(db().global, { ownerId: owner.id }, "pin", NOW - 1)).ok).toBe(
      true,
    );
  });

  it("uses the artifact owner's plan, not the acting user's", async () => {
    const [admin, editor] = [await user(), await user()];
    const workspaceId = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
    await db()
      .insert(schema.workspaces)
      .values({
        id: workspaceId,
        slug: workspaceId.slice(3, 23),
        name: "Team",
        createdBy: admin.id,
        updatedAt: NOW,
      });
    await db()
      .insert(schema.workspaceMembers)
      .values([
        { workspaceId, userId: admin.id, role: "admin", updatedAt: NOW },
        { workspaceId, userId: editor.id, role: "editor", updatedAt: NOW },
      ]);
    await grantPlan(workspaceId, "team");
    const missing = () => fail("not_found", "Artifact not found.");
    const actor = value(await authorizeOn(db(), editor.id, workspaceId, "manage", missing));

    // The editor's own space is free, yet acting on the Team workspace the feature is there.
    expect((await requireOwnerFeature(db().global, actor, "workspaces", NOW)).ok).toBe(true);
    expect(
      (await requireOwnerFeature(db().global, { ownerId: editor.id }, "workspaces", NOW)).ok,
    ).toBe(false);

    // And the other way: a Pro user acting on a free workspace does not bring their plan along.
    await grantPlan(editor.id, "pro");
    await grantPlan(workspaceId, "free");
    expect(await requireOwnerFeature(db().global, actor, "pin", NOW)).toEqual({
      ok: false,
      code: "plan_required",
      message: "Pinning artifacts is part of the Pro plan.",
    });
    expect((await requireOwnerFeature(db().global, personalActor(editor.id), "pin", NOW)).ok).toBe(
      true,
    );
  });
});
