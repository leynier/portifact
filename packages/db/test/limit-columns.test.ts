// Migration 0027 rebuilds account_usage and annotation_usage with per-row limit columns. These
// tests apply the migrations up to 0026 on an empty database, write realistic rows, apply 0027
// and check that the rows, the triggers and the limits behave exactly as before.
import { applyD1Migrations, env } from "cloudflare:test";
import { ANNOTATION_LIMITS, LIMITS } from "@portifact/contracts";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema } from "../src/index.ts";

const NOW = Date.UTC(2026, 10, 9);
const MIGRATION = "0027_account_limit_columns.sql";
const db = () => createDb(env.MIGRATION_DB);

/** Asserts the database refused the statement; Drizzle wraps the SQLite error in `cause`. */
async function rejects(statement: Promise<unknown>, pattern: RegExp) {
  const error = await statement.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "the statement should have been rejected").toBeInstanceOf(Error);
  const messages: string[] = [];
  for (let e: unknown = error; e instanceof Error; e = e.cause) messages.push(e.message);
  expect(messages.join("\n")).toMatch(pattern);
}

/**
 * An artifact row in raw SQL: the schema has columns added by later migrations (`pinned`, 0030)
 * that this database at 0027 does not have, so Drizzle's insert would name them.
 */
async function insertArtifact(id: string, ownerId: string, state: "active" | "draft") {
  await env.MIGRATION_DB.prepare(
    "INSERT INTO artifacts (id, owner_id, type, name, state) VALUES (?, ?, 'site', 'Plan', ?)",
  )
    .bind(id, ownerId, state)
    .run();
}

async function triggers() {
  const { results } = await env.MIGRATION_DB.prepare(
    "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
  ).all<{ name: string; tbl_name: string; sql: string }>();
  return results;
}

async function indexCount(table: string) {
  const { results } = await env.MIGRATION_DB.prepare(`PRAGMA index_list(${table})`).all();
  return results.length;
}

const ACCOUNT_ROWS = [
  // At every limit at once, with one open upload more than the trigger allows (a legacy row).
  [
    "u_full",
    LIMITS.activeArtifacts,
    LIMITS.accountBytes - 1_000,
    1_000,
    3,
    417,
    Date.UTC(2026, 10, 1),
    NOW - 5,
  ],
  ["u_light", 3, 12_345_678, 0, 1, 9, Date.UTC(2026, 9, 1), NOW - 86_400_000],
] as const;
const ANNOTATION_ROWS = [
  ["u_full", ANNOTATION_LIMITS.messagesPerOwner, ANNOTATION_LIMITS.bytesPerOwner],
  ["u_light", 12, 4_096],
] as const;

