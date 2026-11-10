// Traffic quota on delivery (plan sections 11, 12 and 16 "Tráfico"): an account whose artifacts
// used this month's traffic gets 429 on all of them, other accounts are unaffected, and the
// quota starts again with the next month.
import { env } from "cloudflare:test";
import { PLANS, TRAFFIC_LIMITS } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { recordTraffic, type TrafficDelta } from "@portifact/services";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handle } from "../src/index.ts";
import { type TrafficCharge, TrafficMeter } from "../src/traffic.ts";

const MINE = "k7d2qm4xab";
const THEIRS = "p3n5wq7yzc";
const NOW = Date.UTC(2026, 10, 30, 23, 59, 59);
const NOVEMBER = Date.UTC(2026, 10, 1);
const DECEMBER = Date.UTC(2026, 11, 1);
const BODY = "<h1>Plan</h1>";
const HASH = "a".repeat(64);
const db = () => regionsFromEnv(env).get("default").db;

async function seed() {
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
  for (const [id, ownerId] of [
    [MINE, "u_mine"],
    [THEIRS, "u_theirs"],
  ] as const) {
    const key = `objects/${ownerId}/${HASH}`;
    await env.ARTIFACTS.put(key, BODY);
    await db().insert(schema.objects).values({
      ownerId,
      sha256: HASH,
      size: BODY.length,
      r2Key: key,
      state: "verified",
    });
    await db()
      .insert(schema.artifacts)
      .values({
        id,
        ownerId,
        type: "site",
        name: "Plan",
        state: "active",
        accessMode: "public",
        currentVersionId: `${id}-v1`,
        expiresAt: NOW + 10 * 86_400_000,
      });
    await db()
      .insert(schema.versions)
      .values({
        id: `${id}-v1`,
        artifactId: id,
        number: 1,
        authorId: ownerId,
        entrypoint: "index.html",
        publishedBytes: BODY.length,
      });
    await db()
      .insert(schema.versionFiles)
      .values({
        versionId: `${id}-v1`,
        kind: "published",
        path: "index.html",
        ownerId,
        sha256: HASH,
        size: BODY.length,
        contentType: "text/html; charset=utf-8",
      });
  }
}

function setTraffic(ownerId: string, requests: number, bytes: number, cycleStart = NOVEMBER) {
  return db()
    .insert(schema.trafficCounters)
    .values({ ownerId, cycleStart, requests, bytes, updatedAt: NOW });
}

function get(
  id: string,
  path = "/",
  init: RequestInit = {},
  options: { now?: number; charges?: TrafficCharge[] } = {},
) {
  const charges = options.charges ?? [];
  return handle(
    new Request(`https://${id}.portifact.dev${path}`, init),
    env,
    options.now ?? NOW,
    (charge) => charges.push(charge),
  );
}

describe("traffic quota", () => {
  beforeEach(() => seed());

  it("answers 429 on every artifact of an account over its requests, and 200 to other accounts", async () => {
    await setTraffic("u_mine", TRAFFIC_LIMITS.requestsPerMonth, 0);
    const charges: TrafficCharge[] = [];
    const response = await get(MINE, "/", {}, { charges });
    expect(response.status).toBe(429);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "portifact-error": "traffic_exceeded",
      // One second before December: the quota is back then.
      "retry-after": "1",
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    });
    const text = await response.text();
    expect(text).toContain("traffic");
    expect(text).not.toContain(BODY);
    expect((await get(MINE, "/missing.css")).status).toBe(429);
    expect((await get(MINE, "/", { method: "HEAD" })).status).toBe(429);
    // The refusal charges nothing.
    expect(charges).toEqual([]);

    const other = await get(THEIRS);
    expect(other.status).toBe(200);
    expect(await other.text()).toBe(BODY);
  });

  it("follows the owner's plan: Pro serves past free's quota until its own, and only for that owner", async () => {
    await db().insert(schema.ownerPlans).values({
      ownerId: "u_mine",
      plan: "pro",
      grantedBy: "test",
      updatedAt: NOW,
    });
    await setTraffic("u_mine", TRAFFIC_LIMITS.requestsPerMonth, TRAFFIC_LIMITS.bytesPerMonth);
    await setTraffic("u_theirs", TRAFFIC_LIMITS.requestsPerMonth, 0);
    expect((await get(MINE)).status).toBe(200);
    expect((await get(THEIRS)).status).toBe(429);
    await env.DB.exec("DELETE FROM traffic_counters WHERE owner_id = 'u_mine'");
    await setTraffic("u_mine", PLANS.pro.limits.requestsPerMonth, 0);
    expect((await get(MINE)).status).toBe(429);
    await env.DB.exec("DELETE FROM traffic_counters WHERE owner_id = 'u_mine'");
    await setTraffic("u_mine", 0, PLANS.pro.limits.bytesPerMonth);
    expect((await get(MINE)).status).toBe(429);
  });

  it("goes back to free's quota once the plan expires", async () => {
    await db().insert(schema.ownerPlans).values({
      ownerId: "u_mine",
      plan: "pro",
      validUntil: NOW,
      grantedBy: "test",
      updatedAt: NOW,
    });
    await setTraffic("u_mine", TRAFFIC_LIMITS.requestsPerMonth, 0);
    expect((await get(MINE)).status).toBe(429);
  });

  it("answers 429 once the bytes are used up, whatever the request count", async () => {
    await setTraffic("u_mine", 1, TRAFFIC_LIMITS.bytesPerMonth);
    expect((await get(MINE)).status).toBe(429);
  });

  it("serves one request below either limit", async () => {
    await setTraffic(
      "u_mine",
      TRAFFIC_LIMITS.requestsPerMonth - 1,
      TRAFFIC_LIMITS.bytesPerMonth - 1,
    );
    expect((await get(MINE)).status).toBe(200);
  });

  it("serves again when the next month starts, and charges the new cycle", async () => {
    await setTraffic("u_mine", TRAFFIC_LIMITS.requestsPerMonth, TRAFFIC_LIMITS.bytesPerMonth);
    expect((await get(MINE)).status).toBe(429);
    const charges: TrafficCharge[] = [];
    const response = await get(MINE, "/", {}, { now: DECEMBER, charges });
    expect(response.status).toBe(200);
    expect(charges).toEqual([{ ownerId: "u_mine", cycleStart: DECEMBER, bytes: BODY.length }]);
  });

  it("charges each served request with the body bytes it sends", async () => {
    const charges: TrafficCharge[] = [];
    const at = { charges };
    await get(MINE, "/", {}, at);
    await get(MINE, "/", { method: "HEAD" }, at);
    await get(MINE, "/", { headers: { "If-None-Match": `"${HASH}"` } }, at);
    await get(MINE, "/", { headers: { Range: "bytes=0-3" } }, at);
    await get(MINE, "/missing.css", {}, at);
    expect(charges.map((charge) => charge.bytes)).toEqual([BODY.length, 0, 0, 4, 0]);
    expect(new Set(charges.map((charge) => `${charge.ownerId}:${charge.cycleStart}`))).toEqual(
      new Set([`u_mine:${NOVEMBER}`]),
    );
  });

  it("charges nothing for requests no artifact answers", async () => {
    const charges: TrafficCharge[] = [];
    await get("zzzzzzzzzz", "/", {}, { charges });
    await get(MINE, "/", { method: "POST" }, { charges });
    await get(MINE, "/__portifact/report", {}, { charges });
    await env.DB.exec(`UPDATE artifacts SET access_mode = 'restricted' WHERE id = '${MINE}'`);
    await get(MINE, "/", {}, { charges });
    expect(charges).toEqual([]);
  });

  it("turns to 429 once the metered traffic reaches the limit", async () => {
    await setTraffic("u_mine", TRAFFIC_LIMITS.requestsPerMonth - 1, 0);
    const meter = new TrafficMeter((deltas) => recordTraffic(db(), deltas, NOW), 0);
    const waits: Promise<unknown>[] = [];
    const count = (charge: TrafficCharge) => meter.count(charge, (p) => waits.push(p));
    const send = () => handle(new Request(`https://${MINE}.portifact.dev/`), env, NOW, count);
    expect((await send()).status).toBe(200);
    await Promise.all(waits);
    expect((await send()).status).toBe(429);
    expect((await get(THEIRS)).status).toBe(200);
  });
});

