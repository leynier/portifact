// Comment attachments (decision 0028): the triggers of migration 0088 count an attached file in
// its owner's comment storage, move it with a transfer, write the R2 deletion job for every row
// deleted by any path, and delete a message's files when it becomes a deleted marker.
import { env } from "cloudflare:test";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, schema } from "../src/index.ts";

const db = () => createDb(env.DB);
const NOW = Date.UTC(2026, 10, 14);
const OWNER = "u_attach_owner";
const OTHER = "u_attach_other";
const ARTIFACT = "att4chment";

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

async function seedThread(threadId = "t1", messageId = "m1") {
  await db().insert(schema.annotationThreads).values({
    id: threadId,
    artifactId: ARTIFACT,
    versionId: "v1",
    ownerId: OWNER,
    authorId: "u_author",
    target: "{}",
    targetBytes: 10,
    path: "index.html",
    updatedAt: NOW,
  });
  await db().insert(schema.annotationMessages).values({
    id: messageId,
    threadId,
    artifactId: ARTIFACT,
    ownerId: OWNER,
    authorId: "u_author",
    body: "x",
    bodyBytes: 1,
  });
}

function pending(id: string, size = 1_000) {
  return db()
    .insert(schema.commentAttachments)
    .values({
      id,
      artifactId: ARTIFACT,
      ownerId: OWNER,
      uploadedBy: "u_author",
      name: "shot.png",
      size,
      sha256: "a".repeat(64),
      state: "pending",
      expiresAt: NOW + 60_000,
    });
}

function attach(id: string, threadId = "t1", messageId = "m1") {
  return db()
    .update(schema.commentAttachments)
    .set({
      state: "attached",
      threadId,
      messageId,
      contentType: "image/png",
      expiresAt: null,
      attachedAt: NOW,
    })
    .where(eq(schema.commentAttachments.id, id));
}

async function bytesOf(owner: string) {
  const [row] = await db()
    .select({ bytes: schema.annotationUsage.bytes })
    .from(schema.annotationUsage)
    .where(eq(schema.annotationUsage.ownerId, owner));
  return row?.bytes ?? null;
}

async function deletedKeys() {
  const rows = await db()
    .select({ payload: schema.outbox.payload })
    .from(schema.outbox)
    .where(eq(schema.outbox.topic, "delete_objects"));
  const keys = rows.flatMap((row) => (row.payload as { keys: string[] }).keys).sort();
  // Every deleted row schedules its key twice: at once and after its upload link expired.
  const once = [...new Set(keys)];
  expect(keys).toEqual(once.flatMap((key) => [key, key]));
  return once;
}

async function rowIds() {
  const rows = await db()
    .select({ id: schema.commentAttachments.id })
    .from(schema.commentAttachments)
    .orderBy(schema.commentAttachments.id);
  return rows.map((row) => row.id);
}

