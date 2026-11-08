import { env } from "cloudflare:test";
import { createDb, schema } from "@portifact/db";
import { PROTECTION_TRAFFIC_LIMITS } from "@portifact/domain";
import { setBudgetOverride } from "@portifact/services";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_REMEMBERED_REFUSALS,
  overTrafficLimit,
  PROTECTION_TTL_MS,
  resetProtectionCache,
} from "../src/budget.ts";
import { READ_COOKIE, seal } from "../src/cookies.ts";
import { handle } from "../src/index.ts";
import type { TrafficHit, TrafficLimiter } from "../src/traffic-limiter.ts";

const ID = "b7d2qm4xab";
const ORIGIN = `https://${ID}.portifact.dev`;
const NOW = Date.UTC(2026, 10, 8, 12);
const DAY = 86_400_000;
const HASH = "e".repeat(64);
const PERIOD = PROTECTION_TRAFFIC_LIMITS.periodMs;
const db = () => createDb(env.DB);

type Limiters = DurableObjectNamespace<TrafficLimiter>;

/** A stand-in for the limiter namespace that answers `answer` and records each key it counts. */
function fakeLimiters(answer: (key: string) => TrafficHit | Promise<TrafficHit>) {
  const keys: string[] = [];
  const namespace = {
    idFromName: (name: string) => name,
    get: (key: string) => ({
      hit: async () => {
        keys.push(key);
        return answer(key);
      },
    }),
  } as unknown as Limiters;
  return { keys, namespace };
}

const refusing = () => fakeLimiters(() => ({ allowed: false, resetAt: NOW + PERIOD }));

/**
 * How Workers Rate Limiting behaved in production (2026-11-08): every call answered success, so
 * a binding like this one must not be what decides.
 */
const permissiveRateLimit = { limit: async () => ({ success: true }) } as RateLimit;

let ipCounter = 0;
/** A fresh visitor IP: the real limiter keeps its counts for the whole file. */
const freshIp = () => `198.51.100.${++ipCounter}`;

async function protect(steps: number | null) {
  await db().delete(schema.platformBudget);
  if (steps !== null) {
    await setBudgetOverride(db(), {
      level: "protect100",
      steps,
      until: null,
      note: null,
      now: NOW,
    });
  }
  resetProtectionCache();
}

async function seedSite(accessMode: "public" | "restricted") {
  await db().delete(schema.trafficCounters);
  await db().delete(schema.versionFiles);
  await db().delete(schema.versions);
  await db().delete(schema.objects);
  await db().delete(schema.artifacts);
  await db()
    .insert(schema.artifacts)
    .values({
      id: ID,
      ownerId: "u_owner",
      type: "site",
      name: "Plan",
      state: "active",
      accessMode,
      currentVersionId: "v1",
      expiresAt: NOW + 10 * DAY,
    });
  await db().insert(schema.versions).values({
    id: "v1",
    artifactId: ID,
    number: 1,
    authorId: "u_owner",
    entrypoint: "index.html",
    publishedBytes: 13,
  });
  const key = `objects/u_owner/${HASH}`;
  await env.ARTIFACTS.put(key, "<h1>Plan</h1>");
  await db().insert(schema.objects).values({
    ownerId: "u_owner",
    sha256: HASH,
    size: 13,
    r2Key: key,
    state: "verified",
  });
  await db().insert(schema.versionFiles).values({
    versionId: "v1",
    kind: "published",
    path: "index.html",
    ownerId: "u_owner",
    sha256: HASH,
    size: 13,
    contentType: "text/html; charset=utf-8",
  });
}

interface Visit {
  ip?: string;
  limiters?: Limiters | undefined;
  cookie?: string;
  now?: number;
  charges?: unknown[];
}

function visit({ ip = "203.0.113.7", limiters, cookie, now = NOW, charges = [] }: Visit = {}) {
  const headers = new Headers({ "CF-Connecting-IP": ip });
  if (cookie) {
    headers.set("Cookie", cookie);
    headers.set("Sec-Fetch-Site", "same-origin");
    headers.set("Sec-Fetch-Mode", "no-cors");
    headers.set("Sec-Fetch-Dest", "script");
  }
  const testEnv = {
    ...env,
    // Kept to prove it no longer decides anything (see `permissiveRateLimit`).
    PROTECTED_TRAFFIC_LIMIT: permissiveRateLimit,
    PUBLIC_TRAFFIC_LIMIT: permissiveRateLimit,
    TRAFFIC_LIMITER: limiters,
  };
  if (limiters === undefined) testEnv.TRAFFIC_LIMITER = env.TRAFFIC_LIMITER;
  return handle(new Request(`${ORIGIN}/`, { headers }), testEnv, now, (charge) =>
    charges.push(charge),
  );
}

