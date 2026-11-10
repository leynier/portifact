import { env } from "cloudflare:test";
import { schema } from "@portifact/db";
import { type PlatformMetrics, PROTECTION_ACTIONS, personalActor } from "@portifact/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { updateAccess } from "../src/access.ts";
import {
  createAnnotationThread,
  deleteAnnotationThread,
  exportAnnotations,
  type HumanCheck,
  replyToAnnotationThread,
  setAnnotationMode,
  setAnnotationThreadState,
} from "../src/annotations.ts";
import {
  clearBudgetOverride,
  getBudgetState,
  listBudgetAlerts,
  markBudgetAlertsNotified,
  measurePlatformUsage,
  pendingBudgetAlerts,
  platformProtection,
  recordBudgetMeasurement,
  setBudgetOverride,
} from "../src/budget.ts";
import {
  archiveArtifact,
  deleteArtifact,
  renewArtifact,
  restoreArtifact,
} from "../src/lifecycle.ts";
import { preparePublish } from "../src/publish.ts";
import { getAccountUsage } from "../src/usage.ts";
import { getVersionDownload, rollbackArtifact } from "../src/versions.ts";
import { DAY, db, NOW, publishSite, sha256, user, value } from "./fixtures.ts";

const GB = 1_000_000_000;
// November has 30 days: the 16th at 00:00 is half the cycle, so counters project to double.
const MID = Date.UTC(2026, 10, 16);
const NEXT_CYCLE = Date.UTC(2026, 11, 16);

const metrics = (overrides: Partial<PlatformMetrics> = {}): PlatformMetrics => ({
  storedBytes: 0,
  r2ClassA: null,
  r2ClassB: null,
  workerRequests: null,
  d1RowsRead: null,
  d1RowsWritten: null,
  emails: null,
  ...overrides,
});

/** Mid-cycle metrics projecting `usd` dollars in total (US$9 fixed plus D1 writes). */
const spending = (usd: number) => metrics({ d1RowsWritten: (50_000_000 + (usd - 9) * 1e6) / 2 });

async function measure(usd: number, now = MID) {
  return recordBudgetMeasurement(db(), { metrics: spending(usd), analytics: "ok", now });
}

beforeEach(async () => {
  await db().delete(schema.platformBudget);
  await db().delete(schema.budgetAlerts);
  await db().delete(schema.objects);
});