describe("migration 0027: account limits as columns", () => {
  let triggersBefore: Awaited<ReturnType<typeof triggers>>;
  let indexesBefore: number[];

  beforeAll(async () => {
    const all = env.TEST_MIGRATIONS;
    const at = all.findIndex((m) => m.name === MIGRATION);
    expect(at, "migration 0027 should exist").toBeGreaterThan(0);
    await applyD1Migrations(env.MIGRATION_DB, all.slice(0, at));

    const account = env.MIGRATION_DB.prepare(
      "INSERT INTO account_usage (owner_id, active_artifacts, stored_bytes, reserved_bytes, open_uploads, new_objects_this_month, month_started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const annotation = env.MIGRATION_DB.prepare(
      "INSERT INTO annotation_usage (owner_id, messages, bytes) VALUES (?, ?, ?)",
    );
    await env.MIGRATION_DB.batch([
      ...ACCOUNT_ROWS.map((row) => account.bind(...row)),
      ...ANNOTATION_ROWS.map((row) => annotation.bind(...row)),
    ]);
    triggersBefore = await triggers();
    indexesBefore = [await indexCount("account_usage"), await indexCount("annotation_usage")];

    // Up to 0027 only: later migrations add triggers of their own (0029 on workspaces).
    await applyD1Migrations(env.MIGRATION_DB, all.slice(0, at + 1));
  });

  it("keeps every existing value and gives the rows the free plan's limits", async () => {
    const accounts = await db()
      .select()
      .from(schema.accountUsage)
      .orderBy(schema.accountUsage.ownerId);
    expect(accounts).toEqual(
      ACCOUNT_ROWS.map(([ownerId, active, stored, reserved, open, objects, month, updated]) => ({
        ownerId,
        activeArtifacts: active,
        storedBytes: stored,
        reservedBytes: reserved,
        openUploads: open,
        newObjectsThisMonth: objects,
        monthStartedAt: month,
        updatedAt: updated,
        activeLimit: LIMITS.activeArtifacts,
        bytesLimit: LIMITS.accountBytes,
      })),
    );
    const annotations = await db()
      .select()
      .from(schema.annotationUsage)
      .orderBy(schema.annotationUsage.ownerId);
    expect(annotations).toEqual(
      ANNOTATION_ROWS.map(([ownerId, messages, bytes]) => ({
        ownerId,
        messages,
        bytes,
        messagesLimit: ANNOTATION_LIMITS.messagesPerOwner,
        bytesLimit: ANNOTATION_LIMITS.bytesPerOwner,
      })),
    );
  });

  it("recreates every trigger unchanged and leaves no temporary table or broken key", async () => {
    expect(triggersBefore.map((t) => t.name)).toHaveLength(11);
    expect(await triggers()).toEqual(triggersBefore);
    expect([await indexCount("account_usage"), await indexCount("annotation_usage")]).toEqual(
      indexesBefore,
    );
    const { results: leftovers } = await env.MIGRATION_DB.prepare(
      "SELECT name FROM sqlite_master WHERE name LIKE '__new_%'",
    ).all();
    expect(leftovers).toEqual([]);
    const { results: broken } = await env.MIGRATION_DB.prepare("PRAGMA foreign_key_check").all();
    expect(broken).toEqual([]);
  });

  it("still counts active slots on archive, restore, suspend and reinstate", async () => {
    const owner = "u_lifecycle";
    await db()
      .insert(schema.accountUsage)
      .values({ ownerId: owner, activeArtifacts: 1, monthStartedAt: NOW });
    await insertArtifact("lifecycl01", owner, "active");
    const setState = (state: "active" | "archived" | "suspended") =>
      db().update(schema.artifacts).set({ state }).where(eq(schema.artifacts.id, "lifecycl01"));
    const active = async () =>
      (
        await db()
          .select({ n: schema.accountUsage.activeArtifacts })
          .from(schema.accountUsage)
          .where(eq(schema.accountUsage.ownerId, owner))
      )[0]?.n;

    await setState("archived");
    expect(await active()).toBe(0);
    await setState("active");
    expect(await active()).toBe(1);
    await setState("suspended");
    expect(await active()).toBe(0);
    await setState("active");
    expect(await active()).toBe(1);

    // A restore past the limit is still refused by the CHECK constraint.
    await db()
      .update(schema.accountUsage)
      .set({ activeArtifacts: LIMITS.activeArtifacts })
      .where(eq(schema.accountUsage.ownerId, owner));
    await setState("archived");
    await db()
      .update(schema.accountUsage)
      .set({ activeArtifacts: LIMITS.activeArtifacts })
      .where(eq(schema.accountUsage.ownerId, owner));
    await rejects(setState("active"), /account_usage_active_limit/);
  });

  it("still refuses a third open upload and lets uploads close", async () => {
    const change = (owner: string, delta: number) =>
      env.MIGRATION_DB.prepare(
        "UPDATE account_usage SET open_uploads = open_uploads + ? WHERE owner_id = ?",
      )
        .bind(delta, owner)
        .run();
    await change("u_light", 1);
    await rejects(change("u_light", 1), /account_usage_open_uploads_limit/);
    await rejects(change("u_full", 1), /account_usage_open_uploads_limit/);
    await change("u_full", -1);
  });

  it("still keeps annotation usage on every write and refuses one past the limit", async () => {
    const owner = "u_annotator";
    await insertArtifact("annotate01", owner, "draft");
    // Raw SQL: the schema has columns added after migration 0027 (decision 0027's suggestions).
    await env.MIGRATION_DB.prepare(
      "INSERT INTO annotation_threads (id, artifact_id, version_id, owner_id, author_id, target, target_bytes, path, updated_at) VALUES ('t1', 'annotate01', 'v1', ?, 'u_author', '{}', 30, 'index.html', ?)",
    )
      .bind(owner, NOW)
      .run();
    const message = (id: string, bodyBytes: number) =>
      db()
        .insert(schema.annotationMessages)
        .values({
          id,
          threadId: "t1",
          artifactId: "annotate01",
          ownerId: owner,
          authorId: "u_author",
          body: "x".repeat(bodyBytes),
          bodyBytes,
        });
    const usage = async () => {
      const [row] = await db()
        .select({ messages: schema.annotationUsage.messages, bytes: schema.annotationUsage.bytes })
        .from(schema.annotationUsage)
        .where(eq(schema.annotationUsage.ownerId, owner));
      return row;
    };

    await message("m1", 10);
    expect(await usage()).toEqual({ messages: 1, bytes: 40 });
    await db()
      .update(schema.annotationMessages)
      .set({ state: "deleted", body: null, bodyBytes: 0 })
      .where(eq(schema.annotationMessages.id, "m1"));
    expect(await usage()).toEqual({ messages: 0, bytes: 30 });
    await db().delete(schema.annotationMessages).where(eq(schema.annotationMessages.id, "m1"));
    await db().delete(schema.annotationThreads).where(eq(schema.annotationThreads.id, "t1"));
    expect(await usage()).toEqual({ messages: 0, bytes: 0 });

    await rejects(
      env.MIGRATION_DB.prepare(
        "UPDATE annotation_usage SET messages = messages + 1 WHERE owner_id = ?",
      )
        .bind("u_full")
        .run(),
      /annotation_usage_messages_limit/,
    );
  });
});

