// The consumer of the `portifact-email-events` queue: Cloudflare Email Service publishes bounces
// and complaints there, and the consumer records them in the suppression list.
import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import { regionsFromEnv, schema } from "@portifact/db";
import { isEmailSuppressed } from "@portifact/services";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { EMAIL_EVENTS_QUEUE } from "../src/index.ts";

const NOW = Date.UTC(2026, 10, 8);
const db = () => regionsFromEnv(env).get("default").db;

function event(type: string, recipient: string, bounce?: string) {
  return {
    type: `cf.email.sending.message.${type}`,
    source: { type: "email.sending", zoneId: "z", domain: "portifact.com" },
    payload: {
      eventId: `evt-${type}-${crypto.randomUUID()}`,
      messageId: "m",
      sender: "noreply@portifact.com",
      recipient,
      terminal: true,
      ...(bounce ? { bounce: { type: bounce, classification: "x", reason: "550" } } : {}),
    },
    metadata: { accountId: "a", eventSchemaVersion: 1, eventTimestamp: "2026-11-08T00:00:00Z" },
  };
}

async function deliver(bodies: unknown[]) {
  const batch = createMessageBatch(
    EMAIL_EVENTS_QUEUE,
    bodies.map((body, i) => ({ id: `m${i}`, timestamp: NOW, attempts: 1, body })),
  );
  const ctx = createExecutionContext();
  await worker.queue(batch, env);
  return getQueueResult(batch, ctx);
}

const logs: string[] = [];
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await db().delete(schema.emailSuppressions);
  logs.length = 0;
  for (const level of ["log", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("email events consumer", () => {
  it("suppresses hard bounces and complaints and acknowledges every event", async () => {
    const result = await deliver([
      event("bounced", "hard@example.test", "hard"),
      event("complained", "spam@example.test"),
      event("bounced", "soft@example.test", "soft"),
      event("delivered", "fine@example.test"),
      // Also accepted as a JSON string, in case the subscription delivers text.
      JSON.stringify(event("complained", "text@example.test")),
    ]);
    expect(result.explicitAcks).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    expect(result.retryMessages).toEqual([]);
    expect(await isEmailSuppressed(db(), "hard@example.test", NOW)).toBe(true);
    expect(await isEmailSuppressed(db(), "spam@example.test", NOW)).toBe(true);
    expect(await isEmailSuppressed(db(), "text@example.test", NOW)).toBe(true);
    expect(await isEmailSuppressed(db(), "soft@example.test", NOW)).toBe(false);
    expect(await isEmailSuppressed(db(), "fine@example.test", NOW)).toBe(false);
  });

  it("drops malformed events without retrying them", async () => {
    const result = await deliver([null, "{not json", { type: "x", payload: {} }]);
    expect(result.explicitAcks).toEqual(["m0", "m1", "m2"]);
    expect(result.retryMessages).toEqual([]);
    expect(logs.filter((line) => line.includes("email_event_malformed"))).toHaveLength(3);
  });

  it("never logs the recipient's address", async () => {
    await deliver([event("complained", "secret.person@example.test")]);
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) expect(line).not.toContain("secret.person");
  });

  it("retries an event when recording it fails", async () => {
    const broken = { ...env, DB: undefined as unknown as D1Database };
    const batch = createMessageBatch(EMAIL_EVENTS_QUEUE, [
      { id: "m0", timestamp: NOW, attempts: 1, body: event("complained", "x@example.test") },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, broken);
    const result = await getQueueResult(batch, ctx);
    expect(result.retryMessages.map((m) => m.msgId)).toEqual(["m0"]);
    expect(logs.some((line) => line.includes("email_event_failed"))).toBe(true);
  });
});
