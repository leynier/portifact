// D1 calls of the scans, the plan grants and the restore path in today's production shape (one
// region, its database the global one). The numbers were measured once on develop (7e416a49)
// with this same scenario; a change for a separate regional database must leave them as they are
// (decision 0005, "Two-region audit").
import { env } from "cloudflare:test";
import { DEFAULT_POLICY } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { storedPolicy } from "@portifact/domain";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { pruneAuditEvents } from "../src/audit.ts";
import { maintainAuditStreams, rewrapAuditStreamKeys } from "../src/audit-streams.ts";
import { applyTombstones } from "../src/backups.ts";
import { dropLapsedSearchIndexes, scheduleSearchIndexing } from "../src/content-search.ts";
import { scheduleExpiryNotices } from "../src/expiry-notices.ts";
import { archiveExpired, pruneVersions, runMaintenance } from "../src/maintenance.ts";
import {
  alignPlanLimits,
  getOwnerPlan,
  redateDatedPlans,
  removeOwnerPlan,
  setOwnerPlan,
  unpinLapsedPlans,
} from "../src/plans.ts";
import { webhookKeys } from "../src/webhook-keys.ts";
import { enforceWorkspacePolicies, enforceWorkspacePolicy } from "../src/workspace-policies.ts";
import { DAY, db, grantPlan, NOW, publishSite, user } from "./fixtures.ts";
import { recording } from "./recording.ts";

async function counted(run: (database: ReturnType<typeof db>) => Promise<unknown>) {
  const { database, count } = recording();
  await run(database);
  return count();
}

const KEY = "test-only scan cost key for audit streams, long enough";
const OLD_KEY = "the previous test-only scan cost key, long enough";

/** The calls each path made on develop, with the scenario below. */
const DEVELOP = {
  // Plan grace (decision 0022): a grant and a removal read the row they decide the grace from,
  // one call each on the operator's path; no request path reads more.
  setOwnerPlan: 5,
  getOwnerPlan: 3,
  removeOwnerPlan: 5,
  alignPlanLimits: 5,
  unpinLapsedPlans: 3,
  // One more plan row here: the removal above keeps the grantee's row while its grace runs.
  pruneVersions: 12,
  scheduleExpiryNotices: 4,
  scheduleSearchIndexing: 3,
  dropLapsedSearchIndexes: 4,
  pruneAuditEvents: 2,
  applyTombstones: 3,
  // 52 measured on develop before issue integrations, plus their one requeue scan (`requeueThreadIssues`).
  // Plus plan grace (decision 0022): the grace scan's one call (`maintainPlanGraces`: the saved
  // cursor and its first page in one batch, nothing due here), the held row's page in the version
  // prune, and the re-dating pass's two calls on its first run (one on every later run).
  // Plus the one global read of "SSO required"'s suspension scan (`syncSsoRequirementStates`).
  // Plus the stale-cap sweep of the maximum life (decision 0023): with nothing capped, one call,
  // its saved cursor and its first page together.
  runMaintenance: 59,
  // Of those, the one-time re-dating pass (decision 0022, `redateDatedPlans`): its first run reads
  // the cursor with its first page in one call and marks itself done in another; every later run
  // costs one call, the cursor read.
  redateDatedPlansDone: 1,
  // Audit streams (decision 0019): one batch per region and run (prune the log, arm streams that
  // lost their job), whatever the number of owners or streams. Run by the jobs Worker only while
  // streams are switched on, outside `runMaintenance`, which it leaves as it was.
  maintainAuditStreams: 1,
  // The key re-seal reads nothing without a previous key (`WEBHOOK_KEY_PREVIOUS`), so it costs
  // nothing every 15 minutes outside a rotation; during one, a read and a count per region plus
  // one update per stream it re-seals (none here).
  rewrapAuditStreamKeys: 0,
  rewrapAuditStreamKeysRotating: 2,
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
    // Lapsed past its grace (decision 0022), so its pins and versions go as they always did.
    await grantPlan(lapsed.id, "pro", { validUntil: NOW - 61 * DAY });
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
      redateDatedPlansDone: await counted((d) => redateDatedPlans(d, NOW + DAY)),
      maintainAuditStreams: await counted((d) => maintainAuditStreams(d, NOW)),
      rewrapAuditStreamKeys: await counted(async (d) =>
        rewrapAuditStreamKeys(d, await webhookKeys({ current: KEY })),
      ),
      rewrapAuditStreamKeysRotating: await counted(async (d) =>
        rewrapAuditStreamKeys(d, await webhookKeys({ current: KEY, previous: OLD_KEY })),
      ),
    };
    expect(costs).toEqual(DEVELOP);
  });
});

