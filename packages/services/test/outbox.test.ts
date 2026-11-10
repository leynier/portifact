import { env } from "cloudflare:test";
import type { JobMessage } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { and, eq, inArray, ne } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { requestAccountDeletion } from "../src/account-data.ts";
import { archiveArtifact, deleteArtifact } from "../src/lifecycle.ts";
import { purgeArchived, releaseOrphans } from "../src/maintenance.ts";
import { OUTBOX_INLINE_GRACE_MS, OUTBOX_REDELIVER_MS, relayOutbox, runJob } from "../src/outbox.ts";
import { artifactRow, db, MINUTE, NOW, publishSite, session, sha256, user } from "./fixtures.ts";

/** The value, or a failed test when it is missing. */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected a value");
  return value;
}

/** A queue that records what it accepted, or refuses everything while `failing`. */
function fakeQueue() {
  const sent: JobMessage[] = [];
  const queue = {
    failing: false,
    sent,
    async send(body: JobMessage) {
      await queue.sendBatch([{ body }]);
    },
    async sendBatch(messages: Iterable<{ body: JobMessage }>) {
      if (queue.failing) throw new Error("queue unavailable");
      for (const message of messages) sent.push(message.body);
    },
  };
  return queue;
}
const asQueue = (queue: ReturnType<typeof fakeQueue>) => queue as unknown as Queue<JobMessage>;

/** A bucket whose deletes fail, as when the Worker dies between the batch and the R2 call. */
const brokenBucket = new Proxy(env.ARTIFACTS, {
  get(target, property) {
    if (property === "delete") return async () => Promise.reject(new Error("r2 down"));
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  },
}) as R2Bucket;

/** The database, except that every `batch` after the first `n` fails: a crash mid-request. */
function crashAfterBatches(n: number) {
  const real = db();
  let batches = 0;
  return new Proxy(real, {
    get(target, property, receiver) {
      if (property !== "batch") return Reflect.get(target, property, receiver);
      return async (statements: Parameters<typeof real.batch>[0]) => {
        batches += 1;
        if (batches > n) throw new Error("worker crashed");
        return target.batch(statements);
      };
    },
  }) as ReturnType<typeof db>;
}

/** The subject's jobs, except access log erasure, which access-log.test.ts covers. */
async function jobsFor(subject: string) {
  return db()
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.subject, subject), ne(schema.outbox.topic, "erase_access_events")));
}

async function r2Has(ownerId: string, body: string) {
  return (await env.ARTIFACTS.head(`objects/${ownerId}/${await sha256(body)}`)) !== null;
}

const message = (row: { id: number; topic: JobMessage["topic"] }): JobMessage => ({
  id: row.id,
  topic: row.topic,
});

