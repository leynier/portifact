import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createArtifact } from "../src/create.ts";
import { advanceAccountDeletion, requestAccountDeletion } from "../src/deletion.ts";
import { Directory } from "../src/directory.ts";
import { type JobMessage, relayOutbox, runJob } from "../src/outbox.ts";
import type { Regions } from "../src/regions.ts";
import {
  count,
  flaky,
  LAYOUTS,
  type Layout,
  regionsFor,
  seedUser,
  seedWorkspace,
  uid,
} from "./harness.ts";

/**
 * A member of an EU workspace with a personal artifact (default region), comments on the
 * workspace's artifact, a read session and an opening there; another member's comment that
 * must survive.
 */
async function scenario(regions: Regions) {
  const { userId, sessionId } = await seedUser(regions);
  const other = await seedUser(regions);
  const workspace = await seedWorkspace(regions, "eu");
  const personal = await createArtifact(regions, { ownerId: userId, name: "Mine", now: 1 });
  const shared = await createArtifact(regions, { ownerId: workspace, name: "Team plan", now: 1 });
  if (!personal.ok || !shared.ok) throw new Error("seed failed");
  const eu = regions.get("eu").db;
  await eu.batch([
    ...[1, 2, 3].map((n) =>
      eu
        .prepare("insert into annotation_messages values (?, ?, ?, ?, ?)")
        .bind(uid("msg"), shared.id, workspace, userId, `comment ${n}`),
    ),
    eu
      .prepare("insert into annotation_messages values (?, ?, ?, ?, 'keep me')")
      .bind(uid("msg"), shared.id, workspace, other.userId),
    eu
      .prepare("insert into read_sessions values (?, ?, ?, ?, ?)")
      .bind(uid("rs"), shared.id, userId, sessionId, Date.now() + 60_000),
    eu.prepare("insert into access_events values (?, ?, ?, 0)").bind(shared.id, userId, workspace),
  ]);
  return { userId, other, workspace, personal: personal.id, shared: shared.id };
}

/** A queue that keeps what was sent, and a loop that runs every relayed job until none is left. */
async function drain(regions: Regions, now: number) {
  const directory = new Directory(regions.global);
  for (let round = 0; round < 5; round += 1) {
    const sent: JobMessage[] = [];
    await relayOutbox(
      regions,
      { sendBatch: async (m) => void sent.push(...m.map((x) => x.body)) },
      now,
    );
    if (sent.length === 0) return;
    for (const message of sent) await runJob(regions, directory, message, now);
    // Undelivered (pending) rows become relayable again, like the redelivery delay in production.
    for (const { db } of [{ db: regions.global }, ...regions.all()]) {
      await db.prepare("update outbox set dispatched_at = null").run();
    }
  }
}

