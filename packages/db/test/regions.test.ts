import { env } from "cloudflare:test";
import { BACKGROUND, requestContextOf, UNKNOWN_REQUEST } from "@portifact/contracts";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  baseEnv,
  globalDb,
  isRegion,
  type Region,
  regionalDb,
  regionsFromEnv,
  schema,
  withBindings,
  withRequestContext,
} from "../src/index.ts";

const NOW = Date.UTC(2026, 10, 9);

describe("regions of a Worker", () => {
  it("has exactly the default region with only DB bound, its handle on the same binding as the global one", async () => {
    const regions = regionsFromEnv({ DB: env.DB, ACCESS_DB: env.ACCESS_DB });
    expect(regions.all().map((handles) => handles.region)).toEqual(["default"]);
    const { db } = regions.get("default");
    expect(db.global).toBe(regions.global);
    // A row written through one handle is read through the other: one binding.
    await regions.global
      .insert(schema.artifactDirectory)
      .values({ id: "regionsaaa", region: "default", createdAt: NOW });
    const [row] = await db
      .select()
      .from(schema.artifactDirectory)
      .where(eq(schema.artifactDirectory.id, "regionsaaa"));
    expect(row).toEqual({ id: "regionsaaa", region: "default", createdAt: NOW });
  });

  it("never falls back for a region without bindings", () => {
    const regions = regionsFromEnv({ DB: env.DB });
    expect(() => regions.get("eu")).toThrow("Region eu has no bindings in this Worker");
    expect(() => regions.get("mars" as Region)).toThrow("Region mars has no bindings");
  });

  it("binds the EU region only with DB_EU, on its own databases and bucket", async () => {
    const regions = regionsFromEnv(env);
    expect(regions.all().map((handles) => handles.region)).toEqual(["default", "eu"]);
    const eu = regions.get("eu");
    expect(eu.db.global).toBe(regions.global);
    expect(eu.accessDb).toBeDefined();
    expect(eu.bucket).toBe(env.ARTIFACTS_EU);
    expect(regions.get("default").bucket).toBe(env.ARTIFACTS);
    // A row written in the EU database is not in the default one: two databases.
    await eu.db
      .insert(schema.artifacts)
      .values({ id: "regionseua", ownerId: "ws_eu", type: "site" as const, name: "EU" });
    const [here] = await eu.db
      .select({ id: schema.artifacts.id })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, "regionseua"));
    const [there] = await regions
      .get("default")
      .db.select({ id: schema.artifacts.id })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, "regionseua"));
    expect(here).toEqual({ id: "regionseua" });
    expect(there).toBeUndefined();
    // The EU access log and bucket are optional bindings of their own.
    expect(regionsFromEnv({ DB: env.DB, DB_EU: env.DB_EU }).get("eu").accessDb).toBeUndefined();
  });

  it("carries the access log database only when the Worker is bound to it", () => {
    expect(regionsFromEnv(env).get("default").accessDb).toBeDefined();
    expect(regionsFromEnv({ DB: env.DB }).get("default").accessDb).toBeUndefined();
  });

  it("knows its regions by name", () => {
    expect(isRegion("default")).toBe(true);
    expect(isRegion("eu")).toBe(true);
    expect(isRegion("mars")).toBe(false);
    expect(isRegion("")).toBe(false);
  });

  it("attaches a regional database to the global database it is given", () => {
    const global = globalDb(env.DB);
    expect(regionalDb(env.DB, global).global).toBe(global);
  });
});

describe("the request context on the handles (decision 0020)", () => {
  it("is carried by every handle built for a request, and fails closed without one", () => {
    const request = { kind: "request", ip: "192.0.2.1" } as const;
    const scoped = withRequestContext(env, request);
    // A view over the bindings: every binding still reads, and the context rides along.
    expect(scoped.DB).toBe(env.DB);
    const regions = regionsFromEnv(scoped);
    expect(regions.global.request).toEqual(request);
    expect(regions.get("default").db.global.request).toEqual(request);
    expect(regionsFromEnv(env).global.request).toEqual(UNKNOWN_REQUEST);
    expect(globalDb(env.DB).request).toEqual(UNKNOWN_REQUEST);
    expect(regionsFromEnv(withRequestContext(env, BACKGROUND)).global.request).toBe(BACKGROUND);
  });

  it("keeps the Worker's own bindings object for caches keyed by it", () => {
    const once = withRequestContext(env, BACKGROUND);
    const twice = withRequestContext(once, { kind: "request", ip: null });
    expect(baseEnv(once)).toBe(env);
    expect(baseEnv(twice)).toBe(env);
    expect(baseEnv(env)).toBe(env);
  });

  it("replaces bindings without losing the context", () => {
    const scoped = withRequestContext(env, { kind: "request", ip: "192.0.2.1" });
    const replaced = withBindings(scoped, { MIGRATION_DB: env.DB });
    expect(replaced.MIGRATION_DB).toBe(env.DB);
    expect(replaced.DB).toBe(env.DB);
    expect(regionsFromEnv(replaced).global.request).toEqual({ kind: "request", ip: "192.0.2.1" });
  });
});

describe("the request context of a request", () => {
  it("comes from CF-Connecting-IP only", () => {
    const at = (headers: Record<string, string>) =>
      requestContextOf(new Request("https://app.portifact.com/", { headers }));
    expect(at({ "CF-Connecting-IP": " 192.0.2.1 " })).toEqual({ kind: "request", ip: "192.0.2.1" });
    expect(at({ "X-Forwarded-For": "192.0.2.1" })).toEqual({ kind: "request", ip: null });
    expect(at({ "CF-Connecting-IP": "" })).toEqual({ kind: "request", ip: null });
  });
});
