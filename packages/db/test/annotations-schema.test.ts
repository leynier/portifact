import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, schema } from "../src/index.ts";

const db = () => createDb(env.DB);
const NOW = Date.UTC(2026, 10, 8);
const OWNER = "u_annotations_owner";
const ARTIFACT = "annot4tion";

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

function thread(id: string, targetBytes = 30) {
  return db().insert(schema.annotationThreads).values({
    id,
    artifactId: ARTIFACT,
    versionId: "v1",
    ownerId: OWNER,
    authorId: "u_author",
    target: "{}",
    targetBytes,
    path: "index.html",
    updatedAt: NOW,
  });
}

function message(id: string, threadId: string, bodyBytes: number) {
  return db()
    .insert(schema.annotationMessages)
    .values({
      id,
      threadId,
      artifactId: ARTIFACT,
      ownerId: OWNER,
      authorId: "u_author",
      body: "x".repeat(bodyBytes),
      bodyBytes,
    });
}

async function usage() {
  const [row] = await db()
    .select()
    .from(schema.annotationUsage)
    .where(eq(schema.annotationUsage.ownerId, OWNER));
  return row && { messages: row.messages, bytes: row.bytes };
}

describe("annotation tables", () => {
  beforeEach(async () => {
    for (const table of [
      "annotation_events",
      "annotation_messages",
      "annotation_threads",
      "annotation_usage",
      "artifacts",
    ]) {
      await env.DB.exec(`DELETE FROM ${table}`);
    }
    await db()
      .insert(schema.artifacts)
      .values({ id: ARTIFACT, ownerId: OWNER, type: "site", name: "Plan" });
  });

  it("counts live messages and logical bytes per owner on every write", async () => {
    await thread("t1", 40);
    expect(await usage()).toEqual({ messages: 0, bytes: 40 });
    await message("m1", "t1", 10);
    await message("m2", "t1", 5);
    expect(await usage()).toEqual({ messages: 2, bytes: 55 });

    await db()
      .update(schema.annotationMessages)
      .set({ body: "abc", bodyBytes: 3 })
      .where(eq(schema.annotationMessages.id, "m1"));
    expect(await usage()).toEqual({ messages: 2, bytes: 48 });

    // Hidden messages are still stored; deleted ones free their slot and bytes.
    await db()
      .update(schema.annotationMessages)
      .set({ state: "hidden" })
      .where(eq(schema.annotationMessages.id, "m1"));
    expect(await usage()).toEqual({ messages: 2, bytes: 48 });
    await db()
      .update(schema.annotationMessages)
      .set({ state: "deleted", body: null, bodyBytes: 0 })
      .where(eq(schema.annotationMessages.id, "m2"));
    expect(await usage()).toEqual({ messages: 1, bytes: 43 });

    await db().delete(schema.annotationMessages).where(eq(schema.annotationMessages.id, "m2"));
    expect(await usage()).toEqual({ messages: 1, bytes: 43 });
  });

  it("releases the usage of every thread and message when the artifact is purged", async () => {
    await thread("t1", 20);
    await thread("t2", 20);
    await message("m1", "t1", 100);
    await message("m2", "t2", 100);
    await db().insert(schema.annotationEvents).values({
      artifactId: ARTIFACT,
      threadId: "t1",
      actorId: "u_author",
      writeId: "w1",
      kind: "thread_created",
      at: NOW,
    });
    expect(await usage()).toEqual({ messages: 2, bytes: 240 });

    await db().delete(schema.artifacts).where(eq(schema.artifacts.id, ARTIFACT));
    expect(await usage()).toEqual({ messages: 0, bytes: 0 });
    expect(await db().select().from(schema.annotationMessages)).toEqual([]);
    expect(await db().select().from(schema.annotationEvents)).toEqual([]);
  });

  it("refuses writes past the owner's limits in the database", async () => {
    await thread("t1");
    await db()
      .update(schema.annotationUsage)
      .set({ messages: 5000 })
      .where(eq(schema.annotationUsage.ownerId, OWNER));
    await rejects(message("m1", "t1", 1), /CHECK constraint failed/);

    await db()
      .update(schema.annotationUsage)
      .set({ messages: 0, bytes: 49_999_990 })
      .where(eq(schema.annotationUsage.ownerId, OWNER));
    await rejects(message("m2", "t1", 11), /CHECK constraint failed/);
    await message("m3", "t1", 10);
    expect(await usage()).toEqual({ messages: 1, bytes: 50_000_000 });
  });

  it("keeps a deleted message without a body, and a body only on live messages", async () => {
    await thread("t1");
    await rejects(
      db().insert(schema.annotationMessages).values({
        id: "m1",
        threadId: "t1",
        artifactId: ARTIFACT,
        ownerId: OWNER,
        authorId: "u",
        body: null,
        bodyBytes: 0,
      }),
      /CHECK constraint failed/,
    );
    await rejects(message("m2", "t1", 8193), /CHECK constraint failed/);
    await rejects(thread("t2", 8193), /CHECK constraint failed/);
  });
});
