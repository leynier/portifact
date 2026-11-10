// Batching of the access log on the content Worker: openings are gathered per isolate, written
// once per batch after the response, deduplicated by window, and kept when a write fails.
import { env } from "cloudflare:test";
import { createAccessDb, regionsFromEnv, schema } from "@portifact/db";
import { ACCESS_WINDOW_MS } from "@portifact/domain";
import { recordOpenings } from "@portifact/services";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCESS_FLUSH_MS, type Opening, OpeningLog } from "../src/access-log.ts";
import { isolateOpenings } from "../src/index.ts";

const NOW = Date.UTC(2026, 10, 8, 12);
const WINDOW = Math.floor(NOW / ACCESS_WINDOW_MS) * ACCESS_WINDOW_MS;
const opening = (overrides: Partial<Opening> = {}): Opening => ({
  artifactId: "a2345abcde",
  userId: "u_reader",
  at: WINDOW + 60_000,
  ...overrides,
});

/** A log whose writes the test sees, with the waits it scheduled. */
function harness(write: (openings: Opening[]) => Promise<unknown> = async () => undefined) {
  const writes: Opening[][] = [];
  const waits: Promise<unknown>[] = [];
  const log = new OpeningLog(async (batch) => {
    writes.push(batch);
    await write(batch);
  }, 0);
  const record = (value: Opening) => log.record(value, (promise) => waits.push(promise));
  const settle = () => Promise.all(waits.splice(0));
  return { log, writes, record, settle };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("opening log", () => {
  it("writes a batch once, after the response, with one opening per visitor and window", async () => {
    const { writes, record, settle } = harness();
    record(opening());
    record(opening({ at: WINDOW + 120_000 }));
    record(opening({ userId: "u_other" }));
    record(opening({ at: WINDOW + ACCESS_WINDOW_MS }));
    expect(writes).toEqual([]);
    await settle();
    expect(writes).toEqual([
      [opening(), opening({ userId: "u_other" }), opening({ at: WINDOW + ACCESS_WINDOW_MS })],
    ]);
  });

  it("skips what the isolate already wrote in the window and writes again in the next one", async () => {
    const { log, writes, record, settle } = harness();
    record(opening());
    await settle();
    record(opening({ at: WINDOW + 10 * 60_000 }));
    await settle();
    expect(writes).toHaveLength(1);
    expect(log.pending()).toEqual([]);
    const next = opening({ at: WINDOW + ACCESS_WINDOW_MS + 1 });
    record(next);
    await settle();
    expect(writes).toEqual([[opening()], [next]]);
    // The earlier window is forgotten once a later one is written.
    record(opening({ at: WINDOW + 2 }));
    await settle();
    expect(writes).toHaveLength(3);
  });

  it("keeps a failed batch for the next one and logs no identifiers", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    const { log, writes, record, settle } = harness(async () => {
      if (fail) throw new Error("d1 down for u_reader");
    });
    record(opening());
    await settle();
    expect(log.pending()).toEqual([opening()]);
    expect(error).toHaveBeenCalledWith("access log write failed; kept for the next batch");
    fail = false;
    record(opening({ userId: "u_other" }));
    await settle();
    expect(writes.at(-1)).toEqual([opening(), opening({ userId: "u_other" })]);
    expect(log.pending()).toEqual([]);
  });

  it("does nothing when flushed with nothing pending", async () => {
    const { log, writes } = harness();
    await log.flush();
    expect(writes).toEqual([]);
  });

  it("waits a few seconds before writing by default", () => {
    expect(ACCESS_FLUSH_MS).toBe(5_000);
  });
});

describe("the isolate's log", () => {
  it("writes openings to the access log database with the visitor's email", async () => {
    const db = regionsFromEnv(env).get("default").db;
    const at = new Date(NOW);
    await db.insert(schema.users).values(
      ["al_owner", "al_reader"].map((id) => ({
        id,
        name: id,
        email: `${id}@example.com`,
        emailVerified: true,
        createdAt: at,
        updatedAt: at,
      })),
    );
    await db.insert(schema.artifacts).values({
      id: "al2345abcd",
      ownerId: "al_owner",
      type: "site",
      name: "Plan",
      state: "active",
      accessMode: "restricted",
      expiresAt: NOW + 86_400_000,
    });
    const log = isolateOpenings(env);
    expect(isolateOpenings(env)).toBe(log);
    log.record({ artifactId: "al2345abcd", userId: "al_reader", at: NOW }, () => {});
    await log.flush();
    // drizzle-orm is not a dependency of this app, so rows are read with raw SQL.
    const rows = async () =>
      (
        await env.ACCESS_DB.prepare("SELECT * FROM access_events WHERE artifact_id = ?")
          .bind("al2345abcd")
          .all()
      ).results;
    expect(await rows()).toEqual([
      {
        artifact_id: "al2345abcd",
        window_start: WINDOW,
        user_id: "al_reader",
        owner_id: "al_owner",
        email: "al_reader@example.com",
        opened_at: NOW,
      },
    ]);
    // The same writer the isolate uses, called again for the same window, adds no row.
    await recordOpenings(db, createAccessDb(env.ACCESS_DB), [
      { artifactId: "al2345abcd", userId: "al_reader", at: NOW + 60_000 },
    ]);
    expect(await rows()).toHaveLength(1);
  });
});
