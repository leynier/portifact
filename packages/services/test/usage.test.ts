// Account usage: the counters and windows the publish admission reads, and the blocks they cause.
import { env } from "cloudflare:test";
import { LIMITS } from "@portifact/contracts";
import { createDb, schema } from "@portifact/db";
import { beforeEach, describe, expect, it } from "vitest";
import { commitPublish, preparePublish } from "../src/publish.ts";
import { recordTraffic } from "../src/traffic.ts";
import { getAccountUsage } from "../src/usage.ts";

const OWNER = "u_owner";
const OTHER = "u_other";
const NOW = Date.UTC(2026, 10, 20, 12);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const db = () => createDb(env.DB);

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function prepare(ownerId: string, body: string, now = NOW) {
  const prepared = await preparePublish(db(), {
    ownerId,
    type: "text",
    name: "Notes",
    entrypoint: "notes.txt",
    baseVersionId: null,
    files: [
      {
        path: "notes.txt",
        kind: "published",
        sha256: await sha256(body),
        size: body.length,
        contentType: "text/plain",
      },
    ],
    now,
  });
  if (!prepared.ok) throw new Error(prepared.message);
  return prepared.value;
}

async function publish(ownerId: string, body: string, now = NOW) {
  const prepared = await prepare(ownerId, body, now);
  const hash = await sha256(body);
  await env.ARTIFACTS.put(`objects/${ownerId}/${hash}`, body, { sha256: hash });
  const committed = await commitPublish(db(), env.ARTIFACTS, {
    ownerId,
    sessionId: prepared.sessionId,
    now,
  });
  if (!committed.ok) throw new Error(committed.message);
}