describe.each(LAYOUTS)("account deletion across regions (%s)", (layout: Layout) => {
  const regions = regionsFor(layout);
  const eu = env.DB_EU;

  it("deletes identity at once, stops serving everywhere, erases EU traces and tombstones once", async () => {
    const s = await scenario(regions);
    await requestAccountDeletion(regions, { userId: s.userId, now: 10 });

    expect(await count(env.GLOBAL, "select count(*) as n from users where id = ?", s.userId)).toBe(
      0,
    );
    expect(
      await count(env.GLOBAL, "select count(*) as n from sessions where user_id = ?", s.userId),
    ).toBe(0);
    const personal = regions.get("default").db;
    expect(
      await count(
        personal,
        "select count(*) as n from artifacts where id = ? and state = 'purging'",
        s.personal,
      ),
    ).toBe(1);
    expect(
      await count(eu, "select count(*) as n from owner_fences where owner_id = ?", s.userId),
    ).toBe(1);
    expect(
      await count(eu, "select count(*) as n from read_sessions where user_id = ?", s.userId),
    ).toBe(0);
    expect(
      await count(eu, "select count(*) as n from access_events where user_id = ?", s.userId),
    ).toBe(0);

    await drain(regions, 20);

    expect(
      await count(
        env.GLOBAL,
        "select count(*) as n from tombstones where kind = 'account' and id = ?",
        s.userId,
      ),
    ).toBe(1);
    expect(
      await count(
        env.GLOBAL,
        "select count(*) as n from tombstones where kind = 'artifact' and id = ?",
        s.personal,
      ),
    ).toBe(1);
    expect(
      await count(
        env.GLOBAL,
        "select count(*) as n from account_deletions where user_id = ?",
        s.userId,
      ),
    ).toBe(0);
    expect(
      await count(env.GLOBAL, "select count(*) as n from outbox where subject = ?", s.userId),
    ).toBe(0);
    expect(
      await count(personal, "select count(*) as n from artifacts where id = ?", s.personal),
    ).toBe(0);
    // The workspace's artifact and the other member's comment stay; the deleted member's go.
    expect(await count(eu, "select count(*) as n from artifacts where id = ?", s.shared)).toBe(1);
    expect(
      await count(
        eu,
        "select count(*) as n from annotation_messages where author_id = ?",
        s.userId,
      ),
    ).toBe(0);
    expect(
      await count(
        eu,
        "select count(*) as n from annotation_messages where author_id = ?",
        s.other.userId,
      ),
    ).toBe(1);
    expect(await advanceAccountDeletion(regions, { userId: s.userId, now: 30 })).toBe("absent");
  });

  it("refuses an artifact or a comment still in flight once the region is fenced", async () => {
    const s = await scenario(regions);
    await requestAccountDeletion(regions, { userId: s.userId, now: 10 });
    // A request authenticated before the deletion lands its regional write afterwards.
    await expect(
      eu
        .prepare("insert into artifacts (id, owner_id, name) values ('latelatela', ?, 'late')")
        .bind(s.userId)
        .run(),
    ).rejects.toThrow("owner_fenced");
    await expect(
      eu
        .prepare("insert into annotation_messages values (?, ?, ?, ?, 'late')")
        .bind(uid("msg"), s.shared, s.workspace, s.userId)
        .run(),
    ).rejects.toThrow("owner_fenced");
  });

  it("finishes exactly once when several runs race, and only after every region is clean", async () => {
    const s = await scenario(regions);
    await requestAccountDeletion(regions, { userId: s.userId, now: 10 });
    // The personal artifact still waits for its purge job: no run may finish yet.
    expect(await advanceAccountDeletion(regions, { userId: s.userId, now: 11 })).toBe("pending");
    const directory = new Directory(regions.global);
    const personalDb = regions.get("default").db;
    const purge = await personalDb
      .prepare("select id from outbox where topic = 'purge_artifact' and subject = ?")
      .bind(s.personal)
      .first<{ id: number }>();
    if (!purge) throw new Error("no purge job");
    const scope = personalDb === regions.global ? "global" : "default";
    // Delivered twice, concurrently, as an at-least-once queue may.
    await Promise.all([
      runJob(regions, directory, { scope, id: purge.id, topic: "purge_artifact" }, 12),
      runJob(regions, directory, { scope, id: purge.id, topic: "purge_artifact" }, 12),
    ]);
    const states = await Promise.all(
      [1, 2, 3, 4].map(() => advanceAccountDeletion(regions, { userId: s.userId, now: 13 })),
    );
    expect(states.filter((state) => state === "finished")).toHaveLength(1);
    expect(
      states.filter((state) => state === "finished" || state === "pending" || state === "absent"),
    ).toHaveLength(4);
    expect(
      await count(
        env.GLOBAL,
        "select count(*) as n from tombstones where kind = 'account' and id = ?",
        s.userId,
      ),
    ).toBe(1);
  });

  it("erases comments in slices and stays pending until the last one is gone", async () => {
    const s = await scenario(regions);
    await requestAccountDeletion(regions, { userId: s.userId, now: 10 });
    await drain(regions, 11);
    // Simulate a deletion re-applied after a restore with comments back in the EU region.
    await env.GLOBAL.batch([
      env.GLOBAL.prepare("delete from tombstones where kind = 'account' and id = ?").bind(s.userId),
      env.GLOBAL.prepare("insert into account_deletions values (?, 12)").bind(s.userId),
    ]);
    await eu.prepare("delete from owner_fences where owner_id = ?").bind(s.userId).run();
    await eu.batch(
      [1, 2, 3].map(() =>
        eu
          .prepare("insert into annotation_messages values (?, ?, ?, ?, 'back')")
          .bind(uid("msg"), s.shared, s.workspace, s.userId),
      ),
    );
    const step = () =>
      advanceAccountDeletion(regions, { userId: s.userId, now: 13, messagesPerRegion: 1 });
    expect(await step()).toBe("pending");
    expect(await step()).toBe("pending");
    expect(await step()).toBe("finished");
  });

  it("still deletes when a region is down at request time, and the job fences it later", async () => {
    const down = regionsFor(layout, { eu: flaky(env.DB_EU) });
    const s = await scenario(regionsFor(layout));
    await requestAccountDeletion(down, { userId: s.userId, now: 10 });
    expect(await count(env.GLOBAL, "select count(*) as n from users where id = ?", s.userId)).toBe(
      0,
    );
    expect(
      await count(eu, "select count(*) as n from owner_fences where owner_id = ?", s.userId),
    ).toBe(0);
    await drain(regions, 11);
    expect(
      await count(eu, "select count(*) as n from owner_fences where owner_id = ?", s.userId),
    ).toBe(1);
    expect(
      await count(
        eu,
        "select count(*) as n from annotation_messages where author_id = ?",
        s.userId,
      ),
    ).toBe(0);
    expect(
      await count(
        env.GLOBAL,
        "select count(*) as n from tombstones where kind = 'account' and id = ?",
        s.userId,
      ),
    ).toBe(1);
  });
});
