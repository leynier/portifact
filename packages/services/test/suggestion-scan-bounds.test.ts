// The suggestion scans read only what they return (review of pull request #262, finding 8): with a
// large prefix of rows they skip, each selection's `meta.rows_read` stays near its limit and its
// query plan seeks an index instead of scanning the table.
import { env } from "cloudflare:test";
import { schema } from "@portifact/db";
import { eq, type SQL, sql } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { notHeldSql } from "../src/legal-holds.ts";
import {
  draftPage,
  expireAcceptAttempts,
  overdueAttemptQueries,
  pruneSuggestionRecords,
  retentionSweeps,
  sweepPage,
} from "../src/suggestion-maintenance.ts";
import { DAY, db, NOW, user, value } from "./fixtures.ts";
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
    await db()
      .insert(schema.acceptanceAttempts)
      .values(rows.slice(i, i + 6));
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
      const query = raw(sweepPage(sweep, null, LIMIT));
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

/** Rows due for one sweep, all at the same old time, `count` of them, on one artifact. */
async function due(
  sweep: string,
  count: number,
  at: number,
  artifact?: { id: string; owner: string; version: string },
) {
  const owner = artifact ? { id: artifact.owner } : await user("Owner");
  const doc = artifact
    ? { artifactId: artifact.id, versionId: artifact.version }
    : await publishDoc(owner.id);
  const ids = Array.from(
    { length: count },
    (_, i) => `${sweep}_${doc.artifactId}_${String(i).padStart(4, "0")}`,
  );
  for (let i = 0; i < ids.length; i += 6) {
    const chunk = ids.slice(i, i + 6);
    if (sweep === "suggestion_attempts_retention") {
      await db()
        .insert(schema.acceptanceAttempts)
        .values(
          chunk.map((id) => ({
            id,
            artifactId: doc.artifactId,
            ownerId: owner.id,
            origin: "draft" as const,
            userId: owner.id,
            digest: "a".repeat(64),
            baseVersionId: doc.versionId,
            state: "ended" as const,
            reason: "failed" as const,
            createdAt: at,
            updatedAt: at,
          })),
        );
    } else if (sweep === "suggestion_items_retention") {
      await db()
        .insert(schema.changeItems)
        .values(
          chunk.map((id) => ({
            id,
            artifactId: doc.artifactId,
            ownerId: owner.id,
            origin: "draft" as const,
            versionId: doc.versionId,
            path: "index.md",
            envelope: '{"format":1}',
            proof: "",
            bytes: 12,
            reason: "not_eligible",
            state: "dismissed" as const,
            closedAt: at,
          })),
        );
    } else {
      await db()
        .insert(schema.editDrafts)
        .values(
          chunk.map((id) => ({
            artifactId: doc.artifactId,
            userId: id,
            ownerId: owner.id,
            baseVersionId: doc.versionId,
            edit: "{}",
            editBytes: 2,
            updatedAt: at,
          })),
        );
    }
  }
  return { ids, owner: owner.id, artifactId: doc.artifactId, versionId: doc.versionId };
}

const SWEEPS = [
  "suggestion_attempts_retention",
  "suggestion_items_retention",
  "suggestion_drafts_retention",
] as const;
const OLD = NOW - 400 * DAY;
const sweepOf = (name: string) => {
  const sweep = retentionSweeps(NOW).find((s) => s.name === name);
  if (!sweep) throw new Error(name);
  return sweep;
};

