import { env } from "cloudflare:test";
import { regionsFromEnv, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  abortPublish,
  archiveArtifact,
  archiveExpired,
  commitPublish,
  deleteArtifact,
  expireUploads,
  type ManifestEntry,
  preparePublish,
  pruneVersions,
  purgeArchived,
  renewArtifact,
  restoreArtifact,
  runMaintenance,
  sweepOrphanObjects,
} from "../src/index.ts";
import { grantPlan } from "./fixtures.ts";

const OWNER = "u_owner";
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 10, 12);
const db = () => regionsFromEnv(env).get("default").db;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function files(bodies: Record<string, string>): Promise<ManifestEntry[]> {
  return Promise.all(
    Object.entries(bodies).map(async ([path, body]) => ({
      path,
      kind: "published" as const,
      sha256: await sha256(body),
      size: body.length,
      contentType: "text/html",
    })),
  );
}

/** Publishes (or updates) an artifact through the real publish flow. */
async function publish(
  bodies: Record<string, string>,
  now = T0,
  base?: { artifactId: string; versionId: string },
) {
  const prepared = await preparePublish(db(), {
    userId: OWNER,
    type: "site",
    name: "Plan",
    entrypoint: "index.html",
    baseVersionId: base?.versionId ?? null,
    ...(base ? { artifactId: base.artifactId } : {}),
    files: await files(bodies),
    now,
  });
  if (!prepared.ok) throw new Error(prepared.message);
  for (const body of Object.values(bodies)) {
    await env.ARTIFACTS.put(`objects/${OWNER}/${await sha256(body)}`, body);
  }
  const committed = await commitPublish(db(), env.ARTIFACTS, {
    userId: OWNER,
    sessionId: prepared.value.sessionId,
    now,
  });
  if (!committed.ok) throw new Error(committed.message);
  return { artifactId: committed.value.artifactId, versionId: committed.value.versionId };
}

async function artifact(id: string) {
  const [row] = await db().select().from(schema.artifacts).where(eq(schema.artifacts.id, id));
  return row;
}

async function usage() {
  const [row] = await db()
    .select()
    .from(schema.accountUsage)
    .where(eq(schema.accountUsage.ownerId, OWNER));
  return row;
}

async function r2Keys() {
  return (await env.ARTIFACTS.list()).objects.map((o) => o.key).sort();
}

const input = (artifactId: string, now: number, userId = OWNER) => ({ userId, artifactId, now });