describe("measuring and recording the budget", () => {
  it("estimates stored bytes and this cycle's uploads from D1", async () => {
    const owner = await user();
    const old = Date.UTC(2026, 9, 20);
    await db()
      .insert(schema.objects)
      .values([
        { ownerId: owner.id, sha256: "a".repeat(64), size: 3 * GB, r2Key: "k1", createdAt: old },
        { ownerId: owner.id, sha256: "b".repeat(64), size: 2 * GB, r2Key: "k2", createdAt: NOW },
        { ownerId: owner.id, sha256: "c".repeat(64), size: 5, r2Key: "k3", createdAt: NOW },
      ]);
    expect(await measurePlatformUsage(db(), NOW)).toEqual(
      metrics({ storedBytes: 5 * GB + 5, r2ClassA: 2, emails: 0 }),
    );
    await db().delete(schema.objects);
    expect(await measurePlatformUsage(db(), NOW)).toEqual(metrics({ r2ClassA: 0, emails: 0 }));
  });

  it("applies no protection before anything was measured", async () => {
    expect(await getBudgetState(db(), NOW)).toBeNull();
    expect(await platformProtection(db(), NOW)).toEqual({
      level: "none",
      actions: [],
      overridden: false,
    });
  });

  it("records each threshold alert once per cycle and again in the next cycle", async () => {
    const quiet = await measure(20);
    expect(quiet).toMatchObject({ newAlerts: [], changed: true });
    expect(quiet.assessment.level).toBe("none");

    const first = await measure(60);
    expect(first.newAlerts.map((a) => a.kind)).toEqual(["spend_25", "spend_50"]);
    expect(first.newAlerts[0]).toMatchObject({
      level: "alert50",
      projectedUsd: 60,
      notifiedAt: null,
    });
    expect(first.changed).toBe(true);

    const again = await measure(70, MID + 15 * 60_000);
    expect(again.newAlerts).toEqual([]);
    expect(again.changed).toBe(false);

    const higher = await measure(80, MID + 30 * 60_000);
    expect(higher.newAlerts.map((a) => a.kind)).toEqual(["spend_75"]);
    expect(higher.effective).toEqual({
      level: "slow75",
      actions: ["stop_new_artifacts"],
      overridden: false,
    });

    const next = await recordBudgetMeasurement(db(), {
      metrics: metrics({ d1RowsWritten: (50_000_000 + 21e6) / 2 }),
      analytics: "ok",
      now: NEXT_CYCLE,
    });
    expect(next.newAlerts.map((a) => a.kind)).toEqual(["spend_25"]);
    const all = await listBudgetAlerts(db(), { limit: 10 });
    expect(all.map((a) => a.kind)).toEqual(["spend_25", "spend_75", "spend_50", "spend_25"]);
    expect(
      (await listBudgetAlerts(db(), { cycleStart: Date.UTC(2026, 11, 1), limit: 10 })).length,
    ).toBe(1);
  });

  it("keeps when the level last changed while it stays the same", async () => {
    await measure(60);
    await measure(65, MID + 60_000);
    const state = await getBudgetState(db(), MID + 120_000);
    expect(state).toMatchObject({
      automatic: { level: "alert50", actions: [] },
      projectedUsd: 65,
      analytics: "ok",
      measuredAt: MID + 60_000,
      levelChangedAt: MID,
      override: null,
    });
  });

  it("carries counters a source missed forward within the cycle only", async () => {
    await measure(130);
    const missing = await recordBudgetMeasurement(db(), {
      metrics: metrics(),
      analytics: "failed",
      now: MID + 60_000,
    });
    // The failed analytics query does not lift protection.
    expect(missing.assessment.level).toBe("protect100");
    expect((await getBudgetState(db(), MID + 60_000))?.analytics).toBe("failed");
    const nextCycle = await recordBudgetMeasurement(db(), {
      metrics: metrics(),
      analytics: "failed",
      now: NEXT_CYCLE,
    });
    expect(nextCycle.assessment.level).toBe("none");
  });

  it("escalates protection in the plan's order as projected spend grows", async () => {
    const seen: string[][] = [];
    for (const usd of [99, 100, 110, 125, 150]) {
      seen.push((await measure(usd)).effective.actions);
    }
    expect(seen).toEqual([
      ["stop_new_artifacts"],
      ["stop_new_artifacts", "block_uploads"],
      ["stop_new_artifacts", "block_uploads", "pause_annotation_writes"],
      ["stop_new_artifacts", "block_uploads", "pause_annotation_writes", "tighten_public_traffic"],
      [...PROTECTION_ACTIONS],
    ]);
  });

  it("tracks which alerts were emailed", async () => {
    const { newAlerts } = await measure(60);
    const cycle = Date.UTC(2026, 10, 1);
    expect((await pendingBudgetAlerts(db(), cycle)).map((a) => a.kind)).toEqual([
      "spend_25",
      "spend_50",
    ]);
    await markBudgetAlertsNotified(db(), [], MID);
    await markBudgetAlertsNotified(
      db(),
      newAlerts.map((a) => a.id),
      MID + 1,
    );
    await markBudgetAlertsNotified(db(), [newAlerts[0]?.id ?? 0], MID + 2);
    expect(await pendingBudgetAlerts(db(), cycle)).toEqual([]);
    const listed = await listBudgetAlerts(db(), { limit: 5 });
    expect(listed.map((a) => a.notifiedAt)).toEqual([MID + 1, MID + 1]);
  });

  it("ignores malformed stored actions and metrics", async () => {
    await measure(60);
    await db().update(schema.platformBudget).set({ actions: "{", metrics: "null" });
    const state = await getBudgetState(db(), MID);
    expect(state?.automatic.actions).toEqual([]);
    expect(state?.metrics).toBeNull();
    await db().update(schema.platformBudget).set({ actions: '"x"', metrics: "{" });
    expect((await getBudgetState(db(), MID))?.automatic.actions).toEqual([]);
  });
});