describe("outbox jobs for deletions", () => {
  it("closes the purge job when the request finishes the deletion itself", async () => {
    const owner = await user();
    const site = await publishSite(owner.id);
    const deleted = await deleteArtifact(db(), env.ARTIFACTS, {
      userId: owner.id,
      artifactId: site.artifactId,
      now: NOW,
    });
    expect(deleted.ok).toBe(true);
    expect(await jobsFor(site.artifactId)).toEqual([]);
  });

  it("leaves a purge job with the claimed generation when the request dies after the claim", async () => {
    const owner = await user();
    const body = `<p>${crypto.randomUUID()}</p>`;
    const site = await publishSite(owner.id, { "index.html": body });
    const before = await artifactRow(site.artifactId);
    await expect(
      deleteArtifact(crashAfterBatches(1), env.ARTIFACTS, {
        userId: owner.id,
        artifactId: site.artifactId,
        now: NOW,
      }),
    ).rejects.toThrow("worker crashed");

    const [job] = await jobsFor(site.artifactId);
    expect(job).toMatchObject({
      topic: "purge_artifact",
      generation: (before?.lifecycleGeneration ?? 0) + 1,
      availableAt: NOW + OUTBOX_INLINE_GRACE_MS,
      dispatchedAt: null,
    });
    expect((await artifactRow(site.artifactId))?.state).toBe("purging");

    expect(await runJob(db(), env.ARTIFACTS, message(must(job)), NOW + MINUTE)).toBe("done");
    expect(await artifactRow(site.artifactId)).toBeUndefined();
    expect(await r2Has(owner.id, body)).toBe(false);
    expect(await jobsFor(site.artifactId)).toEqual([]);
    const [tombstone] = await db()
      .select()
      .from(schema.tombstones)
      .where(eq(schema.tombstones.id, site.artifactId));
    expect(tombstone?.kind).toBe("artifact");
  });

  it("treats a duplicate delivery as done without acting twice", async () => {
    const owner = await user();
    const site = await publishSite(owner.id);
    await deleteArtifact(crashAfterBatches(1), env.ARTIFACTS, {
      userId: owner.id,
      artifactId: site.artifactId,
      now: NOW,
    }).catch(() => undefined);
    const [job] = await jobsFor(site.artifactId);
    const [first, second] = [
      await runJob(db(), env.ARTIFACTS, message(must(job)), NOW),
      await runJob(db(), env.ARTIFACTS, message(must(job)), NOW),
    ];
    expect([first, second]).toEqual(["done", "done"]);
    const events = await db()
      .select()
      .from(schema.lifecycleEvents)
      .where(
        and(
          eq(schema.lifecycleEvents.artifactId, site.artifactId),
          eq(schema.lifecycleEvents.event, "purged"),
        ),
      );
    expect(events).toHaveLength(1);
  });

  it("ignores a purge job whose generation is stale and drops it", async () => {
    const owner = await user();
    const site = await publishSite(owner.id);
    await deleteArtifact(crashAfterBatches(1), env.ARTIFACTS, {
      userId: owner.id,
      artifactId: site.artifactId,
      now: NOW,
    }).catch(() => undefined);
    const [job] = await jobsFor(site.artifactId);
    // A restore brought the artifact back as it was before the claim.
    await db()
      .update(schema.artifacts)
      .set({ state: "active", lifecycleGeneration: (job?.generation ?? 0) - 1 })
      .where(eq(schema.artifacts.id, site.artifactId));

    expect(await runJob(db(), env.ARTIFACTS, message(must(job)), NOW)).toBe("stale");
    expect((await artifactRow(site.artifactId))?.state).toBe("active");
    expect(await jobsFor(site.artifactId)).toEqual([]);
  });

  it("does not purge an artifact that was claimed again with a newer generation", async () => {
    const owner = await user();
    const site = await publishSite(owner.id);
    await deleteArtifact(crashAfterBatches(1), env.ARTIFACTS, {
      userId: owner.id,
      artifactId: site.artifactId,
      now: NOW,
    }).catch(() => undefined);
    const [job] = await jobsFor(site.artifactId);
    await db()
      .update(schema.artifacts)
      .set({ lifecycleGeneration: (job?.generation ?? 0) + 5 })
      .where(eq(schema.artifacts.id, site.artifactId));
    expect(await runJob(db(), env.ARTIFACTS, message(must(job)), NOW)).toBe("stale");
    expect((await artifactRow(site.artifactId))?.state).toBe("purging");
  });

  it("keeps the job when the purge fails, so a later delivery retries it", async () => {
    const owner = await user();
    const body = `<p>${crypto.randomUUID()}</p>`;
    const site = await publishSite(owner.id, { "index.html": body });
    await deleteArtifact(crashAfterBatches(1), env.ARTIFACTS, {
      userId: owner.id,
      artifactId: site.artifactId,
      now: NOW,
    }).catch(() => undefined);
    const [job] = await jobsFor(site.artifactId);
    await expect(runJob(db(), brokenBucket, message(must(job)), NOW)).rejects.toThrow("r2 down");
    // The rows are gone, but the bytes were not deleted: a delete_objects job keeps them owed.
    const [owed] = await jobsFor(owner.id);
    expect(owed?.topic).toBe("delete_objects");
    expect(await r2Has(owner.id, body)).toBe(true);

    expect(await runJob(db(), env.ARTIFACTS, message(must(owed)), NOW)).toBe("done");
    expect(await r2Has(owner.id, body)).toBe(false);
    expect(await runJob(db(), env.ARTIFACTS, message(must(job)), NOW)).toBe("done");
    expect(await jobsFor(site.artifactId)).toEqual([]);
  });

  it("writes the purge job with the scheduled claim and closes it after purging", async () => {
    const owner = await user();
    const site = await publishSite(owner.id);
    await archiveArtifact(db(), { userId: owner.id, artifactId: site.artifactId, now: NOW });
    const purgeAt = (await artifactRow(site.artifactId))?.purgeAt ?? 0;
    await expect(purgeArchived(crashAfterBatches(1), env.ARTIFACTS, purgeAt)).rejects.toThrow();
    const [job] = await jobsFor(site.artifactId);
    expect(job?.topic).toBe("purge_artifact");
    await purgeArchived(db(), env.ARTIFACTS, purgeAt);
    expect(await artifactRow(site.artifactId)).toBeUndefined();
    expect(await jobsFor(site.artifactId)).toEqual([]);
  });
});

