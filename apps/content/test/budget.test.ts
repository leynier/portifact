import { env } from "cloudflare:test";
import { createDb, schema } from "@portifact/db";
import { setBudgetOverride } from "@portifact/services";
import { beforeEach, describe, expect, it } from "vitest";
import { overTrafficLimit, PROTECTION_TTL_MS, resetProtectionCache } from "../src/budget.ts";
import { handle } from "../src/index.ts";

const ID = "b7d2qm4xab";
const ORIGIN = `https://${ID}.portifact.dev`;
const NOW = Date.UTC(2026, 10, 8, 12);
const DAY = 86_400_000;
const HASH = "e".repeat(64);
const db = () => createDb(env.DB);

/** A rate limiter that answers `success` and records the keys it was asked about. */
function limiter(success: boolean) {
  const keys: string[] = [];
  return {
    keys,
    binding: {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success };
      },
    } as RateLimit,
  };
}

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

async function seedPublicSite() {
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
      accessMode: "public",
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

const visit = (limits: { PUBLIC_TRAFFIC_LIMIT?: RateLimit }, charges: unknown[] = []) =>
  handle(
    new Request(`${ORIGIN}/`, { headers: { "CF-Connecting-IP": "203.0.113.7" } }),
    { ...env, ...limits },
    NOW,
    (charge) => charges.push(charge),
  );

describe("budget protection on delivery", () => {
  beforeEach(seedPublicSite);

  it("has the rate limit bindings configured", () => {
    expect(typeof env.PUBLIC_TRAFFIC_LIMIT?.limit).toBe("function");
    expect(typeof env.PROTECTED_TRAFFIC_LIMIT?.limit).toBe("function");
  });

  it("serves normally while protection does not touch traffic", async () => {
    for (const steps of [null, 1, 2]) {
      await protect(steps);
      const over = limiter(false);
      const response = await visit({ PUBLIC_TRAFFIC_LIMIT: over.binding });
      expect(response.status, String(steps)).toBe(200);
      expect(over.keys).toEqual([]);
    }
  });

  it("rate limits public visitors from the third step, keyed by their IP", async () => {
    await protect(3);
    const over = limiter(false);
    const limited = await visit({ PUBLIC_TRAFFIC_LIMIT: over.binding });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect(limited.headers.get("Cache-Control")).toBe("no-store");
    expect(await limited.text()).toContain("Too many requests right now");
    expect(over.keys).toEqual(["public:203.0.113.7"]);

    const under = limiter(true);
    const served = await visit({ PUBLIC_TRAFFIC_LIMIT: under.binding });
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("<h1>Plan</h1>");
  });

  it("checks the traffic quota first and charges no traffic for a budget refusal", async () => {
    await protect(3);
    const over = limiter(false);
    const charges: unknown[] = [];
    expect((await visit({ PUBLIC_TRAFFIC_LIMIT: over.binding }, charges)).status).toBe(429);
    expect(charges).toEqual([]);

    await db().delete(schema.trafficCounters);
    await db()
      .insert(schema.trafficCounters)
      .values({
        ownerId: "u_owner",
        cycleStart: Date.UTC(2026, 10, 1),
        requests: 1_000_000,
        bytes: 0,
        updatedAt: NOW,
      });
    over.keys.length = 0;
    const exhausted = await visit({ PUBLIC_TRAFFIC_LIMIT: over.binding });
    expect(exhausted.status).toBe(429);
    expect(exhausted.headers.get("portifact-error")).toBe("traffic_exceeded");
    // The account's own quota answers before the platform's limiter is consulted.
    expect(over.keys).toEqual([]);
    await db().delete(schema.trafficCounters);
  });

  it("limits protected traffic only at the last step", async () => {
    const request = new Request(`${ORIGIN}/`);
    const over = limiter(false);
    const limits = { PROTECTED_TRAFFIC_LIMIT: over.binding };
    await protect(3);
    expect(await overTrafficLimit(request, limits, db(), false, NOW)).toBe(false);
    await protect(4);
    expect(await overTrafficLimit(request, limits, db(), false, NOW)).toBe(true);
    expect(over.keys).toEqual(["protected:unknown"]);
    // Without a binding the step cannot apply, and delivery is unchanged.
    expect(await overTrafficLimit(request, {}, db(), false, NOW)).toBe(false);
  });

  it("rereads the protection at most once a minute", async () => {
    const request = new Request(`${ORIGIN}/`);
    const limits = { PUBLIC_TRAFFIC_LIMIT: limiter(false).binding };
    await protect(3);
    expect(await overTrafficLimit(request, limits, db(), true, NOW)).toBe(true);
    await db().delete(schema.platformBudget);
    expect(await overTrafficLimit(request, limits, db(), true, NOW + PROTECTION_TTL_MS - 1)).toBe(
      true,
    );
    expect(await overTrafficLimit(request, limits, db(), true, NOW + PROTECTION_TTL_MS)).toBe(
      false,
    );
  });

  it("fails open when the state cannot be read", async () => {
    resetProtectionCache();
    const broken = new Proxy(db(), {
      get(target, property, receiver) {
        if (property === "select") {
          return () => {
            throw new Error("D1 unavailable");
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const limits = { PUBLIC_TRAFFIC_LIMIT: limiter(false).binding };
    expect(await overTrafficLimit(new Request(ORIGIN), limits, broken, true, NOW)).toBe(false);
    resetProtectionCache();
  });
});
