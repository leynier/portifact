// The jobs Worker's side of audit streams (decision 0019): the queue consumer delivers a stream's
// batch through the network it is given (a fake here), alongside the batch's other jobs; without
// `WEBHOOKS_ENABLED` and `WEBHOOK_KEY` nothing is sent and the schedule arms nothing; with them the
// schedule gives a stream that lost its job a new one and re-seals streams of a rotated key.
import { createMessageBatch, env } from "cloudflare:test";
import type { JobMessage } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { personalActor } from "@portifact/domain";
import { createAuditStream, webhookKeys } from "@portifact/services";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { runQueue, runScheduled } from "../src/index.ts";

const NOW = Date.UTC(2026, 10, 10, 9);
const KEY = "test-only jobs audit stream key, long enough";
const NEXT_KEY = "the next test-only jobs audit stream key, long";
const db = () => regionsFromEnv(env).get("default").db;
const keyed = { ...env, WEBHOOK_KEY: KEY, WEBHOOKS_ENABLED: "true" };

async function streamWithEvent() {
  const ownerId = `u_${crypto.randomUUID()}`;
  await db()
    .insert(schema.users)
    .values({
      id: ownerId,
      name: "Owner",
      email: `${ownerId}@example.test`,
      emailVerified: true,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    });
  await db()
    .insert(schema.ownerPlans)
    .values({ ownerId, plan: "enterprise", seats: 1, grantedBy: "test", updatedAt: NOW });
  const created = await createAuditStream(db(), {
    actor: personalActor(ownerId),
    stream: { label: "SIEM", url: "https://siem.example.com/in", start: "oldest" },
    keys: await webhookKeys({ current: KEY }),
    service: { enabled: true },
    now: NOW,
  });
  if (!created.ok) throw new Error(created.message);
  await db()
    .insert(schema.auditEvents)
    .values({
      id: `ae_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
      ownerId,
      at: NOW - 3_600_000,
      kind: "artifact.archived",
      actorType: "user",
      actorId: ownerId,
      targetId: null,
      artifactId: null,
      detail: {},
      recordedAt: NOW - 3_600_000,
    });
  const streamId = created.value.stream.id;
  return { streamId, job: await jobOf(streamId) };
}

async function jobOf(streamId: string) {
  const [job] = await db()
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.topic, "audit_stream"), eq(schema.outbox.subject, streamId)));
  return job;
}

function batchOf(job: { id: number } | undefined) {
  const body: JobMessage = { id: job?.id ?? 0, topic: "audit_stream" };
  return createMessageBatch("portifact-jobs", [{ id: "m0", timestamp: NOW, attempts: 1, body }]);
}

describe("audit streams in the jobs Worker", () => {
  it("delivers a stream's events through the given network and keeps its job for the next run", async () => {
    const { streamId, job } = await streamWithEvent();
    const sent: { url: string; type: string | null }[] = [];
    const fetcher = async (url: string, init: RequestInit) => {
      sent.push({ url, type: new Headers(init.headers).get("content-type") });
      return new Response("ok");
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runQueue(batchOf(job), keyed, NOW, undefined, fetcher);
    log.mockRestore();
    expect(sent).toEqual([
      { url: "https://siem.example.com/in", type: "application/jsonl; charset=utf-8" },
    ]);
    // The job stays: it is the stream's chain.
    expect((await jobOf(streamId))?.availableAt).toBeGreaterThan(NOW);
  });

  it("sends nothing and arms nothing while switched off; arms and re-seals while on", async () => {
    const { streamId, job } = await streamWithEvent();
    const fetcher = vi.fn(async () => new Response("ok"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runQueue(batchOf(job), { ...env, WEBHOOK_KEY: KEY }, NOW, undefined, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await jobOf(streamId)).toBeUndefined();
    const off = await runScheduled({ ...env, WEBHOOK_KEY: KEY }, NOW, undefined, { relay: false });
    expect(off.auditStreams.armed).toBe(0);
    expect(await jobOf(streamId)).toBeUndefined();
    const on = await runScheduled(
      { ...keyed, WEBHOOK_KEY: NEXT_KEY, WEBHOOK_KEY_PREVIOUS: KEY },
      NOW,
      undefined,
      { relay: false },
    );
    log.mockRestore();
    expect(on.auditStreams.armed).toBeGreaterThanOrEqual(1);
    expect(on.auditStreams.keysRewrapped).toBeGreaterThanOrEqual(1);
    expect(on.auditStreams.keysLeft).toBe(0);
    expect(await jobOf(streamId)).toBeDefined();
    const [current] = await webhookKeys({ current: NEXT_KEY });
    const [row] = await db()
      .select()
      .from(schema.auditStreams)
      .where(eq(schema.auditStreams.id, streamId));
    expect(row?.keyId).toBe(current?.id);
  });

  it("runs the batch's other jobs while a slow endpoint holds the stream", async () => {
    const { job } = await streamWithEvent();
    const [purge] = await db()
      .insert(schema.outbox)
      .values({
        topic: "purge_artifact",
        payload: {},
        availableAt: NOW,
        subject: "gone765432",
        generation: 1,
      })
      .returning();
    let purgedFirst = false;
    const slow = async () => {
      for (let i = 0; i < 40 && !purgedFirst; i += 1) {
        const left = await db()
          .select()
          .from(schema.outbox)
          .where(eq(schema.outbox.id, purge?.id ?? 0));
        purgedFirst = left.length === 0;
        if (!purgedFirst) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return new Response("ok");
    };
    const batch = createMessageBatch("portifact-jobs", [
      { id: "m0", timestamp: NOW, attempts: 1, body: { id: job?.id ?? 0, topic: "audit_stream" } },
      {
        id: "m1",
        timestamp: NOW,
        attempts: 1,
        body: { id: purge?.id ?? 0, topic: "purge_artifact" },
      },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runQueue(batch, keyed, NOW, undefined, slow);
    log.mockRestore();
    expect(purgedFirst).toBe(true);
  });
});