describe("limit columns", () => {
  const raw = () => createDb(env.DB);

  it("default to the free plan's limits in contracts", async () => {
    await raw().insert(schema.accountUsage).values({ ownerId: "u_defaults", monthStartedAt: NOW });
    await env.DB.prepare(
      "INSERT INTO annotation_usage (owner_id, messages, bytes) VALUES ('u_defaults', 0, 0)",
    ).run();
    const [account] = await raw()
      .select()
      .from(schema.accountUsage)
      .where(eq(schema.accountUsage.ownerId, "u_defaults"));
    const [annotation] = await raw()
      .select()
      .from(schema.annotationUsage)
      .where(eq(schema.annotationUsage.ownerId, "u_defaults"));
    expect(account).toMatchObject({
      activeLimit: LIMITS.activeArtifacts,
      bytesLimit: LIMITS.accountBytes,
    });
    expect(annotation).toMatchObject({
      messagesLimit: ANNOTATION_LIMITS.messagesPerOwner,
      bytesLimit: ANNOTATION_LIMITS.bytesPerOwner,
    });
  });

  it("let a raised limit admit usage above the free plan and still refuse past it", async () => {
    const owner = "u_raised";
    await raw().insert(schema.accountUsage).values({
      ownerId: owner,
      activeArtifacts: LIMITS.activeArtifacts,
      storedBytes: LIMITS.accountBytes,
      monthStartedAt: NOW,
      activeLimit: 200,
      bytesLimit: 10_000_000_000,
    });
    await env.DB.prepare(
      "INSERT INTO annotation_usage (owner_id, messages, bytes, messages_limit, bytes_limit) VALUES (?, ?, ?, 20000, 200000000)",
    )
      .bind(owner, ANNOTATION_LIMITS.messagesPerOwner, ANNOTATION_LIMITS.bytesPerOwner)
      .run();
    const account = (set: string) =>
      env.DB.prepare(`UPDATE account_usage SET ${set} WHERE owner_id = ?`).bind(owner).run();
    const annotation = (set: string) =>
      env.DB.prepare(`UPDATE annotation_usage SET ${set} WHERE owner_id = ?`).bind(owner).run();

    await account("active_artifacts = active_artifacts + 1, reserved_bytes = 1000");
    await account("active_artifacts = 200, stored_bytes = 9999999000, reserved_bytes = 1000");
    await rejects(account("active_artifacts = 201"), /account_usage_active_limit/);
    await rejects(account("reserved_bytes = 1001"), /account_usage_bytes_limit/);

    await annotation("messages = messages + 1, bytes = bytes + 1");
    await annotation("messages = 20000, bytes = 200000000");
    await rejects(annotation("messages = 20001"), /annotation_usage_messages_limit/);
    await rejects(annotation("bytes = 200000001"), /annotation_usage_bytes_limit/);
  });

  it("are required and never negative", async () => {
    await raw().insert(schema.accountUsage).values({ ownerId: "u_negative", monthStartedAt: NOW });
    await rejects(
      env.DB.prepare(
        "UPDATE account_usage SET active_limit = -1 WHERE owner_id = 'u_negative'",
      ).run(),
      /CHECK constraint failed/,
    );
    await rejects(
      env.DB.prepare(
        "UPDATE account_usage SET bytes_limit = NULL WHERE owner_id = 'u_negative'",
      ).run(),
      /NOT NULL constraint failed/,
    );
    await rejects(
      env.DB.prepare(
        "INSERT INTO annotation_usage (owner_id, messages, bytes, bytes_limit) VALUES ('u_negative', 0, 0, -1)",
      ).run(),
      /CHECK constraint failed/,
    );
    const [{ n } = { n: -1 }] = await raw()
      .select({ n: sql<number>`count(*)` })
      .from(schema.annotationUsage)
      .where(eq(schema.annotationUsage.ownerId, "u_negative"));
    expect(n).toBe(0);
  });
});
