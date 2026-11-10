// Traffic counters: batched upserts that add up, the current cycle's read and the pruning job.
import { env } from "cloudflare:test";
import { regionsFromEnv, schema } from "@portifact/db";
import { asc } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getTraffic, pruneTrafficCounters, recordTraffic } from "../src/traffic.ts";

const NOW = Date.UTC(2026, 10, 20, 12);
const NOVEMBER = Date.UTC(2026, 10, 1);
const db = () => regionsFromEnv(env).get("default").db;

const rows = () =>
  db()
    .select()
    .from(schema.trafficCounters)
    .orderBy(asc(schema.trafficCounters.ownerId), asc(schema.trafficCounters.cycleStart));

beforeEach(async () => {
  await env.DB.exec("DELETE FROM traffic_counters");
});

describe("recordTraffic", () => {
  it("creates a counter and adds later batches to it, per account and cycle", async () => {
    const delta = { ownerId: "u_a", cycleStart: NOVEMBER, requests: 2, bytes: 100 };
    await recordTraffic(db(), [delta, { ...delta, ownerId: "u_b", requests: 1, bytes: 0 }], NOW);
    await recordTraffic(db(), [{ ...delta, requests: 3, bytes: 50 }], NOW + 5);
    await recordTraffic(db(), [{ ...delta, cycleStart: Date.UTC(2026, 11, 1) }], NOW + 9);
    expect(await rows()).toEqual([
      { ownerId: "u_a", cycleStart: NOVEMBER, requests: 5, bytes: 150, updatedAt: NOW + 5 },
      {
        ownerId: "u_a",
        cycleStart: Date.UTC(2026, 11, 1),
        requests: 2,
        bytes: 100,
        updatedAt: NOW + 9,
      },
      { ownerId: "u_b", cycleStart: NOVEMBER, requests: 1, bytes: 0, updatedAt: NOW },
    ]);
  });

  it("adds concurrent batches from several isolates without losing any", async () => {
    const delta = { ownerId: "u_a", cycleStart: NOVEMBER, requests: 1, bytes: 10 };
    await Promise.all(Array.from({ length: 20 }, () => recordTraffic(db(), [delta], NOW)));
    expect(await getTraffic(db(), "u_a", NOW)).toEqual({ requests: 20, bytes: 200 });
  });

  it("keeps the newest update time when a late batch lands", async () => {
    const delta = { ownerId: "u_a", cycleStart: NOVEMBER, requests: 1, bytes: 1 };
    await recordTraffic(db(), [delta], NOW);
    await recordTraffic(db(), [delta], NOW - 1_000);
    expect((await rows())[0]?.updatedAt).toBe(NOW);
  });

  it("writes nothing for an empty batch or deltas that counted nothing", async () => {
    await recordTraffic(db(), [], NOW);
    await recordTraffic(
      db(),
      [{ ownerId: "u_a", cycleStart: NOVEMBER, requests: 0, bytes: 0 }],
      NOW,
    );
    expect(await rows()).toEqual([]);
  });
});

describe("getTraffic", () => {
  it("reads the cycle that contains the instant, zero without a counter", async () => {
    expect(await getTraffic(db(), "u_a", NOW)).toEqual({ requests: 0, bytes: 0 });
    await recordTraffic(
      db(),
      [{ ownerId: "u_a", cycleStart: Date.UTC(2026, 9, 1), requests: 4, bytes: 4 }],
      NOW,
    );
    expect(await getTraffic(db(), "u_a", NOW)).toEqual({ requests: 0, bytes: 0 });
    expect(await getTraffic(db(), "u_a", Date.UTC(2026, 9, 31))).toEqual({ requests: 4, bytes: 4 });
  });
});

describe("pruneTrafficCounters", () => {
  it("keeps the current and previous cycles and deletes older ones", async () => {
    const cycles = [Date.UTC(2026, 8, 1), Date.UTC(2026, 9, 1), NOVEMBER];
    await recordTraffic(
      db(),
      cycles.map((cycleStart) => ({ ownerId: "u_a", cycleStart, requests: 1, bytes: 1 })),
      NOW,
    );
    expect(await pruneTrafficCounters(db(), NOW)).toBe(1);
    expect((await rows()).map((row) => row.cycleStart)).toEqual(cycles.slice(1));
    expect(await pruneTrafficCounters(db(), NOW)).toBe(0);
  });
});