describe("outbox jobs for released objects", () => {
  it("owes the R2 delete when the Worker dies after the rows are gone", async () => {
    const owner = await user();
    const body = `<p>${crypto.randomUUID()}</p>`;
    const hash = await sha256(body);
    await env.ARTIFACTS.put(`objects/${owner.id}/${hash}`, body);
    await db()
      .insert(schema.objects)
      .values({
        ownerId: owner.id,
        sha256: hash,
        size: body.length,
        r2Key: `objects/${owner.id}/${hash}`,
        state: "verified",
      });
    await db()
      .insert(schema.accountUsage)
      .values({ ownerId: owner.id, storedBytes: body.length, monthStartedAt: NOW, updatedAt: NOW });

    await expect(
      releaseOrphans(db(), brokenBucket, [{ ownerId: owner.id, sha256: hash }], NOW),
    ).rejects.toThrow("r2 down");
    const [usage] = await db()
      .select()
      .from(schema.accountUsage)
      .where(eq(schema.accountUsage.ownerId, owner.id));
    expect(usage?.storedBytes).toBe(0);
    const [job] = await jobsFor(owner.id);
    expect(job).toMatchObject({
      topic: "delete_objects",
      payload: { keys: [`objects/${owner.id}/${hash}`] },
    });

    // A second release finds nothing to delete and releases no bytes twice.
    await releaseOrphans(db(), env.ARTIFACTS, [{ ownerId: owner.id, sha256: hash }], NOW);
    expect(await jobsFor(owner.id)).toHaveLength(1);
    expect(await r2Has(owner.id, body)).toBe(true);

    expect(await runJob(db(), env.ARTIFACTS, message(must(job)), NOW)).toBe("done");
    expect(await r2Has(owner.id, body)).toBe(false);
    expect(await jobsFor(owner.id)).toEqual([]);
  });

  it("keeps an object that was uploaded again before the job ran", async () => {
    const owner = await user();
    const body = `<p>${crypto.randomUUID()}</p>`;
    const hash = await sha256(body);
    const key = `objects/${owner.id}/${hash}`;
    await env.ARTIFACTS.put(key, body);
    const row = { ownerId: owner.id, sha256: hash, size: body.length, r2Key: key };
    await db().insert(schema.objects).values(row);
    await releaseOrphans(db(), brokenBucket, [row], NOW).catch(() => undefined);
    const [job] = await jobsFor(owner.id);
    // The same bytes are uploaded again: same content address, a new row.
    await db().insert(schema.objects).values(row);

    expect(await runJob(db(), env.ARTIFACTS, message(must(job)), NOW)).toBe("done");
    expect(await r2Has(owner.id, body)).toBe(true);
  });

  it("closes the job when the release finishes inline", async () => {
    const owner = await user();
    const body = `<p>${crypto.randomUUID()}</p>`;
    const hash = await sha256(body);
    const key = `objects/${owner.id}/${hash}`;
    await env.ARTIFACTS.put(key, body);
    await db()
      .insert(schema.objects)
      .values({ ownerId: owner.id, sha256: hash, size: body.length, r2Key: key });
    await releaseOrphans(db(), env.ARTIFACTS, [{ ownerId: owner.id, sha256: hash }], NOW);
    expect(await jobsFor(owner.id)).toEqual([]);
    expect(await r2Has(owner.id, body)).toBe(false);
  });

  it("fails a job whose payload is malformed and keeps it", async () => {
    const [row] = await db()
      .insert(schema.outbox)
      .values({
        topic: "delete_objects",
        payload: { keys: "objects/x" },
        availableAt: NOW,
        subject: `u_${crypto.randomUUID()}`,
      })
      .returning();
    await expect(runJob(db(), env.ARTIFACTS, message(must(row)), NOW)).rejects.toThrow();
    expect(await jobsFor(must(must(row).subject))).toHaveLength(1);
  });
});

