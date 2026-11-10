import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import type { JobMessage } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import worker, { FAILED_RETRY_SECONDS, PENDING_RETRY_SECONDS, runScheduled } from "../src/index.ts";

/** The value, or a failed test when it is missing. */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected a value");
  return value;
}

const NOW = Date.UTC(2026, 10, 8);
const db = () => regionsFromEnv(env).get("default").db;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function artifactId(): string {
  let id = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(10))) id += ALPHABET[byte % 32];
  return id;
}

/** An artifact already claimed for purging with generation 2, and its purge job. */
async function claimedArtifact() {
  const id = artifactId();
  await db()
    .insert(schema.artifacts)
    .values({
      id,
      ownerId: `u_${crypto.randomUUID()}`,
      type: "site",
      name: "Plan",
      state: "purging",
      lifecycleGeneration: 2,
    });
  const [job] = await db()
    .insert(schema.outbox)
    .values({ topic: "purge_artifact", payload: {}, availableAt: NOW, subject: id, generation: 2 })
    .returning();
  return { id, job: must(job) };
}

async function deliver(bodies: unknown[]) {
  const batch = createMessageBatch(
    "portifact-jobs",
    bodies.map((body, i) => ({ id: `m${i}`, timestamp: NOW, attempts: 1, body })),
  );
  // The test runtime records which messages were retried but not their delay.
  const delays = new Map<string, number | undefined>();
  for (const message of batch.messages) {
    const retry = message.retry.bind(message);
    vi.spyOn(message, "retry").mockImplementation((options) => {
      delays.set(message.id, options?.delaySeconds);
      retry(options);
    });
  }
  const ctx = createExecutionContext();
  await worker.queue(batch, env);
  const result = await getQueueResult(batch, ctx);
  return {
    ...result,
    retryMessages: result.retryMessages.map((retried) => ({
      msgId: retried.msgId,
      delaySeconds: delays.get(retried.msgId),
    })),
  };
}

const artifactExists = async (id: string) =>
  (await db().select().from(schema.artifacts).where(eq(schema.artifacts.id, id))).length > 0;

describe("queue consumer", () => {
  it("purges a claimed artifact and acknowledges the message", async () => {
    const { id, job } = await claimedArtifact();
    const result = await deliver([{ id: job.id, topic: "purge_artifact" }]);
    expect(result.explicitAcks).toEqual(["m0"]);
    expect(result.retryMessages).toEqual([]);
    expect(await artifactExists(id)).toBe(false);
    expect(await db().select().from(schema.outbox).where(eq(schema.outbox.id, job.id))).toEqual([]);
  });

  it("acknowledges a duplicate delivery without purging twice", async () => {
    const { id, job } = await claimedArtifact();
    const body: JobMessage = { id: job.id, topic: "purge_artifact" };
    const result = await deliver([body, body]);
    expect(result.explicitAcks.sort()).toEqual(["m0", "m1"]);
    const purged = await db()
      .select()
      .from(schema.lifecycleEvents)
      .where(eq(schema.lifecycleEvents.artifactId, id));
    expect(purged.map((event) => event.event)).toEqual(["purged"]);
  });

  it("acknowledges a stale job and leaves the renewed artifact alone", async () => {
    const { id, job } = await claimedArtifact();
    await db()
      .update(schema.artifacts)
      .set({ state: "active", lifecycleGeneration: 3 })
      .where(eq(schema.artifacts.id, id));
    const result = await deliver([{ id: job.id, topic: "purge_artifact" }]);
    expect(result.explicitAcks).toEqual(["m0"]);
    expect(await artifactExists(id)).toBe(true);
  });

  it("retries an account deletion later while its artifacts are not purged", async () => {
    const userId = `u_${crypto.randomUUID()}`;
    await db().insert(schema.accountDeletions).values({ userId, requestedAt: NOW });
    await db()
      .insert(schema.artifacts)
      .values({ id: artifactId(), ownerId: userId, type: "site", name: "Plan", state: "purging" });
    const [job] = await db()
      .insert(schema.outbox)
      .values({ topic: "account_deletion", payload: {}, availableAt: NOW, subject: userId })
      .returning();
    const result = await deliver([{ id: must(job).id, topic: "account_deletion" }]);
    expect(result.retryMessages).toEqual([{ msgId: "m0", delaySeconds: PENDING_RETRY_SECONDS }]);
    expect(
      await db()
        .select()
        .from(schema.outbox)
        .where(eq(schema.outbox.id, must(job).id)),
    ).toHaveLength(1);
  });

  it("retries a job that fails and keeps its row", async () => {
    const [job] = await db()
      .insert(schema.outbox)
      .values({ topic: "delete_objects", payload: { keys: 42 }, availableAt: NOW })
      .returning();
    const result = await deliver([{ id: must(job).id, topic: "delete_objects" }]);
    expect(result.retryMessages).toEqual([{ msgId: "m0", delaySeconds: FAILED_RETRY_SECONDS }]);
    expect(
      await db()
        .select()
        .from(schema.outbox)
        .where(eq(schema.outbox.id, must(job).id)),
    ).toHaveLength(1);
  });

  it("acknowledges and drops a malformed message", async () => {
    const result = await deliver([{ id: "1; drop table outbox", topic: "purge_artifact" }, null]);
    expect(result.explicitAcks.sort()).toEqual(["m0", "m1"]);
    expect(result.retryMessages).toEqual([]);
  });
});

