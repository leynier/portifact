// The triggers that keep a held artifact (migration 0074, docs/operations.md, "Legal holds"). A
// migration that rebuilds `artifacts`, `versions` or `legal_holds` drops its triggers (AGENTS.md,
// database rule): this test then fails.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function triggersOn(table: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY name",
  )
    .bind(table)
    .all<{ name: string }>();
  return results.map((row) => row.name);
}

describe("legal hold triggers", () => {
  it("exist on every table a hold protects", async () => {
    expect(await triggersOn("artifacts")).toEqual(
      expect.arrayContaining([
        "artifacts_held_keep_owner",
        "artifacts_held_not_deleted",
        "artifacts_held_stay_suspended",
      ]),
    );
    expect(await triggersOn("versions")).toContain("versions_held_not_deleted");
    expect(await triggersOn("legal_holds")).toContain("legal_holds_need_suspension");
  });

  it("refuse changing a held artifact and stop applying once the hold is released", async () => {
    const id = "hhhhhhhhhh";
    await env.DB.prepare(
      "INSERT INTO artifacts (id, owner_id, type, name, state, access_mode) VALUES (?, 'u_held', 'site', 'Held', 'suspended', 'restricted')",
    )
      .bind(id)
      .run();
    await env.DB.prepare(
      "INSERT INTO legal_holds (id, artifact_id, owner_id, reason, ground) VALUES ('hold_t', ?, 'u_held', 'spam', 'Authority')",
    )
      .bind(id)
      .run();
    for (const statement of [
      "UPDATE artifacts SET state = 'purging' WHERE id = ?",
      "UPDATE artifacts SET owner_id = 'u_other' WHERE id = ?",
      "DELETE FROM artifacts WHERE id = ?",
    ]) {
      await expect(env.DB.prepare(statement).bind(id).run(), statement).rejects.toThrow(
        /legal_hold/,
      );
    }
    await env.DB.prepare("UPDATE legal_holds SET released_at = 1 WHERE id = 'hold_t'").run();
    await env.DB.prepare("UPDATE artifacts SET state = 'purging' WHERE id = ?").bind(id).run();
  });
});