beforeEach(async () => {
  for (const table of [
    "version_files",
    "versions",
    "objects",
    "artifacts",
    "upload_sessions",
    "account_usage",
    "usage_events",
    "traffic_counters",
    "lifecycle_events",
    "sessions",
    "users",
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  const at = new Date(NOW - 30 * DAY);
  await db()
    .insert(schema.users)
    .values(
      [OWNER, OTHER].map((id) => ({
        id,
        name: id,
        email: `${id}@example.com`,
        emailVerified: true,
        createdAt: at,
        updatedAt: at,
      })),
    );
});

describe("getAccountUsage", () => {
  it("reports an account that never published as empty, with the plan's limits", async () => {
    const usage = await getAccountUsage(db(), { ownerId: OWNER, now: NOW });
    expect(usage).toEqual({
      activeArtifacts: { used: 0, limit: 50 },
      storage: { used: 0, reserved: 0, limit: 2_500_000_000 },
      publishesLast24h: { used: 0, limit: 100 },
      newFilesLast24h: { used: 0, limit: 10_000 },
      newBytesLast24h: { used: 0, limit: 5_000_000_000 },
      newObjectsThisMonth: { used: 0, limit: 100_000, resetsAt: Date.UTC(2026, 11, 1) },
      openUploads: { used: 0, limit: 2 },
      trafficThisMonth: {
        requests: { used: 0, limit: 1_000_000 },
        bytes: { used: 0, limit: 25_000_000_000 },
        resetsAt: Date.UTC(2026, 11, 1),
      },
      versionLimits: { publishedBytes: 250_000_000, files: 1_000, documentBytes: 5_000_000 },
      publicAccessFrom: NOW - 23 * DAY,
      blocks: [],
    });
  });

  it("counts the account's publishes, new files and bytes, and nobody else's", async () => {
    await publish(OWNER, "hello", NOW - 2 * HOUR);
    await publish(OWNER, "world!", NOW - HOUR);
    // Content the account already stores is not new.
    await publish(OWNER, "hello", NOW - HOUR);
    await publish(OTHER, "someone else");
    // Outside the 24-hour window.
    await publish(OWNER, "old", NOW - DAY - 1);

    const usage = await getAccountUsage(db(), { ownerId: OWNER, now: NOW });
    expect(usage.activeArtifacts.used).toBe(4);
    expect(usage.publishesLast24h.used).toBe(3);
    expect(usage.newFilesLast24h.used).toBe(2);
    expect(usage.newBytesLast24h.used).toBe(11);
    // Stored bytes include the rendered pages of the text documents.
    const [row] = await db().select().from(schema.accountUsage);
    expect(row?.storedBytes).toBeGreaterThan(14);
    expect(usage.storage).toMatchObject({ used: row?.storedBytes, reserved: 0 });
    expect(usage.newObjectsThisMonth.used).toBe(3);
    expect(usage.blocks).toEqual([]);
  });

  it("reports open uploads and their reserved bytes, blocking at the limit until one expires", async () => {
    const first = await prepare(OWNER, "first", NOW - 2 * HOUR);
    await prepare(OWNER, "second", NOW - HOUR);
    const usage = await getAccountUsage(db(), { ownerId: OWNER, now: NOW });
    expect(usage.openUploads).toEqual({ used: 2, limit: LIMITS.concurrentUploads });
    expect(usage.storage.reserved).toBe(11);
    expect(usage.blocks).toEqual([
      {
        reason: "open_uploads",
        stops: "publishing",
        message: expect.any(String),
        until: first.expiresAt,
      },
    ]);
  });

  it("explains a full publish window and when it frees room", async () => {
    const events = Array.from({ length: LIMITS.publishesPer24h }, (_, i) => ({
      ownerId: OWNER,
      kind: "publish" as const,
      amount: 1,
      at: NOW - DAY + (i + 1) * 60_000,
    }));
    for (let i = 0; i < events.length; i += 20) {
      await db()
        .insert(schema.usageEvents)
        .values(events.slice(i, i + 20));
    }
    const usage = await getAccountUsage(db(), { ownerId: OWNER, now: NOW });
    expect(usage.publishesLast24h.used).toBe(100);
    expect(usage.blocks).toEqual([
      expect.objectContaining({ reason: "publishes_per_24h", until: NOW + 60_000 }),
    ]);
    // The admission agrees.
    await expect(prepare(OWNER, "one more")).rejects.toThrow(/100 times/);
  });

  it("resets the monthly count in a new month and reports a new account's public block", async () => {
    await db()
      .insert(schema.accountUsage)
      .values({
        ownerId: OWNER,
        newObjectsThisMonth: LIMITS.newObjectsPerMonth,
        monthStartedAt: Date.UTC(2026, 9, 1),
      });
    const lastMonth = await getAccountUsage(db(), { ownerId: OWNER, now: NOW });
    expect(lastMonth.newObjectsThisMonth.used).toBe(0);
    expect(lastMonth.blocks).toEqual([]);

    await db()
      .update(schema.accountUsage)
      .set({ monthStartedAt: Date.UTC(2026, 10, 1) });
    const thisMonth = await getAccountUsage(db(), { ownerId: OWNER, now: NOW });
    expect(thisMonth.blocks).toEqual([
      expect.objectContaining({ reason: "new_objects_per_month", until: Date.UTC(2026, 11, 1) }),
    ]);

    const fresh = await getAccountUsage(db(), { ownerId: "u_missing", now: NOW });
    expect(fresh.publicAccessFrom).toBe(NOW + 7 * DAY);
    expect(fresh.blocks.map((block) => block.reason)).toEqual(["account_too_new_for_public"]);
  });

  it("reports this month's traffic and blocks serving once it is used up, until the next month", async () => {
    const cycle = Date.UTC(2026, 10, 1);
    await recordTraffic(
      db(),
      [
        { ownerId: OWNER, cycleStart: cycle, requests: 10, bytes: 1_000 },
        { ownerId: OWNER, cycleStart: Date.UTC(2026, 9, 1), requests: 999_999, bytes: 9 },
        { ownerId: OTHER, cycleStart: cycle, requests: 1_000_000, bytes: 0 },
      ],
      NOW,
    );
    const usage = await getAccountUsage(db(), { ownerId: OWNER, now: NOW });
    expect(usage.trafficThisMonth).toEqual({
      requests: { used: 10, limit: 1_000_000 },
      bytes: { used: 1_000, limit: 25_000_000_000 },
      resetsAt: Date.UTC(2026, 11, 1),
    });
    expect(usage.blocks).toEqual([]);

    const other = await getAccountUsage(db(), { ownerId: OTHER, now: NOW });
    expect(other.blocks).toEqual([
      {
        reason: "traffic",
        stops: "serving",
        message: expect.stringContaining("429"),
        until: Date.UTC(2026, 11, 1),
      },
    ]);
    // A new month starts from zero.
    const december = await getAccountUsage(db(), { ownerId: OTHER, now: Date.UTC(2026, 11, 1) });
    expect(december.trafficThisMonth.requests.used).toBe(0);
    expect(december.blocks).toEqual([]);
  });
});
