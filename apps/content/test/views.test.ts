// Page views on the content Worker (premium plan P8, decision 0007): which answers delivery
// counts, the per-isolate batching that writes them once per window, and that delivery itself
// never writes a row per request.
import { env } from "cloudflare:test";
import { createAccessDb, regionsFromEnv, schema } from "@portifact/db";
import type { ViewDelta } from "@portifact/services";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handle, isolateViews } from "../src/index.ts";
import { VIEWS_FLUSH_MS, type ViewCharge, ViewMeter } from "../src/views.ts";

const ID = "v7d2qm4xab";
const ORIGIN = `https://${ID}.portifact.dev`;
const APP = "https://app.portifact.com";
const NOW = Date.UTC(2026, 10, 8, 12);
const TODAY = Date.UTC(2026, 10, 8);
const DAY = 86_400_000;
const OWNER = "vw_owner";
const sha = (c: string) => c.repeat(64);
const db = () => regionsFromEnv(env).get("default").db;

const files = {
  "index.html": { body: "<h1>Plan</h1>", type: "text/html; charset=utf-8", hash: sha("1") },
  "app.js": { body: "console.log(1)", type: "text/javascript", hash: sha("2") },
  "data.txt": { body: "0123", type: "text/plain; charset=utf-8", hash: sha("3") },
} as const;

