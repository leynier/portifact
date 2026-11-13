// The suggestion scans read only what they return (review of pull request #262, finding 8): with a
// large prefix of rows they skip, each selection's `meta.rows_read` stays near its limit and its
// query plan seeks an index instead of scanning the table.
import { env } from "cloudflare:test";
import { schema } from "@portifact/db";
import type { SQL } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import {
  draftPage,
  expireAcceptAttempts,
  overdueAttemptQueries,
  retentionSweeps,
  sweepPage,
} from "../src/suggestion-maintenance.ts";
import { DAY, db, NOW, user } from "./fixtures.ts";
import { publishDoc } from "./suggestion-support.ts";

const dialect = new SQLiteAsyncDialect();
const PREFIX = 300;
const LIMIT = 20;

async function run(query: { sql: string; params: unknown[] }) {
  return env.DB.prepare(query.sql)
    .bind(...query.params)
    .all<Record<string, unknown>>();
}

async function plan(query: { sql: string; params: unknown[] }): Promise<string> {
  const rows = await env.DB.prepare(`explain query plan ${query.sql}`)
    .bind(...query.params)
    .all<{ detail: string }>();
  return rows.results.map((row) => row.detail).join("\n");
}

const raw = (query: SQL) => dialect.sqlToQuery(query);

async function prefix(state: "running" | "ended") {
  const owner = await user("Owner");
  const doc = await publishDoc(owner.id);
  const rows = Array.from({ length: PREFIX }, (_, i) => ({
    id: `scan_${state}_${doc.artifactId}_${i}`,
    artifactId: doc.artifactId,
    ownerId: owner.id,
    origin: "draft" as const,
    userId: owner.id,
    digest: "a".repeat(64),
    baseVersionId: doc.versionId,
    state,
    ...(state === "ended" ? { reason: "failed" as const } : {}),
    deliveries: 0,
    // Fresh: neither overdue nor past retention.
    createdAt: NOW,
    updatedAt: NOW,
  }));
  for (let i = 0; i < rows.length; i += 6) {
    await db().insert(schema.acceptanceAttempts).values(rows.slice(i, i + 6));
  }
  return { owner, doc };
}

describe("the suggestion scans' reads", () => {
  it("reads no fresh running attempt when nothing is overdue", async () => {
    await prefix("running");
    for (const query of overdueAttemptQueries(NOW + 1_000, LIMIT).map(raw)) {
      const result = await run(query);
      expect(result.results).toEqual([]);
      expect(result.meta.rows_read, await plan(query)).toBeLessThanOrEqual(LIMIT);
      expect(await plan(query)).not.toMatch(/SCAN acceptance_attempts/);
    }
    expect((await expireAcceptAttempts(db(), NOW + 1_000)).ended).toBe(0);
  });

  it("reads no fresh finished attempt, closed item or draft past a retention cursor", async () => {
    await prefix("ended");
    for (const sweep of retentionSweeps(NOW + DAY)) {
      const query = raw(sweepPage(db(), sweep, [-1, -1], LIMIT));
      const result = await run(query);
      expect(result.results).toEqual([]);
      expect(result.meta.rows_read, sweep.name).toBeLessThanOrEqual(LIMIT);
      expect(await plan(query), sweep.name).not.toMatch(
        /SCAN (acceptance_attempts|change_items|edit_drafts)$/m,
      );
    }
  });

  it("seeks the drafts from the cursor instead of scanning the prefix", async () => {
    const query = draftPage(db(), ["zzzzzzzzzz", "zz"], 200).toSQL();
    expect(await plan(query)).toMatch(/SEARCH edit_drafts/);
  });
});
