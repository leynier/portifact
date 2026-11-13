// The guards inside the suggestion batches (review of pull request #262, finding 10): each test
// changes the state the batch is held to right before the batch runs (`raceBeforeBatchWith`, not
// `Promise.all`: see docs/testing.md), and asserts the losing request leaves no state change, no
// item, no audit event and no disclosure. The mutation each test kills is named in its title.
import { env } from "cloudflare:test";
import { schema } from "@portifact/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createAnnotationThread, deleteAnnotationThread } from "../src/annotations.ts";
import { markChangeItem } from "../src/change-list.ts";
import { runJob } from "../src/outbox.ts";
import { acceptSuggestion, publishDraft } from "../src/suggestion-accept.ts";
import { planDraft, planSuggestion } from "../src/suggestion-plans.ts";
import { rejectSuggestion, submitSuggestion, withdrawSuggestion } from "../src/suggestions.ts";
import { transferArtifact } from "../src/transfer.ts";
import { createWorkspace } from "../src/workspaces.ts";
import { db, grantPlan, NOW, user, value } from "./fixtures.ts";
import { raceBeforeBatchWith } from "./race.ts";
import {
  attempts,
  DOC,
  DOMAIN,
  type Doc,
  humanCheck,
  items,
  JOB_DEPS,
  jobsOf,
  publishDoc,
  republish,
  runJobs,
  textOp,
  thread,
} from "./suggestion-support.ts";

const MD = { type: "markdown" as const, path: "index.md" };
const LONGER = DOC.replace("First paragraph.", "First paragraph, now much longer.");

async function auditOf(artifactId: string, kind: string) {
  return db()
    .select()
    .from(schema.auditEvents)
    .where(
      and(
        eq(schema.auditEvents.artifactId, artifactId),
        eq(schema.auditEvents.kind, kind as never),
      ),
    );
}

async function suggest(doc: Doc, userId: string, listed = false) {
  return value(
    await submitSuggestion(db(), {
      userId,
      artifactId: doc.artifactId,
      now: NOW,
      versionId: doc.versionId,
      edit: {
        operations: [
          textOp(MD, DOC, listed ? "A linked" : "Second", listed ? "One linked" : "Next"),
        ],
      },
      body: "Fix",
      humanCheck,
    }),
  ).id;
}

const planOf = (userId: string, doc: Doc, threadId: string) =>
  planSuggestion(db(), env.ARTIFACTS, {
    userId,
    artifactId: doc.artifactId,
    now: NOW + 10,
    threadId,
    contentDomain: DOMAIN,
  });

/**
 * An artifact of workspace W1 managed by an editor of W1 only, and an admin of W1 and W2 who can
 * move it to W2, where the editor has no role.
 */
async function movable(listed = false) {
  const admin = await user("Admin");
  const editor = await user("Editor");
  const slugs = [`g1-${crypto.randomUUID().slice(0, 8)}`, `g2-${crypto.randomUUID().slice(0, 8)}`];
  const spaces = [] as { id: string }[];
  for (const slug of slugs) {
    const ws = value(
      await createWorkspace(db().global, { slug, name: slug, adminUserId: admin.id, now: NOW }),
    );
    await grantPlan(ws.id, "team", { seats: 10 });
    spaces.push(ws);
  }
  const first = spaces[0] as { id: string };
  await db()
    .insert(schema.workspaceMembers)
    .values({ workspaceId: first.id, userId: editor.id, role: "editor", updatedAt: NOW });
  const doc = await publishDoc(editor.id, { ownerId: first.id });
  const threadId = await suggest(doc, editor.id, listed);
  const plan = value(await planOf(editor.id, doc, threadId));
  const move = async () => {
    value(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: admin.id,
        artifactId: doc.artifactId,
        workspace: slugs[1] as string,
        now: NOW + 50,
      }),
    );
  };
  return { admin, editor, doc, threadId, plan, move };
}

