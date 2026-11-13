// Edit suggestions through a backup restore (decision 0027, "Withdrawal, deletion and retention";
// docs/operations.md, "Restoring a backup"): a withdrawal, a rejection and every removal of a draft
// write a window tombstone in the batch of the change, and `applyTombstones` withdraws or rejects
// the suggestion again and deletes the draft again when a D1 Time Travel restore brought it back,
// never a draft its author started after (its incarnation).
import { env } from "cloudflare:test";
import { regionsFromEnv, schema } from "@portifact/db";
import { and, asc, eq, type SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  deleteOwnAnnotationMessage,
  eraseAuthorFromThread,
  replyToAnnotationThread,
} from "../src/annotations.ts";
import { applyTombstones, exportTombstones } from "../src/backups.ts";
import { writeCommentTombstones } from "../src/comment-retention.ts";
import { discardDraft, removeDraftBatch, saveDraft } from "../src/edit-drafts.ts";
import { acceptSuggestion, publishDraft } from "../src/suggestion-accept.ts";
import { pruneDraftsWithoutRole } from "../src/suggestion-maintenance.ts";
import { draftMarkerId } from "../src/suggestion-markers.ts";
import { planDraft, planSuggestion } from "../src/suggestion-plans.ts";
import { rejectSuggestion, submitSuggestion, withdrawSuggestion } from "../src/suggestions.ts";
import { transferArtifact } from "../src/transfer.ts";
import { createWorkspace } from "../src/workspaces.ts";
import { publishIn, team } from "./comment-retention-fixtures.ts";
import { DAY, db, grantPlan, NOW, user, value } from "./fixtures.ts";
import {
  DOC,
  DOMAIN,
  type Doc,
  humanCheck,
  publishDoc,
  runJobs,
  textOp,
  thread,
} from "./suggestion-support.ts";

const MD = { type: "markdown" as const, path: "index.md" };
const regions = () => regionsFromEnv(env);
const t = schema.tombstones;
const th = schema.annotationThreads;
const m = schema.annotationMessages;
const dr = schema.editDrafts;

type Kind = "suggestion_withdrawn" | "suggestion_rejected" | "edit_draft";

async function marker(kind: Kind, id: string) {
  const [row] = await db()
    .global.select()
    .from(t)
    .where(and(eq(t.kind, kind), eq(t.id, id)));
  return row;
}

/** An owner's document, a reader on its list and that reader's pending suggestion. */
async function setup() {
  const owner = await user("Owner");
  const reader = await user("Reader");
  const doc = await publishDoc(owner.id);
  await db()
    .insert(schema.artifactReaders)
    .values({ artifactId: doc.artifactId, email: reader.email });
  const view = value(
    await submitSuggestion(db(), {
      userId: reader.id,
      artifactId: doc.artifactId,
      now: NOW,
      versionId: doc.versionId,
      edit: { operations: [textOp(MD, DOC, "Second", "Next")] },
      body: "Typo",
      humanCheck,
    }),
  );
  const as = (userId: string, now = NOW + 10) => ({ userId, artifactId: doc.artifactId, now });
  return { owner, reader, doc, threadId: view.id, as };
}

/** The thread and its messages as they are now: what a restore to this moment brings back. */
async function snapshot(threadId: string) {
  return {
    thread: await thread(threadId),
    messages: await db().select().from(m).where(eq(m.threadId, threadId)),
  };
}

/**
 * Puts a snapshot back as a restore does, by replacing the rows (the immutability trigger refuses
 * an update out of a decided state, which a restore never goes through).
 */
async function rewind(saved: Awaited<ReturnType<typeof snapshot>>) {
  if (!saved.thread) throw new Error("no thread");
  await db().delete(th).where(eq(th.id, saved.thread.id));
  await db().insert(th).values(saved.thread);
  if (saved.messages.length > 0) await db().insert(m).values(saved.messages);
}

const restore = (now = NOW + DAY) => applyTombstones(regions(), [], now);

