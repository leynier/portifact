import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createRegions, isRegion, ownerRegion, s3Endpoint } from "../src/regions.ts";
import { ACCOUNT_ID, randomId, regionsFor, seedUser, seedWorkspace } from "./harness.ts";

describe("region resolver", () => {
  it("presigns EU objects on the jurisdiction's own endpoint", () => {
    expect(s3Endpoint(ACCOUNT_ID, "eu", "portifact-artifacts-eu")).toBe(
      `https://${ACCOUNT_ID}.eu.r2.cloudflarestorage.com/portifact-artifacts-eu`,
    );
    expect(s3Endpoint(ACCOUNT_ID, "default", "portifact-artifacts")).toBe(
      `https://${ACCOUNT_ID}.r2.cloudflarestorage.com/portifact-artifacts`,
    );
    expect(regionsFor("separate").get("eu").s3Endpoint).toContain(".eu.r2.cloudflarestorage.com");
  });

  it("refuses a Worker without the default region and a region it has no bindings for", () => {
    expect(() => createRegions({ global: env.GLOBAL, accountId: ACCOUNT_ID, regions: {} })).toThrow(
      "default region",
    );
    const onlyDefault = createRegions({
      global: env.GLOBAL,
      accountId: ACCOUNT_ID,
      regions: { default: { db: env.GLOBAL, bucket: env.ARTIFACTS, bucketName: "b" } },
    });
    expect(onlyDefault.all().map((r) => r.region)).toEqual(["default"]);
    expect(() => onlyDefault.get("eu")).toThrow("no bindings");
    expect(isRegion("eu")).toBe(true);
    expect(isRegion("us")).toBe(false);
  });

  it("puts a personal space in the default region and a workspace in its own", async () => {
    const regions = regionsFor("separate");
    const { userId } = await seedUser(regions);
    const eu = await seedWorkspace(regions, "eu");
    const plain = await seedWorkspace(regions, "default");
    expect(await ownerRegion(regions.global, userId)).toBe("default");
    expect(await ownerRegion(regions.global, eu)).toBe("eu");
    expect(await ownerRegion(regions.global, plain)).toBe("default");
    expect(await ownerRegion(regions.global, "org_missing")).toBeNull();
    const odd = await seedWorkspace(regions, "mars");
    await expect(ownerRegion(regions.global, odd)).rejects.toThrow("Unknown region");
  });

  it("never changes a workspace's region or a directory row, and never deletes a directory row", async () => {
    const regions = regionsFor("separate");
    const org = await seedWorkspace(regions, "eu");
    await expect(
      env.GLOBAL.prepare("update organizations set region = 'default' where id = ?")
        .bind(org)
        .run(),
    ).rejects.toThrow("region_fixed");
    // Writing the same value is not a change.
    await env.GLOBAL.prepare("update organizations set region = 'eu' where id = ?").bind(org).run();
    const id = randomId();
    await env.GLOBAL.prepare("insert into artifact_directory values (?, 'eu', 1)").bind(id).run();
    await expect(
      env.GLOBAL.prepare("update artifact_directory set region = 'default' where id = ?")
        .bind(id)
        .run(),
    ).rejects.toThrow("region_fixed");
    await expect(
      env.GLOBAL.prepare("delete from artifact_directory where id = ?").bind(id).run(),
    ).rejects.toThrow("directory_permanent");
  });
});
