// The triggers that write restore markers for the identity tables (migration 0071): a migration
// that rebuilds one of these tables drops its triggers (AGENTS.md, database rule), and the first
// test then fails.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const DAY = 86_400_000;

async function triggersOn(table: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY name",
  )
    .bind(table)
    .all<{ name: string }>();
  return results.map((row) => row.name);
}

async function marked(kind: string, id: string) {
  return (
    (await env.DB.prepare("SELECT 1 AS hit FROM tombstones WHERE kind = ? AND id = ?")
      .bind(kind, id)
      .first()) !== null
  );
}

describe("restore markers of the identity tables", () => {
  it("are written by triggers on sessions, tokens and consents", async () => {
    expect(await triggersOn("sessions")).toContain("sessions_restore_marker");
    expect(await triggersOn("oauth_access_tokens")).toEqual(
      expect.arrayContaining([
        "oauth_access_tokens_restore_marker_delete",
        "oauth_access_tokens_restore_marker_revoke",
      ]),
    );
    expect(await triggersOn("oauth_refresh_tokens")).toEqual(
      expect.arrayContaining([
        "oauth_refresh_tokens_restore_marker_delete",
        "oauth_refresh_tokens_restore_marker_revoke",
      ]),
    );
    expect(await triggersOn("oauth_consents")).toContain("oauth_consents_restore_marker");
  });

  it("mark a session that ends before it expires, and not one that already expired", async () => {
    const user = `u_${crypto.randomUUID()}`;
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    )
      .bind(user, user, `${user}@example.test`, now, now)
      .run();
    const live = `s_${crypto.randomUUID()}`;
    const expired = `s_${crypto.randomUUID()}`;
    for (const [id, expiresAt] of [
      [live, now + DAY],
      [expired, now - DAY],
    ] as const) {
      await env.DB.prepare(
        "INSERT INTO sessions (id, token, user_id, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind(id, `t_${id}`, user, expiresAt, now, now)
        .run();
    }
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user).run();
    expect(await marked("session", live)).toBe(true);
    expect(await marked("session", expired)).toBe(false);
  });
});
