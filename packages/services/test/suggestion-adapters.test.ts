// What the adapters of edit suggestions read through (decision 0027): one change item, marking
// once per idempotency key without storing reviewers' text, and the `kind` and `suggestion`
// fields a thread view carries only when asked.
import { schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getAnnotationThread, listAnnotations } from "../src/annotations.ts";
import { getChangeItem, markChangeItemOnce } from "../src/change-list.ts";
import { submitSuggestion } from "../src/suggestions.ts";
import { db, NOW, user, value } from "./fixtures.ts";
import { DOC, humanCheck, publishDoc, textOp } from "./suggestion-support.ts";

const ENVELOPE = JSON.stringify({
  format: 1,
  status: "listed",
  reason: "spans_nodes",
  operation: { kind: "text", before: "A linked", after: "One linked" },
  binding: {
    artifactId: "x",
    versionId: "v",
    path: "index.md",
    fileSha256: "a".repeat(64),
    renderer: "portifact-render@1",
    route: null,
    subject: "th",
    revision: 1,
  },
  people: { submitter: true, acceptor: true },
  location: { unresolved: true },
  context: null,
  destinations: [],
  destinationsKnown: false,
});

async function listedItem() {
  const owner = await user("Item Owner");
  const doc = await publishDoc(owner.id);
  const id = `chg_${doc.artifactId}`;
  await db().insert(schema.changeItems).values({
    id,
    artifactId: doc.artifactId,
    ownerId: owner.id,
    origin: "suggestion",
    versionId: doc.versionId,
    path: "index.md",
    envelope: ENVELOPE,
    bytes: ENVELOPE.length,
    reason: "spans_nodes",
    createdBy: owner.id,
    createdAt: NOW,
  });
  return { owner, doc, id };
}

describe("one change item", () => {
  it("is read by the owner side and refused to anyone else as the list is", async () => {
    const l = await listedItem();
    const at = { artifactId: l.doc.artifactId, now: NOW + 1 };
    const item = value(await getChangeItem(db(), { ...at, userId: l.owner.id, itemId: l.id }));
    expect(item).toMatchObject({ id: l.id, state: "open", revision: 1 });
    expect(
      await getChangeItem(db(), { ...at, userId: l.owner.id, itemId: "chg_missing" }),
    ).toMatchObject({ ok: false, code: "not_found" });
    const stranger = await user("Item Stranger");
    expect(await getChangeItem(db(), { ...at, userId: stranger.id, itemId: l.id })).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });
});

describe("marking once per key", () => {
  it("replays by reading the item again, stores only its ID, and refuses another request", async () => {
    const l = await listedItem();
    const request = (key: string, state: "applied" | "dismissed") => ({
      actorId: l.owner.id,
      key,
      operation: "changes.mark",
      requestHash: `hash-${state}`,
      now: NOW + 5,
    });
    const input = {
      userId: l.owner.id,
      artifactId: l.doc.artifactId,
      itemId: l.id,
      state: "applied" as const,
      baseRevision: 1,
      now: NOW + 5,
    };
    const first = await markChangeItemOnce(db(), request("key-00001", "applied"), input);
    expect(first).toMatchObject({ kind: "done", result: { ok: true } });
    const stored = await db()
      .select()
      .from(schema.operations)
      .where(eq(schema.operations.idempotencyKey, "key-00001"));
    expect(JSON.stringify(stored)).not.toContain("One linked");
    const again = await markChangeItemOnce(db(), request("key-00001", "applied"), input);
    expect(again).toMatchObject({
      kind: "done",
      result: { ok: true, value: { state: "applied", revision: 2 } },
    });
    expect(
      await markChangeItemOnce(db(), request("key-00001", "dismissed"), {
        ...input,
        state: "dismissed",
      }),
    ).toEqual({ kind: "mismatch" });
    // A refusal is stored as the refusal.
    const stale = await markChangeItemOnce(db(), request("key-00002", "dismissed"), {
      ...input,
      state: "dismissed",
    });
    expect(stale).toMatchObject({
      kind: "done",
      result: { ok: false, code: "version_conflict" },
    });
  });
});

describe("suggestion fields on thread views", () => {
  it("adds kind and the suggestion block only when asked", async () => {
    const owner = await user("Fields Owner");
    const doc = await publishDoc(owner.id);
    const thread = value(
      await submitSuggestion(db(), {
        userId: owner.id,
        artifactId: doc.artifactId,
        now: NOW,
        versionId: doc.versionId,
        edit: { operations: [textOp(doc, DOC, "Second", "Next")] },
        body: "Typo",
        humanCheck,
      }),
    );
    const as = { userId: owner.id, artifactId: doc.artifactId, now: NOW + 1 };
    const plain = value(await getAnnotationThread(db(), { ...as, threadId: thread.id }));
    expect(plain).not.toHaveProperty("kind");
    expect(plain).not.toHaveProperty("suggestion");
    const asked = value(
      await getAnnotationThread(db(), { ...as, threadId: thread.id, suggestionFields: true }),
    );
    expect(asked).toMatchObject({
      kind: "suggestion",
      suggestion: { threadId: thread.id, state: "pending", revision: 1 },
    });
    const page = value(
      await listAnnotations(db(), {
        ...as,
        limit: 10,
        version: "current",
        suggestionFields: true,
      }),
    );
    expect(page.threads[0]).toMatchObject({ kind: "suggestion" });
    const listed = value(await listAnnotations(db(), { ...as, limit: 10, version: "current" }));
    expect(listed.threads[0]).not.toHaveProperty("kind");
  });
});