describe("TrafficMeter", () => {
  const charge = { ownerId: "u_a", cycleStart: NOVEMBER, bytes: 10 };

  it("adds up a window's requests per account and cycle and writes them once", async () => {
    const writes: TrafficDelta[][] = [];
    const meter = new TrafficMeter(async (deltas) => {
      writes.push(deltas);
    }, 0);
    const waits: Promise<unknown>[] = [];
    const waitUntil = (promise: Promise<unknown>) => waits.push(promise);
    meter.count(charge, waitUntil);
    meter.count({ ...charge, bytes: 5 }, waitUntil);
    meter.count({ ...charge, ownerId: "u_b" }, waitUntil);
    meter.count({ ...charge, cycleStart: DECEMBER }, waitUntil);
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
    expect(writes).toEqual([
      [
        { ownerId: "u_a", cycleStart: NOVEMBER, requests: 2, bytes: 15 },
        { ownerId: "u_b", cycleStart: NOVEMBER, requests: 1, bytes: 10 },
        { ownerId: "u_a", cycleStart: DECEMBER, requests: 1, bytes: 10 },
      ],
    ]);
    expect(meter.pending()).toEqual([]);
    // The next charge opens a new window.
    meter.count(charge, waitUntil);
    expect(waits).toHaveLength(2);
    await Promise.all(waits);
    expect(writes).toHaveLength(2);
  });

  it("waits for its window before writing", async () => {
    vi.useFakeTimers();
    try {
      const write = vi.fn(async () => {});
      const meter = new TrafficMeter(write, 5_000);
      let flushed: Promise<unknown> = Promise.resolve();
      meter.count(charge, (promise) => {
        flushed = promise;
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(write).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await flushed;
      expect(write).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the deltas of a failed write for the next window", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    const writes: TrafficDelta[][] = [];
    const meter = new TrafficMeter(async (deltas) => {
      if (fail) throw new Error("D1 unavailable");
      writes.push(deltas);
    }, 0);
    const waits: Promise<unknown>[] = [];
    const waitUntil = (promise: Promise<unknown>) => waits.push(promise);
    meter.count(charge, waitUntil);
    await Promise.all(waits);
    expect(meter.pending()).toEqual([{ ...charge, requests: 1 }]);
    expect(error).toHaveBeenCalledOnce();
    expect(String(error.mock.calls[0]?.[0])).not.toContain("u_a");
    fail = false;
    meter.count(charge, waitUntil);
    await Promise.all(waits);
    expect(writes).toEqual([[{ ...charge, requests: 2, bytes: 20 }]]);
    error.mockRestore();
  });

  it("writes nothing when nothing is pending", async () => {
    const write = vi.fn(async () => {});
    await new TrafficMeter(write).flush();
    expect(write).not.toHaveBeenCalled();
  });
});
