import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createDb,
  findDeliveryArtifact,
  findDeliveryOwner,
  findDeliveryPlan,
  findPublishedFile,
  findRenderedPage,
  networksOf,
  schema,
  UNREADABLE_NETWORKS,
} from "../src/index.ts";

const db = () => createDb(env.DB);
const sha = (c: string) => c.repeat(64);
const CYCLE = Date.UTC(2026, 10, 1);

describe("delivery queries", () => {
  beforeEach(async () => {
    for (const table of [
      "version_files",
      "versions",
      "objects",
      "artifacts",
      "traffic_counters",
      "owner_plans",
    ]) {
      await env.DB.exec(`DELETE FROM ${table}`);
    }
    await db().insert(schema.artifacts).values({
      id: "k7d2qm4xab",
      ownerId: "u_owner",
      type: "site",
      name: "Report",
      state: "active",
      accessMode: "public",
      currentVersionId: "v1",
    });
    await db().insert(schema.versions).values({
      id: "v1",
      artifactId: "k7d2qm4xab",
      number: 1,
      authorId: "u_owner",
      entrypoint: "index.html",
      publishedBytes: 20,
    });
    await db()
      .insert(schema.objects)
      .values([
        { ownerId: "u_owner", sha256: sha("a"), size: 10, r2Key: "o/a", state: "verified" },
        { ownerId: "u_owner", sha256: sha("b"), size: 10, r2Key: "o/b", state: "pending" },
      ]);
    const file = { versionId: "v1", ownerId: "u_owner", size: 10, contentType: "text/html" };
    await db()
      .insert(schema.versionFiles)
      .values([
        { ...file, kind: "published", path: "index.html", sha256: sha("a") },
        { ...file, kind: "published", path: "draft.html", sha256: sha("b") },
        { ...file, kind: "source", path: "src/index.ts", sha256: sha("a") },
        { ...file, kind: "rendered", path: "index.md", sha256: sha("a") },
        { ...file, kind: "block_map", path: "index.json", sha256: sha("a") },
      ]);
  });

  it("finds the artifact with what delivery needs", async () => {
    expect(await findDeliveryArtifact(db(), "k7d2qm4xab", CYCLE)).toMatchObject({
      id: "k7d2qm4xab",
      state: "active",
      accessMode: "public",
      currentVersionId: "v1",
      entrypoint: "index.html",
      indexable: false,
    });
    expect(await findDeliveryArtifact(db(), "zzzzzzzzzz", CYCLE)).toBeNull();
  });

  it("joins the owner's traffic of the asked cycle only, zero without a counter", async () => {
    expect((await findDeliveryArtifact(db(), "k7d2qm4xab", CYCLE))?.traffic).toEqual({
      requests: 0,
      bytes: 0,
    });
    const counter = { ownerId: "u_owner", updatedAt: CYCLE };
    await db()
      .insert(schema.trafficCounters)
      .values([
        { ...counter, cycleStart: CYCLE, requests: 7, bytes: 25_000_000_001 },
        { ...counter, cycleStart: Date.UTC(2026, 9, 1), requests: 99, bytes: 99 },
        { ...counter, ownerId: "u_other", cycleStart: CYCLE, requests: 5, bytes: 5 },
      ]);
    expect((await findDeliveryArtifact(db(), "k7d2qm4xab", CYCLE))?.traffic).toEqual({
      requests: 7,
      bytes: 25_000_000_001,
    });
    const next = Date.UTC(2026, 11, 1);
    expect((await findDeliveryArtifact(db(), "k7d2qm4xab", next))?.traffic).toEqual({
      requests: 0,
      bytes: 0,
    });
  });

  it("never joins the plan (global, decision 0005), which its own read finds, never another owner's", async () => {
    expect(await findDeliveryPlan(db(), "u_owner")).toBeNull();
    await db()
      .insert(schema.ownerPlans)
      .values({ ownerId: "u_other", plan: "enterprise", grantedBy: "test", updatedAt: CYCLE });
    expect(await findDeliveryPlan(db(), "u_owner")).toBeNull();
    await db()
      .insert(schema.ownerPlans)
      .values({
        ownerId: "u_owner",
        plan: "team",
        seats: 3,
        validUntil: CYCLE + 1,
        overrides: { limits: { activeArtifacts: 9 } },
        grantedBy: "test",
        updatedAt: CYCLE,
      });
    // The artifact's lookup leaves the plan to the caller, whatever the plan row says, unless it
    // is asked to join it (one database, `bothSides`).
    expect((await findDeliveryArtifact(db(), "k7d2qm4xab", CYCLE))?.plan).toBeNull();
    const joined = await findDeliveryArtifact(db(), "k7d2qm4xab", CYCLE, undefined, {
      withPlan: true,
    });
    expect(joined?.plan).toEqual({
      plan: "team",
      seats: 3,
      validUntil: CYCLE + 1,
      overrides: { limits: { activeArtifacts: 9 } },
      // The plan's grace rides the same row (decision 0022).
      grace: null,
    });
    expect(joined?.traffic).toEqual({ requests: 0, bytes: 0 });
    expect(
      await findDeliveryArtifact(db(), "k7d2qm4xab", CYCLE, "other.example.com", {
        withPlan: true,
      }),
    ).toBeNull();
    expect(
      (await findDeliveryArtifact(db(), "k7d2qm4xab", CYCLE, undefined, { withPlan: true }))?.id,
    ).toBe("k7d2qm4xab");
    await db().delete(schema.ownerPlans).where(eq(schema.ownerPlans.ownerId, "u_owner"));
    expect(
      (await findDeliveryArtifact(db(), "k7d2qm4xab", CYCLE, undefined, { withPlan: true }))?.plan,
    ).toBeNull();
    await db()
      .insert(schema.ownerPlans)
      .values({
        ownerId: "u_owner",
        plan: "team",
        seats: 3,
        validUntil: CYCLE + 1,
        overrides: { limits: { activeArtifacts: 9 } },
        grantedBy: "test",
        updatedAt: CYCLE,
      });
    expect(await findDeliveryPlan(db(), "u_owner")).toEqual({
      plan: "team",
      seats: 3,
      validUntil: CYCLE + 1,
      overrides: { limits: { activeArtifacts: 9 } },
      // The plan's grace rides the same row (decision 0022).
      grace: null,
    });
  });

  it("joins a workspace's people network allowlist, or reads it with the plan in one read", async () => {
    const ws = "ws_0123456789abcdef0123456789abcdef";
    await env.DB.prepare("DELETE FROM workspaces WHERE id = ?").bind(ws).run();
    await env.DB.exec("UPDATE artifacts SET owner_id = 'ws_0123456789abcdef0123456789abcdef'");
    const joined = () =>
      findDeliveryArtifact(db(), "k7d2qm4xab", CYCLE, undefined, { withPlan: true });
    // No workspace row (or a personal owner): no allowlist.
    expect((await joined())?.networks).toBeNull();
    expect(await findDeliveryOwner(db(), ws)).toEqual({ plan: null, networks: null });
    await db()
      .insert(schema.workspaces)
      .values({
        id: ws,
        slug: "nets",
        name: "Nets",
        createdBy: "u_owner",
        updatedAt: CYCLE,
        policy: { ipAllowlist: ["192.0.2.0/24"], tokenIpAllowlist: ["203.0.113.0/24"] },
      });
    expect((await joined())?.networks).toEqual(["192.0.2.0/24"]);
    // Without the join (a separate regional database) the lookup leaves it to the owner read.
    expect((await findDeliveryArtifact(db(), "k7d2qm4xab", CYCLE))?.networks).toBeNull();
    await db()
      .insert(schema.ownerPlans)
      .values({ ownerId: ws, plan: "enterprise", seats: 2, grantedBy: "t", updatedAt: CYCLE });
    expect(await findDeliveryOwner(db(), ws)).toEqual({
      plan: { plan: "enterprise", seats: 2, validUntil: null, overrides: null, grace: null },
      networks: ["192.0.2.0/24"],
    });
    await env.DB.prepare("DELETE FROM workspaces WHERE id = ?").bind(ws).run();
  });

  it("reads a stored allowlist that is not a list of strings as unreadable, never throwing", () => {
    expect(networksOf(null)).toBeNull();
    expect(networksOf('["192.0.2.0/24"]')).toEqual(["192.0.2.0/24"]);
    expect(networksOf('{"a":1}')).toEqual(UNREADABLE_NETWORKS);
    expect(networksOf("[1]")).toEqual(UNREADABLE_NETWORKS);
    expect(networksOf("not json")).toEqual(UNREADABLE_NETWORKS);
  });

  it("refuses a plan the schema does not know and fewer than one seat", async () => {
    const row = { ownerId: "u_x", grantedBy: "test", updatedAt: CYCLE };
    await expect(
      env.DB.exec(
        "INSERT INTO owner_plans (owner_id, plan, granted_by, updated_at) VALUES ('u_x', 'gold', 't', 0)",
      ),
    ).rejects.toThrow();
    await expect(
      db()
        .insert(schema.ownerPlans)
        .values({ ...row, plan: "pro", seats: 0 }),
    ).rejects.toThrow();
  });

  it("has no entrypoint before the first version is current", async () => {
    await env.DB.exec("UPDATE artifacts SET current_version_id = NULL");
    expect(await findDeliveryArtifact(db(), "k7d2qm4xab", CYCLE)).toMatchObject({
      currentVersionId: null,
      entrypoint: null,
    });
  });

  it("finds the rendered page of a document by its entrypoint", async () => {
    expect(await findRenderedPage(db(), "v1", "index.md")).toEqual({
      path: "index.md",
      sha256: sha("a"),
      size: 10,
      contentType: "text/html",
      r2Key: "o/a",
    });
    expect(await findRenderedPage(db(), "v1", "index.html")).toBeNull();
    expect(await findPublishedFile(db(), "v1", "index.md")).toBeNull();
  });

  it("finds a published file with the R2 key of its verified object", async () => {
    expect(await findPublishedFile(db(), "v1", "index.html")).toEqual({
      path: "index.html",
      sha256: sha("a"),
      size: 10,
      contentType: "text/html",
      r2Key: "o/a",
    });
  });

  it("never serves private sources, unverified objects or other versions", async () => {
    expect(await findPublishedFile(db(), "v1", "src/index.ts")).toBeNull();
    expect(await findPublishedFile(db(), "v1", "draft.html")).toBeNull();
    expect(await findPublishedFile(db(), "v2", "index.html")).toBeNull();
    expect(await findPublishedFile(db(), "v1", "index.json")).toBeNull();
  });
});
