// The triggers that carry how a grant's sign-in happened onto its OAuth tokens (decision 0021,
// "SSO required", migration 0061), the way `auth_time` is carried. A migration that rebuilds one
// of these tables drops its triggers (AGENTS.md, database rule): the first test then fails.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 11, 12);
const SSO = `sso:sso_${"b".repeat(32)}`;

async function triggersOn(table: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY name",
  )
    .bind(table)
    .all<{ name: string }>();
  return results.map((row) => row.name);
}

async function user(id: string) {
  await env.DB.prepare(
    "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
  )
    .bind(id, id, `${id}@example.test`, NOW, NOW)
    .run();
}

async function session(id: string, userId: string, method: string | null) {
  await env.DB.prepare(
    "INSERT INTO sessions (id, token, user_id, expires_at, created_at, updated_at, sign_in_method) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, `tok_${id}`, userId, NOW + 24 * HOUR, NOW - HOUR, NOW, method)
    .run();
}

interface RefreshRow {
  id: string;
  userId: string;
  sessionId: string | null;
  createdAt?: number;
  authTime?: number | null;
  code?: string | null;
  method?: string | null;
  client?: string;
}

async function refresh(row: RefreshRow) {
  await env.DB.prepare(
    "INSERT INTO oauth_refresh_tokens (id, token, client_id, session_id, user_id, authorization_code_id, scopes, created_at, expires_at, auth_time, sign_in_method) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)",
  )
    .bind(
      row.id,
      `rt_${row.id}`,
      row.client ?? "portifact-cli",
      row.sessionId,
      row.userId,
      row.code ?? null,
      row.createdAt ?? NOW,
      NOW + 30 * 24 * HOUR,
      row.authTime ?? NOW - HOUR,
      row.method ?? null,
    )
    .run();
}

/** What the provider does on a refresh: revoke the old token at `at`, then insert the new one. */
async function rotate(from: string, row: RefreshRow, at: number) {
  await env.DB.prepare("UPDATE oauth_refresh_tokens SET revoked = ?, rotated_at = ? WHERE id = ?")
    .bind(at, at, from)
    .run();
  await refresh({ ...row, createdAt: at });
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

const methodOf = async (table: string, id: string) =>
  (
    await env.DB.prepare(`SELECT sign_in_method AS m FROM ${table} WHERE id = ?`)
      .bind(id)
      .first<{ m: string | null }>()
  )?.m ?? null;

describe("the sign-in method triggers on the token tables", () => {
  it("exist after every migration, beside the sign-in time triggers", async () => {
    expect(await triggersOn("oauth_refresh_tokens")).toEqual([
      "oauth_refresh_tokens_auth_time",
      "oauth_refresh_tokens_sign_in_method",
    ]);
    expect(await triggersOn("oauth_access_tokens")).toEqual([
      "oauth_access_tokens_auth_time",
      "oauth_access_tokens_sign_in_method",
    ]);
  });

  it("give a new grant its session's method, and tokens without one nothing", async () => {
    await user("u_m1");
    await session("s_sso", "u_m1", SSO);
    await session("s_old", "u_m1", null);
    await refresh({ id: "rt_sso", userId: "u_m1", sessionId: "s_sso", code: "c1" });
    await refresh({ id: "rt_old", userId: "u_m1", sessionId: "s_old", code: "c2" });
    await refresh({ id: "rt_dev", userId: "u_m1", sessionId: null });
    expect(await methodOf("oauth_refresh_tokens", "rt_sso")).toBe(SSO);
    expect(await methodOf("oauth_refresh_tokens", "rt_old")).toBeNull();
    expect(await methodOf("oauth_refresh_tokens", "rt_dev")).toBeNull();
    await access("at_sso", "u_m1", "rt_sso", "s_sso");
    await access("at_code_only", "u_m1", null, "s_sso");
    await access("at_dev", "u_m1", "rt_dev", null);
    expect(await methodOf("oauth_access_tokens", "at_sso")).toBe(SSO);
    expect(await methodOf("oauth_access_tokens", "at_code_only")).toBe(SSO);
    expect(await methodOf("oauth_access_tokens", "at_dev")).toBeNull();
  });

  it("carry the method through every rotation, even after the session is gone", async () => {
    await user("u_m2");
    await session("s_m2", "u_m2", "code");
    await refresh({ id: "r0", userId: "u_m2", sessionId: "s_m2", code: "c3" });
    await env.DB.prepare("DELETE FROM sessions WHERE id = 's_m2'").run();
    await rotate("r0", { id: "r1", userId: "u_m2", sessionId: null, code: "c3" }, NOW + HOUR);
    await rotate("r1", { id: "r2", userId: "u_m2", sessionId: null, code: "c3" }, NOW + 2 * HOUR);
    expect(await methodOf("oauth_refresh_tokens", "r2")).toBe("code");
    await access("at_r2", "u_m2", "r2", null);
    expect(await methodOf("oauth_access_tokens", "at_r2")).toBe("code");
  });

  it("carry a device grant's stamped method through rotation", async () => {
    await user("u_m3");
    await refresh({ id: "d0", userId: "u_m3", sessionId: null, method: SSO });
    await rotate("d0", { id: "d1", userId: "u_m3", sessionId: null }, NOW + HOUR);
    expect(await methodOf("oauth_refresh_tokens", "d1")).toBe(SSO);
  });

  it("never mixes two grants rotated at the same instant: different methods read as not known", async () => {
    await user("u_m4");
    await refresh({ id: "g1", userId: "u_m4", sessionId: null, method: SSO });
    await refresh({ id: "g2", userId: "u_m4", sessionId: null, method: "code" });
    const at = NOW + 3 * HOUR;
    await env.DB.prepare(
      "UPDATE oauth_refresh_tokens SET revoked = ?, rotated_at = ? WHERE id IN ('g1', 'g2')",
    )
      .bind(at, at)
      .run();
    await refresh({ id: "g3", userId: "u_m4", sessionId: null, createdAt: at });
    expect(await methodOf("oauth_refresh_tokens", "g3")).toBeNull();
    // Another client's or user's rotation at that instant is never a predecessor.
    await user("u_m5");
    await refresh({ id: "h3", userId: "u_m5", sessionId: null, createdAt: at });
    expect(await methodOf("oauth_refresh_tokens", "h3")).toBeNull();
  });

  it("keep a method the provider or the app wrote", async () => {
    await user("u_m6");
    await session("s_m6", "u_m6", "github");
    await refresh({ id: "k1", userId: "u_m6", sessionId: "s_m6", method: SSO });
    expect(await methodOf("oauth_refresh_tokens", "k1")).toBe(SSO);
  });
});

describe("the sign-in method columns", () => {
  it("leave sessions and device codes from before the release not known", async () => {
    await user("u_m7");
    await env.DB.prepare(
      "INSERT INTO sessions (id, token, user_id, expires_at, created_at, updated_at) VALUES ('s_m7', 'tok_s_m7', 'u_m7', ?, ?, ?)",
    )
      .bind(NOW + HOUR, NOW, NOW)
      .run();
    expect(await methodOf("sessions", "s_m7")).toBeNull();
  });
});

describe("the predecessor match's cost (review of PR 210)", () => {
  it("finds the rotated token through the user, client and rotation index, not the user's history", async () => {
    // The trigger's own lookup (migration 0061), planned as SQLite plans it inside the trigger.
    const { results } = await env.DB.prepare(
      `EXPLAIN QUERY PLAN
       SELECT CASE WHEN count(DISTINCT coalesce(p.sign_in_method, '')) = 1 THEN max(p.sign_in_method) END
       FROM oauth_refresh_tokens p
       WHERE p.id <> ? AND p.user_id = ? AND p.client_id = ? AND p.rotated_at = ?
         AND p.auth_time IS ? AND p.authorization_code_id IS ?`,
    )
      .bind("x", "u", "portifact-cli", NOW, NOW, null)
      .all<{ detail: string }>();
    const plan = results.map((row) => row.detail).join(" | ");
    // All three equalities served by the index: only the rotated predecessors are read. The
    // count(DISTINCT) still uses a temporary B-tree, over those few rows only.
    expect(plan).toContain(
      "SEARCH p USING INDEX oauth_refresh_tokens_user_client_rotated_idx (user_id=? AND client_id=? AND rotated_at=?)",
    );
    expect(plan).not.toContain("oauth_refresh_tokens_user_id_idx");
  });
});