describe("owner predicates", () => {
  it("M23: an acceptance cannot start on an artifact moved to another owner before its batch", async () => {
    const m = await movable();
    const raced = raceBeforeBatchWith(/insert into "acceptance_attempts"/i, m.move);
    const result = await acceptSuggestion(raced, env.ARTIFACTS, {
      userId: m.editor.id,
      artifactId: m.doc.artifactId,
      now: NOW + 60,
      threadId: m.threadId,
      digest: m.plan.digest,
      contentDomain: DOMAIN,
    });
    expect(result.ok).toBe(false);
    expect(await attempts(m.doc.artifactId)).toEqual([]);
    expect((await thread(m.threadId))?.suggestionState).toBe("pending");
  });

  it("M24: an acceptance's claim loses to a move before it, leaving no item", async () => {
    const m = await movable(true);
    value(
      await acceptSuggestion(db(), env.ARTIFACTS, {
        userId: m.editor.id,
        artifactId: m.doc.artifactId,
        now: NOW + 20,
        threadId: m.threadId,
        digest: m.plan.digest,
        contentDomain: DOMAIN,
      }),
    );
    const raced = raceBeforeBatchWith(/insert into "acceptance_claims"/i, m.move);
    await runJobs("suggestion_accept", m.doc.artifactId, NOW + 2_000, raced);
    expect(await items(m.doc.artifactId)).toEqual([]);
    expect((await thread(m.threadId))?.suggestionState).toBe("pending");
    expect(await auditOf(m.doc.artifactId, "suggestion.accepted")).toEqual([]);
  });

  it("M01: marking loses to a move before its batch, with no envelope or audit event", async () => {
    const m = await movable(true);
    value(
      await acceptSuggestion(db(), env.ARTIFACTS, {
        userId: m.editor.id,
        artifactId: m.doc.artifactId,
        now: NOW + 20,
        threadId: m.threadId,
        digest: m.plan.digest,
        contentDomain: DOMAIN,
      }),
    );
    await runJobs("suggestion_accept", m.doc.artifactId);
    const [item] = await items(m.doc.artifactId);
    const raced = raceBeforeBatchWith(/update "change_items"/i, m.move);
    const result = await markChangeItem(raced, {
      userId: m.editor.id,
      artifactId: m.doc.artifactId,
      now: NOW + 3_000,
      itemId: item?.id ?? "",
      state: "applied",
      baseRevision: item?.revision ?? 0,
    });
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("value");
    expect((await items(m.doc.artifactId))[0]?.state).toBe("open");
    expect(await auditOf(m.doc.artifactId, "change_item.marked")).toEqual([]);
  });
});

describe("live artifact predicates", () => {
  const archive = (artifactId: string) => async () => {
    await db()
      .update(schema.artifacts)
      .set({ state: "archived", archivedAt: NOW })
      .where(eq(schema.artifacts.id, artifactId));
  };

  it("M13: a suggestion is not created on an artifact archived before its batch", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const raced = raceBeforeBatchWith(/insert into "annotation_events"/i, archive(doc.artifactId));
    const result = await submitSuggestion(raced, {
      userId: owner.id,
      artifactId: doc.artifactId,
      now: NOW,
      versionId: doc.versionId,
      edit: { operations: [textOp(MD, DOC, "Second", "Next")] },
      body: "Fix",
      humanCheck,
    });
    expect(result.ok).toBe(false);
    expect(
      await db()
        .select()
        .from(schema.annotationThreads)
        .where(eq(schema.annotationThreads.artifactId, doc.artifactId)),
    ).toEqual([]);
  });

  it("M14: a suggestion is not created on a version replaced before its batch", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const raced = raceBeforeBatchWith(/insert into "annotation_events"/i, async () => {
      await republish(owner.id, doc, LONGER);
    });
    const result = await submitSuggestion(raced, {
      userId: owner.id,
      artifactId: doc.artifactId,
      now: NOW,
      versionId: doc.versionId,
      edit: { operations: [textOp(MD, DOC, "Second", "Next")] },
      body: "Fix",
      humanCheck,
    });
    expect(result).toMatchObject({ ok: false, code: "version_conflict" });
    expect(
      await db()
        .select()
        .from(schema.annotationThreads)
        .where(eq(schema.annotationThreads.artifactId, doc.artifactId)),
    ).toEqual([]);
  });

  it("M16: a rejection loses to an archive before its batch, with no audit event", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const threadId = await suggest(doc, owner.id);
    const raced = raceBeforeBatchWith(/update "annotation_threads"/i, archive(doc.artifactId));
    const result = await rejectSuggestion(raced, {
      userId: owner.id,
      artifactId: doc.artifactId,
      now: NOW + 10,
      threadId,
      revision: 1,
    });
    expect(result.ok).toBe(false);
    expect((await thread(threadId))?.suggestionState).toBe("pending");
    expect(await auditOf(doc.artifactId, "suggestion.rejected")).toEqual([]);
  });

  it("M27: an acceptance job ends as revoked on an archived artifact", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const threadId = await suggest(doc, owner.id, true);
    const plan = value(await planOf(owner.id, doc, threadId));
    value(
      await acceptSuggestion(db(), env.ARTIFACTS, {
        userId: owner.id,
        artifactId: doc.artifactId,
        now: NOW + 20,
        threadId,
        digest: plan.digest,
        contentDomain: DOMAIN,
      }),
    );
    await archive(doc.artifactId)();
    await runJobs("suggestion_accept", doc.artifactId);
    expect(await thread(threadId)).toMatchObject({
      suggestionState: "pending",
      attemptReason: "revoked",
    });
    expect(await jobsOf("suggestion_carry", doc.artifactId)).toEqual([]);
    expect(await items(doc.artifactId)).toEqual([]);
  });
});

