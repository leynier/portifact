// The rest of the text delivery of edit suggestions (decision 0027): previews of one's own draft
// and of edits nobody saved, rebasing a draft onto a newer version, and the account export of
// suggestions, drafts and change lists.
import { env } from "cloudflare:test";
import type { DraftView } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { exportAccount } from "../src/account-data.ts";
import { rebaseDraft } from "../src/draft-rebase.ts";
import { saveDraft } from "../src/edit-drafts.ts";
import { placeLegalHold } from "../src/legal-holds.ts";
import { suspendArtifact } from "../src/moderation.ts";
import { planDraft } from "../src/suggestion-plans.ts";
import { issuePreviewCode, redeemPreviewCode } from "../src/suggestion-previews.ts";
import { submitSuggestion } from "../src/suggestions.ts";
import { db, NOW, session, value } from "./fixtures.ts";
import { person } from "./suggestion-fixtures.ts";
import { DOC, DOMAIN, humanCheck, publishDoc, republish, textOp } from "./suggestion-support.ts";

const regions = () => regionsFromEnv(env);

function codeIn(result: Awaited<ReturnType<typeof issuePreviewCode>>): string {
  if (!result.ok || result.value.state !== "ready") throw new Error(JSON.stringify(result));
  return new URL(result.value.url).pathname.slice("/p/".length);
}

async function setup() {
  const owner = await person("Owner");
  const doc = await publishDoc(owner.id);
  const sessionId = await session(owner.id);
  const as = (userId: string, now = NOW + 10) => ({ userId, artifactId: doc.artifactId, now });
  const save = async (after: string, held: DraftView | null = null) =>
    value(
      await saveDraft(db(), {
        ...as(owner.id),
        baseVersionId: doc.versionId,
        baseRevision: held?.revision ?? null,
        baseIncarnation: held?.incarnation ?? null,
        edit: { operations: [textOp(doc, DOC, "Second", after)] },
      }),
    );
  return { owner, doc, sessionId, as, save };
}

