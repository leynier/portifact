// Delivery of an EU artifact (decision 0005, "Two-region audit"): the content Worker gets only
// the ID, the global directory says the region, the bytes come from the EU bucket, traffic and
// openings land in the EU databases, and a warm request costs the one regional read it always did.
import { env } from "cloudflare:test";
import { regionsFromEnv, schema } from "@portifact/db";
import { describe, expect, it } from "vitest";
import { deliveryCacheSizes } from "../src/directory.ts";
import { handle, isolateMeter, isolateOpenings } from "../src/index.ts";
import type { TrafficCharge } from "../src/traffic.ts";

const ID = "e5u2qm4xab";
const OWNER = "ws_00000000000000000000000000000e05";
const NOW = Date.UTC(2026, 10, 10, 12);
const BODY = "<h1>Stored in the EU</h1>";
const HASH = "e".repeat(64);
const eu = () => regionsFromEnv(env).get("eu").db;

async function seedInEu() {
  await regionsFromEnv(env)
    .global.insert(schema.artifactDirectory)
    .values({ id: ID, region: "eu", createdAt: NOW })
    .onConflictDoNothing();
  const key = `objects/${OWNER}/${HASH}`;
  await env.ARTIFACTS_EU.put(key, BODY);
  await eu()
    .insert(schema.objects)
    .values({ ownerId: OWNER, sha256: HASH, size: BODY.length, r2Key: key, state: "verified" })
    .onConflictDoNothing();
  await eu()
    .insert(schema.artifacts)
    .values({
      id: ID,
      ownerId: OWNER,
      type: "site",
      name: "Plan",
      state: "active",
      accessMode: "public",
      currentVersionId: `${ID}-v1`,
      expiresAt: NOW + 10 * 86_400_000,
    })
    .onConflictDoNothing();
  await eu()
    .insert(schema.versions)
    .values({
      id: `${ID}-v1`,
      artifactId: ID,
      number: 1,
      authorId: "u_admin",
      entrypoint: "index.html",
      publishedBytes: BODY.length,
    })
    .onConflictDoNothing();
  await eu()
    .insert(schema.versionFiles)
    .values({
      versionId: `${ID}-v1`,
      kind: "published",
      path: "index.html",
      ownerId: OWNER,
      sha256: HASH,
      size: BODY.length,
      contentType: "text/html; charset=utf-8",
    })
    .onConflictDoNothing();
}

/** The environment with every statement each control database runs counted. */
function counted() {
  const calls = { global: 0, eu: 0 };
  const count = (d1: D1Database, key: keyof typeof calls) =>
    new Proxy(d1, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            calls[key] += 1;
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return { env: { ...env, DB: count(env.DB, "global"), DB_EU: count(env.DB_EU, "eu") }, calls };
}

describe("an artifact in the EU region", () => {
  it("is served from the EU bucket, charged to the EU database, and warm costs one regional read", async () => {
    await seedInEu();
    const charges: { charge: TrafficCharge; region: string | undefined }[] = [];
    const get = (target: typeof env) =>
      handle(new Request(`https://${ID}.portifact.dev/index.html`), target, NOW, (charge, region) =>
        charges.push({ charge, region }),
      );
    const cold = counted();
    const first = await get(cold.env);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe(BODY);
    // Cold: the directory, the plan and budget protection's state (cached a minute, as before)
    // from the global database; the artifact and its file from the EU one.
    expect(cold.calls).toEqual({ global: 3, eu: 2 });
    expect(deliveryCacheSizes()).toEqual({ regions: 1, plans: 1 });
    const warm = counted();
    expect((await get(warm.env)).status).toBe(200);
    // Warm: nothing global, the same two regional reads as a default-region artifact.
    expect(warm.calls).toEqual({ global: 0, eu: 2 });
    expect(charges.map((entry) => entry.region)).toEqual(["eu", "eu"]);
    expect(charges[0]?.charge.ownerId).toBe(OWNER);
  });

  it("answers an ID the directory does not know exactly as with one region, and caches no miss", async () => {
    const request = () => new Request("https://zzzzzzzzzz.portifact.dev/");
    const missing = await handle(request(), env, NOW);
    const oneRegion = await handle(
      request(),
      { ...env, DB_EU: undefined } as unknown as typeof env,
      NOW,
    );
    expect(missing.status).toBe(oneRegion.status);
    expect(await missing.text()).toBe(await oneRegion.text());
    expect(deliveryCacheSizes().regions).toBe(0);
  });

  it("writes the EU artifact's traffic to the EU database and its openings to the EU access log", async () => {
    await seedInEu();
    await env.DB_EU.prepare("update artifacts set access_mode = 'restricted' where id = ?")
      .bind(ID)
      .run();
    const meter = isolateMeter(env, "eu");
    expect(meter).not.toBe(isolateMeter(env));
    meter.count({ ownerId: OWNER, cycleStart: NOW, bytes: 10 }, () => {});
    await meter.flush();
    // The reader is an account (global); the opening is logged in the artifact's region.
    await env.DB.prepare(
      "insert or ignore into users (id, name, email, email_verified, created_at, updated_at) values ('u_reader', 'Reader', 'reader@example.test', 1, 0, 0)",
    ).run();
    const openings = isolateOpenings(env, "eu");
    openings.record({ artifactId: ID, userId: "u_reader", at: NOW }, () => {});
    await openings.flush();
    const rows = async (d1: D1Database, sql: string) =>
      (await d1.prepare(sql).bind(OWNER).all<Record<string, unknown>>()).results;
    const counters = "select requests from traffic_counters where owner_id = ?";
    expect(await rows(env.DB_EU, counters)).toEqual([{ requests: 1 }]);
    expect(await rows(env.DB, counters)).toEqual([]);
    const logged = await env.ACCESS_DB_EU.prepare(
      "select user_id from access_events where artifact_id = ?",
    )
      .bind(ID)
      .all();
    expect(logged.results).toEqual([{ user_id: "u_reader" }]);
    const elsewhere = await env.ACCESS_DB.prepare(
      "select user_id from access_events where artifact_id = ?",
    )
      .bind(ID)
      .all();
    expect(elsewhere.results).toEqual([]);
  });
});
