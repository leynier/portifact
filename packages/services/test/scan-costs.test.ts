// D1 calls of the scans, the plan grants and the restore path in today's production shape (one
// region, its database the global one). The numbers were measured once on develop (7e416a49)
// with this same scenario; a change for a separate regional database must leave them as they are
// (decision 0005, "Two-region audit").
import { env } from "cloudflare:test";
import { schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { pruneAuditEvents } from "../src/audit.ts";
import { maintainAuditStreams } from "../src/audit-streams.ts";
import { applyTombstones } from "../src/backups.ts";
import { dropLapsedSearchIndexes, scheduleSearchIndexing } from "../src/content-search.ts";
import { scheduleExpiryNotices } from "../src/expiry-notices.ts";
import { pruneVersions, runMaintenance } from "../src/maintenance.ts";
import {
  alignPlanLimits,
  getOwnerPlan,
  removeOwnerPlan,
  setOwnerPlan,
  unpinLapsedPlans,
} from "../src/plans.ts";
import { DAY, db, grantPlan, NOW, publishSite, user } from "./fixtures.ts";
import { recording } from "./recording.ts";

async function counted(run: (database: ReturnType<typeof db>) => Promise<unknown>) {
  const { database, count } = recording();
  await run(database);
  return count();
}

/** The calls each path made on develop, with the scenario below. */
const DEVELOP = {
  setOwnerPlan: 4,
  getOwnerPlan: 3,
  removeOwnerPlan: 4,
  alignPlanLimits: 5,
  unpinLapsedPlans: 3,
  pruneVersions: 11,
  scheduleExpiryNotices: 4,
  scheduleSearchIndexing: 3,
  dropLapsedSearchIndexes: 4,
  pruneAuditEvents: 2,
  applyTombstones: 3,
  // 52 measured on develop before issue integrations, plus their one requeue scan (`requeueThreadIssues`).
  runMaintenance: 53,
  // Audit streams (decision 0019): one batch per region and run (prune the log, arm streams that
  // lost their job), whatever the number of owners or streams. Run by the jobs Worker only while
  // streams are switched on, outside `runMaintenance`, which it leaves as it was.
  maintainAuditStreams: 1,
};

describe("D1 calls of the scans and plan paths, one region", () => {
  it("are what develop makes", async () => {
    // A team owner with an expiring artifact, a lapsed owner with a pinned one, a free owner
    // with two versions, and an indexed owner whose plan lost search.
    const team = await user("Team");
    await grantPlan(team.id, "team", { seats: 2 });
    const expiring = await publishSite(team.id);
    await db()
      .update(schema.artifacts)
      .set({ expiresAt: NOW + 2 * DAY })
      .where(eq(schema.artifacts.id, expiring.artifactId));
    const lapsed = await user("Lapsed");
    await grantPlan(lapsed.id, "pro", { validUntil: NOW - DAY });
    const pinned = await publishSite(lapsed.id);
    await db()
      .update(schema.artifacts)
      .set({ pinned: true, expiresAt: null })
      .where(eq(schema.artifacts.id, pinned.artifactId));
    const free = await user("Free");
    const first = await publishSite(free.id, { "index.html": "<p>one</p>" }, NOW - 40 * DAY);
    await publishSite(free.id, { "index.html": "<p>two</p>" }, NOW - 35 * DAY, first);
    await db()
      .insert(schema.searchArtifacts)
      .values({
        artifactId: pinned.artifactId,
        ownerId: lapsed.id,
        versionId: pinned.versionId,
        textBytes: 1,
        partial: false,
        nextFile: null,
        indexedAt: NOW,
      })
      .onConflictDoNothing();

    const grantee = await user("Grantee");
    const costs = {
      setOwnerPlan: await counted((d) =>
        setOwnerPlan(d, {
          ownerId: grantee.id,
          plan: "pro",
          seats: 1,
          validUntil: null,
          overrides: null,
          grantedBy: "test",
          note: null,
          now: NOW,
        }),
      ),
      getOwnerPlan: await counted((d) => getOwnerPlan(d, grantee.id, NOW)),
      removeOwnerPlan: await counted((d) => removeOwnerPlan(d, { ownerId: grantee.id, now: NOW })),
      alignPlanLimits: await counted((d) => alignPlanLimits(d, NOW)),
      unpinLapsedPlans: await counted((d) => unpinLapsedPlans(d, NOW)),
      pruneVersions: await counted((d) => pruneVersions(d, env.ARTIFACTS, NOW)),
      scheduleExpiryNotices: await counted((d) => scheduleExpiryNotices(d, NOW)),
      scheduleSearchIndexing: await counted((d) => scheduleSearchIndexing(d, NOW)),
      dropLapsedSearchIndexes: await counted((d) => dropLapsedSearchIndexes(d, NOW)),
      pruneAuditEvents: await counted((d) => pruneAuditEvents(d, d.global, NOW)),
      applyTombstones: await counted((d) =>
        applyTombstones(d, [{ kind: "artifact", id: "gonegonego", deletedAt: NOW }], NOW),
      ),
      runMaintenance: await counted((d) => runMaintenance(d, env.ARTIFACTS, NOW + DAY)),
      maintainAuditStreams: await counted((d) => maintainAuditStreams(d, NOW)),
    };
    expect(costs).toEqual(DEVELOP);
  });
});