/** A valid read session cookie for the restricted artifact, as the callback would set it. */
async function readCookie() {
  const value = await seal(env.READ_SESSION_SECRET, "pf_read", {
    v: 1,
    sid: "s".repeat(43),
    aid: ID,
    uid: "u_reader",
    gen: 1,
    exp: NOW + 10 * 60_000,
    sexp: NOW + DAY,
  });
  return `${READ_COOKIE}=${value}`;
}

async function statuses(responses: Promise<Response>[]) {
  const counts: Record<number, number> = {};
  for (const response of await Promise.all(responses)) {
    counts[response.status] = (counts[response.status] ?? 0) + 1;
    await response.arrayBuffer();
  }
  return counts;
}

afterEach(() => {
  vi.restoreAllMocks();
  resetProtectionCache();
});

describe("budget protection on public delivery", () => {
  beforeEach(() => seedSite("public"));

  it("has the limiter bound", () => {
    expect(typeof env.TRAFFIC_LIMITER?.idFromName).toBe("function");
  });

  it("serves normally while protection does not touch traffic", async () => {
    for (const steps of [null, 1, 2]) {
      await protect(steps);
      const over = refusing();
      const response = await visit({ limiters: over.namespace });
      expect(response.status, String(steps)).toBe(200);
      expect(over.keys).toEqual([]);
    }
  });

  it("rate limits public visitors from the third step, keyed by their IP", async () => {
    await protect(3);
    const ip = freshIp();
    const served = await statuses(
      Array.from({ length: PROTECTION_TRAFFIC_LIMITS.public }, () => visit({ ip })),
    );
    expect(served).toEqual({ 200: PROTECTION_TRAFFIC_LIMITS.public });

    const limited = await visit({ ip, now: NOW + 15_000 });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("45");
    expect(limited.headers.get("Cache-Control")).toBe("no-store");
    expect(await limited.text()).toContain("Too many requests right now");

    // Another visitor has a limit of their own.
    expect((await visit({ ip: freshIp() })).status).toBe(200);
    // A new window serves the first visitor again.
    resetProtectionCache();
    expect((await visit({ ip, now: NOW + PERIOD })).status).toBe(200);
  });

  it("keys the counter by kind of traffic and visitor IP", async () => {
    await protect(3);
    const over = refusing();
    await visit({ ip: "203.0.113.7", limiters: over.namespace });
    expect(over.keys).toEqual(["public:203.0.113.7"]);
    const request = new Request(`${ORIGIN}/`);
    await protect(4);
    await overTrafficLimit(request, { TRAFFIC_LIMITER: over.namespace }, db(), false, NOW);
    expect(over.keys).toEqual(["public:203.0.113.7", "protected:unknown"]);
  });

  it("checks the traffic quota first and charges no traffic for a budget refusal", async () => {
    await protect(3);
    const over = refusing();
    const charges: unknown[] = [];
    expect((await visit({ limiters: over.namespace, charges })).status).toBe(429);
    expect(charges).toEqual([]);

    await db()
      .insert(schema.trafficCounters)
      .values({
        ownerId: "u_owner",
        cycleStart: Date.UTC(2026, 10, 1),
        requests: 1_000_000,
        bytes: 0,
        updatedAt: NOW,
      });
    resetProtectionCache();
    over.keys.length = 0;
    const exhausted = await visit({ limiters: over.namespace });
    expect(exhausted.status).toBe(429);
    expect(exhausted.headers.get("portifact-error")).toBe("traffic_exceeded");
    // The account's own quota answers before the platform's limiter is consulted.
    expect(over.keys).toEqual([]);
  });

  it("refuses a visitor known to be over the limit without asking the limiter again", async () => {
    await protect(3);
    const over = refusing();
    const limiters = over.namespace;
    expect((await visit({ limiters })).status).toBe(429);
    expect((await visit({ limiters, now: NOW + PERIOD - 1 })).headers.get("Retry-After")).toBe("1");
    expect(over.keys).toHaveLength(1);
    // Once the window ends, the limiter decides again.
    const allowed = fakeLimiters(() => ({ allowed: true, resetAt: NOW + 2 * PERIOD }));
    expect((await visit({ limiters: allowed.namespace, now: NOW + PERIOD })).status).toBe(200);
    expect(allowed.keys).toHaveLength(1);
  });

  it("forgets expired refusals first, and all of them if none expired", async () => {
    // A small memory behaves like the real one; ten thousand requests take seconds per pass.
    const max = 50;
    await protect(3);
    resetProtectionCache({ maxRefusals: max });
    const request = (ip: string) => new Request(ORIGIN, { headers: { "CF-Connecting-IP": ip } });
    let resetAt = NOW + 1;
    const over = fakeLimiters(() => ({ allowed: false, resetAt }));
    const limits = { TRAFFIC_LIMITER: over.namespace };
    for (let i = 0; i < max; i++) {
      await overTrafficLimit(request(`ip-${i}`), limits, db(), true, NOW);
    }
    resetAt = NOW + PERIOD;
    // Full, but every remembered refusal has expired: they go, the new one stays.
    await overTrafficLimit(request("late"), limits, db(), true, NOW + 1);
    for (let i = 0; i < max - 1; i++) {
      await overTrafficLimit(request(`next-${i}`), limits, db(), true, NOW + 1);
    }
    over.keys.length = 0;
    expect(await overTrafficLimit(request("late"), limits, db(), true, NOW + 2)).toBe(NOW + PERIOD);
    expect(over.keys).toEqual([]);
    // Full of refusals still running: all are forgotten, so "late" asks the limiter again.
    await overTrafficLimit(request("overflow"), limits, db(), true, NOW + 2);
    over.keys.length = 0;
    await overTrafficLimit(request("late"), limits, db(), true, NOW + 2);
    expect(over.keys).toEqual(["public:late"]);
    resetProtectionCache();
  });

  it("remembers ten thousand refusing visitors by default", () => {
    expect(MAX_REMEMBERED_REFUSALS).toBe(10_000);
  });

  it("rereads the protection at most once a minute", async () => {
    const request = new Request(`${ORIGIN}/`);
    const limits = {
      TRAFFIC_LIMITER: fakeLimiters(() => ({ allowed: false, resetAt: 0 })).namespace,
    };
    await protect(3);
    expect(await overTrafficLimit(request, limits, db(), true, NOW)).toBe(0);
    await db().delete(schema.platformBudget);
    expect(await overTrafficLimit(request, limits, db(), true, NOW + PROTECTION_TTL_MS - 1)).toBe(
      0,
    );
    expect(await overTrafficLimit(request, limits, db(), true, NOW + PROTECTION_TTL_MS)).toBeNull();
  });

  it("fails open and logs when the state cannot be read", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = new Proxy(db(), {
      get(target, property, receiver) {
        if (property === "select") {
          return () => {
            throw new TypeError("D1 unavailable");
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const limits = { TRAFFIC_LIMITER: refusing().namespace };
    expect(await overTrafficLimit(new Request(ORIGIN), limits, broken, true, NOW)).toBeNull();
    expect(logged).toHaveBeenCalledWith(
      JSON.stringify({ event: "budget_protection_unreadable", error: "TypeError" }),
    );
  });

  it("fails open and logs when the limiter fails", async () => {
    await protect(3);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = fakeLimiters(() => Promise.reject("overloaded"));
    expect((await visit({ limiters: failing.namespace })).status).toBe(200);
    expect(logged).toHaveBeenCalledWith(
      JSON.stringify({ event: "traffic_limiter_failed", error: "string" }),
    );
  });

  it("serves normally without the limiter bound", async () => {
    await protect(4);
    expect(await overTrafficLimit(new Request(ORIGIN), {}, db(), true, NOW)).toBeNull();
    expect(await overTrafficLimit(new Request(ORIGIN), {}, db(), false, NOW)).toBeNull();
  });
});

describe("budget protection on protected delivery", () => {
  beforeEach(() => seedSite("restricted"));

  // Reproduces the production incident of 2026-11-08: with `protect100 --steps 4`, a reader
  // sending requests in parallel to a restricted artifact was never limited while the rate limit
  // binding answered success. The limit must hold whatever that binding says.
  it("limits a protected reader at the last step, exactly, under parallel requests", async () => {
    const cookie = await readCookie();
    await protect(3);
    const ip = freshIp();
    expect(await statuses(Array.from({ length: 20 }, () => visit({ ip, cookie })))).toEqual({
      200: 20,
    });

    await protect(4);
    const burst = PROTECTION_TRAFFIC_LIMITS.protected + 60;
    const other = freshIp();
    expect(
      await statuses(Array.from({ length: burst }, () => visit({ ip: other, cookie }))),
    ).toEqual({ 200: PROTECTION_TRAFFIC_LIMITS.protected, 429: 60 });
  });
});

describe("the traffic limiter", () => {
  const stub = (name: string) => env.TRAFFIC_LIMITER.get(env.TRAFFIC_LIMITER.idFromName(name));

  it("counts a fixed window and starts a new one when it ends", async () => {
    const limiter = stub("unit:window");
    expect(await limiter.hit(2, 1000, NOW)).toEqual({ allowed: true, resetAt: NOW + 1000 });
    expect(await limiter.hit(2, 1000, NOW + 500)).toEqual({ allowed: true, resetAt: NOW + 1000 });
    expect(await limiter.hit(2, 1000, NOW + 999)).toEqual({ allowed: false, resetAt: NOW + 1000 });
    expect(await limiter.hit(2, 1000, NOW + 1000)).toEqual({ allowed: true, resetAt: NOW + 2000 });
  });

  it("starts a new window when a caller's clock is behind the window", async () => {
    const limiter = stub("unit:clock");
    await limiter.hit(1, 1000, NOW);
    expect(await limiter.hit(1, 1000, NOW + 10)).toEqual({ allowed: false, resetAt: NOW + 1000 });
    expect(await limiter.hit(1, 1000, NOW - 5)).toEqual({ allowed: true, resetAt: NOW + 995 });
  });
});
