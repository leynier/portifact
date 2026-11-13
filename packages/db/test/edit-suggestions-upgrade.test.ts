// Upgrading a populated database to edit suggestions (decision 0027; second review of pull request
// #252, R3): migrations 0077 and 0078 apply over ordinary threads without touching them, every
// earlier trigger survives, the new ones exist, and rows in every state can then be written. No
// change item can exist before this shape, so format 1 of the envelope starts here.
import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const NOW = Date.UTC(2026, 10, 12);

const NEW_TRIGGERS = [
  "annotation_threads_suggestion_immutable",
  "annotation_threads_suggestion_insert",
  "annotation_threads_suggestion_update",
  "annotation_threads_usage_edit",
  "change_items_immutable",
  "change_items_open_limit_insert",
  "change_items_open_limit_reopen",
  "change_items_usage_delete",
  "change_items_usage_insert",
  "change_items_usage_owner",
  "edit_drafts_limit",
  "preview_codes_limit",
];

async function triggers(db: D1Database): Promise<Map<string, string>> {
  const { results } = await db
    .prepare("select name, sql from sqlite_master where type = 'trigger' order by name")
    .all<{ name: string; sql: string }>();
  return new Map(results.map((row) => [row.name, row.sql]));
}

describe("upgrading a populated database", () => {
  it("keeps ordinary threads and every earlier trigger, and adds the suggestion triggers", async () => {
    const db = env.MIGRATION_DB;
    const all = env.TEST_MIGRATIONS;
    const at = all.findIndex((migration) => migration.name.startsWith("0077_"));
    expect(at).toBeGreaterThan(0);
    // The two suggestion migrations, in order; later migrations apply after them like any other.
    expect(all.slice(at, at + 2).map((migration) => migration.name.slice(0, 4))).toEqual([
      "0077",
      "0078",
    ]);
    await applyD1Migrations(db, all.slice(0, at));
    const before = await triggers(db);
    await db.batch([
      db.prepare(
        "insert into artifacts (id, owner_id, type, name) values ('upgrade001', 'owner', 'html', 'A')",
      ),
      db
        .prepare(
          "insert into annotation_threads (id, artifact_id, version_id, owner_id, author_id, target, target_bytes, path, updated_at) values ('t_old', 'upgrade001', 'v1', 'owner', 'u', '{}', 2, 'index.html', ?)",
        )
        .bind(NOW),
      db
        .prepare(
          "insert into annotation_messages (id, thread_id, artifact_id, owner_id, author_id, body, body_bytes, created_at) values ('m_old', 't_old', 'upgrade001', 'owner', 'u', 'hello', 5, ?)",
        )
        .bind(NOW),
    ]);
    const usage = await db
      .prepare("select messages, bytes from annotation_usage where owner_id = 'owner'")
      .first();

    await applyD1Migrations(db, all);

    const after = await triggers(db);
    // Every trigger of the database before keeps its name and definition; the new ones are exactly
    // the suggestion triggers, those of rebuilt usage included.
    const changed = [...before]
      .filter(([name, sql]) => after.get(name) !== sql)
      .map(([name]) => name);
    expect(changed.sort()).toEqual([
      "annotation_threads_usage_delete",
      "annotation_threads_usage_insert",
      "annotation_threads_usage_owner",
    ]);
    expect([...after.keys()].filter((name) => !before.has(name)).sort()).toEqual(NEW_TRIGGERS);
    expect(after.size).toBe(before.size + NEW_TRIGGERS.length);

    const thread = await db
      .prepare(
        "select kind, suggestion_state, edit, edit_bytes from annotation_threads where id = 't_old'",
      )
      .first();
    expect(thread).toEqual({ kind: "comment", suggestion_state: null, edit: null, edit_bytes: 0 });
    expect(
      await db
        .prepare("select messages, bytes from annotation_usage where owner_id = 'owner'")
        .first(),
    ).toEqual(usage);

    // Rows in every state can be written at the new shape.
    const edit = '{"operations":[]}';
    for (const [index, state] of [
      "pending",
      "applying",
      "accepted",
      "rejected",
      "withdrawn",
      "outdated",
    ].entries()) {
      const fields: Record<string, string | number | null> = {
        suggestion_state: state,
        edit: state === "withdrawn" ? null : edit,
        edit_bytes: state === "withdrawn" ? 0 : edit.length,
        attempt_id: state === "applying" ? "aa_1" : null,
        decided_at: state === "accepted" || state === "rejected" ? NOW : null,
        resolved_at: state === "pending" || state === "applying" ? null : NOW,
      };
      await db
        .prepare(
          `insert into annotation_threads (id, artifact_id, version_id, owner_id, author_id, target, target_bytes, path, updated_at, kind, suggestion_state, edit, edit_bytes, attempt_id, decided_at, resolved_at) values (?, 'upgrade001', 'v1', 'owner', 'u', '{}', 2, 'index.html', ?, 'suggestion', ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `s_${index}`,
          NOW,
          fields.suggestion_state,
          fields.edit,
          fields.edit_bytes,
          fields.attempt_id,
          fields.decided_at,
          fields.resolved_at,
        )
        .run();
    }
    const envelope = '{"format":1}';
    for (const state of ["open", "applied", "dismissed", "closed_by_version"]) {
      await db
        .prepare(
          "insert into change_items (id, artifact_id, owner_id, origin, version_id, path, envelope, bytes, reason, state, closed_at, closed_version_id, created_by, submitted_by) values (?, 'upgrade001', 'owner', 'suggestion', 'v1', 'index.html', ?, ?, 'not_text', ?, ?, ?, 'owner', 'reviewer')",
        )
        .bind(
          `ci_${state}`,
          envelope,
          envelope.length,
          state,
          state === "open" ? null : NOW,
          state === "closed_by_version" ? "v2" : null,
        )
        .run();
    }
    const { results } = await db
      .prepare("select state, submitted_by from change_items order by id")
      .all<{ state: string; submitted_by: string }>();
    expect(results.map((row) => row.submitted_by)).toEqual([
      "reviewer",
      "reviewer",
      "reviewer",
      "reviewer",
    ]);
    expect((await db.prepare("pragma foreign_key_check").all()).results).toEqual([]);
  });
});
