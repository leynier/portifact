import { env } from "cloudflare:test";
import { regionsFromEnv, schema } from "@portifact/db";
import { describe, expect, it } from "vitest";
import {
  ABANDONED_CLAIM_MS,
  hashRequest,
  IDEMPOTENCY_TTL_MS,
  pruneOperations,
  runIdempotent,
} from "../src/idempotency.ts";

const db = () => regionsFromEnv(env).get("default").db;
const NOW = Date.UTC(2026, 10, 8, 12);

function request(overrides: Partial<Parameters<typeof runIdempotent>[1]> = {}) {
  return {
    actorId: "u_actor",
    key: `key-${crypto.randomUUID()}`,
    operation: "publish.prepare",
    requestHash: "a".repeat(64),
    now: NOW,
    ...overrides,
  };
}

describe("idempotent mutations", () => {
  it("runs the work once and replays the stored response for a retry", async () => {
    const req = request();
    let runs = 0;
    const work = async () => {
      runs += 1;
      return { status: 201, body: { id: "x", runs } };
    };
    const first = await runIdempotent(db(), req, work);
    const second = await runIdempotent(db(), { ...req, now: NOW + 1000 }, work);
    expect(first).toEqual({ kind: "fresh", response: { status: 201, body: { id: "x", runs: 1 } } });
    expect(second).toEqual({
      kind: "replayed",
      response: { status: 201, body: { id: "x", runs: 1 } },
    });
    expect(runs).toBe(1);
  });

  it("stores client errors too, so a retry does not run twice", async () => {
    const req = request();
    let runs = 0;
    const work = async () => {
      runs += 1;
      return { status: 409, body: { error: { code: "version_conflict", message: "x" } } };
    };
    await runIdempotent(db(), req, work);
    expect((await runIdempotent(db(), req, work)).kind).toBe("replayed");
    expect(runs).toBe(1);
  });

  it("refuses the same key with a different body or operation", async () => {
    const req = request();
    await runIdempotent(db(), req, async () => ({ status: 200, body: {} }));
    const work = async () => ({ status: 200, body: { other: true } });
    expect(await runIdempotent(db(), { ...req, requestHash: "b".repeat(64) }, work)).toEqual({
      kind: "mismatch",
    });
    expect(await runIdempotent(db(), { ...req, operation: "other" }, work)).toEqual({
      kind: "mismatch",
    });
  });

  it("keeps keys apart per user", async () => {
    const req = request();
    await runIdempotent(db(), req, async () => ({ status: 200, body: { who: "a" } }));
    const other = await runIdempotent(db(), { ...req, actorId: "u_other" }, async () => ({
      status: 200,
      body: { who: "b" },
    }));
    expect(other).toEqual({ kind: "fresh", response: { status: 200, body: { who: "b" } } });
  });

  it("reports a request still running with the same key", async () => {
    const req = request();
    let release: () => void = () => {};
    const slow = runIdempotent(db(), req, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { status: 200, body: {} };
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await runIdempotent(db(), req, async () => ({ status: 200, body: {} }))).toEqual({
      kind: "in_progress",
    });
    release();
    expect((await slow).kind).toBe("fresh");
  });

  it("frees the key when the work fails with a server error or throws", async () => {
    const req = request();
    const failed = await runIdempotent(db(), req, async () => ({ status: 503, body: {} }));
    expect(failed.kind).toBe("fresh");
    expect((await runIdempotent(db(), req, async () => ({ status: 200, body: 1 }))).kind).toBe(
      "fresh",
    );

    const other = request();
    await expect(
      runIdempotent(db(), other, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await runIdempotent(db(), other, async () => ({ status: 200, body: 2 }))).kind).toBe(
      "fresh",
    );
  });

  it("frees an abandoned claim and an expired response", async () => {
    const abandoned = request();
    await db()
      .insert(schema.operations)
      .values({
        actorId: abandoned.actorId,
        idempotencyKey: abandoned.key,
        operation: abandoned.operation,
        requestHash: abandoned.requestHash,
        createdAt: NOW - ABANDONED_CLAIM_MS - 1,
      });
    expect(
      (await runIdempotent(db(), abandoned, async () => ({ status: 200, body: 1 }))).kind,
    ).toBe("fresh");

    const expired = request();
    await runIdempotent(db(), expired, async () => ({ status: 200, body: "old" }));
    const later = { ...expired, now: NOW + IDEMPOTENCY_TTL_MS + 1 };
    expect(await runIdempotent(db(), later, async () => ({ status: 200, body: "new" }))).toEqual({
      kind: "fresh",
      response: { status: 200, body: "new" },
    });
  });

  it("prunes stored responses past the retention window", async () => {
    const req = request({ now: NOW - IDEMPOTENCY_TTL_MS - 10 });
    await runIdempotent(db(), req, async () => ({ status: 200, body: {} }));
    expect(await pruneOperations(db(), NOW)).toBeGreaterThanOrEqual(1);
    expect(await pruneOperations(db(), NOW)).toBe(0);
  });

  it("prunes in bounded batches", async () => {
    const old = NOW - IDEMPOTENCY_TTL_MS - 10;
    for (let i = 0; i < 3; i += 1) {
      await runIdempotent(db(), request({ now: old }), async () => ({ status: 200, body: i }));
    }
    expect(await pruneOperations(db(), NOW, 2)).toBe(2);
    expect(await pruneOperations(db(), NOW, 2)).toBe(1);
    expect(await pruneOperations(db(), NOW, 2)).toBe(0);
  });

  it("hashes equal bodies equally and different bodies differently", async () => {
    expect(await hashRequest({ a: 1 })).toBe(await hashRequest({ a: 1 }));
    expect(await hashRequest({ a: 1 })).not.toBe(await hashRequest({ a: 2 }));
    expect(await hashRequest({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
