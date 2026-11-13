import { createScheduledController, env } from "cloudflare:test";
import { regionsFromEnv, schema } from "@portifact/db";
import { describe, expect, it, vi } from "vitest";
import worker, { RELAY_CRON, runPreviewPrune, runScheduled } from "../src/index.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 8);

describe("scheduled maintenance", () => {
  it("archives expired artifacts on each run", async () => {
    await regionsFromEnv(env)
      .get("default")
      .db.insert(schema.artifacts)
      .values({
        id: "k7d2qm4xab",
        ownerId: "u_owner",
        type: "site",
        name: "Plan",
        state: "active",
        expiresAt: NOW - DAY,
      });

    expect(await runScheduled(env, NOW)).toMatchObject({ archived: 1, purged: 0 });
    const [row] = await regionsFromEnv(env).get("default").db.select().from(schema.artifacts);
    expect(row?.state).toBe("archived");
  });

  it("runs from the scheduled handler", async () => {
    const waits: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      passThroughOnException: () => {},
      props: {},
    };
    worker.scheduled(
      createScheduledController({ scheduledTime: NOW, cron: "*/15 * * * *" }),
      env,
      ctx as unknown as ExecutionContext,
    );
    await Promise.all(waits);
    // Maintenance and the budget run, independently.
    expect(waits).toHaveLength(2);
  });
});

describe("access log retention", () => {
  const DAY_MS = 86_400_000;

  it("prunes openings older than 30 days on each run and keeps the rest", async () => {
    const insert = env.ACCESS_DB.prepare(
      "insert into access_events (artifact_id, window_start, user_id, owner_id, email, opened_at) values ('ret2345abc', ?, ?, 'u_o', 'r@example.test', ?)",
    );
    await insert.bind(NOW - 31 * DAY_MS, "u_old", NOW - 31 * DAY_MS).run();
    await insert.bind(NOW - 29 * DAY_MS, "u_recent", NOW - 29 * DAY_MS).run();
    expect(await runScheduled(env, NOW)).toMatchObject({ prunedAccessEvents: 1 });
    const left = await env.ACCESS_DB.prepare(
      "select user_id from access_events where artifact_id = 'ret2345abc'",
    ).all();
    expect(left.results).toEqual([{ user_id: "u_recent" }]);
  });

  it("reports a failed prune and still finishes the run", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      prepare() {
        throw new Error("access log unavailable");
      },
    } as unknown as D1Database;
    const result = await runScheduled({ ...env, ACCESS_DB: broken }, NOW);
    expect(result).toMatchObject({ prunedAccessEvents: "failed", storage: expect.anything() });
    expect(error).toHaveBeenCalledWith(
      JSON.stringify({
        event: "access_log_prune_failed",
        region: "default",
        error: "Error",
      }),
    );
    error.mockRestore();
  });
});

describe("the preview prune on the one-minute schedule (decision 0027)", () => {
  const minute = (workerEnv: typeof env) => {
    const waits: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      passThroughOnException: () => {},
      props: {},
    };
    worker.scheduled(
      createScheduledController({ scheduledTime: NOW, cron: RELAY_CRON }),
      workerEnv,
      ctx as unknown as ExecutionContext,
    );
    return waits;
  };
  const oldKey = () => `previews/${NOW - 3 * 60_000}/${crypto.randomUUID()}`;

  it("does nothing while suggestions are switched off", async () => {
    const key = oldKey();
    await env.ARTIFACTS.put(key, "<p>old</p>");
    expect(await runPreviewPrune(env, NOW)).toBe("off");
    await Promise.all(minute(env));
    expect(await env.ARTIFACTS.head(key)).not.toBeNull();
    await env.ARTIFACTS.delete(key);
  });

  it("prunes every region beside the relay, each in its own waitUntil, once switched on", async () => {
    const on = { ...env, SUGGESTIONS_ENABLED: "true" };
    const key = oldKey();
    const euKey = oldKey();
    await env.ARTIFACTS.put(key, "<p>old</p>");
    await env.ARTIFACTS_EU.put(euKey, "<p>old</p>");
    const waits = minute(on);
    // The relay and the prune never share a promise: one failing cannot stop the other.
    expect(waits).toHaveLength(2);
    await Promise.all(waits);
    expect(await env.ARTIFACTS.head(key)).toBeNull();
    expect(await env.ARTIFACTS_EU.head(euKey)).toBeNull();
  });

  it("logs a region whose prune fails and goes on with the others", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    const broken = {
      ...env,
      SUGGESTIONS_ENABLED: "true",
      ARTIFACTS: {
        list: async () => {
          throw new Error("down");
        },
      } as unknown as R2Bucket,
    };
    const euKey = oldKey();
    await env.ARTIFACTS_EU.put(euKey, "<p>old</p>");
    expect(await runPreviewPrune(broken, NOW)).toBe("failed");
    expect(errors.map((line) => JSON.parse(line).event)).toEqual(["preview_prune_failed"]);
    expect(await env.ARTIFACTS_EU.head(euKey)).toBeNull();
    vi.restoreAllMocks();
  });
});
