// Migration 0048 on a database whose `webhook_deliveries` never had a row, so `sqlite_sequence`
// may hold no counter for it: saving and restoring the counter must not fail or invent a higher
// one, and the first delivery gets ID 1.
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

const MIGRATION = "0048_webhook_review_events.sql";
const D = () => env.MIGRATION_DB;

describe("migration 0048 on an empty delivery log", () => {
  beforeAll(async () => {
    const all = env.TEST_MIGRATIONS;
    const at = all.findIndex((m) => m.name === MIGRATION);
    expect(at, "migration 0048 should exist").toBeGreaterThan(0);
    await applyD1Migrations(D(), all.slice(0, at + 1));
  });

  it("keeps the counter at zero and starts the first delivery at 1", async () => {
    const counter = await D()
      .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'webhook_deliveries'")
      .all<{ seq: number }>();
    expect(counter.results.every((row) => row.seq === 0)).toBe(true);
    const { results: leftovers } = await D()
      .prepare("SELECT name FROM sqlite_master WHERE name LIKE '__keep_%'")
      .all();
    expect(leftovers).toEqual([]);
    await D()
      .prepare(
        "INSERT INTO webhooks (id, owner_id, host, format, events, key_id, url_box, created_via) VALUES ('wh_1', 'u_1', 'hooks.example.com', 'generic', 96, 'k1', 'box', 'dashboard')",
      )
      .run();
    await D()
      .prepare(
        "INSERT INTO webhook_deliveries (webhook_id, owner_id, delivery_id, attempt, at, outcome) VALUES ('wh_1', 'u_1', 'whd_1', 1, 1, 'delivered')",
      )
      .run();
    const { results } = await D()
      .prepare("SELECT id FROM webhook_deliveries")
      .all<{ id: number }>();
    expect(results).toEqual([{ id: 1 }]);
  });
});