describe("the retention sweeps seek past what they read", () => {
  it("reads no excluded publishing draft before the due ones", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    for (let i = 0; i < PREFIX; i += 6) {
      await db()
        .insert(schema.editDrafts)
        .values(
          Array.from({ length: 6 }, (_, j) => ({
            artifactId: doc.artifactId,
            userId: `publishing_${i + j}`,
            ownerId: owner.id,
            baseVersionId: doc.versionId,
            edit: "{}",
            editBytes: 2,
            attemptId: `att_${i + j}`,
            updatedAt: OLD - 1,
          })),
        );
    }
    const query = raw(sweepPage(sweepOf("suggestion_drafts_retention"), null, LIMIT));
    const result = await run(query);
    expect(result.results).toEqual([]);
    expect(result.meta.rows_read, await plan(query)).toBeLessThanOrEqual(LIMIT);
    expect(await plan(query)).toMatch(/USING (COVERING )?INDEX edit_drafts_unused_idx/);
  });

  it.each(SWEEPS)("%s seeks past an equal-time run from its cursor", async (name) => {
    const rows = await due(name, PREFIX, OLD);
    const sweep = sweepOf(name);
    // Every row of the run read, as a pass leaves the cursor: nothing after it is read.
    const first = await run(raw(sweepPage(sweep, null, LIMIT)));
    const keys = (first.results as { key: string }[]).map((row) => JSON.parse(row.key));
    expect(keys).toHaveLength(LIMIT);
    expect(keys[0]?.[0]).toBe(OLD);
    const lastKey =
      name === "suggestion_drafts_retention"
        ? [OLD, rows.artifactId, rows.ids.at(-1)]
        : [OLD, rows.ids.at(-1)];
    const end = raw(sweepPage(sweep, lastKey as (string | number)[], LIMIT));
    const ended = await run(end);
    expect(ended.results).toEqual([]);
    expect(ended.meta.rows_read, await plan(end)).toBeLessThanOrEqual(LIMIT);
    // From the middle of the run, the page starts right after the cursor.
    const middle = rows.ids[149] as string;
    const midKey =
      name === "suggestion_drafts_retention" ? [OLD, rows.artifactId, middle] : [OLD, middle];
    const page = raw(sweepPage(sweep, midKey, LIMIT));
    const read = await run(page);
    const next = (read.results as { key: string }[]).map((row) => JSON.parse(row.key).at(-1));
    expect(next).toEqual(rows.ids.slice(150, 150 + LIMIT));
    expect(read.meta.rows_read, await plan(page)).toBeLessThanOrEqual(3 * LIMIT);
    expect(await plan(page)).toMatch(new RegExp(`USING (COVERING )?INDEX ${sweep.index}`));
  });

  it.each(SWEEPS)(
    "%s deletes every free row once across runs and keeps a held artifact's",
    async (name) => {
      const { suspendArtifact } = await import("../src/moderation.ts");
      const { placeLegalHold } = await import("../src/legal-holds.ts");
      const held = await due(name, 5, OLD);
      value(
        await suspendArtifact(db(), { artifactId: held.artifactId, reason: "spam", now: NOW - 10 }),
      );
      value(
        await placeLegalHold(db(), {
          artifactId: held.artifactId,
          ground: "court order",
          releaseAt: null,
          now: NOW - 10,
        }),
      );
      const free = await due(name, 40, OLD);
      const key = {
        suggestion_attempts_retention: "attempts",
        suggestion_items_retention: "items",
        suggestion_drafts_retention: "drafts",
      } as const;
      const sweep = sweepOf(name);
      const dueFree = async () =>
        Number(
          (
            await run(
              raw(
                sql`select count(*) as n from ${sweep.table} where ${sweep.due} and ${notHeldSql(sweep.artifactId)}`,
              ),
            )
          ).results[0]?.n,
        );
      // Every due row no hold keeps, other tests' included, is deleted once across the runs.
      const before = await dueFree();
      expect(before).toBeGreaterThanOrEqual(free.ids.length);
      let deleted = 0;
      for (let pass = 0; pass < Math.ceil(before / LIMIT) + 2; pass++) {
        deleted += (await pruneSuggestionRecords(db(), NOW + pass, LIMIT))[key[name]];
      }
      expect(deleted).toBe(before);
      expect(await dueFree()).toBe(0);
      const left = async (artifactId: string) =>
        (
          await (name === "suggestion_attempts_retention"
            ? db()
                .select()
                .from(schema.acceptanceAttempts)
                .where(eq(schema.acceptanceAttempts.artifactId, artifactId))
            : name === "suggestion_items_retention"
              ? db()
                  .select()
                  .from(schema.changeItems)
                  .where(eq(schema.changeItems.artifactId, artifactId))
              : db()
                  .select()
                  .from(schema.editDrafts)
                  .where(eq(schema.editDrafts.artifactId, artifactId)))
        ).length;
      expect(await left(free.artifactId)).toBe(0);
      expect(await left(held.artifactId)).toBe(5);
    },
  );
});