describe("comment attachments", () => {
  beforeEach(async () => {
    for (const table of [
      "comment_attachments",
      "annotation_events",
      "annotation_messages",
      "annotation_threads",
      "annotation_usage",
      "outbox",
      "artifacts",
    ]) {
      await env.DB.exec(`DELETE FROM ${table}`);
    }
    await db()
      .insert(schema.artifacts)
      .values({ id: ARTIFACT, ownerId: OWNER, type: "site", name: "Plan" });
    await seedThread();
  });

  it("counts a file only once it is attached, and stops counting when it goes", async () => {
    const before = await bytesOf(OWNER);
    await pending("a1", 2_000);
    expect(await bytesOf(OWNER)).toBe(before);
    await attach("a1");
    expect(await bytesOf(OWNER)).toBe((before ?? 0) + 2_000);
    await db().delete(schema.commentAttachments).where(eq(schema.commentAttachments.id, "a1"));
    expect(await bytesOf(OWNER)).toBe(before);
  });

  it("refuses attaching past the owner's comment storage", async () => {
    await db()
      .update(schema.annotationUsage)
      .set({ bytesLimit: sql`${schema.annotationUsage.bytes} + 500` })
      .where(eq(schema.annotationUsage.ownerId, OWNER));
    await pending("a1", 1_000);
    await rejects(attach("a1"), /annotation_usage_bytes_limit/);
    const [row] = await db().select().from(schema.commentAttachments);
    expect(row?.state).toBe("pending");
  });

  it("writes the R2 deletion of every row deleted, pending or attached", async () => {
    await pending("a1");
    await pending("a2");
    await attach("a2");
    await db().delete(schema.commentAttachments);
    expect(await deletedKeys()).toEqual([
      `attachments/${ARTIFACT}/a1`,
      `attachments/${ARTIFACT}/a2`,
    ]);
  });

  it("deletes a message's files when it becomes a deleted marker, and only its own", async () => {
    await db().insert(schema.annotationMessages).values({
      id: "m2",
      threadId: "t1",
      artifactId: ARTIFACT,
      ownerId: OWNER,
      authorId: "u_other",
      body: "y",
      bodyBytes: 1,
    });
    await pending("a1");
    await attach("a1", "t1", "m1");
    await pending("a2");
    await attach("a2", "t1", "m2");
    await db()
      .update(schema.annotationMessages)
      .set({ state: "hidden" })
      .where(eq(schema.annotationMessages.id, "m1"));
    expect(await rowIds()).toEqual(["a1", "a2"]);
    await db()
      .update(schema.annotationMessages)
      .set({ state: "deleted", body: null, bodyBytes: 0 })
      .where(eq(schema.annotationMessages.id, "m1"));
    expect(await rowIds()).toEqual(["a2"]);
    expect(await deletedKeys()).toEqual([`attachments/${ARTIFACT}/a1`]);
  });

  it("goes with its message, thread and artifact by cascade, each writing its deletion", async () => {
    await pending("a1");
    await attach("a1");
    await db().delete(schema.annotationMessages).where(eq(schema.annotationMessages.id, "m1"));
    expect(await rowIds()).toEqual([]);
    await seedThread("t2", "m2");
    await pending("a2");
    await attach("a2", "t2", "m2");
    await db().delete(schema.annotationThreads).where(eq(schema.annotationThreads.id, "t2"));
    expect(await rowIds()).toEqual([]);
    await pending("a3");
    await db().delete(schema.artifacts).where(eq(schema.artifacts.id, ARTIFACT));
    expect(await rowIds()).toEqual([]);
    expect(await deletedKeys()).toEqual([
      `attachments/${ARTIFACT}/a1`,
      `attachments/${ARTIFACT}/a2`,
      `attachments/${ARTIFACT}/a3`,
    ]);
  });

  it("schedules the second deletion after any upload link expired, and refuses deleting a held artifact's file", async () => {
    await pending("a1");
    await db().delete(schema.commentAttachments);
    const jobs = await db()
      .select({ available: schema.outbox.availableAt })
      .from(schema.outbox)
      .where(eq(schema.outbox.topic, "delete_objects"))
      .orderBy(schema.outbox.availableAt);
    expect(jobs).toHaveLength(2);
    expect((jobs[1]?.available ?? 0) - (jobs[0]?.available ?? 0)).toBe(20 * 60 * 1000);

    await pending("a2");
    await db()
      .update(schema.artifacts)
      .set({ state: "suspended", suspensionReason: "malware" })
      .where(eq(schema.artifacts.id, ARTIFACT));
    await env.DB.prepare(
      "INSERT INTO legal_holds (id, artifact_id, owner_id, reason, ground) VALUES ('hold_att', ?, ?, 'malware', 'g')",
    )
      .bind(ARTIFACT, OWNER)
      .run();
    await rejects(
      db().delete(schema.commentAttachments).where(eq(schema.commentAttachments.id, "a2")),
      /legal_hold/,
    );
    await env.DB.exec("DELETE FROM legal_holds WHERE id = 'hold_att'");
  });

  it("moves an attached file's bytes with a transfer", async () => {
    await pending("a1", 3_000);
    await attach("a1");
    const source = (await bytesOf(OWNER)) ?? 0;
    await db()
      .update(schema.commentAttachments)
      .set({ ownerId: OTHER })
      .where(eq(schema.commentAttachments.id, "a1"));
    expect(await bytesOf(OWNER)).toBe(source - 3_000);
    expect(await bytesOf(OTHER)).toBe(3_000);
  });

  it("keeps the states whole", async () => {
    await pending("a1");
    await rejects(
      db()
        .update(schema.commentAttachments)
        .set({ state: "attached" })
        .where(eq(schema.commentAttachments.id, "a1")),
      /comment_attachments_state/,
    );
    await rejects(pending("a2", 10_485_761), /comment_attachments_size/);
    await rejects(
      db()
        .update(schema.commentAttachments)
        .set({ sha256: "short" })
        .where(eq(schema.commentAttachments.id, "a1")),
      /comment_attachments_sha256/,
    );
  });
});
