// Suggestions as comment threads (decision 0027, "The edit model", "Withdrawal, deletion and
// retention"): submitting, reading, rejecting and withdrawing under the annotation rules, the
// refusal to resolve an undecided suggestion, and the withdrawal when its author deletes their
// first message.
import { env } from "cloudflare:test";
import { schema } from "@portifact/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  deleteOwnAnnotationMessage,
  replyToAnnotationThread,
  setAnnotationThreadState,
} from "../src/annotations.ts";
import { acceptSuggestion } from "../src/suggestion-accept.ts";
import { planSuggestion } from "../src/suggestion-plans.ts";
import {
  getSuggestion,
  rejectSuggestion,
  submitSuggestion,
  withdrawSuggestion,
} from "../src/suggestions.ts";
import { db, NOW, user, value } from "./fixtures.ts";
import { raceBeforeFirstWrite } from "./race.ts";
import {
  auditKinds,
  DOC,
  DOMAIN,
  humanCheck,
  noHumanCheck,
  publishDoc,
  textOp,
  thread,
} from "./suggestion-support.ts";

const MD = { type: "markdown" as const, path: "index.md" };

async function usageBytes(ownerId: string): Promise<number> {
  const [row] = await db()
    .select({ bytes: schema.annotationUsage.bytes })
    .from(schema.annotationUsage)
    .where(eq(schema.annotationUsage.ownerId, ownerId));
  return row?.bytes ?? 0;
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
  const as = (userId: string) => ({ userId, artifactId: doc.artifactId, now: NOW + 10 });
  return { owner, reader, doc, threadId: view.id, as };
}

