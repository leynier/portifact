import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  CLAIM_ATTEMPTS,
  claimArtifactId,
  createArtifact,
  generateArtifactId,
} from "../src/create.ts";
import { findForDelivery } from "../src/delivery.ts";
import { Directory } from "../src/directory.ts";
import { fenceStatements } from "../src/purge.ts";
import {
  count,
  LAYOUTS,
  randomId,
  regionsFor,
  scripted,
  seedUser,
  seedWorkspace,
} from "./harness.ts";

describe.each(LAYOUTS)("creating an artifact (%s)", (layout) => {
  const regions = regionsFor(layout);

  it("claims the ID globally and writes the artifact only in the owner's region", async () => {
    const workspace = await seedWorkspace(regions, "eu");
    const created = await createArtifact(regions, { ownerId: workspace, name: "Plan", now: 1 });
    if (!created.ok) throw new Error(created.code);
    expect(created.region).toBe("eu");
    expect(
      await count(env.DB_EU, "select count(*) as n from artifacts where id = ?", created.id),
    ).toBe(1);
    expect(
      await count(
        regions.get("default").db,
        "select count(*) as n from artifacts where id = ?",
        created.id,
      ),
    ).toBe(0);
    const directory = await env.GLOBAL.prepare("select * from artifact_directory where id = ?")
      .bind(created.id)
      .first();
    // The directory row holds the ID, the region and a time: nothing about the owner or content.
    expect(directory).toEqual({ id: created.id, region: "eu", created_at: 1 });
  });

  it("keeps a personal artifact in the default region", async () => {
    const { userId } = await seedUser(regions);
    const created = await createArtifact(regions, { ownerId: userId, name: "Mine", now: 1 });
    expect(created).toMatchObject({ ok: true, region: "default" });
  });

  it("answers not_found for an owner that does not exist", async () => {
    expect(await createArtifact(regions, { ownerId: "org_nobody", name: "x", now: 1 })).toEqual({
      ok: false,
      code: "not_found",
    });
  });

  it("gives two concurrent creates that draw the same ID one winner, and the loser another ID", async () => {
    const workspace = await seedWorkspace(regions, "eu");
    const same = randomId();
    const [a, b] = await Promise.all([
      createArtifact(regions, {
        ownerId: workspace,
        name: "A",
        now: 1,
        random: scripted([same, randomId()]),
      }),
      createArtifact(regions, {
        ownerId: workspace,
        name: "B",
        now: 1,
        random: scripted([same, randomId()]),
      }),
    ]);
    if (!a.ok || !b.ok) throw new Error("both creates must succeed");
    expect(new Set([a.id, b.id]).size).toBe(2);
    expect([a.id, b.id]).toContain(same);
    expect(
      await count(env.DB_EU, "select count(*) as n from artifacts where owner_id = ?", workspace),
    ).toBe(2);
  });

  it("never hands out a tombstoned ID, in any region", async () => {
    const workspace = await seedWorkspace(regions, "eu");
    const dead = randomId();
    await env.GLOBAL.prepare("insert into tombstones values ('artifact', ?, 1)").bind(dead).run();
    expect(await claimArtifactId(env.GLOBAL, dead, "default", 2)).toBe(false);
    const fresh = randomId();
    const created = await createArtifact(regions, {
      ownerId: workspace,
      name: "x",
      now: 2,
      random: scripted([dead, fresh]),
    });
    expect(created).toEqual({ ok: true, id: fresh, region: "eu" });
  });

  it("gives up after a few taken IDs without writing anything regional", async () => {
    const workspace = await seedWorkspace(regions, "eu");
    const taken = randomId();
    expect(await claimArtifactId(env.GLOBAL, taken, "default", 1)).toBe(true);
    const created = await createArtifact(regions, {
      ownerId: workspace,
      name: "x",
      now: 1,
      random: scripted(Array(CLAIM_ATTEMPTS).fill(taken)),
    });
    expect(created).toEqual({ ok: false, code: "id_exhausted" });
    expect(
      await count(env.DB_EU, "select count(*) as n from artifacts where owner_id = ?", workspace),
    ).toBe(0);
  });

  it("leaves only an unused, unreachable ID when the region fails after the claim, and a retry succeeds", async () => {
    const workspace = await seedWorkspace(regions, "eu");
    const orphan = randomId();
    await expect(
      createArtifact(regions, {
        ownerId: workspace,
        name: "x",
        now: 1,
        random: scripted([orphan]),
        afterClaim: () => Promise.reject(new Error("isolate died")),
      }),
    ).rejects.toThrow("isolate died");
    // The retry (same idempotency key in production) draws a new ID and succeeds.
    const retried = await createArtifact(regions, { ownerId: workspace, name: "x", now: 2 });
    expect(retried.ok).toBe(true);
    // The orphan is claimed forever, serves nothing and can never be claimed again.
    expect(await findForDelivery(regions, new Directory(env.GLOBAL), orphan)).toBeNull();
    expect(await claimArtifactId(env.GLOBAL, orphan, "eu", 3)).toBe(false);
  });

  it("refuses an artifact for an owner fenced in the region (deletion in progress)", async () => {
    const workspace = await seedWorkspace(regions, "eu");
    await env.DB_EU.batch(fenceStatements(env.DB_EU, workspace, 1));
    expect(await createArtifact(regions, { ownerId: workspace, name: "late", now: 2 })).toEqual({
      ok: false,
      code: "owner_fenced",
    });
  });
});

describe("artifact IDs", () => {
  it("are 10 characters of the existing alphabet, so released clients accept them", () => {
    for (let i = 0; i < 50; i += 1) expect(generateArtifactId()).toMatch(/^[a-z2-7]{10}$/);
  });
});

describe("a regional failure that is not a fence", () => {
  it("is rethrown", async () => {
    const regions = regionsFor("separate");
    const workspace = await seedWorkspace(regions, "eu");
    const existing = randomId();
    // The ID is already in the regional database but not in the directory: impossible through
    // createArtifact, forced here to make the regional insert fail on the primary key.
    await env.DB_EU.prepare("insert into artifacts (id, owner_id, name) values (?, 'other', 'x')")
      .bind(existing)
      .run();
    await expect(
      createArtifact(regions, {
        ownerId: workspace,
        name: "x",
        now: 1,
        random: scripted([existing]),
      }),
    ).rejects.toThrow("UNIQUE");
  });
});