describe("operator override", () => {
  it("protects before any measurement and clears back to automatic", async () => {
    const state = await setBudgetOverride(db(), {
      level: "protect100",
      steps: 2,
      until: null,
      note: "suspicious traffic",
      now: NOW,
    });
    expect(state).toMatchObject({
      measuredAt: 0,
      metrics: { storedBytes: 0 },
      override: {
        level: "protect100",
        steps: 2,
        until: null,
        note: "suspicious traffic",
        setAt: NOW,
      },
      effective: {
        level: "protect100",
        actions: ["stop_new_artifacts", "block_uploads", "pause_annotation_writes"],
        overridden: true,
      },
    });
    // A measurement keeps the override.
    await measure(30);
    expect((await platformProtection(db(), MID)).overridden).toBe(true);
    const cleared = await clearBudgetOverride(db(), MID);
    expect(cleared?.override).toBeNull();
    expect(cleared?.effective).toEqual({ level: "alert25", actions: [], overridden: false });
  });

  it("lifts automatic protection until it expires", async () => {
    await measure(160);
    await setBudgetOverride(db(), {
      level: "none",
      steps: 1,
      until: MID + DAY,
      note: null,
      now: MID,
    });
    expect(await platformProtection(db(), MID + 1)).toEqual({
      level: "none",
      actions: [],
      overridden: true,
    });
    expect((await platformProtection(db(), MID + DAY)).actions).toEqual([...PROTECTION_ACTIONS]);
  });

  it("clearing without a state does nothing", async () => {
    expect(await clearBudgetOverride(db(), NOW)).toBeNull();
  });
});

async function protect(level: "slow75" | "protect100", steps = 1) {
  await setBudgetOverride(db(), { level, steps, until: null, note: null, now: NOW });
}

async function siteFiles(body: string) {
  return [
    {
      path: "index.html",
      kind: "published" as const,
      sha256: await sha256(body),
      size: body.length,
      contentType: "text/html",
    },
  ];
}

