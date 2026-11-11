// The plan scans read a bounded number of pages per run and resume where the last run stopped,
// wrapping around (decision 0005, "Second delivery"), so a run's D1 calls never grow with the
// number of owners and nobody at the end of the list is starved. One database here; the EU
// variants are in two-regions.test.ts.
import { env } from "cloudflare:test";
import { schema } from "@portifact/db";
import { entitlements } from "@portifact/domain";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { pruneVersions } from "../src/maintenance.ts";
import { alignPlanLimits, unpinLapsedPlans } from "../src/plans.ts";
import { DAY, db, grantPlan, NOW, publishSite, user } from "./fixtures.ts";
import { recording } from "./recording.ts";

const CAPS = { pageSize: 2, maxPages: 1 };

async function cursor(name: string) {
  const [row] = await db()
    .select({ cursor: schema.maintenanceCursors.cursor })
    .from(schema.maintenanceCursors)
    .where(eq(schema.maintenanceCursors.name, name));
  return row?.cursor ?? "";
}

describe("plan alignment, one database", () => {
  it("stops at its page cap, resumes on the next run and reaches every owner", async () => {
    const owners: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const owner = await user(`Pro ${i}`);
      await grantPlan(owner.id, "pro");
      owners.push(owner.id);
    }
    const pro = entitlements({ plan: "pro", seats: 1, validUntil: null, overrides: null }, NOW)
      .limits.activeArtifacts;
    const aligned = async () => {
      let count = 0;
      for (const id of owners) {
        const [row] = await db()
          .select({ limit: schema.accountUsage.activeLimit })
          .from(schema.accountUsage)
          .where(eq(schema.accountUsage.ownerId, id));
        if (row?.limit === pro) count += 1;
      }
      return count;
    };
    const first = await alignPlanLimits(db(), NOW, 50, "default", CAPS);
    expect(first.processed).toBeLessThanOrEqual(2);
    expect(await cursor("align_plan_limits:default")).not.toBe("");
    for (let run = 0; run < 10 && (await aligned()) < owners.length; run += 1) {
      await alignPlanLimits(db(), NOW, 50, "default", CAPS);
    }
    expect(await aligned()).toBe(owners.length);
    // With every owner in line, a run costs its cap: the page (with the cursor), three reads
    // and the cursor's save, however many owners there are.
    const { database, count } = recording();
    await alignPlanLimits(database, NOW, 50, "default", CAPS);
    expect(count()).toBeLessThanOrEqual(5);
  });
});

describe("version pruning, one database", () => {
  it("reads at most its cap of plans per run and prunes every owner within a few runs", async () => {
    const artifacts: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const owner = await user(`Lapsed ${i}`);
      await grantPlan(owner.id, "pro", { validUntil: NOW - DAY });
      const first = await publishSite(owner.id, { "index.html": "<p>one</p>" }, NOW - 40 * DAY);
      await publishSite(owner.id, { "index.html": "<p>two</p>" }, NOW - 35 * DAY, first);
      artifacts.push(first.artifactId);
    }
    const left = async () => {
      let count = 0;
      for (const id of artifacts) {
        const rows = await db()
          .select({ id: schema.versions.id })
          .from(schema.versions)
          .where(eq(schema.versions.artifactId, id));
        count += rows.length;
      }
      return count;
    };
    const first = await pruneVersions(db(), env.ARTIFACTS, NOW, 50, "default", { plans: CAPS });
    expect(first.processed).toBeLessThanOrEqual(2);
    for (let run = 0; run < 10 && (await left()) > artifacts.length; run += 1) {
      await pruneVersions(db(), env.ARTIFACTS, NOW, 50, "default", { plans: CAPS });
    }
    expect(await left()).toBe(artifacts.length);
  });
});

describe("unpinning, one database", () => {
  it("reads at most its cap of pinned owners per run and reaches every owner", async () => {
    const artifacts: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const owner = await user(`Pinned ${i}`);
      const site = await publishSite(owner.id);
      await db()
        .update(schema.artifacts)
        .set({ pinned: true, expiresAt: null })
        .where(eq(schema.artifacts.id, site.artifactId));
      artifacts.push(site.artifactId);
    }
    const pinned = async () => {
      let count = 0;
      for (const id of artifacts) {
        const [row] = await db()
          .select({ pinned: schema.artifacts.pinned })
          .from(schema.artifacts)
          .where(eq(schema.artifacts.id, id));
        if (row?.pinned) count += 1;
      }
      return count;
    };
    const first = await unpinLapsedPlans(db(), NOW, 50, "default", CAPS);
    expect(first.processed).toBeLessThanOrEqual(2);
    for (let run = 0; run < 10 && (await pinned()) > 0; run += 1) {
      await unpinLapsedPlans(db(), NOW, 50, "default", CAPS);
    }
    expect(await pinned()).toBe(0);
  });
});
