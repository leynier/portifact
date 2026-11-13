// Plans, drafts and the suggestion scans (decision 0027): plans built from the stored files alone,
// rate limited and cached, with the suggestion's proofs persisted; a draft published like an
// acceptance; and the scans that end overdue attempts and delete what has a lifetime.
import { env } from "cloudflare:test";
import { DRAFT_LIMITS, SUGGESTION_LIMITS } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { placeLegalHold } from "../src/legal-holds.ts";
import { suspendArtifact } from "../src/moderation.ts";
import { publishDraft } from "../src/suggestion-accept.ts";
import { pruneDraftsWithoutRole, pruneSuggestionRecords } from "../src/suggestion-maintenance.ts";
import { planDraft, planSuggestion } from "../src/suggestion-plans.ts";
import { rejectSuggestion, storedProofs, submitSuggestion } from "../src/suggestions.ts";
import { DAY, db, NOW, user, value } from "./fixtures.ts";
import {
  attempts,
  auditKinds,
  currentText,
  DOC,
  DOMAIN,
  type Doc,
  humanCheck,
  items,
  PAGE,
  publishDoc,
  republish,
  runJobs,
  textOp,
  thread,
} from "./suggestion-support.ts";
import { publishVersion, workspace } from "./version-support.ts";

const MD = { type: "markdown" as const, path: "index.md" };
const SITE = { type: "site" as const, path: "index.html" };

async function suggestionOn(
  doc: Doc,
  authorId: string,
  operation = textOp(MD, DOC, "Second", "Next"),
) {
  return value(
    await submitSuggestion(db(), {
      userId: authorId,
      artifactId: doc.artifactId,
      now: NOW,
      versionId: doc.versionId,
      edit: { operations: [operation] },
      body: "Fix",
      humanCheck,
    }),
  ).id;
}

