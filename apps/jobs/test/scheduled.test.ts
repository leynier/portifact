import { createScheduledController, env } from "cloudflare:test";
import { createDb, schema } from "@portifact/db";
import { describe, expect, it } from "vitest";
import worker, { runScheduled } from "../src/index.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 8);

describe("scheduled maintenance", () => {
  it("archives expired artifacts on each run", async () => {
    await createDb(env.DB)
      .insert(schema.artifacts)
      .values({
        id: "k7d2qm4xab",
        ownerId: "u_owner",
        type: "site",
        name: "Plan",
        state: "active",
        expiresAt: NOW - DAY,
      });

    expect(await runScheduled(env, NOW)).toMatchObject({ archived: 1, purged: 0 });
    const [row] = await createDb(env.DB).select().from(schema.artifacts);
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
    expect(waits).toHaveLength(1);
  });
});