describe("scheduled relay", () => {
  it("relays pending outbox rows to the queue", async () => {
    const { job } = await claimedArtifact();
    const result = await runScheduled(env, NOW);
    expect(result.relayed).toBeGreaterThanOrEqual(1);
    const [row] = await db().select().from(schema.outbox).where(eq(schema.outbox.id, job.id));
    // The consumer may already have run it; if not, it is marked sent.
    if (row) expect(row.dispatchedAt).toBe(NOW);
  });

  it("keeps running the reconciliation when the queue refuses the jobs", async () => {
    const [job] = await db()
      .insert(schema.outbox)
      .values({ topic: "account_deletion", payload: {}, availableAt: NOW, subject: "u_gone" })
      .returning();
    const failing = {
      send: async () => Promise.reject(new Error("queue unavailable")),
      sendBatch: async () => Promise.reject(new Error("queue unavailable")),
    } as unknown as Queue<JobMessage>;
    const result = await runScheduled({ ...env, JOBS: failing }, NOW);
    expect(result.relayed).toBe("failed");
    expect(result.storage).toMatchObject({ checkedRows: expect.any(Number) });
    const [row] = await db()
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.id, must(job).id));
    expect(row?.dispatchedAt).toBeNull();
  });
});

describe("access log jobs", () => {
  const events = async (artifact: string) =>
    (
      await env.ACCESS_DB.prepare("select user_id from access_events where artifact_id = ?")
        .bind(artifact)
        .all()
    ).results;

  it("erases a purged artifact's access log from the access log database", async () => {
    const id = artifactId();
    const insert = env.ACCESS_DB.prepare(
      "insert into access_events (artifact_id, window_start, user_id, owner_id, email, opened_at) values (?, ?, ?, 'u_o', 'r@example.test', ?)",
    );
    await insert.bind(id, NOW, "u_a", NOW).run();
    await insert.bind(id, NOW, "u_b", NOW).run();
    await insert.bind("keep234567", NOW, "u_a", NOW).run();
    const [job] = await db()
      .insert(schema.outbox)
      .values({
        topic: "erase_access_events",
        payload: { kind: "artifact" },
        availableAt: NOW,
        subject: id,
      })
      .returning();
    const result = await deliver([{ id: must(job).id, topic: "erase_access_events" }]);
    expect(result.explicitAcks).toEqual(["m0"]);
    expect(await events(id)).toEqual([]);
    expect(await events("keep234567")).toEqual([{ user_id: "u_a" }]);
    expect(
      await db()
        .select()
        .from(schema.outbox)
        .where(eq(schema.outbox.id, must(job).id)),
    ).toEqual([]);
  });
});