describe("submitting a suggestion", () => {
  it("is a thread whose first message is the note, holding the edit and counting its bytes", async () => {
    const before = Date.now();
    const s = await setup();
    const row = await thread(s.threadId);
    expect(row).toMatchObject({
      kind: "suggestion",
      suggestionState: "pending",
      authorId: s.reader.id,
      state: "open",
      messageCount: 1,
      suggestionRevision: 1,
    });
    expect(row?.editBytes).toBe(new TextEncoder().encode(row?.edit ?? "").length);
    expect(await usageBytes(s.owner.id)).toBeGreaterThanOrEqual(
      (row?.editBytes ?? 0) + (row?.targetBytes ?? 0),
    );
    // A new suggestion is a new comment for the owner's notices and webhooks.
    const view = value(await getSuggestion(db(), { ...s.as(s.owner.id), threadId: s.threadId }));
    expect(view).toMatchObject({
      state: "pending",
      revision: 1,
      planned: false,
      attemptReason: null,
    });
    expect(view.edit).toMatchObject({ operations: [{ kind: "text", after: "Next" }] });
    expect(Date.now()).toBeGreaterThanOrEqual(before);
  });

  it("refuses an invalid edit, another version, a file it cannot plan and a stranger", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const base = {
      userId: owner.id,
      artifactId: doc.artifactId,
      now: NOW,
      versionId: doc.versionId,
      body: "x",
      humanCheck,
    };
    const operation = textOp(MD, DOC, "Second", "Next");
    expect(await submitSuggestion(db(), { ...base, edit: { operations: [] } })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(
      await submitSuggestion(db(), {
        ...base,
        edit: { operations: [{ ...operation, after: "Second" }] },
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    expect(
      await submitSuggestion(db(), {
        ...base,
        versionId: "ver_other",
        edit: { operations: [operation] },
      }),
    ).toMatchObject({ ok: false, code: "version_conflict" });
    const elsewhere = { ...operation, target: { ...operation.target, path: "other.md" } };
    expect(
      await submitSuggestion(db(), { ...base, edit: { operations: [elsewhere] } }),
    ).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    const stranger = await user("Stranger");
    expect(
      await submitSuggestion(db(), {
        ...base,
        userId: stranger.id,
        edit: { operations: [operation] },
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
    expect(
      await submitSuggestion(db(), {
        ...base,
        userId: "st_00000000000000000000",
        edit: { operations: [operation] },
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
  });

  it("asks a reader for the human check like any comment", async () => {
    const owner = await user("Owner");
    const reader = await user("Reader");
    const doc = await publishDoc(owner.id);
    await db()
      .insert(schema.artifactReaders)
      .values({ artifactId: doc.artifactId, email: reader.email });
    expect(
      await submitSuggestion(db(), {
        userId: reader.id,
        artifactId: doc.artifactId,
        now: NOW,
        versionId: doc.versionId,
        edit: { operations: [textOp(MD, DOC, "Second", "Next")] },
        body: "Typo",
        humanCheck: noHumanCheck,
      }),
    ).toMatchObject({ ok: false, code: "human_verification_required" });
  });

  it("refuses a file of a site that is not a page", async () => {
    const owner = await user("Owner");
    const { publishVersion } = await import("./version-support.ts");
    const site = await publishVersion(owner.id, {
      "index.html": "<p>Hello there</p>",
      "style.css": { body: "p{color:red}", contentType: "text/css" },
    });
    await db()
      .update(schema.artifacts)
      .set({ annotations: "open" })
      .where(eq(schema.artifacts.id, site.artifactId));
    const operation = textOp(
      { type: "site", path: "style.css" },
      "<p>Hello there</p>",
      "Hello",
      "Hi",
    );
    expect(
      await submitSuggestion(db(), {
        userId: owner.id,
        artifactId: site.artifactId,
        now: NOW,
        versionId: site.versionId,
        edit: { operations: [operation] },
        body: "x",
        humanCheck,
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
  });
});

describe("reading a suggestion", () => {
  it("follows the comment scope: hidden from another reader, missing for a token", async () => {
    const s = await setup();
    const other = await user("Other");
    await db()
      .insert(schema.artifactReaders)
      .values({ artifactId: s.doc.artifactId, email: other.email });
    expect(await getSuggestion(db(), { ...s.as(other.id), threadId: s.threadId })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(
      await getSuggestion(db(), { ...s.as("st_00000000000000000000"), threadId: s.threadId }),
    ).toMatchObject({ ok: false, code: "not_found" });
    expect((await getSuggestion(db(), { ...s.as(s.reader.id), threadId: s.threadId })).ok).toBe(
      true,
    );
  });

  it("answers an ordinary comment thread as no suggestion", async () => {
    const s = await setup();
    const { createAnnotationThread } = await import("../src/annotations.ts");
    const comment = value(
      await createAnnotationThread(db(), {
        ...s.as(s.owner.id),
        versionId: s.doc.versionId,
        target: textOp(MD, DOC, "First", "x").target,
        body: "A comment",
        humanCheck,
      }),
    );
    expect(await getSuggestion(db(), { ...s.as(s.owner.id), threadId: comment.id })).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });
});

describe("rejecting and withdrawing", () => {
  it("lets the owner side reject, once, with its audit event", async () => {
    const s = await setup();
    expect(
      await rejectSuggestion(db(), { ...s.as(s.reader.id), threadId: s.threadId, revision: 1 }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(
      await rejectSuggestion(db(), { ...s.as(s.owner.id), threadId: s.threadId, revision: 7 }),
    ).toMatchObject({ ok: false, code: "version_conflict" });
    const rejected = value(
      await rejectSuggestion(db(), { ...s.as(s.owner.id), threadId: s.threadId, revision: 1 }),
    );
    expect(rejected).toMatchObject({ state: "rejected", revision: 2 });
    expect(await thread(s.threadId)).toMatchObject({ decidedBy: s.owner.id, state: "open" });
    expect(
      await rejectSuggestion(db(), { ...s.as(s.owner.id), threadId: s.threadId, revision: 2 }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await auditKinds(s.doc.artifactId)).toContain("suggestion.rejected");
  });

  it("lets the author withdraw: the edit and its bytes go, the thread stays", async () => {
    const s = await setup();
    const before = await usageBytes(s.owner.id);
    const editBytes = (await thread(s.threadId))?.editBytes ?? 0;
    expect(
      await withdrawSuggestion(db(), { ...s.as(s.owner.id), threadId: s.threadId, revision: 1 }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    const withdrawn = value(
      await withdrawSuggestion(db(), { ...s.as(s.reader.id), threadId: s.threadId, revision: 1 }),
    );
    expect(withdrawn).toMatchObject({ state: "withdrawn", edit: null });
    expect(await usageBytes(s.owner.id)).toBe(before - editBytes);
    expect(await thread(s.threadId)).toMatchObject({ editBytes: 0, edit: null, state: "open" });
    expect(await auditKinds(s.doc.artifactId)).toContain("suggestion.withdrawn");
  });

  it("lets a rejection that landed first win over a withdrawal", async () => {
    const s = await setup();
    const raced = raceBeforeFirstWrite(async () => {
      value(
        await rejectSuggestion(db(), { ...s.as(s.owner.id), threadId: s.threadId, revision: 1 }),
      );
    });
    expect(
      await withdrawSuggestion(raced, { ...s.as(s.reader.id), threadId: s.threadId, revision: 1 }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    expect((await thread(s.threadId))?.suggestionState).toBe("rejected");
    expect((await auditKinds(s.doc.artifactId)).filter((k) => k.startsWith("suggestion."))).toEqual(
      ["suggestion.rejected"],
    );
  });
});

describe("thread changes on a suggestion", () => {
  it("refuses resolving an undecided suggestion, and allows replies", async () => {
    const s = await setup();
    expect(
      await setAnnotationThreadState(db(), {
        ...s.as(s.owner.id),
        threadId: s.threadId,
        state: "resolved",
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    value(
      await replyToAnnotationThread(db(), {
        ...s.as(s.owner.id),
        threadId: s.threadId,
        body: "Thanks",
        humanCheck,
      }),
    );
    value(await rejectSuggestion(db(), { ...s.as(s.owner.id), threadId: s.threadId, revision: 1 }));
    expect(
      (
        await setAnnotationThreadState(db(), {
          ...s.as(s.owner.id),
          threadId: s.threadId,
          state: "resolved",
        })
      ).ok,
    ).toBe(true);
  });

  it("withdraws a pending suggestion when its author deletes the first message", async () => {
    const s = await setup();
    value(
      await replyToAnnotationThread(db(), {
        ...s.as(s.owner.id),
        threadId: s.threadId,
        body: "Hm",
        humanCheck,
      }),
    );
    const [first] = await db()
      .select({ id: schema.annotationMessages.id })
      .from(schema.annotationMessages)
      .where(
        and(
          eq(schema.annotationMessages.threadId, s.threadId),
          eq(schema.annotationMessages.authorId, s.reader.id),
        ),
      );
    value(
      await deleteOwnAnnotationMessage(db(), { ...s.as(s.reader.id), messageId: first?.id ?? "" }),
    );
    expect(await thread(s.threadId)).toMatchObject({
      suggestionState: "withdrawn",
      edit: null,
      editBytes: 0,
    });
    expect(await auditKinds(s.doc.artifactId)).toContain("suggestion.withdrawn");
  });

  it("keeps a reply's deletion from withdrawing, and waits while an acceptance applies", async () => {
    const s = await setup();
    const reply = value(
      await replyToAnnotationThread(db(), {
        ...s.as(s.reader.id),
        threadId: s.threadId,
        body: "Also",
        humanCheck,
      }),
    );
    const replyId = reply.messages.at(-1)?.id ?? "";
    value(await deleteOwnAnnotationMessage(db(), { ...s.as(s.reader.id), messageId: replyId }));
    expect((await thread(s.threadId))?.suggestionState).toBe("pending");
    const plan = value(
      await planSuggestion(db(), env.ARTIFACTS, {
        ...s.as(s.owner.id),
        threadId: s.threadId,
        contentDomain: DOMAIN,
      }),
    );
    value(
      await acceptSuggestion(db(), env.ARTIFACTS, {
        ...s.as(s.owner.id),
        threadId: s.threadId,
        digest: plan.digest,
        contentDomain: DOMAIN,
      }),
    );
    const firstId = reply.messages[0]?.id ?? "";
    expect(
      await deleteOwnAnnotationMessage(db(), { ...s.as(s.reader.id), messageId: firstId }),
    ).toMatchObject({
      ok: false,
      code: "version_conflict",
    });
    expect((await thread(s.threadId))?.suggestionState).toBe("applying");
  });
});
