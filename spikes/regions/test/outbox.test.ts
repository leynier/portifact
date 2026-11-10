import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createArtifact } from "../src/create.ts";
import { Directory } from "../src/directory.ts";
import { type JobMessage, outboxScopes, relayOutbox, runJob } from "../src/outbox.ts";
import { applyTombstones, fenceStatements, purgeArtifact } from "../src/purge.ts";
import { count, randomId, regionsFor, seedUser, seedWorkspace } from "./harness.ts";

function collector() {
  const sent: JobMessage[] = [];
  return {
    sent,
    queue: {
      sendBatch: async (m: { body: JobMessage }[]) => void sent.push(...m.map((x) => x.body)),
    },
  };
}

/** An EU artifact claimed for purging, with an object in the EU bucket. */
async function claimedEu() {
  const regions = regionsFor("separate");
  const workspace = await seedWorkspace(regions, "eu");
  const created = await createArtifact(regions, { ownerId: workspace, name: "x", now: 1 });
  if (!created.ok) throw new Error(created.code);
  await env.ARTIFACTS_EU.put(`objects/${created.id}/index.html`, "bytes");
  await env.DB_EU.batch(fenceStatements(env.DB_EU, workspace, 2));
  const job = await env.DB_EU.prepare("select id, generation from outbox where subject = ?")
    .bind(created.id)
    .first<{ id: number; generation: number }>();
  if (!job) throw new Error("no job");
  return { regions, workspace, id: created.id, job };
}

describe("outbox per database", () => {
  it("relays one scope per database, so a colocated default region is not sent twice", () => {
    expect(outboxScopes(regionsFor("separate")).map((s) => s.scope)).toEqual([
      "global",
      "default",
      "eu",
    ]);
    expect(outboxScopes(regionsFor("colocated")).map((s) => s.scope)).toEqual(["global", "eu"]);
  });

  it("relays an EU job with its scope and runs it against the EU database and bucket", async () => {
    const { regions, id, job } = await claimedEu();
    const { sent, queue } = collector();
    await relayOutbox(regions, queue, 3);
    const message = sent.find((m) => m.id === job.id && m.scope === "eu");
    if (!message) throw new Error("not relayed");
    // Relayed once: the next run sends nothing new for it.
    const again = collector();
    await relayOutbox(regions, again.queue, 4);
    expect(again.sent.some((m) => m.id === job.id && m.scope === "eu")).toBe(false);

    const directory = new Directory(env.GLOBAL);
    expect(await runJob(regions, directory, message, 5)).toBe("done");
    expect(await env.ARTIFACTS_EU.get(`objects/${id}/index.html`)).toBeNull();
    expect(await count(env.DB_EU, "select count(*) as n from artifacts where id = ?", id)).toBe(0);
    expect(
      await count(
        env.GLOBAL,
        "select count(*) as n from tombstones where kind = 'artifact' and id = ?",
        id,
      ),
    ).toBe(1);
    // Redelivery after the work: the row is gone, so it is done without acting.
    expect(await runJob(regions, directory, message, 6)).toBe("done");
  });

  it("finishes a purge that died after the tombstone, and answers stale for an old generation", async () => {
    const { regions, id, job } = await claimedEu();
    const directory = new Directory(env.GLOBAL);
    // A job from an older claim does nothing.
    expect(
      await purgeArtifact(regions, directory, { id, generation: job.generation - 1, now: 3 }),
    ).toBe("stale");
    // The tombstone was written, then the isolate died before the regional delete.
    await env.GLOBAL.prepare("insert into tombstones values ('artifact', ?, 3)").bind(id).run();
    expect(
      await purgeArtifact(regions, directory, { id, generation: job.generation, now: 4 }),
    ).toBe("done");
    expect(
      await purgeArtifact(regions, directory, { id, generation: job.generation, now: 5 }),
    ).toBe("done");
    expect(await purgeArtifact(regions, directory, { id: randomId(), generation: 1, now: 5 })).toBe(
      "stale",
    );
  });

  it("deletes a stale job's row and refuses an unknown topic", async () => {
    const { regions, id, job } = await claimedEu();
    await env.DB_EU.prepare(
      "update artifacts set lifecycle_generation = lifecycle_generation + 1 where id = ?",
    )
      .bind(id)
      .run();
    const directory = new Directory(env.GLOBAL);
    expect(
      await runJob(regions, directory, { scope: "eu", id: job.id, topic: "purge_artifact" }, 3),
    ).toBe("stale");
    expect(await count(env.DB_EU, "select count(*) as n from outbox where id = ?", job.id)).toBe(0);
    const odd = await env.GLOBAL.prepare(
      "insert into outbox (topic, subject, available_at) values ('mystery', 'x', 1) returning id",
    ).first<{ id: number }>();
    await expect(
      runJob(regions, directory, { scope: "global", id: odd?.id ?? 0, topic: "mystery" }, 3),
    ).rejects.toThrow("Unknown topic");
    await env.GLOBAL.prepare("delete from outbox where topic = 'mystery'").run();
  });
});

describe("tombstones after a restore", () => {
  it("re-deletes a purged artifact and re-fences a deleted account in a restored region", async () => {
    const { regions, workspace, id, job } = await claimedEu();
    await purgeArtifact(regions, new Directory(env.GLOBAL), {
      id,
      generation: job.generation,
      now: 3,
    });
    const { userId } = await seedUser(regions);
    const theirs = await createArtifact(regions, {
      ownerId: await seedWorkspace(regions, "eu"),
      name: "y",
      now: 3,
    });
    if (!theirs.ok) throw new Error(theirs.code);
    await env.GLOBAL.prepare("insert into tombstones values ('account', ?, 4)").bind(userId).run();

    // A Time Travel restore of the EU database brings the purged artifact back and loses fences.
    await env.DB_EU.batch([
      env.DB_EU.prepare("delete from owner_fences where owner_id = ?").bind(workspace),
      env.DB_EU.prepare("insert into artifacts (id, owner_id, name) values (?, ?, 'back')").bind(
        id,
        workspace,
      ),
      env.DB_EU.prepare(
        "insert into artifacts (id, owner_id, name) values (?, ?, 'deleted owner')",
      ).bind(randomId(), userId),
    ]);
    const applied = await applyTombstones(regions, "eu", 5);
    expect(applied.artifacts).toBeGreaterThanOrEqual(1);
    expect(await count(env.DB_EU, "select count(*) as n from artifacts where id = ?", id)).toBe(0);
    expect(
      await count(env.DB_EU, "select count(*) as n from owner_fences where owner_id = ?", userId),
    ).toBe(1);
    expect(
      await count(
        env.DB_EU,
        "select count(*) as n from artifacts where owner_id = ? and state <> 'purging'",
        userId,
      ),
    ).toBe(0);
    // An artifact of a live owner is untouched.
    expect(
      await count(
        env.DB_EU,
        "select count(*) as n from artifacts where id = ? and state = 'active'",
        theirs.id,
      ),
    ).toBe(1);
  });
});