describe("planning a suggestion", () => {
  it("binds the plan to the version, the file and the suggestion, and keeps its proofs", async () => {
    const owner = await user("Owner");
    const reader = await user("Reader");
    const doc = await publishDoc(owner.id);
    await db()
      .insert(schema.artifactReaders)
      .values({ artifactId: doc.artifactId, email: reader.email });
    const threadId = await suggestionOn(doc, reader.id);
    const as = (userId: string) => ({
      userId,
      artifactId: doc.artifactId,
      now: NOW + 10,
      threadId,
      contentDomain: DOMAIN,
    });
    const owners = value(await planSuggestion(db(), env.ARTIFACTS, as(owner.id)));
    expect(owners.binding).toMatchObject({
      artifactId: doc.artifactId,
      versionId: doc.versionId,
      path: "index.md",
      subject: threadId,
      revision: 1,
    });
    expect(owners.applied[0]?.people).toEqual({ submitter: true, acceptor: true });
    // The reviewer's own confirmation names no acceptor, so it is another plan.
    const readers = value(await planSuggestion(db(), env.ARTIFACTS, as(reader.id)));
    expect(readers.applied[0]?.people).toEqual({ submitter: true, acceptor: false });
    expect(readers.digest).not.toBe(owners.digest);
    const proofs = storedProofs((await thread(threadId)) ?? { editProofs: null });
    expect(proofs?.versionId).toBe(doc.versionId);
    expect(proofs?.operations[0]?.proof.before).toBe("Second");
    const cached = await db()
      .select()
      .from(schema.suggestionPlans)
      .where(eq(schema.suggestionPlans.threadId, threadId));
    expect(cached.map((row) => row.digest).sort()).toEqual([owners.digest, readers.digest].sort());
    expect(cached[0]?.expiresAt).toBe(NOW + 10 + 10 * 60_000);
  });

  it("refuses a decided suggestion, an earlier version and a stranger", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const threadId = await suggestionOn(doc, owner.id);
    const input = {
      userId: owner.id,
      artifactId: doc.artifactId,
      now: NOW + 10,
      threadId,
      contentDomain: DOMAIN,
    };
    expect(
      await planSuggestion(db(), env.ARTIFACTS, { ...input, userId: (await user("Stranger")).id }),
    ).toMatchObject({ ok: false, code: "not_found" });
    await republish(owner.id, doc, `${DOC}\nMore.\n`);
    expect(await planSuggestion(db(), env.ARTIFACTS, input)).toMatchObject({
      ok: false,
      code: "version_conflict",
    });
    const other = await publishDoc(owner.id);
    const decided = await suggestionOn(other, owner.id);
    value(
      await rejectSuggestion(db(), {
        userId: owner.id,
        artifactId: other.artifactId,
        now: NOW + 5,
        threadId: decided,
        revision: 1,
      }),
    );
    expect(
      await planSuggestion(db(), env.ARTIFACTS, {
        ...input,
        artifactId: other.artifactId,
        threadId: decided,
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("limits plans per person and per artifact", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const threadId = await suggestionOn(doc, owner.id);
    const input = {
      userId: owner.id,
      artifactId: doc.artifactId,
      now: NOW + 10,
      threadId,
      contentDomain: DOMAIN,
    };
    await db()
      .insert(schema.rateLimits)
      .values({
        key: `suggestion_plan:user:${owner.id}`,
        windowStart: NOW,
        count: SUGGESTION_LIMITS.plansPerPerson,
      });
    expect(await planSuggestion(db(), env.ARTIFACTS, input)).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
    const other = await user("Other");
    const second = await publishDoc(other.id);
    const otherThread = await suggestionOn(second, other.id);
    await db()
      .insert(schema.rateLimits)
      .values({
        key: `suggestion_plan:artifact:${second.artifactId}`,
        windowStart: NOW,
        count: SUGGESTION_LIMITS.plansPerArtifact,
      });
    expect(
      await planSuggestion(db(), env.ARTIFACTS, {
        ...input,
        userId: other.id,
        artifactId: second.artifactId,
        threadId: otherThread,
      }),
    ).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("lists everything on a page that is not UTF-8, and keeps a byte order mark it applies to", async () => {
    const owner = await user("Owner");
    const broken = await publishVersion(owner.id, {
      "index.html": { body: new Uint8Array([...new TextEncoder().encode(PAGE), 0xff]) },
    });
    await db()
      .update(schema.artifacts)
      .set({ annotations: "open" })
      .where(eq(schema.artifacts.id, broken.artifactId));
    const threadId = await suggestionOn(
      { ...broken, type: "site", path: "index.html" },
      owner.id,
      textOp(SITE, PAGE, "Second", "Next"),
    );
    const plan = value(
      await planSuggestion(db(), env.ARTIFACTS, {
        userId: owner.id,
        artifactId: broken.artifactId,
        now: NOW + 10,
        threadId,
        contentDomain: DOMAIN,
      }),
    );
    expect(plan.applied).toEqual([]);
    expect(plan.listed.map((item) => item.reason)).toEqual(["not_eligible"]);

    const withBom = await publishDoc(owner.id, { type: "site", body: `﻿${PAGE}` });
    const bomThread = await suggestionOn(withBom, owner.id, textOp(SITE, PAGE, "Second", "Next"));
    const bomPlan = value(
      await planSuggestion(db(), env.ARTIFACTS, {
        userId: owner.id,
        artifactId: withBom.artifactId,
        now: NOW + 10,
        threadId: bomThread,
        contentDomain: DOMAIN,
      }),
    );
    expect(bomPlan.applied).toHaveLength(1);
    const { acceptSuggestion } = await import("../src/suggestion-accept.ts");
    value(
      await acceptSuggestion(db(), env.ARTIFACTS, {
        userId: owner.id,
        artifactId: withBom.artifactId,
        now: NOW + 10,
        threadId: bomThread,
        digest: bomPlan.digest,
        contentDomain: DOMAIN,
      }),
    );
    await runJobs("suggestion_accept", withBom.artifactId);
    expect(await currentText(withBom.artifactId, "index.html")).toBe(
      `﻿${PAGE.replace("Second", "Next")}`,
    );
  });
});

/** Writes a person's draft directly, as the draft services of a later delivery will. */
async function draftOf(
  doc: Doc,
  userId: string,
  operations = [textOp(MD, DOC, "Second", "Next")],
  updatedAt = NOW,
) {
  const edit = JSON.stringify({ operations });
  await db()
    .insert(schema.editDrafts)
    .values({
      artifactId: doc.artifactId,
      userId,
      ownerId:
        (
          await db()
            .select({ ownerId: schema.artifacts.ownerId })
            .from(schema.artifacts)
            .where(eq(schema.artifacts.id, doc.artifactId))
        )[0]?.ownerId ?? userId,
      baseVersionId: doc.versionId,
      edit,
      editBytes: new TextEncoder().encode(edit).length,
      updatedAt,
    });
}

async function draftRow(doc: Doc, userId: string) {
  const [row] = await db()
    .select()
    .from(schema.editDrafts)
    .where(
      and(eq(schema.editDrafts.artifactId, doc.artifactId), eq(schema.editDrafts.userId, userId)),
    );
  return row;
}

describe("publishing a draft", () => {
  it("publishes what applies, lists the rest, and deletes the draft", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    await draftOf(doc, owner.id, [
      textOp(MD, DOC, "Second", "Next"),
      textOp(MD, DOC, "A linked", "One linked"),
    ]);
    const input = {
      userId: owner.id,
      artifactId: doc.artifactId,
      now: NOW + 10,
      contentDomain: DOMAIN,
    };
    const plan = value(await planDraft(db(), env.ARTIFACTS, input));
    expect(plan.binding.subject).toBe(`draft:${owner.id}`);
    value(await publishDraft(db(), env.ARTIFACTS, { ...input, digest: plan.digest }));
    expect((await draftRow(doc, owner.id))?.attemptId).not.toBeNull();
    expect(
      await publishDraft(db(), env.ARTIFACTS, { ...input, digest: plan.digest }),
    ).toMatchObject({
      ok: false,
      code: "version_conflict",
    });
    expect(await runJobs("draft_publish", doc.artifactId)).toEqual(["done"]);
    expect(await draftRow(doc, owner.id)).toBeUndefined();
    expect(await currentText(doc.artifactId, "index.md")).toBe(DOC.replace("Second", "Next"));
    const [item] = await items(doc.artifactId);
    expect(item).toMatchObject({
      origin: "draft",
      threadId: null,
      submittedBy: owner.id,
      createdBy: owner.id,
    });
    expect(await auditKinds(doc.artifactId)).toEqual(
      expect.arrayContaining(["suggestion.accepted"]),
    );
    expect((await attempts(doc.artifactId))[0]).toMatchObject({ origin: "draft", state: "done" });
  });

  it("answers another person's draft as missing, and refuses one whose base is not current", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    await draftOf(doc, owner.id);
    const reader = await user("Reader");
    await db()
      .insert(schema.artifactReaders)
      .values({ artifactId: doc.artifactId, email: reader.email });
    expect(
      await planDraft(db(), env.ARTIFACTS, {
        userId: reader.id,
        artifactId: doc.artifactId,
        now: NOW,
        contentDomain: DOMAIN,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
    const input = {
      userId: owner.id,
      artifactId: doc.artifactId,
      now: NOW + 10,
      contentDomain: DOMAIN,
    };
    const plan = value(await planDraft(db(), env.ARTIFACTS, input));
    await republish(owner.id, doc, `${DOC}\nMore.\n`);
    expect(await planDraft(db(), env.ARTIFACTS, input)).toMatchObject({
      ok: false,
      code: "version_conflict",
    });
    expect(
      await publishDraft(db(), env.ARTIFACTS, { ...input, digest: plan.digest }),
    ).toMatchObject({
      ok: false,
      code: "version_conflict",
    });
  });

  it("ends a draft publish whose draft changed meanwhile, keeping the draft", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    await draftOf(doc, owner.id, [textOp(MD, DOC, "A linked", "One linked")]);
    const input = {
      userId: owner.id,
      artifactId: doc.artifactId,
      now: NOW + 10,
      contentDomain: DOMAIN,
    };
    const plan = value(await planDraft(db(), env.ARTIFACTS, input));
    value(await publishDraft(db(), env.ARTIFACTS, { ...input, digest: plan.digest }));
    await db()
      .update(schema.editDrafts)
      .set({ attemptId: null })
      .where(eq(schema.editDrafts.artifactId, doc.artifactId));
    await runJobs("draft_publish", doc.artifactId);
    expect((await attempts(doc.artifactId))[0]).toMatchObject({
      state: "ended",
      reason: "revoked",
    });
    expect(await draftRow(doc, owner.id)).toBeDefined();
    expect(await items(doc.artifactId)).toEqual([]);
  });
});

describe("the suggestion scans", () => {
  it("deletes expired plans, finished attempts, closed items and unused drafts, except a held artifact's", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const held = await publishDoc(owner.id);
    for (const d of [doc, held]) {
      await draftOf(d, owner.id, undefined, NOW - DRAFT_LIMITS.unusedDays * DAY - 1);
      await db()
        .insert(schema.changeItems)
        .values({
          id: `old_${d.artifactId}`,
          artifactId: d.artifactId,
          ownerId: owner.id,
          origin: "draft",
          versionId: d.versionId,
          path: "index.md",
          envelope: '{"format":1}',
          bytes: 12,
          reason: "not_text",
          state: "dismissed",
          closedAt: NOW - 91 * DAY,
          closedBy: owner.id,
        });
      await db()
        .insert(schema.acceptanceAttempts)
        .values({
          id: `att_old_${d.artifactId}`,
          artifactId: d.artifactId,
          ownerId: owner.id,
          origin: "draft",
          userId: owner.id,
          digest: "a".repeat(64),
          baseVersionId: d.versionId,
          state: "ended",
          reason: "failed",
          createdAt: NOW - SUGGESTION_LIMITS.attemptRetentionMs - 1,
          updatedAt: NOW,
        });
    }
    await db()
      .insert(schema.suggestionPlans)
      .values({
        userId: owner.id,
        digest: "b".repeat(64),
        artifactId: doc.artifactId,
        plan: "{}",
        createdAt: NOW - 20 * 60_000,
        expiresAt: NOW - 1,
      });
    value(await suspendArtifact(db(), { artifactId: held.artifactId, reason: "spam", now: NOW }));
    value(
      await placeLegalHold(db(), {
        artifactId: held.artifactId,
        ground: "order",
        releaseAt: null,
        now: NOW,
      }),
    );
    const pruned = await pruneSuggestionRecords(db(), NOW);
    expect(pruned.plans).toBeGreaterThanOrEqual(1);
    expect(await draftRow(doc, owner.id)).toBeUndefined();
    expect(await items(doc.artifactId)).toEqual([]);
    expect(await attempts(doc.artifactId)).toEqual([]);
    expect(await draftRow(held, owner.id)).toBeDefined();
    expect(await items(held.artifactId)).toHaveLength(1);
    expect(await attempts(held.artifactId)).toHaveLength(1);
  });

  it("keeps what is still within its time", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    await draftOf(doc, owner.id, undefined, NOW - DRAFT_LIMITS.unusedDays * DAY + 1);
    await pruneSuggestionRecords(db(), NOW);
    expect(await draftRow(doc, owner.id)).toBeDefined();
  });

  it("deletes the drafts of people who no longer act for the owner", async () => {
    const team = await workspace(() => user("Member"));
    const doc = await publishDoc(team.admin.id, { ownerId: team.id });
    await draftOf(doc, team.editor.id);
    await draftOf(doc, team.admin.id);
    const personal = await publishDoc(team.outsider.id);
    // A draft of someone who is not the space's own account (left after a transfer back).
    await draftOf(personal, team.member.id);
    await db()
      .update(schema.workspaceMembers)
      .set({ role: "member" })
      .where(
        and(
          eq(schema.workspaceMembers.workspaceId, team.id),
          eq(schema.workspaceMembers.userId, team.editor.id),
        ),
      );
    for (let i = 0; i < 20; i++) {
      await pruneDraftsWithoutRole(db(), NOW + i);
      if (!(await draftRow(doc, team.editor.id)) && !(await draftRow(personal, team.member.id)))
        break;
    }
    expect(await draftRow(doc, team.editor.id)).toBeUndefined();
    expect(await draftRow(personal, team.member.id)).toBeUndefined();
    expect(await draftRow(doc, team.admin.id)).toBeDefined();
  });

  it("resumes the drafts scan from its cursor", async () => {
    const owner = await user("Owner");
    const docs = [
      await publishDoc(owner.id),
      await publishDoc(owner.id),
      await publishDoc(owner.id),
    ];
    const stranger = await user("Stranger");
    for (const doc of docs) await draftOf(doc, stranger.id);
    for (let i = 0; i < 50; i++) {
      await pruneDraftsWithoutRole(db(), NOW + i, { pageSize: 1, maxPages: 1 });
      const left = await Promise.all(docs.map((doc) => draftRow(doc, stranger.id)));
      if (left.every((row) => row === undefined)) break;
    }
    expect(await Promise.all(docs.map((doc) => draftRow(doc, stranger.id)))).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
});
