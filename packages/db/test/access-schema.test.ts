// The access log database: its own migrations, one row per artifact, window and visitor.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { accessSchema, createAccessDb } from "../src/index.ts";

const row = {
  artifactId: "k7d2qm4xab",
  windowStart: 1_000,
  userId: "u_reader",
  ownerId: "u_owner",
  email: "reader@example.com",
  openedAt: 1_500,
};

describe("access log schema", () => {
  it("keeps one row per artifact, window and visitor", async () => {
    const db = createAccessDb(env.ACCESS_DB);
    await db.insert(accessSchema.accessEvents).values(row);
    await expect(
      db.insert(accessSchema.accessEvents).values({ ...row, openedAt: 1_600 }),
    ).rejects.toThrow();
    await db.insert(accessSchema.accessEvents).values({ ...row, windowStart: 2_000 });
    await db.insert(accessSchema.accessEvents).values({ ...row, userId: "u_other" });
    expect(await db.select().from(accessSchema.accessEvents)).toHaveLength(3);
  });

  it("lives apart from the control database", async () => {
    const tables = async (d1: D1Database) =>
      (
        await d1
          .prepare("select name from sqlite_master where type = 'table' and name = 'access_events'")
          .all()
      ).results;
    expect(await tables(env.ACCESS_DB)).toEqual([{ name: "access_events" }]);
    expect(await tables(env.DB)).toEqual([]);
  });
});
