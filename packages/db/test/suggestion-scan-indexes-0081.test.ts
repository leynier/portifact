// Migration 0081 (decision 0027, the suggestion scans' indexes) over a populated database at the
// state after 0080: it only replaces indexes, so every row of the suggestion tables and every
// trigger stays as it was, the two time-only indexes of 0077 go and the five keyed ones come.
import { applyD1Migrations, env } from "cloudflare:test";
import { expect, it } from "vitest";

const NEW = [
  "acceptance_attempts_finished_created_idx",
  "acceptance_attempts_running_created_idx",
  "acceptance_attempts_running_deliveries_idx",
  "change_items_closed_key_idx",
  "edit_drafts_unused_idx",
];
const OLD = ["change_items_closed_idx", "edit_drafts_updated_idx"];
const TABLES = ["acceptance_attempts", "change_items", "edit_drafts"];

async function names(db: D1Database, type: "index" | "trigger") {
  const { results } = await db
    .prepare("select name, sql from sqlite_master where type = ? order by name")
    .bind(type)
    .all<{ name: string; sql: string | null }>();
  return results;
}

it("0081 keeps populated attempts, items and drafts and every trigger, and swaps the indexes", async () => {
  const db = env.MIGRATION_DB;
  const all = env.TEST_MIGRATIONS;
  const at = all.findIndex((m) => m.name.startsWith("0081_"));
  expect(all[at]?.name).toBe("0081_suggestion_scan_indexes.sql");
  expect(all[at - 1]?.name.startsWith("0080_")).toBe(true);
  await applyD1Migrations(db, all.slice(0, at));
  await db.batch([
    db.prepare(
      "insert into artifacts (id, owner_id, type, name) values ('upgrade081', 'owner', 'markdown', 'A')",
    ),
    db.prepare(
      `insert into acceptance_attempts (id, artifact_id, owner_id, origin, user_id, digest, base_version_id, state, reason, created_at, updated_at) values ('a_run', 'upgrade081', 'owner', 'draft', 'owner', '${"a".repeat(64)}', 'v1', 'running', null, 1, 1), ('a_end', 'upgrade081', 'owner', 'draft', 'owner', '${"b".repeat(64)}', 'v1', 'ended', 'failed', 2, 2)`,
    ),
    db.prepare(
      "insert into change_items (id, artifact_id, owner_id, origin, version_id, path, envelope, bytes, reason) values ('i_open', 'upgrade081', 'owner', 'draft', 'v1', 'index.md', '{}', 2, 'not_eligible')",
    ),
    db.prepare(
      "insert into edit_drafts (artifact_id, user_id, owner_id, base_version_id, edit, edit_bytes, updated_at) values ('upgrade081', 'u1', 'owner', 'v1', '{}', 2, 3), ('upgrade081', 'u2', 'owner', 'v1', '{}', 2, 4)",
    ),
  ]);
  const rows = async () => {
    const out: unknown[] = [];
    for (const table of TABLES) {
      out.push(
        (await db.prepare(`select * from ${table} where artifact_id = 'upgrade081'`).all()).results,
      );
    }
    return out;
  };
  const before = await rows();
  const triggers = await names(db, "trigger");
  const indexes = (await names(db, "index")).map((row) => row.name);
  expect(indexes).toEqual(expect.arrayContaining(OLD));
  for (const name of NEW) expect(indexes).not.toContain(name);

  await applyD1Migrations(db, all.slice(at, at + 1));

  expect(await rows()).toEqual(before);
  expect(await names(db, "trigger")).toEqual(triggers);
  const after = (await names(db, "index")).map((row) => row.name);
  expect(after).toEqual(expect.arrayContaining(NEW));
  for (const name of OLD) expect(after).not.toContain(name);
});
