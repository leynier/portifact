// Migration 0048 rebuilds `webhooks` to widen its events CHECK for the review events, and with it
// `webhook_events` and `webhook_deliveries`, whose foreign keys would otherwise cascade the drop.
// These tests apply the migrations before it on an empty database, write realistic rows in all
// three tables, apply it and check that every row, index and key survives, that a stored
// subscription keeps its value, and that the new bits and the review column are accepted.
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

const MIGRATION = "0048_webhook_review_events.sql";
const NOW = Date.UTC(2026, 10, 10);
const D = () => env.MIGRATION_DB;

async function rows(table: string, order: string) {
  return (await D().prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()).results;
}

async function indexes(table: string) {
  const { results } = await D().prepare(`PRAGMA index_list(${table})`).all<{ name: string }>();
  return results.map((row) => row.name).sort();
}

async function rejects(statement: Promise<unknown>, pattern: RegExp) {
  const error = await statement.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "the statement should have been rejected").toBeInstanceOf(Error);
  expect(String((error as Error).message)).toMatch(pattern);
}

describe("migration 0048: review events for webhooks", () => {
  const before: Record<string, unknown[]> = {};
  const indexesBefore: Record<string, string[]> = {};

  beforeAll(async () => {
    const all = env.TEST_MIGRATIONS;
    const at = all.findIndex((m) => m.name === MIGRATION);
    expect(at, "migration 0048 should exist").toBeGreaterThan(0);
    await applyD1Migrations(D(), all.slice(0, at));
    const hook = D().prepare(
      "INSERT INTO webhooks (id, owner_id, host, format, events, key_id, url_box, secret_box, created_at, disabled_at, disabled_reason, failures, probation, reenables, reenable_day, created_by, created_via) VALUES (?, ?, 'hooks.example.com', ?, ?, 'k1', 'box', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dashboard')",
    );
    await D().batch([
      hook.bind(
        `wh_${"a".repeat(32)}`,
        "u_1",
        "generic",
        31,
        "sbox",
        NOW,
        null,
        null,
        0,
        0,
        0,
        null,
        "u_1",
      ),
      hook.bind(
        `wh_${"b".repeat(32)}`,
        "ws_1",
        "slack",
        5,
        null,
        NOW,
        NOW,
        "failures",
        15,
        1,
        2,
        NOW,
        null,
      ),
      D()
        .prepare(
          "INSERT INTO webhook_events (webhook_id, artifact_id, type, count, first_at, last_at, actor_id, version, access, expires_at) VALUES (?, 'abcdefghij', 'artifact.published', 3, ?, ?, 'u_1', 4, null, null)",
        )
        .bind(`wh_${"a".repeat(32)}`, NOW - 10, NOW),
      D()
        .prepare(
          "INSERT INTO webhook_deliveries (id, webhook_id, owner_id, delivery_id, attempt, at, outcome, status, error) VALUES (41, ?, 'u_1', ?, 2, ?, 'failed', null, 'timeout')",
        )
        .bind(`wh_${"a".repeat(32)}`, `whd_${"c".repeat(32)}`, NOW),
    ]);
    // A delivery of a removed webhook took ID 90 and is gone: the counter stays at 90, above
    // every row that is copied back.
    await D()
      .prepare(
        "INSERT INTO webhook_deliveries (id, webhook_id, owner_id, delivery_id, attempt, at, outcome) VALUES (90, ?, 'u_1', ?, 1, ?, 'delivered')",
      )
      .bind(`wh_${"a".repeat(32)}`, `whd_${"e".repeat(32)}`, NOW)
      .run();
    await D().prepare("DELETE FROM webhook_deliveries WHERE id = 90").run();
    for (const [table, order] of [
      ["webhooks", "id"],
      ["webhook_events", "webhook_id"],
      ["webhook_deliveries", "id"],
    ] as const) {
      before[table] = await rows(table, order);
      indexesBefore[table] = await indexes(table);
    }
    await applyD1Migrations(D(), all.slice(0, at + 1));
  });

  it("keeps every webhook, pending event and delivery, with no review on old events", async () => {
    expect(await rows("webhooks", "id")).toEqual(before.webhooks);
    expect(await rows("webhook_events", "webhook_id")).toEqual(
      (before.webhook_events as Record<string, unknown>[]).map((row) => ({ ...row, review: null })),
    );
    expect(await rows("webhook_deliveries", "id")).toEqual(before.webhook_deliveries);
    for (const table of ["webhooks", "webhook_events", "webhook_deliveries"]) {
      expect(await indexes(table), table).toEqual(indexesBefore[table]);
    }
  });

  it("leaves no temporary table and no broken key, and still cascades from a webhook", async () => {
    const { results: leftovers } = await D()
      .prepare("SELECT name FROM sqlite_master WHERE name LIKE '__new_%' OR name LIKE '__keep_%'")
      .all();
    expect(leftovers).toEqual([]);
    expect((await D().prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    // A new delivery takes an ID after the copied ones.
    await D()
      .prepare(
        "INSERT INTO webhook_deliveries (webhook_id, owner_id, delivery_id, attempt, at, outcome) VALUES (?, 'u_1', ?, 1, ?, 'delivered')",
      )
      .bind(`wh_${"a".repeat(32)}`, `whd_${"d".repeat(32)}`, NOW)
      .run();
    const { results } = await D()
      .prepare("SELECT max(id) AS id FROM webhook_deliveries")
      .all<{ id: number }>();
    // Never an ID a removed webhook's delivery already had: the counter survived the rebuild.
    expect(results[0]?.id).toBe(91);
    await D()
      .prepare("DELETE FROM webhooks WHERE id = ?")
      .bind(`wh_${"a".repeat(32)}`)
      .run();
    expect(await rows("webhook_events", "webhook_id")).toEqual([]);
    expect(await rows("webhook_deliveries", "id")).toEqual([]);
  });

  it("accepts the review bits and a review, and still refuses an empty or unknown bit set", async () => {
    await D()
      .prepare("UPDATE webhooks SET events = 127 WHERE id = ?")
      .bind(`wh_${"b".repeat(32)}`)
      .run();
    await D()
      .prepare(
        "INSERT INTO webhook_events (webhook_id, artifact_id, type, count, first_at, last_at, review) VALUES (?, 'abcdefghij', 'review.completed', 1, ?, ?, ?)",
      )
      .bind(`wh_${"b".repeat(32)}`, NOW, NOW, '{"status":"approved"}')
      .run();
    for (const events of [0, 128]) {
      await rejects(
        D()
          .prepare("UPDATE webhooks SET events = ? WHERE id = ?")
          .bind(events, `wh_${"b".repeat(32)}`)
          .run(),
        /CHECK constraint failed/,
      );
    }
  });
});