describe("a withdrawal through a restore", () => {
  it("writes its marker with the withdrawal, and a restore withdraws the suggestion again", async () => {
    const s = await setup();
    const before = await snapshot(s.threadId);
    value(
      await withdrawSuggestion(db(), { ...s.as(s.reader.id), threadId: s.threadId, revision: 1 }),
    );
    expect(await marker("suggestion_withdrawn", s.threadId)).toMatchObject({ deletedAt: NOW + 10 });
    expect((await exportTombstones(regions())).map((x) => `${x.kind}:${x.id}`)).toContain(
      `suggestion_withdrawn:${s.threadId}`,
    );
    await rewind(before);
    expect(await thread(s.threadId)).toMatchObject({ suggestionState: "pending" });
    expect((await restore()).withdrawnSuggestions).toBe(1);
    expect(await thread(s.threadId)).toMatchObject({
      suggestionState: "withdrawn",
      edit: null,
      editBytes: 0,
      editProofs: null,
    });
    // Running it again changes nothing.
    expect((await restore()).withdrawnSuggestions).toBe(0);
  });

  it("writes no marker for a withdrawal that is refused", async () => {
    const s = await setup();
    expect(
      await withdrawSuggestion(db(), { ...s.as(s.reader.id), threadId: s.threadId, revision: 9 }),
    ).toMatchObject({ ok: false, code: "version_conflict" });
    expect(
      await withdrawSuggestion(db(), { ...s.as(s.owner.id), threadId: s.threadId, revision: 1 }),
    ).toMatchObject({ ok: false });
    expect(await marker("suggestion_withdrawn", s.threadId)).toBeUndefined();
  });

  it("marks the withdrawal its author makes by deleting their first message", async () => {
    const s = await setup();
    value(
      await replyToAnnotationThread(db(), {
        ...s.as(s.owner.id),
        threadId: s.threadId,
        body: "Thanks",
        humanCheck,
      }),
    );
    const before = await snapshot(s.threadId);
    const [first] = await db()
      .select({ id: m.id })
      .from(m)
      .where(eq(m.threadId, s.threadId))
      .orderBy(asc(m.createdAt))
      .limit(1);
    value(
      await deleteOwnAnnotationMessage(db(), {
        ...s.as(s.reader.id, NOW + 20),
        messageId: first?.id as string,
      }),
    );
    expect(await thread(s.threadId)).toMatchObject({ suggestionState: "withdrawn" });
    expect(await marker("suggestion_withdrawn", s.threadId)).toMatchObject({ deletedAt: NOW + 20 });
    await rewind(before);
    await restore();
    expect(await thread(s.threadId)).toMatchObject({ suggestionState: "withdrawn", edit: null });
  });

  it("marks the system's withdrawal when its author's words are erased", async () => {
    const s = await setup();
    value(
      await replyToAnnotationThread(db(), {
        ...s.as(s.owner.id),
        threadId: s.threadId,
        body: "A reply that keeps the thread",
        humanCheck,
      }),
    );
    expect(
      await eraseAuthorFromThread(db(), {
        authorId: s.reader.id,
        threadId: s.threadId,
        now: NOW + 30,
      }),
    ).toBe(true);
    expect(await thread(s.threadId)).toMatchObject({ suggestionState: "withdrawn" });
    expect(await marker("suggestion_withdrawn", s.threadId)).toMatchObject({ deletedAt: NOW + 30 });
  });

  it("ends an acceptance the restore brought back running, so nothing publishes it", async () => {
    const s = await setup();
    const params = { ...s.as(s.owner.id), threadId: s.threadId, contentDomain: DOMAIN };
    const plan = value(await planSuggestion(db(), env.ARTIFACTS, params));
    value(await acceptSuggestion(db(), env.ARTIFACTS, { ...params, digest: plan.digest }));
    expect(await thread(s.threadId)).toMatchObject({ suggestionState: "applying" });
    // The marker of a withdrawal made after the moment the restore went back to.
    await db()
      .global.insert(t)
      .values({ kind: "suggestion_withdrawn", id: s.threadId, deletedAt: NOW });
    expect((await restore()).withdrawnSuggestions).toBe(1);
    expect(await thread(s.threadId)).toMatchObject({
      suggestionState: "withdrawn",
      attemptId: null,
    });
    const attempts = await db()
      .select({ state: schema.acceptanceAttempts.state, reason: schema.acceptanceAttempts.reason })
      .from(schema.acceptanceAttempts)
      .where(eq(schema.acceptanceAttempts.threadId, s.threadId));
    expect(attempts).toEqual([{ state: "ended", reason: "revoked" }]);
    await runJobs("suggestion_accept", s.doc.artifactId);
    expect(await thread(s.threadId)).toMatchObject({ suggestionState: "withdrawn" });
  });
});

