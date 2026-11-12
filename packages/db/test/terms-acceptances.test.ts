// The history of accepted terms (docs/legal.md, "Acceptance at sign-in"): the sign-up trigger of
// migration 0068, its backfill and the cascade on account deletion. A migration that rebuilds
// `users` drops the trigger (AGENTS.md, database rule): the first test then fails.
import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const NOW = Date.UTC(2026, 10, 12, 12);

interface Row {
  user_id: string;
  version: string;
  accepted_at: number;
  action: string;
}

async function history(db: D1Database, userId: string): Promise<Row[]> {
  const { results } = await db
    .prepare(
      "SELECT user_id, version, accepted_at, action FROM terms_acceptances WHERE user_id = ? ORDER BY version",
    )
    .bind(userId)
    .all<Row>();
  return results;
}

function insertUser(
  db: D1Database,
  id: string,
  terms: { version: string; at: number } | null,
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO users (id, name, email, email_verified, created_at, updated_at, terms_version, terms_accepted_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)",
    )
    .bind(id, id, `${id}@example.test`, NOW, NOW, terms?.version ?? null, terms?.at ?? null);
}

describe("terms_acceptances", () => {
  it("keeps the sign-up trigger on users", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'users'",
    ).all<{ name: string }>();
    expect(results.map((row) => row.name)).toContain("terms_acceptances_sign_up");
  });

  it("records the acceptance an account is created with, in the same statement", async () => {
    await insertUser(env.DB, "u_signup", { version: "2026-11-13", at: NOW - 5 }).run();
    expect(await history(env.DB, "u_signup")).toEqual([
      { user_id: "u_signup", version: "2026-11-13", accepted_at: NOW - 5, action: "sign_up" },
    ]);
  });

  it("records nothing for an account created without an acceptance", async () => {
    await insertUser(env.DB, "u_none", null).run();
    expect(await history(env.DB, "u_none")).toEqual([]);
  });

  it("refuses an unknown action", async () => {
    await insertUser(env.DB, "u_action", null).run();
    await expect(
      env.DB.prepare(
        "INSERT INTO terms_acceptances (user_id, version, accepted_at, action) VALUES ('u_action', 'v', 1, 'guess')",
      ).run(),
    ).rejects.toThrow(/CHECK/);
  });

  it("goes with the account", async () => {
    await insertUser(env.DB, "u_gone", { version: "2026-11-13", at: NOW }).run();
    await env.DB.prepare(
      "INSERT INTO terms_acceptances (user_id, version, accepted_at, action) VALUES ('u_gone', '2026-11-08', ?, 'review')",
    )
      .bind(NOW - 1000)
      .run();
    await env.DB.prepare("DELETE FROM users WHERE id = 'u_gone'").run();
    expect(await history(env.DB, "u_gone")).toEqual([]);
  });

  it("backfills the acceptance existing accounts hold", async () => {
    const all = env.TEST_MIGRATIONS;
    const at = all.findIndex((migration) => migration.name.startsWith("0067_"));
    expect(at).toBeGreaterThan(0);
    await applyD1Migrations(env.MIGRATION_DB, all.slice(0, at));
    await env.MIGRATION_DB.batch([
      insertUser(env.MIGRATION_DB, "u_old", { version: "2026-11-08", at: NOW - 86_400_000 }),
      insertUser(env.MIGRATION_DB, "u_never", null),
    ]);
    await applyD1Migrations(env.MIGRATION_DB, all);
    expect(await history(env.MIGRATION_DB, "u_old")).toEqual([
      {
        user_id: "u_old",
        version: "2026-11-08",
        accepted_at: NOW - 86_400_000,
        action: "backfill",
      },
    ]);
    expect(await history(env.MIGRATION_DB, "u_never")).toEqual([]);
  });
});