describe("subject and state predicates", () => {
  it("M26: a claim loses to the thread's deletion before it, leaving no item", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const threadId = await suggest(doc, owner.id, true);
    const plan = value(await planOf(owner.id, doc, threadId));
    value(
      await acceptSuggestion(db(), env.ARTIFACTS, {
        userId: owner.id,
        artifactId: doc.artifactId,
        now: NOW + 20,
        threadId,
        digest: plan.digest,
        contentDomain: DOMAIN,
      }),
    );
    const raced = raceBeforeBatchWith(/insert into "acceptance_claims"/i, async () => {
      value(
        await deleteAnnotationThread(db(), {
          userId: owner.id,
          artifactId: doc.artifactId,
          now: NOW + 30,
          threadId,
        }),
      );
    });
    const [job] = await jobsOf("suggestion_accept", doc.artifactId);
    expect(
      await runJob(
        raced,
        env.ARTIFACTS,
        { id: job?.id ?? 0, topic: "suggestion_accept" },
        NOW + 2_000,
        JOB_DEPS,
      ),
    ).toBe("done");
    expect(await items(doc.artifactId)).toEqual([]);
    expect((await attempts(doc.artifactId))[0]?.state).toBe("ended");
  });

  it("M26: a draft publish's claim loses to the draft's discard before it", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const edit = JSON.stringify({ operations: [textOp(MD, DOC, "A linked", "One linked")] });
    await db().insert(schema.editDrafts).values({
      artifactId: doc.artifactId,
      userId: owner.id,
      ownerId: owner.id,
      baseVersionId: doc.versionId,
      edit,
      editBytes: edit.length,
      updatedAt: NOW,
    });
    const input = {
      userId: owner.id,
      artifactId: doc.artifactId,
      now: NOW + 10,
      contentDomain: DOMAIN,
    };
    const plan = value(await planDraft(db(), env.ARTIFACTS, input));
    value(await publishDraft(db(), env.ARTIFACTS, { ...input, digest: plan.digest }));
    const raced = raceBeforeBatchWith(/insert into "acceptance_claims"/i, async () => {
      await db().delete(schema.editDrafts).where(eq(schema.editDrafts.artifactId, doc.artifactId));
    });
    await runJobs("draft_publish", doc.artifactId, NOW + 2_000, raced);
    expect(await items(doc.artifactId)).toEqual([]);
    expect(await auditOf(doc.artifactId, "suggestion.accepted")).toEqual([]);
  });

  it("M17: a rejection loses to an acceptance that started before its batch", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const threadId = await suggest(doc, owner.id);
    const plan = value(await planOf(owner.id, doc, threadId));
    const raced = raceBeforeBatchWith(/update "annotation_threads"/i, async () => {
      value(
        await acceptSuggestion(db(), env.ARTIFACTS, {
          userId: owner.id,
          artifactId: doc.artifactId,
          now: NOW + 20,
          threadId,
          digest: plan.digest,
          contentDomain: DOMAIN,
        }),
      );
    });
    expect(
      await rejectSuggestion(raced, {
        userId: owner.id,
        artifactId: doc.artifactId,
        now: NOW + 30,
        threadId,
        revision: 1,
      }),
    ).toMatchObject({ ok: false, code: "version_conflict" });
    expect((await thread(threadId))?.suggestionState).toBe("applying");
    expect(await auditOf(doc.artifactId, "suggestion.rejected")).toEqual([]);
  });

  it("M18: a withdrawal loses to a carry that moved the suggestion before its batch", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const threadId = await suggest(doc, owner.id);
    value(await planOf(owner.id, doc, threadId));
    const raced = raceBeforeBatchWith(/update "annotation_threads"/i, async () => {
      await republish(owner.id, doc, LONGER);
      await runJobs("suggestion_carry", doc.artifactId);
    });
    expect(
      await withdrawSuggestion(raced, {
        userId: owner.id,
        artifactId: doc.artifactId,
        now: NOW + 30,
        threadId,
        revision: 1,
      }),
    ).toMatchObject({ ok: false, code: "version_conflict" });
    expect(await thread(threadId)).toMatchObject({
      suggestionState: "pending",
      suggestionRevision: 2,
    });
    expect(await auditOf(doc.artifactId, "suggestion.withdrawn")).toEqual([]);
  });

  it("M11: a carry's writes lose to a publish that replaced its version before them", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const threadId = await suggest(doc, owner.id);
    value(await planOf(owner.id, doc, threadId));
    const second = await republish(owner.id, doc, LONGER);
    const [job] = await jobsOf("suggestion_carry", doc.artifactId);
    const raced = raceBeforeBatchWith(/update "annotation_threads"/i, async () => {
      await republish(owner.id, second, LONGER.replace("much", "far"), NOW + 1_500);
    });
    await runJob(
      raced,
      env.ARTIFACTS,
      { id: job?.id ?? 0, topic: "suggestion_carry" },
      NOW + 2_000,
      JOB_DEPS,
    );
    expect(await thread(threadId)).toMatchObject({
      versionId: doc.versionId,
      suggestionRevision: 1,
    });
  });

  it("M12: a closure loses to an item marked and reopened before its batch", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id, {
      type: "site",
      body: "<!doctype html><html><head><title>t</title></head><body><p>Second paragraph here.</p><script>1</script></body></html>",
    });
    const page =
      "<!doctype html><html><head><title>t</title></head><body><p>Second paragraph here.</p><script>1</script></body></html>";
    const view = value(
      await submitSuggestion(db(), {
        userId: owner.id,
        artifactId: doc.artifactId,
        now: NOW,
        versionId: doc.versionId,
        edit: {
          operations: [textOp({ type: "site", path: "index.html" }, page, "Second", "Next")],
        },
        body: "Fix",
        humanCheck,
      }),
    );
    const plan = value(await planOf(owner.id, doc, view.id));
    value(
      await acceptSuggestion(db(), env.ARTIFACTS, {
        userId: owner.id,
        artifactId: doc.artifactId,
        now: NOW + 20,
        threadId: view.id,
        digest: plan.digest,
        contentDomain: DOMAIN,
      }),
    );
    await runJobs("suggestion_accept", doc.artifactId);
    const [item] = await items(doc.artifactId);
    await republish(owner.id, doc, page.replace("Second", "Next"), NOW + 1_000);
    const raced = raceBeforeBatchWith(/update "change_items"/i, async () => {
      const input = {
        userId: owner.id,
        artifactId: doc.artifactId,
        now: NOW + 1_200,
        itemId: item?.id ?? "",
      };
      value(await markChangeItem(db(), { ...input, state: "applied", baseRevision: 1 }));
      value(await markChangeItem(db(), { ...input, state: "open", baseRevision: 2 }));
    });
    const [job] = await jobsOf("change_list_check", doc.artifactId);
    await runJob(
      raced,
      env.ARTIFACTS,
      { id: job?.id ?? 0, topic: "change_list_check" },
      NOW + 2_000,
      JOB_DEPS,
    );
    expect((await items(doc.artifactId))[0]).toMatchObject({ state: "open", revision: 3 });
  });
});