describe("enforcement", () => {
  it("the brake refuses new artifacts but keeps updates working", async () => {
    const owner = await user();
    const site = await publishSite(owner.id);
    await protect("slow75");
    const created = await preparePublish(db(), {
      userId: owner.id,
      type: "site",
      name: "New",
      entrypoint: "index.html",
      baseVersionId: null,
      files: await siteFiles("<p>new</p>"),
      now: NOW,
    });
    expect(created).toMatchObject({ ok: false, code: "capacity_unavailable" });
    expect(await publishSite(owner.id, { "index.html": "<p>v2</p>" }, NOW, site)).toMatchObject({
      artifactId: site.artifactId,
    });
  });

  it("the first step refuses every upload; the rest of the account keeps working", async () => {
    const owner = await user();
    const v1 = await publishSite(owner.id, { "index.html": "<p>one</p>" }, NOW - DAY);
    const v2 = await publishSite(owner.id, { "index.html": "<p>two</p>" }, NOW - DAY + 1, v1);
    await protect("protect100", 1);

    const update = await preparePublish(db(), {
      userId: owner.id,
      artifactId: v1.artifactId,
      type: "site",
      name: "Plan",
      entrypoint: "index.html",
      baseVersionId: v2.versionId,
      files: await siteFiles("<p>three</p>"),
      now: NOW,
    });
    expect(update).toMatchObject({ ok: false, code: "capacity_unavailable" });

    const input = { userId: owner.id, artifactId: v1.artifactId, now: NOW };
    expect((await renewArtifact(db(), input)).ok).toBe(true);
    const download = await getVersionDownload(db(), {
      userId: owner.id,
      artifactId: v1.artifactId,
      versionId: v2.versionId,
      kind: "published",
      now: NOW,
    });
    expect(download.ok).toBe(true);
    const access = await updateAccess(db(), { ...input, change: { mode: "restricted" } });
    expect(access.ok).toBe(true);
    // A rollback re-publishes retained objects and uploads nothing.
    const rolledBack = await rollbackArtifact(db(), {
      ...input,
      versionId: v1.versionId,
      baseVersionId: v2.versionId,
    });
    expect(rolledBack.ok).toBe(true);
    expect((await archiveArtifact(db(), input)).ok).toBe(true);
    expect((await restoreArtifact(db(), input)).ok).toBe(true);
    expect((await deleteArtifact(db(), env.ARTIFACTS, input)).ok).toBe(true);
  });

  it("pauses new comments from the second step; moderation and export keep working", async () => {
    const owner = await user();
    const site = await publishSite(owner.id);
    const reader = await user("Reader");
    const actor = { userId: owner.id, artifactId: site.artifactId, now: NOW };
    expect((await setAnnotationMode(db(), { ...actor, mode: "open" })).ok).toBe(true);
    const shared = await updateAccess(db(), {
      userId: owner.id,
      artifactId: site.artifactId,
      change: { mode: "restricted", addReaders: [reader.email] },
      now: NOW,
    });
    expect(shared.ok).toBe(true);
    const visitor = { userId: reader.id, artifactId: site.artifactId, now: NOW };
    const target = {
      schema: 1 as const,
      path: "index.html",
      anchor: { kind: "document" as const },
    };
    // A reader's first comments on someone else's artifact need a human check (plan section 13).
    const verified: string[] = [];
    const humanCheck: HumanCheck = {
      token: "solved",
      verify: async (token) => {
        verified.push(token);
        return "passed";
      },
    };

    await protect("protect100", 1);
    const thread = await createAnnotationThread(db(), {
      ...visitor,
      versionId: site.versionId,
      target,
      body: "Still allowed at the first step",
      humanCheck,
    });
    if (!thread.ok) throw new Error(thread.message);
    expect(verified).toEqual(["solved"]);

    await protect("protect100", 2);
    const paused = await createAnnotationThread(db(), {
      ...visitor,
      versionId: site.versionId,
      target,
      body: "Paused",
      humanCheck,
    });
    expect(paused).toMatchObject({ ok: false, code: "capacity_unavailable" });
    const reply = await replyToAnnotationThread(db(), {
      ...visitor,
      threadId: thread.value.id,
      body: "Paused too",
      humanCheck,
    });
    expect(reply).toMatchObject({ ok: false, code: "capacity_unavailable" });
    // Refused before the human check: no Turnstile token was spent on a paused comment.
    expect(verified).toEqual(["solved"]);

    const resolved = await setAnnotationThreadState(db(), {
      ...actor,
      threadId: thread.value.id,
      state: "resolved",
    });
    expect(resolved.ok).toBe(true);
    expect((await exportAnnotations(db(), { ...actor, version: "all" })).ok).toBe(true);
    expect((await deleteAnnotationThread(db(), { ...actor, threadId: thread.value.id })).ok).toBe(
      true,
    );
  });

  it("shows accounts a capacity block while protection limits publishing", async () => {
    const owner = await user();
    expect(
      value(await getAccountUsage(db(), { actor: personalActor(owner.id), now: NOW })).blocks,
    ).toEqual([]);
    await protect("protect100", 2);
    const [block] = value(
      await getAccountUsage(db(), { actor: personalActor(owner.id), now: NOW }),
    ).blocks;
    expect(block).toMatchObject({ reason: "capacity", stops: "publishing", until: null });
    expect(block?.message).toMatch(/^New uploads and comments are paused/);
  });

  it("reports the capacity block next to an exhausted traffic quota", async () => {
    const owner = await user();
    await db()
      .insert(schema.trafficCounters)
      .values({
        ownerId: owner.id,
        cycleStart: Date.UTC(2026, 10, 1),
        requests: 1_000_000,
        bytes: 0,
        updatedAt: NOW,
      });
    await protect("slow75");
    const { blocks } = value(
      await getAccountUsage(db(), { actor: personalActor(owner.id), now: NOW }),
    );
    expect(blocks.map((b) => [b.reason, b.stops])).toEqual([
      ["capacity", "new_artifacts"],
      ["traffic", "serving"],
    ]);
  });
});