describe("previews of one's own draft", () => {
  it("previews the draft's plan, and no longer once the draft changed", async () => {
    const s = await setup();
    const held = await s.save("Next");
    const plan = value(
      await planDraft(db(), env.ARTIFACTS, { ...s.as(s.owner.id), contentDomain: DOMAIN }),
    );
    const issue = () =>
      issuePreviewCode(db(), env.ARTIFACTS, {
        ...s.as(s.owner.id),
        sessionId: s.sessionId,
        digest: plan.digest,
        contentDomain: DOMAIN,
      });
    const code = codeIn(await issue());
    const [row] = await db()
      .select()
      .from(schema.previewCodes)
      .where(eq(schema.previewCodes.artifactId, s.doc.artifactId));
    expect(row?.threadId).toBeNull();
    expect(await redeemPreviewCode(regions(), code, NOW + 20)).toContain("Next paragraph here.");
    // Saved again: the preview built before shows a draft that is no more.
    const stale = codeIn(await issue());
    await s.save("Later", held);
    expect(await redeemPreviewCode(regions(), stale, NOW + 30)).toBeUndefined();
    expect(await issue()).toMatchObject({ ok: false, code: "version_conflict" });
  });

  it("answers another person's digest like a missing plan", async () => {
    const s = await setup();
    await s.save("Next");
    const plan = value(
      await planDraft(db(), env.ARTIFACTS, { ...s.as(s.owner.id), contentDomain: DOMAIN }),
    );
    const other = await person("Other");
    expect(
      await issuePreviewCode(db(), env.ARTIFACTS, {
        ...s.as(other.id),
        sessionId: await session(other.id),
        digest: plan.digest,
        contentDomain: DOMAIN,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("previews of an unsaved edit", () => {
  const unsaved = (
    s: Awaited<ReturnType<typeof setup>>,
    as: "suggestion" | "draft",
    after = "Next",
  ) => ({
    versionId: s.doc.versionId,
    as,
    edit: { operations: [textOp(s.doc, DOC, "Second", after)] },
  });

  it("previews a reader's suggestion and the owner's draft, storing nothing but the code", async () => {
    const s = await setup();
    const reader = await person("Reader");
    await db()
      .insert(schema.artifactReaders)
      .values({ artifactId: s.doc.artifactId, email: reader.email });
    const readerSession = await session(reader.id);
    const issued = await issuePreviewCode(db(), env.ARTIFACTS, {
      ...s.as(reader.id),
      sessionId: readerSession,
      unsaved: unsaved(s, "suggestion"),
      contentDomain: DOMAIN,
    });
    const code = codeIn(issued);
    expect(
      await db()
        .select()
        .from(schema.annotationThreads)
        .where(eq(schema.annotationThreads.artifactId, s.doc.artifactId)),
    ).toEqual([]);
    expect(
      await db()
        .select()
        .from(schema.suggestionPlans)
        .where(eq(schema.suggestionPlans.artifactId, s.doc.artifactId)),
    ).toEqual([]);
    expect(await redeemPreviewCode(regions(), code, NOW + 20)).toContain("Next paragraph here.");
    // The owner's unsaved draft; a reader may not draft, as saving a draft is refused to them.
    codeIn(
      await issuePreviewCode(db(), env.ARTIFACTS, {
        ...s.as(s.owner.id),
        sessionId: s.sessionId,
        unsaved: unsaved(s, "draft"),
        contentDomain: DOMAIN,
      }),
    );
    expect(
      await issuePreviewCode(db(), env.ARTIFACTS, {
        ...s.as(reader.id),
        sessionId: readerSession,
        unsaved: unsaved(s, "draft"),
        contentDomain: DOMAIN,
      }),
    ).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("refuses strangers, tokens, an invalid edit and an old version; says why nothing applies", async () => {
    const s = await setup();
    const stranger = await person("Stranger");
    const ask = (userId: string, edit: unknown, versionId = s.doc.versionId) =>
      issuePreviewCode(db(), env.ARTIFACTS, {
        ...s.as(userId),
        sessionId: s.sessionId,
        unsaved: { versionId, as: "suggestion", edit },
        contentDomain: DOMAIN,
      });
    const good = unsaved(s, "suggestion").edit;
    expect(await ask(stranger.id, good)).toMatchObject({ ok: false, code: "not_found" });
    expect(await ask("st_00000000000000000000", good)).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await ask(s.owner.id, { operations: [] })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(await ask(s.owner.id, good, "ver_old")).toMatchObject({
      ok: false,
      code: "version_conflict",
    });
    // A selection across a link is listed: nothing applies, so there is no preview.
    const across = { operations: [textOp(s.doc, DOC, "A linked", "One linked")] };
    const listed = await ask(s.owner.id, across);
    expect(listed).toMatchObject({ ok: true, value: { state: "unavailable" } });
  });

  it("is refused at redemption once the artifact has a newer version", async () => {
    const s = await setup();
    const code = codeIn(
      await issuePreviewCode(db(), env.ARTIFACTS, {
        ...s.as(s.owner.id),
        sessionId: s.sessionId,
        unsaved: unsaved(s, "suggestion"),
        contentDomain: DOMAIN,
      }),
    );
    await republish(s.owner.id, s.doc, `${DOC}\nMore.\n`);
    expect(await redeemPreviewCode(regions(), code, NOW + 2_000)).toBeUndefined();
  });
});

describe("rebasing a draft", () => {
  it("carries the draft to the new version, or hands back what does not relocate", async () => {
    const s = await setup();
    const held = await s.save("Next");
    const next = await republish(s.owner.id, s.doc, `Intro added.\n\n${DOC}`);
    const rebased = value(
      await rebaseDraft(db(), env.ARTIFACTS, {
        ...s.as(s.owner.id, NOW + 2_000),
        baseRevision: held.revision,
        baseIncarnation: held.incarnation,
        contentDomain: DOMAIN,
      }),
    );
    expect(rebased.conflicts).toEqual([]);
    expect(rebased.draft).toMatchObject({
      baseVersionId: next.versionId,
      revision: held.revision + 1,
      incarnation: held.incarnation,
    });
    // The carried operation is where the text now is on the new page.
    const moved = textOp(next, `Intro added.\n\n${DOC}`, "Second", "Next");
    expect(rebased.draft?.edit).toEqual({ operations: [moved] });

    // The target's own text changes: nothing carries and the draft goes.
    const later = await republish(
      s.owner.id,
      next,
      `Intro added.\n\n${DOC.replace("Second", "Other")}`,
      NOW + 3_000,
    );
    const gone = value(
      await rebaseDraft(db(), env.ARTIFACTS, {
        ...s.as(s.owner.id, NOW + 4_000),
        baseRevision: rebased.draft?.revision ?? 0,
        baseIncarnation: held.incarnation,
        contentDomain: DOMAIN,
      }),
    );
    expect(gone.draft).toBeNull();
    expect(gone.conflicts).toEqual([
      { operation: moved, reason: expect.stringMatching(/^[a-z_]+$/) },
    ]);
    expect(later.versionId).not.toBe(next.versionId);
    expect(
      await db()
        .select()
        .from(schema.editDrafts)
        .where(eq(schema.editDrafts.artifactId, s.doc.artifactId)),
    ).toEqual([]);
  });

  it("changes nothing on the current version, and refuses a stale draft or another person", async () => {
    const s = await setup();
    const held = await s.save("Next");
    const rebase = (userId: string, revision = held.revision, incarnation = held.incarnation) =>
      rebaseDraft(db(), env.ARTIFACTS, {
        ...s.as(userId),
        baseRevision: revision,
        baseIncarnation: incarnation,
        contentDomain: DOMAIN,
      });
    expect(value(await rebase(s.owner.id))).toEqual({ draft: held, conflicts: [] });
    expect(await rebase(s.owner.id, held.revision + 1)).toMatchObject({
      ok: false,
      code: "version_conflict",
    });
    expect(await rebase(s.owner.id, held.revision, "AAAAAAAAAAAAAAAAAAAAAA")).toMatchObject({
      ok: false,
      code: "version_conflict",
    });
    const stranger = await person("Stranger");
    expect(await rebase(stranger.id)).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("the account export", () => {
  it("holds the account's suggestions, drafts and change lists, never a held artifact's list", async () => {
    const s = await setup();
    await s.save("Next");
    // A suggestion by someone else on the account's artifact, and one by the account elsewhere.
    const reviewer = await person("Reviewer");
    await db()
      .insert(schema.artifactReaders)
      .values({ artifactId: s.doc.artifactId, email: reviewer.email });
    value(
      await submitSuggestion(db(), {
        ...s.as(reviewer.id),
        versionId: s.doc.versionId,
        edit: { operations: [textOp(s.doc, DOC, "First", "Opening")] },
        body: "Better word",
        humanCheck,
      }),
    );
    const theirs = await publishDoc(reviewer.id);
    await db()
      .insert(schema.artifactReaders)
      .values({ artifactId: theirs.artifactId, email: (await ownerEmail(s.owner.id)) ?? "" });
    value(
      await submitSuggestion(db(), {
        userId: s.owner.id,
        artifactId: theirs.artifactId,
        now: NOW + 10,
        versionId: theirs.versionId,
        edit: { operations: [textOp(theirs, DOC, "Second", "Mine")] },
        body: "Try this",
        humanCheck,
      }),
    );
    const envelope = JSON.stringify({ format: 1, operation: { kind: "text" } });
    await db()
      .insert(schema.changeItems)
      .values({
        id: `chg_${s.doc.artifactId}`,
        artifactId: s.doc.artifactId,
        ownerId: s.owner.id,
        origin: "draft",
        versionId: s.doc.versionId,
        path: "index.md",
        envelope,
        bytes: envelope.length,
        reason: "spans_nodes",
        createdAt: NOW,
      });
    const exported = value(await exportAccount(db(), { userId: s.owner.id, now: NOW + 20 }));
    const mine = exported.artifacts.find((a) => a.id === s.doc.artifactId);
    expect(mine?.threads[0]?.suggestion).toMatchObject({
      state: "pending",
      edit: { operations: [{ after: "Opening" }] },
    });
    expect(mine?.changeItems).toEqual([
      expect.objectContaining({ id: `chg_${s.doc.artifactId}`, envelope: JSON.parse(envelope) }),
    ]);
    expect(exported.drafts).toEqual([
      expect.objectContaining({
        artifactId: s.doc.artifactId,
        edit: { operations: [expect.objectContaining({ after: "Next" })] },
      }),
    ]);
    expect(exported.commentsElsewhere[0]?.suggestion).toMatchObject({
      edit: { operations: [{ after: "Mine" }] },
    });
    // A held artifact's change list waits for its release, like its comments.
    value(await suspendArtifact(db(), { artifactId: s.doc.artifactId, reason: "spam", now: NOW }));
    value(
      await placeLegalHold(db(), {
        artifactId: s.doc.artifactId,
        ground: "Evidence",
        releaseAt: null,
        now: NOW + 1,
      }),
    );
    const held = value(await exportAccount(db(), { userId: s.owner.id, now: NOW + 30 }));
    expect(held.artifacts.find((a) => a.id === s.doc.artifactId)?.changeItems).toEqual([]);
  });
});

async function ownerEmail(userId: string): Promise<string | undefined> {
  const [row] = await db()
    .global.select({ email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return row?.email;
}