describe("authorization on reads that write", () => {
  it("M20: a reader cannot plan a suggestion outside their comment scope", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const [a, b] = [await user("A"), await user("B")];
    for (const reader of [a, b]) {
      await db()
        .insert(schema.artifactReaders)
        .values({ artifactId: doc.artifactId, email: reader.email });
    }
    const threadId = value(
      await submitSuggestion(db(), {
        userId: a.id,
        artifactId: doc.artifactId,
        now: NOW,
        versionId: doc.versionId,
        edit: { operations: [textOp(MD, DOC, "Second", "Private")] },
        body: "Fix",
        humanCheck: { token: "t", verify: async () => "passed" },
      }),
    ).id;
    expect(await planOf(b.id, doc, threadId)).toMatchObject({ ok: false, code: "not_found" });
    expect(
      await db()
        .select()
        .from(schema.suggestionPlans)
        .where(eq(schema.suggestionPlans.userId, b.id)),
    ).toEqual([]);
  });

  it("M21: a reader's draft row is no draft: planning it answers as missing", async () => {
    const owner = await user("Owner");
    const reader = await user("Reader");
    const doc = await publishDoc(owner.id);
    await db()
      .insert(schema.artifactReaders)
      .values({ artifactId: doc.artifactId, email: reader.email });
    const edit = JSON.stringify({ operations: [textOp(MD, DOC, "Second", "Next")] });
    await db().insert(schema.editDrafts).values({
      artifactId: doc.artifactId,
      userId: reader.id,
      ownerId: owner.id,
      baseVersionId: doc.versionId,
      edit,
      editBytes: edit.length,
      updatedAt: NOW,
    });
    expect(
      await planDraft(db(), env.ARTIFACTS, {
        userId: reader.id,
        artifactId: doc.artifactId,
        now: NOW,
        contentDomain: DOMAIN,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
  });

  it("a comment thread is not accepted, planned or decided", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const comment = value(
      await createAnnotationThread(db(), {
        userId: owner.id,
        artifactId: doc.artifactId,
        now: NOW,
        versionId: doc.versionId,
        target: textOp(MD, DOC, "First", "x").target,
        body: "c",
        humanCheck,
      }),
    );
    expect(await planOf(owner.id, doc, comment.id)).toMatchObject({ ok: false, code: "not_found" });
  });
});
