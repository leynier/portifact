// The backfill of `suspensions.target_gone_at` (migration 0070) for suspensions whose artifact
// was purged or whose account was deleted before the column existed: re-running its statements
// dates each from the purge or the tombstone and leaves the others alone.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const NOW = Date.UTC(2026, 10, 12);

function migration(prefix: string): string[] {
  const found = env.TEST_MIGRATIONS.find((m) => m.name.startsWith(prefix));
  if (!found) throw new Error(`no migration ${prefix}`);
  return found.queries;
}

async function suspension(id: string, kind: "artifact" | "account", targetId: string) {
  await env.DB.prepare(
    "INSERT INTO suspensions (id, kind, target_id, reason, created_at) VALUES (?, ?, ?, 'spam', ?)",
  )
    .bind(id, kind, targetId, NOW - 1000)
    .run();
}

async function goneAt(id: string) {
  return (
    await env.DB.prepare("SELECT target_gone_at AS at FROM suspensions WHERE id = ?")
      .bind(id)
      .first<{ at: number | null }>()
  )?.at;
}

describe("the target_gone_at backfill", () => {
  it("dates suspensions of purged artifacts and deleted accounts, and only those", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const purged = `p${tag}`;
    const tombstoned = `t${tag}`;
    const deletedAccount = `u_gone${tag}`;
    const liveAccount = `u_live${tag}`;
    await env.DB.prepare(
      "INSERT INTO lifecycle_events (artifact_id, channel, event, at) VALUES (?, 'system', 'purged', ?)",
    )
      .bind(purged, NOW - 50)
      .run();
    await env.DB.prepare("INSERT INTO tombstones (kind, id, deleted_at) VALUES ('artifact', ?, ?)")
      .bind(tombstoned, NOW - 40)
      .run();
    await env.DB.prepare("INSERT INTO tombstones (kind, id, deleted_at) VALUES ('account', ?, ?)")
      .bind(deletedAccount, NOW - 30)
      .run();
    await env.DB.prepare(
      "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    )
      .bind(liveAccount, liveAccount, `${liveAccount}@example.test`, NOW, NOW)
      .run();
    await suspension(`s1${tag}`, "artifact", purged);
    await suspension(`s2${tag}`, "artifact", tombstoned);
    await suspension(`s3${tag}`, "account", deletedAccount);
    await suspension(`s4${tag}`, "account", liveAccount);

    for (const query of migration("0070_")) await env.DB.prepare(query).run();

    expect(await goneAt(`s1${tag}`)).toBe(NOW - 50);
    expect(await goneAt(`s2${tag}`)).toBe(NOW - 40);
    expect(await goneAt(`s3${tag}`)).toBe(NOW - 30);
    expect(await goneAt(`s4${tag}`)).toBeNull();
  });
});
