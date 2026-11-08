import { env } from "cloudflare:test";
import { createDb, schema } from "@portifact/db";
import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, getArtifact, listArtifacts } from "../src/artifacts.ts";

const db = () => createDb(env.DB);
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function artifactId(seed: number): string {
  let id = "";
  for (let i = 0; i < 10; i += 1) id += ALPHABET[(seed * 7 + i * 13) % 32];
  return id;
}

async function insert(
  ownerId: string,
  count: number,
  state: "active" | "archived" | "deleted" | "draft" = "active",
  offset = 0,
) {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = artifactId(offset + i);
    ids.push(id);
    await db()
      .insert(schema.artifacts)
      .values({
        id,
        ownerId,
        type: "site",
        name: `Artifact ${i}`,
        state,
        createdAt: 1000,
        // Two share each timestamp, so the id breaks ties.
        updatedAt: 1000 + Math.floor((offset + i) / 2),
      });
  }
  return ids;
}

describe("listing an owner's artifacts", () => {
  it("pages through every artifact once, newest first, without others' or deleted ones", async () => {
    const owner = `u_${crypto.randomUUID()}`;
    const ids = await insert(owner, 5);
    await insert(owner, 1, "deleted", 40);
    await insert(owner, 1, "draft", 41);
    await insert(`u_${crypto.randomUUID()}`, 2, "active", 50);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await listArtifacts(db(), { ownerId: owner, cursor, limit: 2 });
      if (!result) throw new Error("invalid cursor");
      seen.push(...result.items.map((item) => item.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(ids));
    const rows = await listArtifacts(db(), { ownerId: owner, limit: 100 });
    const times = rows?.items.map((row) => row.updatedAt) ?? [];
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(rows?.nextCursor).toBeNull();
  });

  it("rejects a cursor it did not issue", async () => {
    for (const cursor of ["not-base64!", btoa("x.y"), btoa("123.TOOSHORT"), "%%%"]) {
      expect(
        await listArtifacts(db(), { ownerId: "u", cursor, limit: 10 }),
        cursor,
      ).toBeUndefined();
    }
    expect(decodeCursor(encodeCursor({ updatedAt: 42, id: "abcdefghij" }))).toEqual({
      updatedAt: 42,
      id: "abcdefghij",
    });
  });

  it("finds only the owner's live artifact", async () => {
    const owner = `u_${crypto.randomUUID()}`;
    const [live] = await insert(owner, 1, "active", 60);
    const [gone] = await insert(owner, 1, "deleted", 61);
    expect((await getArtifact(db(), { ownerId: owner, artifactId: live as string }))?.id).toBe(
      live,
    );
    expect(
      await getArtifact(db(), { ownerId: "u_else", artifactId: live as string }),
    ).toBeUndefined();
    expect(await getArtifact(db(), { ownerId: owner, artifactId: gone as string })).toBeUndefined();
    expect(await getArtifact(db(), { ownerId: owner, artifactId: "zzzzzzzzzz" })).toBeUndefined();
  });
});
