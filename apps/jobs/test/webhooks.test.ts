// The jobs Worker's side of webhooks (decision 0009): the queue consumer delivers through the
// network it is given (a fake here; nothing leaves the test), a delivery without `WEBHOOK_KEY`
// waits, `WEBHOOKS_PAUSED` holds every delivery, the one-minute schedule only relays and the
// maintenance run re-seals webhooks of a rotated key.
import { createMessageBatch, createScheduledController, env } from "cloudflare:test";
import type { JobMessage } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { personalActor } from "@portifact/domain";
import { createWebhook, sendTestEvent, webhookKeys } from "@portifact/services";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import worker, { RELAY_CRON, runQueue, runScheduled } from "../src/index.ts";
import { webhookDepsFromEnv } from "../src/webhooks.ts";

const NOW = Date.UTC(2026, 10, 10, 9);
const KEY = "test-only jobs webhook sealing key, long enough";
const NEXT_KEY = "the next test-only jobs webhook sealing key";
const db = () => regionsFromEnv(env).get("default").db;
const keyed = { ...env, WEBHOOK_KEY: KEY };

async function hookWithTest() {
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
    .values({ ownerId, plan: "pro", seats: 1, grantedBy: "test", updatedAt: NOW });
  const created = await createWebhook(db(), {
    actor: personalActor(ownerId),
    webhook: {
      url: "https://hooks.example.com/in",
      format: "generic",
      events: ["artifact.published"],
    },
    keys: await webhookKeys({ current: KEY }),
    now: NOW,
  });
  if (!created.ok) throw new Error(created.message);
  const webhookId = created.value.webhook.id;
  const queued = await sendTestEvent(db(), { actor: personalActor(ownerId), webhookId, now: NOW });
  if (!queued.ok) throw new Error(queued.message);
  const [job] = await db().select().from(schema.outbox).where(eq(schema.outbox.subject, webhookId));
  if (!job) throw new Error("no job");
  return { webhookId, job };
}

function batchOf(job: { id: number }) {
  const body: JobMessage = { id: job.id, topic: "webhook_delivery" };
  return createMessageBatch("portifact-jobs", [{ id: "m0", timestamp: NOW, attempts: 1, body }]);
}

describe("webhook deliveries in the jobs Worker", () => {
  it("delivers a queued job through the given network and acknowledges it", async () => {
    const { job } = await hookWithTest();
    const sent: string[] = [];
    const fetcher = async (url: string) => {
      sent.push(url);
      return new Response("ok");
    };
    const batch = batchOf(job);
    const ack = vi.spyOn(batch.messages[0] as Message<unknown>, "ack");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runQueue(batch, keyed, NOW, fetcher);
    expect(sent).toEqual(["https://hooks.example.com/in"]);
    expect(ack).toHaveBeenCalled();
    // The log line names the job, never the URL, the secret or the body.
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes("webhook_delivery"))).toBe(true);
    expect(lines.join("\n")).not.toContain("hooks.example.com");
    log.mockRestore();
    expect(await db().select().from(schema.outbox).where(eq(schema.outbox.id, job.id))).toEqual([]);
  });

  it("retries the message, keeping the job, when WEBHOOK_KEY is missing", async () => {
    const { job } = await hookWithTest();
    const batch = batchOf(job);
    const retry = vi.spyOn(batch.messages[0] as Message<unknown>, "retry");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetcher = vi.fn(async () => new Response("ok"));
    await runQueue(batch, env, NOW, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalled();
    error.mockRestore();
    expect(
      await db().select().from(schema.outbox).where(eq(schema.outbox.id, job.id)),
    ).toHaveLength(1);
  });

  it("holds every delivery while WEBHOOKS_PAUSED is set", async () => {
    const { job } = await hookWithTest();
    const fetcher = vi.fn(async () => new Response("ok"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runQueue(batchOf(job), { ...keyed, WEBHOOKS_PAUSED: "1" }, NOW, fetcher);
    log.mockRestore();
    expect(fetcher).not.toHaveBeenCalled();
    const [row] = await db().select().from(schema.outbox).where(eq(schema.outbox.id, job.id));
    expect(row?.availableAt).toBeGreaterThan(NOW);
    expect((await webhookDepsFromEnv({ ...keyed, WEBHOOKS_PAUSED: "" })).paused).toBe(false);
  });

  it("only relays on the one-minute schedule", async () => {
    const { job } = await hookWithTest();
    const waits: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      passThroughOnException: () => {},
      props: {},
    };
    worker.scheduled(
      createScheduledController({ scheduledTime: NOW, cron: RELAY_CRON }),
      env,
      ctx as unknown as ExecutionContext,
    );
    expect(waits).toHaveLength(1);
    expect(await waits[0]).toEqual(expect.any(Number));
    const [row] = await db().select().from(schema.outbox).where(eq(schema.outbox.id, job.id));
    // The consumer may already have run it; if not, it is marked sent.
    if (row) expect(row.dispatchedAt).toBe(NOW);
  });

  it("re-seals webhooks of the previous key during maintenance", async () => {
    const { webhookId } = await hookWithTest();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await runScheduled(
      { ...env, WEBHOOK_KEY: NEXT_KEY, WEBHOOK_KEY_PREVIOUS: KEY },
      NOW,
      {
        relay: false,
      },
    );
    log.mockRestore();
    expect(result.relayed).toBe("scheduled");
    expect(result.webhookKeysRewrapped).toBeGreaterThanOrEqual(1);
    expect(result.webhookKeysLeft).toBe(0);
    const [current] = await webhookKeys({ current: NEXT_KEY });
    const [row] = await db()
      .select()
      .from(schema.webhooks)
      .where(eq(schema.webhooks.id, webhookId));
    expect(row?.keyId).toBe(current?.id);
  });
});