async function seed(options: { bar: boolean; plan: "free" | "pro" | null }) {
  for (const table of [
    "traffic_counters",
    "owner_plans",
    "version_files",
    "versions",
    "objects",
    "artifacts",
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  await env.ACCESS_DB.exec("DELETE FROM artifact_views");
  await db()
    .insert(schema.artifacts)
    .values({
      id: ID,
      ownerId: OWNER,
      type: "site",
      name: "Plan",
      state: "active",
      accessMode: "public",
      bar: options.bar,
      currentVersionId: "vw1",
      expiresAt: NOW + 10 * DAY,
    });
  await db().insert(schema.versions).values({
    id: "vw1",
    artifactId: ID,
    number: 1,
    authorId: OWNER,
    entrypoint: "index.html",
    publishedBytes: 30,
  });
  for (const [path, file] of Object.entries(files)) {
    const key = `objects/${OWNER}/${file.hash}`;
    await env.ARTIFACTS.put(key, file.body);
    await db().insert(schema.objects).values({
      ownerId: OWNER,
      sha256: file.hash,
      size: file.body.length,
      r2Key: key,
      state: "verified",
    });
    await db().insert(schema.versionFiles).values({
      versionId: "vw1",
      kind: "published",
      path,
      ownerId: OWNER,
      sha256: file.hash,
      size: file.body.length,
      contentType: file.type,
    });
  }
  if (options.plan !== null) {
    await db()
      .insert(schema.ownerPlans)
      .values({ ownerId: OWNER, plan: options.plan, seats: 1, grantedBy: "test", updatedAt: NOW });
  }
}

const TOP_LEVEL = {
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "document",
};
const VIEWER_FRAME = {
  "Sec-Fetch-Site": "cross-site",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "iframe",
};

/** Sends one request and returns its status with the views it counted. */
async function visit(path: string, headers: Record<string, string>, method = "GET") {
  const views: ViewCharge[] = [];
  const response = await handle(
    new Request(`${ORIGIN}${path}`, { method, headers }),
    { ...env, APP_ORIGIN: APP },
    NOW,
    undefined,
    undefined,
    (view) => views.push(view),
  );
  return { status: response.status, views };
}

describe("counting views in delivery", () => {
  const anonymous: ViewCharge = {
    artifactId: ID,
    ownerId: OWNER,
    at: NOW,
    visitorId: null,
    expiresAt: TODAY + 366 * DAY,
  };

  it.each<[string, boolean, string, Record<string, string>, string, number, number]>([
    // name, bar, path, headers, method, status, views
    ["bar off: the top-level page", false, "/", TOP_LEVEL, "GET", 200, 1],
    [
      "bar off: a further page of the site",
      false,
      "/index.html",
      { ...TOP_LEVEL, "Sec-Fetch-Site": "same-origin" },
      "GET",
      200,
      1,
    ],
    ["bar on: the redirect to the viewer", true, "/", TOP_LEVEL, "GET", 303, 0],
    ["bar on: the viewer's frame", true, "/", VIEWER_FRAME, "GET", 200, 1],
    ["bar off: another site's embed", false, "/", VIEWER_FRAME, "GET", 200, 1],
    [
      "a sibling artifact's frame",
      false,
      "/",
      { ...VIEWER_FRAME, "Sec-Fetch-Site": "same-site" },
      "GET",
      200,
      0,
    ],
    [
      "an embed element",
      false,
      "/",
      { ...VIEWER_FRAME, "Sec-Fetch-Dest": "embed", "Sec-Fetch-Mode": "navigate" },
      "GET",
      200,
      0,
    ],
    [
      "a subresource",
      true,
      "/app.js",
      { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "script" },
      "GET",
      200,
      0,
    ],
    ["a file that is not a page", false, "/data.txt", TOP_LEVEL, "GET", 200, 0],
    ["no fetch metadata", false, "/", {}, "GET", 200, 0],
    ["HEAD", false, "/", TOP_LEVEL, "HEAD", 200, 0],
    ["a missing page", false, "/nope.html", TOP_LEVEL, "GET", 404, 0],
  ])("%s", async (_name, bar, path, headers, method, status, count) => {
    await seed({ bar, plan: "pro" });
    const result = await visit(path, headers, method);
    expect(result.status).toBe(status);
    expect(result.views).toEqual(count === 1 ? [anonymous] : []);
  });

  it("counts a revalidated reload", async () => {
    await seed({ bar: false, plan: "pro" });
    const result = await visit("/", { ...TOP_LEVEL, "If-None-Match": `"${sha("1")}"` });
    expect(result).toEqual({ status: 304, views: [anonymous] });
  });

  it("counts nothing for an owner without analytics, free or expired", async () => {
    for (const plan of ["free", null] as const) {
      await seed({ bar: false, plan });
      expect((await visit("/", TOP_LEVEL)).views).toEqual([]);
    }
    await seed({ bar: false, plan: "pro" });
    await db().update(schema.ownerPlans).set({ validUntil: NOW });
    expect((await visit("/", TOP_LEVEL)).views).toEqual([]);
  });

  it("sets the row's expiry from the owner's plan", async () => {
    await seed({ bar: false, plan: "pro" });
    await db()
      .update(schema.ownerPlans)
      .set({ validUntil: NOW + 90 * DAY });
    const [view] = (await visit("/", TOP_LEVEL)).views;
    // Kept until the plan's grace ends, 60 days after it (decision 0022).
    expect(view?.expiresAt).toBe(NOW + 150 * DAY);
  });

  it("writes no row while serving: the meter writes once per window", async () => {
    await seed({ bar: false, plan: "pro" });
    for (let i = 0; i < 20; i += 1) {
      await handle(new Request(`${ORIGIN}/`, { headers: TOP_LEVEL }), env, NOW);
    }
    const { results } = await env.ACCESS_DB.prepare(
      "select count(*) as n from artifact_views",
    ).all<{
      n: number;
    }>();
    expect(results[0]?.n).toBe(0);
  });
});

describe("view meter", () => {
  const charge = (overrides: Partial<ViewCharge> = {}): ViewCharge => ({
    artifactId: "a2345abcde",
    ownerId: "u_owner",
    at: NOW,
    visitorId: null,
    expiresAt: TODAY + 31 * DAY,
    ...overrides,
  });

  function harness(write: (deltas: ViewDelta[]) => Promise<unknown> = async () => undefined) {
    const writes: ViewDelta[][] = [];
    const waits: Promise<unknown>[] = [];
    const meter = new ViewMeter(async (deltas) => {
      writes.push(structuredClone(deltas));
      await write(deltas);
    }, 0);
    const count = (value: ViewCharge) => meter.count(value, (promise) => waits.push(promise));
    const settle = () => Promise.all(waits.splice(0));
    return { meter, writes, count, settle, waits };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds views up per artifact and day and writes once per window", async () => {
    const { writes, count, settle, waits } = harness();
    count(charge());
    count(charge({ visitorId: "u_a" }));
    count(charge({ visitorId: "u_a", expiresAt: TODAY + 366 * DAY }));
    count(charge({ at: NOW - DAY }));
    count(charge({ artifactId: "b2345abcde" }));
    expect(waits).toHaveLength(1);
    expect(writes).toEqual([]);
    await settle();
    expect(writes).toEqual([
      [
        {
          artifactId: "a2345abcde",
          ownerId: "u_owner",
          day: TODAY,
          anonymous: 1,
          signedIn: { u_a: 2 },
          expiresAt: TODAY + 366 * DAY,
        },
        {
          artifactId: "a2345abcde",
          ownerId: "u_owner",
          day: TODAY - DAY,
          anonymous: 1,
          signedIn: {},
          expiresAt: TODAY + 31 * DAY,
        },
        {
          artifactId: "b2345abcde",
          ownerId: "u_owner",
          day: TODAY,
          anonymous: 1,
          signedIn: {},
          expiresAt: TODAY + 31 * DAY,
        },
      ],
    ]);
  });

  it("keeps a failed write for the next window and logs no identifiers", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    const { meter, writes, count, settle } = harness(async () => {
      if (fail) throw new Error("d1 down");
    });
    count(charge({ visitorId: "u_a" }));
    await settle();
    expect(meter.pending()).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(JSON.stringify({ event: "view_write_failed" }));
    fail = false;
    count(charge({ visitorId: "u_a" }));
    await settle();
    expect(writes.at(-1)?.[0]?.signedIn).toEqual({ u_a: 2 });
    expect(meter.pending()).toEqual([]);
    await meter.flush();
    expect(writes).toHaveLength(2);
  });

  it("waits a few seconds before writing by default", () => {
    expect(VIEWS_FLUSH_MS).toBe(5_000);
  });

  it("adds up exactly across isolates writing to the access database at once", async () => {
    await env.ACCESS_DB.exec("DELETE FROM artifact_views");
    const meters = Array.from(
      { length: 6 },
      () =>
        new ViewMeter(
          (deltas) =>
            import("@portifact/services").then(({ recordViews }) =>
              recordViews(db().global, createAccessDb(env.ACCESS_DB), deltas),
            ),
          0,
        ),
    );
    const waits: Promise<unknown>[] = [];
    for (let window = 0; window < 3; window += 1) {
      meters.forEach((meter, i) => {
        for (let n = 0; n < 50; n += 1) {
          meter.count(charge({ visitorId: n % 5 === 0 ? `u_${i}` : null }), (p) => waits.push(p));
        }
      });
      await Promise.all(waits.splice(0));
    }
    const { results } = await env.ACCESS_DB.prepare(
      "select views, signed_in_views from artifact_views where artifact_id = 'a2345abcde'",
    ).all<{ views: number; signed_in_views: number }>();
    expect(results).toEqual([{ views: 6 * 3 * 50, signed_in_views: 6 * 3 * 10 }]);
  });
});

describe("the isolate's view meter", () => {
  beforeEach(() => env.ACCESS_DB.exec("DELETE FROM artifact_views"));

  it("writes the views to the access database", async () => {
    const meter = isolateViews(env);
    expect(isolateViews(env)).toBe(meter);
    meter.count(
      {
        artifactId: "i2345abcde",
        ownerId: "u_iso",
        at: NOW,
        visitorId: null,
        expiresAt: NOW + DAY,
      },
      () => {},
    );
    await meter.flush();
    const { results } = await env.ACCESS_DB.prepare(
      "select artifact_id, day, views from artifact_views",
    ).all();
    expect(results).toEqual([{ artifact_id: "i2345abcde", day: TODAY, views: 1 }]);
  });
});