describe("a rejection through a restore", () => {
  it("writes its marker with the rejection, and a restore rejects the suggestion again", async () => {
    const s = await setup();
    const before = await snapshot(s.threadId);
    value(await rejectSuggestion(db(), { ...s.as(s.owner.id), threadId: s.threadId, revision: 1 }));
    expect(await marker("suggestion_rejected", s.threadId)).toMatchObject({ deletedAt: NOW + 10 });
    await rewind(before);
    expect((await restore(NOW + DAY)).rejectedSuggestions).toBe(1);
    // The edit stays with a rejected suggestion; the restore's time stands for the decision.
    expect(await thread(s.threadId)).toMatchObject({
      suggestionState: "rejected",
      decidedAt: NOW + DAY,
      decidedBy: null,
      edit: before.thread?.edit,
    });
  });

  it("leaves a suggestion decided since as it is, and a refused decision writes nothing", async () => {
    const s = await setup();
    expect(
      await rejectSuggestion(db(), { ...s.as(s.owner.id), threadId: s.threadId, revision: 3 }),
    ).toMatchObject({ ok: false, code: "version_conflict" });
    expect(await marker("suggestion_rejected", s.threadId)).toBeUndefined();
    value(
      await withdrawSuggestion(db(), { ...s.as(s.reader.id), threadId: s.threadId, revision: 1 }),
    );
    await db()
      .global.insert(t)
      .values({ kind: "suggestion_rejected", id: s.threadId, deletedAt: NOW });
    expect((await restore()).rejectedSuggestions).toBe(0);
    expect(await thread(s.threadId)).toMatchObject({ suggestionState: "withdrawn" });
  });
});

async function draftRow(doc: Doc, userId: string) {
  const [row] = await db()
    .select()
    .from(dr)
    .where(and(eq(dr.artifactId, doc.artifactId), eq(dr.userId, userId)));
  return row;
}

async function save(doc: Doc, userId: string, now = NOW + 10) {
  return value(
    await saveDraft(db(), {
      userId,
      artifactId: doc.artifactId,
      now,
      baseVersionId: doc.versionId,
      edit: { operations: [textOp(MD, DOC, "Second", "Next")] },
      baseRevision: null,
      baseIncarnation: null,
    }),
  );
}

