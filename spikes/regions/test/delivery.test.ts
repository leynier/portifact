import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createArtifact } from "../src/create.ts";
import { findForDelivery, readObject } from "../src/delivery.ts";
import { Directory } from "../src/directory.ts";
import { createRegions } from "../src/regions.ts";
import { ACCOUNT_ID, counting, randomId, regionsFor, seedWorkspace } from "./harness.ts";

/** Regions whose global and EU databases count the queries the content Worker sends. */
function countedRegions() {
  const global = counting(env.GLOBAL);
  const eu = counting(env.DB_EU);
  const regions = createRegions({
    global: global.db,
    accountId: ACCOUNT_ID,
    regions: {
      default: { db: env.DB_DEFAULT, bucket: env.ARTIFACTS, bucketName: "a" },
      eu: { db: eu.db, bucket: env.ARTIFACTS_EU, bucketName: "b" },
    },
  });
  return { regions, queries: () => global.queries() + eu.queries() };
}

describe("delivery lookup", () => {
  it("costs two reads on a cold isolate, then one per request like today", async () => {
    const setup = regionsFor("separate");
    const workspace = await seedWorkspace(setup, "eu");
    const created = await createArtifact(setup, { ownerId: workspace, name: "x", now: 1 });
    if (!created.ok) throw new Error(created.code);

    const { regions, queries } = countedRegions();
    const directory = new Directory(regions.global);
    expect(await findForDelivery(regions, directory, created.id)).toMatchObject({ region: "eu" });
    expect(queries()).toBe(2);
    for (let i = 0; i < 5; i += 1) await findForDelivery(regions, directory, created.id);
    expect(queries()).toBe(2 + 5);
  });

  it("costs one read for an unknown ID, as today, and never caches the miss", async () => {
    const { regions, queries } = countedRegions();
    const directory = new Directory(regions.global);
    const id = randomId();
    expect(await findForDelivery(regions, directory, id)).toBeNull();
    expect(queries()).toBe(1);
    // Claimed and created right after the miss: found at once.
    const workspace = await seedWorkspace(regionsFor("separate"), "eu");
    await env.GLOBAL.prepare("insert into artifact_directory values (?, 'eu', 1)").bind(id).run();
    await env.DB_EU.prepare("insert into artifacts (id, owner_id, name) values (?, ?, 'x')")
      .bind(id, workspace)
      .run();
    expect(await findForDelivery(regions, directory, id)).toMatchObject({ region: "eu" });
  });

  it("reads an EU artifact's bytes only from the EU bucket", async () => {
    const regions = regionsFor("separate");
    const workspace = await seedWorkspace(regions, "eu");
    const created = await createArtifact(regions, { ownerId: workspace, name: "x", now: 1 });
    if (!created.ok) throw new Error(created.code);
    const key = `objects/${created.id}/index.html`;
    await env.ARTIFACTS_EU.put(key, "eu bytes");
    await env.ARTIFACTS.put(key, "wrong bucket");
    const found = await findForDelivery(regions, new Directory(env.GLOBAL), created.id);
    if (!found) throw new Error("not found");
    expect(await readObject(regions, found, "index.html")).toBe("eu bytes");
    expect(await readObject(regions, found, "missing.css")).toBeNull();
  });

  it("evicts the least recently used entry past its size, and refuses an unknown region", async () => {
    const ids = [randomId(), randomId(), randomId()];
    for (const id of ids) {
      await env.GLOBAL.prepare("insert into artifact_directory values (?, 'eu', 1)").bind(id).run();
    }
    const directory = new Directory(env.GLOBAL, 2);
    await directory.regionOf(ids[0] as string);
    await directory.regionOf(ids[1] as string);
    await directory.regionOf(ids[0] as string);
    await directory.regionOf(ids[2] as string);
    expect(directory.size).toBe(2);
    const odd = randomId();
    await env.GLOBAL.prepare("insert into artifact_directory values (?, 'mars', 1)")
      .bind(odd)
      .run();
    await expect(directory.regionOf(odd)).rejects.toThrow("Unknown region");
  });

  it("finds a claimed ID with no regional row as missing", async () => {
    const regions = regionsFor("separate");
    const id = randomId();
    await env.GLOBAL.prepare("insert into artifact_directory values (?, 'eu', 1)").bind(id).run();
    expect(await findForDelivery(regions, new Directory(env.GLOBAL), id)).toBeNull();
  });
});