describe("outbox jobs for account deletions", () => {
  it("writes one deletion job and a purge job per artifact with the request", async () => {
    const owner = await user();
    const first = await publishSite(owner.id);
    const second = await publishSite(owner.id);
    const sessionId = await session(owner.id);
    const result = await requestAccountDeletion(db(), {
      userId: owner.id,
      sessionId,
      confirmEmail: owner.email,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    const [deletionJob] = await jobsFor(owner.id);
    expect(deletionJob).toMatchObject({ topic: "account_deletion", availableAt: NOW });
    const purges = await db()
      .select()
      .from(schema.outbox)
      .where(inArray(schema.outbox.subject, [first.artifactId, second.artifactId]));
    expect(purges.map((job) => job.topic)).toEqual(["purge_artifact", "purge_artifact"]);
    for (const job of purges) {
      expect(job.generation).toBe((await artifactRow(must(job.subject)))?.lifecycleGeneration);
    }

    // The account cannot finish while its artifacts are not purged yet.
    expect(await runJob(db(), env.ARTIFACTS, message(must(deletionJob)), NOW)).toBe("pending");
    expect(await jobsFor(owner.id)).toHaveLength(1);
    for (const job of purges) {
      expect(await runJob(db(), env.ARTIFACTS, message(job), NOW)).toBe("done");
    }
    expect(await runJob(db(), env.ARTIFACTS, message(must(deletionJob)), NOW)).toBe("done");
    expect(await jobsFor(owner.id)).toEqual([]);
    const [tombstone] = await db()
      .select()
      .from(schema.tombstones)
      .where(eq(schema.tombstones.id, owner.id));
    expect(tombstone?.kind).toBe("account");
    // Redelivered after it finished: nothing left to do.
    expect(await runJob(db(), env.ARTIFACTS, message(must(deletionJob)), NOW)).toBe("done");
  });

  it("drops a deletion job whose account has no deletion pending", async () => {
    const [row] = await db()
      .insert(schema.outbox)
      .values({
        topic: "account_deletion",
        payload: {},
        availableAt: NOW,
        subject: `u_${crypto.randomUUID()}`,
      })
      .returning();
    expect(await runJob(db(), env.ARTIFACTS, message(must(row)), NOW)).toBe("stale");
    expect(await jobsFor(must(must(row).subject))).toEqual([]);
  });
});

describe("relaying the outbox", () => {
  async function pendingJob(availableAt = NOW) {
    const [row] = await db()
      .insert(schema.outbox)
      .values({
        topic: "account_deletion",
        payload: {},
        availableAt,
        subject: `u_${crypto.randomUUID()}`,
      })
      .returning();
    return must(row);
  }

  async function clearOutbox() {
    await db().delete(schema.outbox);
  }

  it("sends due jobs once and marks them sent", async () => {
    await clearOutbox();
    const due = await pendingJob();
    const later = await pendingJob(NOW + OUTBOX_INLINE_GRACE_MS);
    const queue = fakeQueue();
    expect(await relayOutbox(db(), asQueue(queue), NOW)).toEqual({ relayed: 1 });
    expect(queue.sent).toEqual([{ id: due.id, topic: "account_deletion" }]);
    const [row] = await db().select().from(schema.outbox).where(eq(schema.outbox.id, due.id));
    expect(row).toMatchObject({ dispatchedAt: NOW, attempts: 1 });

    expect(await relayOutbox(db(), asQueue(queue), NOW + MINUTE)).toEqual({ relayed: 0 });
    expect(await relayOutbox(db(), asQueue(queue), NOW + OUTBOX_INLINE_GRACE_MS)).toEqual({
      relayed: 1,
    });
    expect(queue.sent.at(-1)?.id).toBe(later.id);
  });

  it("sends a job again when it is still there an hour after it was sent", async () => {
    await clearOutbox();
    const job = await pendingJob();
    const queue = fakeQueue();
    await relayOutbox(db(), asQueue(queue), NOW);
    expect(await relayOutbox(db(), asQueue(queue), NOW + OUTBOX_REDELIVER_MS - 1)).toEqual({
      relayed: 0,
    });
    expect(await relayOutbox(db(), asQueue(queue), NOW + OUTBOX_REDELIVER_MS)).toEqual({
      relayed: 1,
    });
    const [row] = await db().select().from(schema.outbox).where(eq(schema.outbox.id, job.id));
    expect(row?.attempts).toBe(2);
  });

  it("leaves jobs unsent when the queue refuses them", async () => {
    await clearOutbox();
    const job = await pendingJob();
    const queue = fakeQueue();
    queue.failing = true;
    await expect(relayOutbox(db(), asQueue(queue), NOW)).rejects.toThrow("queue unavailable");
    const [row] = await db().select().from(schema.outbox).where(eq(schema.outbox.id, job.id));
    expect(row).toMatchObject({ dispatchedAt: null, attempts: 0 });
    queue.failing = false;
    expect(await relayOutbox(db(), asQueue(queue), NOW + MINUTE)).toEqual({ relayed: 1 });
  });

  it("relays a large backlog in pages of at most 80 messages", async () => {
    await clearOutbox();
    for (let i = 0; i < 170; i += 1) await pendingJob();
    const queue = fakeQueue();
    expect(await relayOutbox(db(), asQueue(queue), NOW, 2)).toEqual({ relayed: 160 });
    expect(await relayOutbox(db(), asQueue(queue), NOW)).toEqual({ relayed: 10 });
    expect(new Set(queue.sent.map((sent) => sent.id)).size).toBe(170);
  });
});