beforeEach(async () => {
  const listed = await env.ARTIFACTS.list();
  if (listed.objects.length > 0) await env.ARTIFACTS.delete(listed.objects.map((o) => o.key));
  for (const table of [
    "version_files",
    "versions",
    "objects",
    "artifacts",
    "upload_sessions",
    "account_usage",
    "owner_plans",
    "usage_events",
    "lifecycle_events",
    "tombstones",
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
});

describe("archiving expired artifacts", () => {
  it("archives at the expiry date, frees the slot and schedules the purge", async () => {
    const a = await publish({ "index.html": "<h1>a</h1>" });
    expect(await usage()).toMatchObject({ activeArtifacts: 1 });

    expect(await archiveExpired(db(), T0 + 29 * DAY)).toEqual({ processed: 0 });
    expect(await archiveExpired(db(), T0 + 45 * DAY)).toEqual({ processed: 1 });

    expect(await artifact(a.artifactId)).toMatchObject({
      state: "archived",
      archivedAt: T0 + 30 * DAY,
      purgeAt: Date.UTC(2026, 7, 9, 12),
    });
    expect(await usage()).toMatchObject({ activeArtifacts: 0 });
  });

  it("frees the slot exactly once when two runs race", async () => {
    await publish({ "index.html": "<h1>a</h1>" });
    const runs = await Promise.all([
      archiveExpired(db(), T0 + 31 * DAY),
      archiveExpired(db(), T0 + 31 * DAY),
    ]);
    expect(runs.reduce((sum, r) => sum + r.processed, 0)).toBe(1);
    expect(await usage()).toMatchObject({ activeArtifacts: 0 });
  });

  it("leaves an artifact renewed after the job read it", async () => {
    const a = await publish({ "index.html": "<h1>a</h1>" });
    await renewArtifact(db(), input(a.artifactId, T0 + 29 * DAY));
    expect(await archiveExpired(db(), T0 + 31 * DAY)).toEqual({ processed: 0 });
    expect((await artifact(a.artifactId))?.state).toBe("active");
  });
});

describe("owner lifecycle actions", () => {
  it("renews an active artifact for 30 days from now", async () => {
    const a = await publish({ "index.html": "<h1>a</h1>" });
    expect(await renewArtifact(db(), input(a.artifactId, T0 + 10 * DAY))).toEqual({
      ok: true,
      value: { state: "active", expiresAt: T0 + 40 * DAY, purgeAt: null, pinned: false },
    });
  });

  it("refuses to renew archived or foreign artifacts", async () => {
    const a = await publish({ "index.html": "<h1>a</h1>" });
    expect(await renewArtifact(db(), input(a.artifactId, T0, "u_other"))).toMatchObject({
      code: "not_found",
    });
    expect(await renewArtifact(db(), input(a.artifactId, T0 + 31 * DAY))).toMatchObject({
      code: "artifact_archived",
    });
  });

  it("archives on request and restores within six months, keeping the URL", async () => {
    const a = await publish({ "index.html": "<h1>a</h1>" });
    expect(await archiveArtifact(db(), input(a.artifactId, T0 + DAY))).toMatchObject({
      ok: true,
      value: { state: "archived", purgeAt: Date.UTC(2026, 6, 11, 12) },
    });
    expect(await usage()).toMatchObject({ activeArtifacts: 0 });

    const restored = await restoreArtifact(db(), input(a.artifactId, T0 + 60 * DAY));
    expect(restored).toEqual({
      ok: true,
      value: { state: "active", expiresAt: T0 + 90 * DAY, purgeAt: null, pinned: false },
    });
    expect(await artifact(a.artifactId)).toMatchObject({
      state: "active",
      currentVersionId: a.versionId,
    });
    expect(await usage()).toMatchObject({ activeArtifacts: 1 });
  });

  it("restores an expired artifact that maintenance has not archived yet without taking a second slot", async () => {
    const a = await publish({ "index.html": "<h1>a</h1>" });
    expect((await restoreArtifact(db(), input(a.artifactId, T0 + 31 * DAY))).ok).toBe(true);
    expect(await usage()).toMatchObject({ activeArtifacts: 1 });
  });

  it("refuses to restore after the purge date or beyond 50 active artifacts", async () => {
    const a = await publish({ "index.html": "<h1>a</h1>" });
    await archiveArtifact(db(), input(a.artifactId, T0 + DAY));
    expect(await restoreArtifact(db(), input(a.artifactId, T0 + 200 * DAY))).toMatchObject({
      code: "not_found",
    });

    await db().update(schema.accountUsage).set({ activeArtifacts: 50 });
    expect(await restoreArtifact(db(), input(a.artifactId, T0 + 2 * DAY))).toMatchObject({
      code: "quota_exceeded",
    });
  });

  it("restores with the active slots of the owner's plan, and an expired plan reads as free", async () => {
    const a = await publish({ "index.html": "<h1>a</h1>" });
    const b = await publish({ "index.html": "<h1>b</h1>" });
    await archiveArtifact(db(), input(a.artifactId, T0 + DAY));
    // Below the free CHECK, so only the plan's limit can refuse.
    await grantPlan(OWNER, "pro", { overrides: { limits: { activeArtifacts: 1 } } });
    expect(await restoreArtifact(db(), input(a.artifactId, T0 + 2 * DAY))).toEqual({
      ok: false,
      code: "quota_exceeded",
      message: "You already have 1 active artifacts.",
    });
    await grantPlan(OWNER, "pro", {
      validUntil: T0 + 2 * DAY,
      overrides: { limits: { activeArtifacts: 1 } },
    });
    expect((await restoreArtifact(db(), input(a.artifactId, T0 + 2 * DAY))).ok).toBe(true);
    expect(b.artifactId).not.toBe(a.artifactId);
  });

  it("refuses invalid transitions", async () => {
    const a = await publish({ "index.html": "<h1>a</h1>" });
    expect(await restoreArtifact(db(), input(a.artifactId, T0 + DAY))).toMatchObject({
      code: "invalid_input",
    });
    await archiveArtifact(db(), input(a.artifactId, T0 + DAY));
    expect(await archiveArtifact(db(), input(a.artifactId, T0 + DAY))).toMatchObject({
      code: "invalid_input",
    });
    expect(await archiveArtifact(db(), input(a.artifactId, T0, "u_other"))).toMatchObject({
      code: "not_found",
    });
    expect(await restoreArtifact(db(), input(a.artifactId, T0, "u_other"))).toMatchObject({
      code: "not_found",
    });
  });

  it("deletes an artifact with its objects, frees storage and leaves a tombstone", async () => {
    const a = await publish({ "index.html": "<h1>a</h1>", "app.js": "x" });
    expect(await r2Keys()).toHaveLength(2);

    expect(await deleteArtifact(db(), env.ARTIFACTS, input(a.artifactId, T0 + DAY))).toMatchObject({
      ok: true,
      value: { state: "deleted" },
    });

    expect(await artifact(a.artifactId)).toBeUndefined();
    expect(await r2Keys()).toEqual([]);
    expect(await usage()).toMatchObject({ activeArtifacts: 0, storedBytes: 0 });
    const [tombstone] = await db().select().from(schema.tombstones);
    expect(tombstone).toMatchObject({ kind: "artifact", id: a.artifactId });
    expect(await deleteArtifact(db(), env.ARTIFACTS, input(a.artifactId, T0 + DAY))).toMatchObject({
      code: "not_found",
    });
    expect(await deleteArtifact(db(), env.ARTIFACTS, input("zzzzzzzzzz", T0))).toMatchObject({
      code: "not_found",
    });
  });

  it("keeps objects another artifact of the account still uses", async () => {
    const a = await publish({ "index.html": "<h1>shared</h1>" });
    await publish({ "index.html": "<h1>shared</h1>" });
    await deleteArtifact(db(), env.ARTIFACTS, input(a.artifactId, T0 + DAY));
    expect(await r2Keys()).toHaveLength(1);
    expect((await usage())?.storedBytes).toBe("<h1>shared</h1>".length);
  });
});

describe("races between requests and jobs", () => {
  it("lets only one of two racing restores take the last active slot", async () => {
    const a = await publish({ "index.html": "<h1>a</h1>" });
    const b = await publish({ "index.html": "<h1>b</h1>" });
    await archiveArtifact(db(), input(a.artifactId, T0 + DAY));
    await archiveArtifact(db(), input(b.artifactId, T0 + DAY));
    await db().update(schema.accountUsage).set({ activeArtifacts: 49 });

    const results = await Promise.all([
      restoreArtifact(db(), input(a.artifactId, T0 + 2 * DAY)),
      restoreArtifact(db(), input(b.artifactId, T0 + 2 * DAY)),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ code: "quota_exceeded" });
    expect(await usage()).toMatchObject({ activeArtifacts: 50 });
  });

  it("turns a concurrent renew and archive into one success and one conflict", async () => {
    const a = await publish({ "index.html": "<h1>a</h1>" });
    const results = await Promise.all([
      renewArtifact(db(), input(a.artifactId, T0 + DAY)),
      archiveArtifact(db(), input(a.artifactId, T0 + DAY)),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ code: "version_conflict" });
  });

  it("treats deleting an artifact that is already being purged as done", async () => {
    const a = await publish({ "index.html": "<h1>a</h1>" });
    await db()
      .update(schema.artifacts)
      .set({ state: "purging" })
      .where(eq(schema.artifacts.id, a.artifactId));
    expect(await deleteArtifact(db(), env.ARTIFACTS, input(a.artifactId, T0))).toMatchObject({
      ok: true,
      value: { state: "deleted" },
    });
  });

  it("processes each version and purge once when jobs overlap", async () => {
    const a = await publish({ "index.html": "<h1>v1</h1>" });
    await publish({ "index.html": "<h1>v2</h1>" }, T0 + DAY, a);
    const prunes = await Promise.all([
      pruneVersions(db(), env.ARTIFACTS, T0 + 9 * DAY),
      pruneVersions(db(), env.ARTIFACTS, T0 + 9 * DAY),
    ]);
    expect(prunes.reduce((sum, r) => sum + r.processed, 0)).toBe(1);

    await archiveExpired(db(), T0 + 40 * DAY);
    const purgeAt = (await artifact(a.artifactId))?.purgeAt ?? 0;
    const purges = await Promise.all([
      purgeArchived(db(), env.ARTIFACTS, purgeAt),
      purgeArchived(db(), env.ARTIFACTS, purgeAt),
    ]);
    expect(purges.reduce((sum, r) => sum + r.processed, 0)).toBeGreaterThanOrEqual(1);
    expect(await artifact(a.artifactId)).toBeUndefined();
    expect(await usage()).toMatchObject({ storedBytes: 0 });
  });
});

describe("pruning versions and uploads", () => {
  it("deletes previous versions after seven days and only their own objects", async () => {
    const a = await publish({ "index.html": "<h1>v1</h1>", "app.js": "shared" });
    const b = await publish({ "index.html": "<h1>v2</h1>", "app.js": "shared" }, T0 + DAY, a);
    expect(await r2Keys()).toHaveLength(3);

    expect(await pruneVersions(db(), env.ARTIFACTS, T0 + 7 * DAY)).toEqual({ processed: 0 });
    expect(await pruneVersions(db(), env.ARTIFACTS, T0 + 9 * DAY)).toEqual({ processed: 1 });

    const versions = await db().select().from(schema.versions);
    expect(versions.map((v) => v.id)).toEqual([b.versionId]);
    expect(await r2Keys()).toHaveLength(2);
    expect((await usage())?.storedBytes).toBe("<h1>v2</h1>".length + "shared".length);
  });

  it("releases abandoned uploads and removes what they left behind", async () => {
    const a = await publish({ "index.html": "<h1>v1</h1>" });
    const pending = await preparePublish(db(), {
      userId: OWNER,
      type: "site",
      name: "Plan",
      entrypoint: "index.html",
      artifactId: a.artifactId,
      baseVersionId: a.versionId,
      files: await files({ "index.html": "<h1>never committed</h1>" }),
      now: T0 + DAY,
    });
    if (!pending.ok) throw new Error(pending.message);
    await env.ARTIFACTS.put(pending.value.uploads[0]?.r2Key ?? "", "<h1>never committed</h1>");

    expect(await expireUploads(db(), T0 + DAY + 1)).toEqual({ processed: 0 });
    expect(await expireUploads(db(), T0 + 2 * DAY)).toEqual({ processed: 1 });
    expect(await pruneVersions(db(), env.ARTIFACTS, T0 + 2 * DAY)).toEqual({ processed: 1 });

    expect(await r2Keys()).toHaveLength(1);
    expect(await usage()).toMatchObject({
      openUploads: 0,
      reservedBytes: 0,
      storedBytes: "<h1>v1</h1>".length,
    });
    expect((await artifact(a.artifactId))?.currentVersionId).toBe(a.versionId);
  });

  it("never prunes the current version", async () => {
    const a = await publish({ "index.html": "<h1>v1</h1>" });
    await db()
      .update(schema.versions)
      .set({ supersededAt: T0 - 8 * DAY })
      .where(eq(schema.versions.id, a.versionId));
    expect(await pruneVersions(db(), env.ARTIFACTS, T0 + DAY)).toEqual({ processed: 0 });
  });

  it("lets an aborted first upload leave nothing behind", async () => {
    const pending = await preparePublish(db(), {
      userId: OWNER,
      type: "site",
      name: "Plan",
      entrypoint: "index.html",
      baseVersionId: null,
      files: await files({ "index.html": "<h1>draft</h1>" }),
      now: T0,
    });
    if (!pending.ok) throw new Error(pending.message);
    await env.ARTIFACTS.put(pending.value.uploads[0]?.r2Key ?? "", "<h1>draft</h1>");
    await abortPublish(db(), { userId: OWNER, sessionId: pending.value.sessionId, now: T0 });

    expect(await sweepOrphanObjects(db(), env.ARTIFACTS, T0)).toEqual({ processed: 1 });
    expect(await db().select().from(schema.objects)).toEqual([]);
    expect(await r2Keys()).toEqual([]);
    expect(await usage()).toMatchObject({ activeArtifacts: 0, storedBytes: 0, reservedBytes: 0 });
  });
});

describe("purging archives", () => {
  it("purges six months after archiving, never before, and cannot be restored afterwards", async () => {
    const a = await publish({ "index.html": "<h1>a</h1>" });
    await archiveExpired(db(), T0 + 31 * DAY);
    const purgeAt = (await artifact(a.artifactId))?.purgeAt ?? 0;

    expect(await purgeArchived(db(), env.ARTIFACTS, purgeAt - 1)).toEqual({ processed: 0 });
    expect(await purgeArchived(db(), env.ARTIFACTS, purgeAt)).toEqual({ processed: 1 });

    expect(await artifact(a.artifactId)).toBeUndefined();
    expect(await r2Keys()).toEqual([]);
    expect(await restoreArtifact(db(), input(a.artifactId, purgeAt + 1))).toMatchObject({
      code: "not_found",
    });
  });

  it("resumes a purge that a previous run left half done", async () => {
    const a = await publish({ "index.html": "<h1>a</h1>" });
    await db()
      .update(schema.artifacts)
      .set({ state: "purging" })
      .where(eq(schema.artifacts.id, a.artifactId));
    expect(await purgeArchived(db(), env.ARTIFACTS, T0)).toEqual({ processed: 1 });
    expect(await artifact(a.artifactId)).toBeUndefined();
  });

  it("runs every job from the scheduled entry point", async () => {
    await publish({ "index.html": "<h1>a</h1>" });
    expect(await runMaintenance(db(), env.ARTIFACTS, T0 + 31 * DAY)).toEqual({
      archived: 1,
      expiryNotices: 0,
      commentNotices: 0,
      expiredUploads: 0,
      prunedVersions: 0,
      purged: 0,
      orphanObjects: 0,
      prunedAuditEvents: 0,
      prunedOperations: 0,
      readSessions: 0,
      artifactGroups: 0,
      groupTombstones: 0,
      shareLinks: 0,
      approvalReviewers: 0,
      reviewSessions: 0,
      rerendered: 0,
      accountDeletions: 0,
      workspaceDeletions: 0,
      expiredInvitations: 0,
      federatedCredentials: 0,
      usedGitHubTokens: 0,
      directoryUsers: 0,
      prunedTrafficCounters: 0,
      prunedEmailCounters: 0,
      prunedEmailSuppressions: 0,
      planGraces: 0,
      graceNotices: 0,
      redatedPlans: 0,
      alignedPlanLimits: 0,
      unpinned: 0,
      ssoRequirements: 0,
      droppedSearchIndexes: 0,
      scheduledSearchIndexing: 0,
      webhooks: { prunedDeliveries: 0, requeued: 0 },
      threadIssues: 0,
      workspacePolicies: { checked: 0, corrected: 0, failed: 0 },
      commentRetention: {
        checked: 0,
        threads: 0,
        suspended: 0,
        paused: false,
        heldBack: 0,
        failed: 0,
        guardSweep: { listed: 0, deleted: 0, young: 0, foreign: 0, failed: 0 },
      },
    });
  });
});