describe("a removed draft through a restore", () => {
  it("writes its marker with the discard, and a restore deletes that draft again", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    await save(doc, owner.id);
    const before = await draftRow(doc, owner.id);
    if (!before) throw new Error("no draft");
    value(
      await discardDraft(db(), { userId: owner.id, artifactId: doc.artifactId, now: NOW + 20 }),
    );
    const id = draftMarkerId(doc.artifactId, owner.id, before.incarnation);
    expect(await marker("edit_draft", id)).toMatchObject({ deletedAt: NOW + 20 });
    await db().insert(dr).values(before);
    expect((await restore()).drafts).toBe(1);
    expect(await draftRow(doc, owner.id)).toBeUndefined();
  });

  it("keeps a draft started after the discard: another incarnation", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const first = await save(doc, owner.id);
    value(
      await discardDraft(db(), { userId: owner.id, artifactId: doc.artifactId, now: NOW + 20 }),
    );
    const second = await save(doc, owner.id, NOW + 30);
    expect(second.incarnation).not.toBe(first.incarnation);
    expect((await restore()).drafts).toBe(0);
    expect(await draftRow(doc, owner.id)).toMatchObject({ incarnation: second.incarnation });
  });

  it("writes no marker when the removal's condition fails", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const saved = await save(doc, owner.id);
    const stale = and(eq(dr.artifactId, doc.artifactId), eq(dr.revision, 99)) as SQL;
    const [, deleted] = await removeDraftBatch(db(), db(), stale, NOW);
    expect(deleted).toEqual([]);
    expect(
      await marker("edit_draft", draftMarkerId(doc.artifactId, owner.id, saved.incarnation)),
    ).toBeUndefined();
  });

  it("marks a published draft, so a restore never publishes it twice", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    await save(doc, owner.id);
    const before = await draftRow(doc, owner.id);
    if (!before) throw new Error("no draft");
    const input = {
      userId: owner.id,
      artifactId: doc.artifactId,
      now: NOW + 20,
      contentDomain: DOMAIN,
    };
    const plan = value(await planDraft(db(), env.ARTIFACTS, input));
    value(await publishDraft(db(), env.ARTIFACTS, { ...input, digest: plan.digest }));
    await runJobs("draft_publish", doc.artifactId);
    expect(await draftRow(doc, owner.id)).toBeUndefined();
    expect(
      await marker("edit_draft", draftMarkerId(doc.artifactId, owner.id, before.incarnation)),
    ).toBeDefined();
    await db().insert(dr).values(before);
    await restore();
    expect(await draftRow(doc, owner.id)).toBeUndefined();
  });

  it("marks the drafts a transfer removes", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const saved = await save(doc, owner.id);
    const slug = `m-${crypto.randomUUID().slice(0, 8)}`;
    const ws = value(
      await createWorkspace(db().global, { slug, name: "Team", adminUserId: owner.id, now: NOW }),
    );
    await grantPlan(ws.id, "team", { seats: 10 });
    value(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: owner.id,
        artifactId: doc.artifactId,
        workspace: slug,
        now: NOW + 40,
      }),
    );
    expect(await draftRow(doc, owner.id)).toBeUndefined();
    expect(
      await marker("edit_draft", draftMarkerId(doc.artifactId, owner.id, saved.incarnation)),
    ).toMatchObject({ deletedAt: NOW + 40 });
  });

  it("marks the drafts of people who left the owner side", async () => {
    const owner = await user("Owner");
    const stranger = await user("Stranger");
    const doc = await publishDoc(owner.id);
    const incarnation = `inc-${crypto.randomUUID()}`;
    const edit = JSON.stringify({ operations: [textOp(MD, DOC, "Second", "Next")] });
    await db()
      .insert(dr)
      .values({
        artifactId: doc.artifactId,
        userId: stranger.id,
        ownerId: owner.id,
        baseVersionId: doc.versionId,
        edit,
        editBytes: new TextEncoder().encode(edit).length,
        updatedAt: NOW,
        incarnation,
      });
    for (let i = 0; i < 20 && (await draftRow(doc, stranger.id)); i++) {
      await pruneDraftsWithoutRole(db(), NOW + 50 + i);
    }
    expect(await draftRow(doc, stranger.id)).toBeUndefined();
    expect(
      await marker("edit_draft", draftMarkerId(doc.artifactId, stranger.id, incarnation)),
    ).toBeDefined();
  });
});

describe("restore markers in a region with its own database", () => {
  it("go through a comment_tombstones job, and the restore deletes the EU draft again", async () => {
    const ws = await team("eu");
    const published = await publishIn(ws.editor.id, ws.id, "eu");
    const eu = regions().get("eu").db;
    const incarnation = `inc-${crypto.randomUUID()}`;
    const edit = JSON.stringify({ operations: [textOp(MD, DOC, "Second", "Next")] });
    const row = {
      artifactId: published.artifactId,
      userId: ws.editor.id,
      ownerId: ws.id,
      baseVersionId: published.versionId,
      edit,
      editBytes: new TextEncoder().encode(edit).length,
      updatedAt: NOW,
      incarnation,
    };
    await eu.insert(dr).values(row);
    const mine = and(eq(dr.artifactId, published.artifactId), eq(dr.userId, ws.editor.id)) as SQL;
    const [, deleted] = await removeDraftBatch(eu, eu, mine, NOW + 5);
    expect(deleted).toHaveLength(1);
    const id = draftMarkerId(published.artifactId, ws.editor.id, incarnation);
    // Not in the global database yet: the regional batch wrote the job that writes it there.
    expect(await marker("edit_draft", id)).toBeUndefined();
    const jobs = await eu
      .select()
      .from(schema.outbox)
      .where(
        and(
          eq(schema.outbox.topic, "comment_tombstones"),
          eq(schema.outbox.subject, published.artifactId),
        ),
      );
    expect(jobs).toHaveLength(1);
    expect(await writeCommentTombstones(eu, jobs[0] as (typeof jobs)[number])).toBe("done");
    expect(await marker("edit_draft", id)).toMatchObject({ deletedAt: NOW + 5 });
    await eu.insert(dr).values(row);
    const applied = await applyTombstones(
      { global: db().global, all: () => [{ db: eu }] },
      [],
      NOW + DAY,
    );
    expect(applied.drafts).toBe(1);
    expect(await eu.select().from(dr).where(eq(dr.artifactId, published.artifactId))).toEqual([]);
  });
});
