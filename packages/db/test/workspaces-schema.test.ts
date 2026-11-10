// Migration 0030: workspaces, memberships and the global artifact directory (decisions 0004 and
// 0005). The backfill runs on a database with artifacts and tombstones written before it; the
// triggers are checked on the fully migrated test database.
import { applyD1Migrations, env } from "cloudflare:test";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema } from "../src/index.ts";

const NOW = Date.UTC(2026, 10, 9);
const MIGRATION = "0030_workspaces.sql";
const WS = "ws_0123456789abcdef0123456789abcdef";

/** Asserts the database refused the statement; Drizzle wraps the SQLite error in `cause`. */
async function rejects(statement: Promise<unknown>, pattern: RegExp) {
  const error = await statement.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "the statement should have been rejected").toBeInstanceOf(Error);
  const messages: string[] = [];
  for (let e: unknown = error; e instanceof Error; e = e.cause) messages.push(e.message);
  expect(messages.join("\n")).toMatch(pattern);
}

describe("migration 0030: the directory backfill", () => {
  const migrated = () => createDb(env.MIGRATION_DB);

  beforeAll(async () => {
    const all = env.TEST_MIGRATIONS;
    const at = all.findIndex((m) => m.name === MIGRATION);
    expect(at).toBeGreaterThan(0);
    await applyD1Migrations(env.MIGRATION_DB, all.slice(0, at));
    await env.MIGRATION_DB.batch([
      env.MIGRATION_DB.prepare(
        "INSERT INTO artifacts (id, owner_id, type, name, state, created_at, updated_at) VALUES ('backfilla1', 'u_a', 'site', 'A', 'active', 1000, 1000), ('backfillb2', 'u_b', 'markdown', 'B', 'purging', 2000, 2000)",
      ),
      env.MIGRATION_DB.prepare(
        "INSERT INTO tombstones (kind, id, deleted_at) VALUES ('artifact', 'backfillc3', 3000), ('account', 'u_gone', 4000)",
      ),
    ]);
    await applyD1Migrations(env.MIGRATION_DB, all);
  });

  it("puts every artifact and every tombstoned artifact ID in the default region", async () => {
    const rows = await migrated()
      .select()
      .from(schema.artifactDirectory)
      .orderBy(schema.artifactDirectory.id);
    expect(rows).toEqual([
      { id: "backfilla1", region: "default", createdAt: 1000 },
      { id: "backfillb2", region: "default", createdAt: 2000 },
      { id: "backfillc3", region: "default", createdAt: 3000 },
    ]);
  });
});

describe("migration 0030: the triggers", () => {
  const db = () => createDb(env.DB);

  async function workspace(id = WS, slug = `s-${crypto.randomUUID().slice(0, 8)}`) {
    await db()
      .insert(schema.workspaces)
      .values({ id, slug, name: "Team", createdBy: "u_creator", updatedAt: NOW });
  }

  async function user(id: string) {
    await db()
      .insert(schema.users)
      .values({
        id,
        name: id,
        email: `${id}@example.test`,
        emailVerified: true,
        createdAt: new Date(NOW),
        updatedAt: new Date(NOW),
      });
  }

  it("never updates or deletes a directory row", async () => {
    await db()
      .insert(schema.artifactDirectory)
      .values({ id: "immutable1", region: "default", createdAt: NOW });
    await rejects(
      db()
        .update(schema.artifactDirectory)
        .set({ createdAt: NOW + 1 })
        .where(eq(schema.artifactDirectory.id, "immutable1")),
      /artifact_directory_immutable/,
    );
    await rejects(
      db().delete(schema.artifactDirectory).where(eq(schema.artifactDirectory.id, "immutable1")),
      /artifact_directory_immutable/,
    );
    await rejects(
      db()
        .insert(schema.artifactDirectory)
        .values({ id: "immutable1", region: "default", createdAt: NOW }),
      /UNIQUE|PRIMARY KEY/,
    );
  });

  it("fixes a workspace's region at creation but lets the rest change", async () => {
    const id = "ws_11111111111111111111111111111111";
    await workspace(id);
    await rejects(
      db()
        .update(schema.workspaces)
        .set({ region: sql`'eu'` as unknown as "default" })
        .where(eq(schema.workspaces.id, id)),
      /workspace_region_fixed/,
    );
    await db()
      .update(schema.workspaces)
      .set({ name: "Renamed", region: "default" })
      .where(eq(schema.workspaces.id, id));
    const [row] = await db().select().from(schema.workspaces).where(eq(schema.workspaces.id, id));
    expect(row).toMatchObject({ name: "Renamed", region: "default" });
  });

  it("keeps slugs unique, roles to the three and one membership per user", async () => {
    const id = "ws_22222222222222222222222222222222";
    await workspace(id, "unique-slug");
    await rejects(workspace("ws_33333333333333333333333333333333", "unique-slug"), /UNIQUE/);
    await user("u_role");
    await rejects(
      db()
        .insert(schema.workspaceMembers)
        .values({ workspaceId: id, userId: "u_role", role: "owner" as "admin", updatedAt: NOW }),
      /CHECK constraint failed: workspace_members_role/,
    );
    await db()
      .insert(schema.workspaceMembers)
      .values({ workspaceId: id, userId: "u_role", role: "member", updatedAt: NOW });
    await rejects(
      db()
        .insert(schema.workspaceMembers)
        .values({ workspaceId: id, userId: "u_role", role: "editor", updatedAt: NOW }),
      /UNIQUE|PRIMARY KEY/,
    );
  });

  it("removes memberships with their workspace and with their user", async () => {
    const id = "ws_44444444444444444444444444444444";
    await workspace(id);
    await user("u_leaves");
    await user("u_stays");
    await db()
      .insert(schema.workspaceMembers)
      .values([
        { workspaceId: id, userId: "u_leaves", role: "admin", updatedAt: NOW },
        { workspaceId: id, userId: "u_stays", role: "admin", updatedAt: NOW },
      ]);
    await db().delete(schema.users).where(eq(schema.users.id, "u_leaves"));
    const members = () =>
      db()
        .select({ userId: schema.workspaceMembers.userId })
        .from(schema.workspaceMembers)
        .where(eq(schema.workspaceMembers.workspaceId, id));
    expect(await members()).toEqual([{ userId: "u_stays" }]);
    await db().delete(schema.workspaces).where(eq(schema.workspaces.id, id));
    expect(await members()).toEqual([]);
  });

  it("refuses deleting a workspace's only admin unless the account is tombstoned", async () => {
    const id = "ws_55555555555555555555555555555555";
    await workspace(id);
    await user("u_sole");
    await user("u_editor");
    await db()
      .insert(schema.workspaceMembers)
      .values([
        { workspaceId: id, userId: "u_sole", role: "admin", updatedAt: NOW },
        { workspaceId: id, userId: "u_editor", role: "editor", updatedAt: NOW },
      ]);
    await rejects(
      db().delete(schema.users).where(eq(schema.users.id, "u_sole")),
      /sole_workspace_admin/,
    );
    // An editor is not an admin: deleting them is fine.
    await db().delete(schema.users).where(eq(schema.users.id, "u_editor"));
    // A tombstone re-applied after a restore always wins.
    await db().insert(schema.tombstones).values({ kind: "account", id: "u_sole", deletedAt: NOW });
    await db().delete(schema.users).where(eq(schema.users.id, "u_sole"));
    const [left] = await db().select().from(schema.users).where(eq(schema.users.id, "u_sole"));
    expect(left).toBeUndefined();
  });
});
