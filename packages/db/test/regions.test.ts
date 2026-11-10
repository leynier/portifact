import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  globalDb,
  isRegion,
  type Region,
  regionalDb,
  regionsFromEnv,
  schema,
} from "../src/index.ts";

const NOW = Date.UTC(2026, 10, 9);

describe("regions of a Worker", () => {
  it("has exactly the default region, whose handle wraps the same binding as the global one", async () => {
    const regions = regionsFromEnv(env);
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
    const regions = regionsFromEnv(env);
    expect(() => regions.get("eu" as Region)).toThrow("Region eu has no bindings in this Worker");
  });

  it("carries the access log database only when the Worker is bound to it", () => {
    expect(regionsFromEnv(env).get("default").accessDb).toBeDefined();
    expect(regionsFromEnv({ DB: env.DB }).get("default").accessDb).toBeUndefined();
  });

  it("knows its regions by name", () => {
    expect(isRegion("default")).toBe(true);
    expect(isRegion("eu")).toBe(false);
    expect(isRegion("")).toBe(false);
  });

  it("attaches a regional database to the global database it is given", () => {
    const global = globalDb(env.DB);
    expect(regionalDb(env.DB, global).global).toBe(global);
  });
});
