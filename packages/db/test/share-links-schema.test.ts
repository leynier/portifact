// Migration 0031 (decision 0008): share links, their handoffs and sessions go with the artifact
// and with the link, a token is unique, and a password is stored whole or not at all.
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, schema } from "../src/index.ts";

const NOW = Date.UTC(2026, 10, 10, 12);
const db = () => createDb(env.DB);
const LINK = `sl_${"1".repeat(32)}`;

beforeEach(async () => {
  for (const table of ["share_sessions", "share_handoffs", "share_links", "artifacts"]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  await db()
    .insert(schema.artifacts)
    .values({
      id: "sl2345abcd",
      ownerId: "u_owner",
      type: "site",
      name: "Plan",
      state: "active",
      accessMode: "restricted",
      expiresAt: NOW + 86_400_000,
    });
});

const link = (overrides: Partial<typeof schema.shareLinks.$inferInsert> = {}) => ({
  id: LINK,
  artifactId: "sl2345abcd",
  tokenHash: "a".repeat(64),
  label: "Board",
  createdBy: "u_owner",
  createdAt: NOW,
  ...overrides,
});

describe("share link tables", () => {
  it("cascade from the artifact and from the link", async () => {
    await db().insert(schema.shareLinks).values(link());
    await db()
      .insert(schema.shareHandoffs)
      .values({
        codeHash: "c".repeat(64),
        linkId: LINK,
        artifactId: "sl2345abcd",
        expiresAt: NOW + 60_000,
      });
    await db()
      .insert(schema.shareSessions)
      .values({
        id: "s".repeat(43),
        linkId: LINK,
        artifactId: "sl2345abcd",
        expiresAt: NOW + 60_000,
      });
    await db().delete(schema.shareLinks).where(eq(schema.shareLinks.id, LINK));
    expect(await db().select().from(schema.shareHandoffs)).toEqual([]);
    expect(await db().select().from(schema.shareSessions)).toEqual([]);

    await db().insert(schema.shareLinks).values(link());
    await db().delete(schema.artifacts).where(eq(schema.artifacts.id, "sl2345abcd"));
    expect(await db().select().from(schema.shareLinks)).toEqual([]);
  });

  it("refuses a second link with the same token hash", async () => {
    await db().insert(schema.shareLinks).values(link());
    await expect(
      db()
        .insert(schema.shareLinks)
        .values(link({ id: `sl_${"2".repeat(32)}` })),
    ).rejects.toThrow();
  });

  it("stores a password's hash, salt and iterations together or not at all", async () => {
    await expect(
      db()
        .insert(schema.shareLinks)
        .values(link({ passwordHash: "h" })),
    ).rejects.toThrow();
    await expect(
      db()
        .insert(schema.shareLinks)
        .values(link({ passwordHash: "h", passwordSalt: "s" })),
    ).rejects.toThrow();
    await db()
      .insert(schema.shareLinks)
      .values(link({ passwordHash: "h", passwordSalt: "s", passwordIterations: 100_000 }));
    expect(await db().select().from(schema.shareLinks)).toHaveLength(1);
  });
});
