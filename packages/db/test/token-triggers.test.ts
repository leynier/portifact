// The triggers that keep the sign-in time of OAuth grants (decision 0021, migrations 0058 and
// 0059) and the backfill 0058 ran on rows from before it. A migration that rebuilds one of these
// tables drops its triggers (AGENTS.md, database rule): the first test then fails.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 11, 12);

async function triggersOn(table: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY name",
  )
    .bind(table)
    .all<{ name: string }>();
  return results.map((row) => row.name);
}

/** The statements of one migration, as the test pool applied them. */
function migration(prefix: string): string[] {
  const found = env.TEST_MIGRATIONS.find((m) => m.name.startsWith(prefix));
  if (!found) throw new Error(`no migration ${prefix}`);
  return found.queries;
}

async function user(id: string) {
  await env.DB.prepare(
    "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
  )
    .bind(id, id, `${id}@example.test`, NOW, NOW)
    .run();
}

async function session(id: string, userId: string, createdAt: number) {
  await env.DB.prepare(
    "INSERT INTO sessions (id, token, user_id, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, `tok_${id}`, userId, NOW + 24 * HOUR, createdAt, NOW)
    .run();
}

async function refresh(id: string, userId: string, sessionId: string | null) {
  await env.DB.prepare(
    "INSERT INTO oauth_refresh_tokens (id, token, client_id, session_id, user_id, scopes, created_at, expires_at) VALUES (?, ?, 'portifact-cli', ?, ?, '[]', ?, ?)",
  )
    .bind(id, `rt_${id}`, sessionId, userId, NOW, NOW + 30 * 24 * HOUR)
    .run();
}

async function access(
  id: string,
  userId: string,
  refreshId: string | null,
  sessionId: string | null,
) {
  await env.DB.prepare(
    "INSERT INTO oauth_access_tokens (id, token, client_id, session_id, user_id, refresh_id, scopes, created_at, expires_at) VALUES (?, ?, 'portifact-cli', ?, ?, ?, '[]', ?, ?)",
  )
    .bind(id, `at_${id}`, sessionId, userId, refreshId, NOW, NOW + HOUR)
    .run();
}

const authTime = async (table: string, id: string) =>
  (
    await env.DB.prepare(`SELECT auth_time AS t FROM ${table} WHERE id = ?`)
      .bind(id)
      .first<{ t: number | null }>()
  )?.t ?? null;

describe("the sign-in time triggers on the token tables", () => {
  it("exist after every migration", async () => {
    expect(await triggersOn("oauth_refresh_tokens")).toContain("oauth_refresh_tokens_auth_time");
    expect(await triggersOn("oauth_access_tokens")).toContain("oauth_access_tokens_auth_time");
  });

  it("give a new grant its session's sign-in, and a device grant without one 0 (not known)", async () => {
    await user("u_trig");
    await session("s_trig", "u_trig", NOW - 2 * HOUR);
    await refresh("rt_code", "u_trig", "s_trig");
    await refresh("rt_device", "u_trig", null);
    await access("at_code", "u_trig", "rt_code", "s_trig");
    await access("at_device", "u_trig", "rt_device", null);
    await access("at_plain", "u_trig", null, "s_trig");
    await access("at_none", "u_trig", null, null);
    expect(await authTime("oauth_refresh_tokens", "rt_code")).toBe(NOW - 2 * HOUR);
    // Migration 0059: never the poll's time, which a stale session could make look fresh.
    expect(await authTime("oauth_refresh_tokens", "rt_device")).toBe(0);
    expect(await authTime("oauth_access_tokens", "at_code")).toBe(NOW - 2 * HOUR);
    expect(await authTime("oauth_access_tokens", "at_device")).toBe(0);
    expect(await authTime("oauth_access_tokens", "at_plain")).toBe(NOW - 2 * HOUR);
    expect(await authTime("oauth_access_tokens", "at_none")).toBeNull();
  });
});

describe("the 0058 backfill on rows from before it", () => {
  it("gives a session's sign-in where the session is there, 0 where it is not, and access tokens their refresh token's", async () => {
    await user("u_legacy");
    await session("s_legacy", "u_legacy", NOW - 5 * HOUR);
    await refresh("rt_alive", "u_legacy", "s_legacy");
    await refresh("rt_gone", "u_legacy", null);
    await access("at_alive", "u_legacy", "rt_alive", null);
    await access("at_gone", "u_legacy", "rt_gone", null);
    // As rows written before migration 0058: no sign-in time at all.
    await env.DB.prepare(
      "UPDATE oauth_refresh_tokens SET auth_time = NULL WHERE user_id = 'u_legacy'",
    ).run();
    await env.DB.prepare(
      "UPDATE oauth_access_tokens SET auth_time = NULL WHERE user_id = 'u_legacy'",
    ).run();
    const backfill = migration("0058_").filter((query) => /^\s*(--.*\n)*\s*UPDATE/i.test(query));
    expect(backfill).toHaveLength(2);
    for (const query of backfill) await env.DB.prepare(query).run();
    expect(await authTime("oauth_refresh_tokens", "rt_alive")).toBe(NOW - 5 * HOUR);
    expect(await authTime("oauth_refresh_tokens", "rt_gone")).toBe(0);
    expect(await authTime("oauth_access_tokens", "at_alive")).toBe(NOW - 5 * HOUR);
    expect(await authTime("oauth_access_tokens", "at_gone")).toBe(0);
  });
});