/**
 * The maximum life of artifacts (decision 0023), measured when it was added, one region: the
 * scan finds the workspace in its one regional query and runs one step; the step is one batch for
 * the maximum life after the workspace's read (no access policy to apply); archiving an artifact
 * that reached it is one batch with its audit event instead of the bare update, after one read of
 * the plan and the policy together.
 */
const MAX_LIFE = {
  // The cursor, the workspaces, the violations, the step (its read and batch), the cursor's write,
  // and the stale-cap sweep's one call (the workspace has a maximum, so it is not swept).
  enforceWorkspacePolicies: 7,
  // Clean: the step's two calls are gone.
  enforceWorkspacePoliciesClean: 5,
  // After the maximum is removed and its job lost: the scan's cursor, workspaces and cursor
  // write (three; no workspace has a policy to step), then the sweep finds the owner (one call
  // with its cursor), reads its policy (one) and gives back (one batch); its pass ends where it
  // started, so no cursor write.
  enforceWorkspacePoliciesStale: 6,
  enforceWorkspacePolicy: 2,
  // The due read, the plan and policy, the archive's batch, the lifecycle event.
  archiveExpired: 4,
};

describe("D1 calls of the maximum life's scans, one region", () => {
  it("are what they were measured at", async () => {
    const admin = await user("Admin");
    const id = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
    await db()
      .insert(schema.workspaces)
      .values({
        id,
        slug: `c${crypto.randomUUID().slice(0, 12)}`,
        name: "Costs",
        createdBy: admin.id,
        updatedAt: NOW,
        policy: storedPolicy({
          ...DEFAULT_POLICY,
          artifactMaxDays: 30,
          artifactMaxDaysFrom: NOW - DAY,
        }),
      });
    await grantPlan(id, "enterprise", { seats: 2 });
    await db()
      .insert(schema.workspaceMembers)
      .values({ workspaceId: id, userId: admin.id, role: "admin", updatedAt: NOW });
    const old = await publishSite(admin.id, { "index.html": "<p>old</p>" }, NOW - 60 * DAY);
    await db()
      .update(schema.artifacts)
      .set({ ownerId: id, expiresAt: NOW + 20 * DAY })
      .where(eq(schema.artifacts.id, old.artifactId));
    const costs = {
      enforceWorkspacePolicies: await counted((d) => enforceWorkspacePolicies(d, NOW)),
      enforceWorkspacePoliciesClean: await counted((d) => enforceWorkspacePolicies(d, NOW)),
      enforceWorkspacePolicy: await counted((d) => enforceWorkspacePolicy(d, id, NOW)),
      archiveExpired: await counted((d) => archiveExpired(d, NOW + DAY)),
      enforceWorkspacePoliciesStale: await (async () => {
        // A second artifact, capped and still live, then the maximum removed with its job lost.
        const kept = await publishSite(admin.id, { "index.html": "<p>kept</p>" }, NOW - 60 * DAY);
        await db()
          .update(schema.artifacts)
          .set({ ownerId: id, expiresAt: NOW + 3 * DAY, uncappedExpiresAt: NOW + 20 * DAY })
          .where(eq(schema.artifacts.id, kept.artifactId));
        await db()
          .update(schema.workspaces)
          .set({ policy: null })
          .where(eq(schema.workspaces.id, id));
        return counted((d) => enforceWorkspacePolicies(d, NOW + DAY));
      })(),
    };
    expect(costs).toEqual(MAX_LIFE);
  });
});
