// The edges of the suggestion services (decision 0027): stored data a planner cannot read, jobs
// that find their subject changed, bounded runs that continue in the next job, and refusals on
// the less common paths.
import { env } from "cloudflare:test";
import { schema } from "@portifact/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { deleteAnnotationThread } from "../src/annotations.ts";
import { listChangeItems, markChangeItem } from "../src/change-list.ts";
import { runJob } from "../src/outbox.ts";
import { acceptSuggestion, publishDraft } from "../src/suggestion-accept.ts";
import { planDraft, planSuggestion } from "../src/suggestion-plans.ts";
import { runChangeListCheck, runSuggestionCarry } from "../src/suggestion-versions.ts";
import { getSuggestion, rejectSuggestion, submitSuggestion } from "../src/suggestions.ts";
import { db, NOW, user, value } from "./fixtures.ts";
import { raceBeforeFirstWrite, raceBeforeStatement } from "./race.ts";
import {
  artifactOf,
  attempts,
  currentText,
  DOC,
  DOMAIN,
  type Doc,
  humanCheck,
  JOB_DEPS,
  jobsOf,
  PAGE,
  publishDoc,
  republish,
  runJobs,
  textOp,
  thread,
} from "./suggestion-support.ts";
import { publishVersion } from "./version-support.ts";

const MD = { type: "markdown" as const, path: "index.md" };
const LONGER = DOC.replace("First paragraph.", "First paragraph, now much longer than before.");

async function pending(doc: Doc, userId: string, operation = textOp(MD, DOC, "Second", "Next")) {
  return value(
    await submitSuggestion(db(), {
      userId,
      artifactId: doc.artifactId,
      now: NOW,
      versionId: doc.versionId,
      edit: { operations: [operation] },
      body: "Fix",
      humanCheck,
    }),
  ).id;
}

const planned = (userId: string, doc: Doc, threadId: string, now = NOW + 10) =>
  planSuggestion(db(), env.ARTIFACTS, {
    userId,
    artifactId: doc.artifactId,
    now,
    threadId,
    contentDomain: DOMAIN,
  });

async function accepted(owner: { id: string }, doc: Doc, threadId: string) {
  const plan = value(await planned(owner.id, doc, threadId));
  value(
    await acceptSuggestion(db(), env.ARTIFACTS, {
      userId: owner.id,
      artifactId: doc.artifactId,
      now: NOW + 10,
      threadId,
      digest: plan.digest,
      contentDomain: DOMAIN,
    }),
  );
  return plan;
}

async function renderedKey(versionId: string, kind: "rendered" | "published") {
  const [row] = await db()
    .select({ r2Key: schema.objects.r2Key })
    .from(schema.versionFiles)
    .innerJoin(
      schema.objects,
      and(
        eq(schema.objects.ownerId, schema.versionFiles.ownerId),
        eq(schema.objects.sha256, schema.versionFiles.sha256),
      ),
    )
    .where(and(eq(schema.versionFiles.versionId, versionId), eq(schema.versionFiles.kind, kind)));
  return row?.r2Key ?? "";
}

describe("stored data a plan cannot use", () => {
  it("lists everything when the stored rendering is missing, and refuses a missing file", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const threadId = await pending(doc, owner.id);
    await env.ARTIFACTS.delete(await renderedKey(doc.versionId, "rendered"));
    const plan = value(await planned(owner.id, doc, threadId));
    expect(plan.listed.map((item) => item.reason)).toEqual(["renderer_changed"]);
    await env.ARTIFACTS.delete(await renderedKey(doc.versionId, "published"));
    expect(await planned(owner.id, doc, threadId, NOW + 20)).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("reads a suggestion whose stored edit or proofs cannot be read", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const threadId = await pending(doc, owner.id);
    await db()
      .update(schema.annotationThreads)
      .set({ editProofs: "{not json" })
      .where(eq(schema.annotationThreads.id, threadId));
    const view = value(
      await getSuggestion(db(), {
        userId: owner.id,
        artifactId: doc.artifactId,
        now: NOW,
        threadId,
      }),
    );
    expect(view.planned).toBe(false);
    // A pending suggestion whose stored edit no longer parses (an older format) holds no edit.
    const odd = crypto.randomUUID();
    const edit = '{"operations":[]}';
    await db().insert(schema.annotationThreads).values({
      id: odd,
      artifactId: doc.artifactId,
      versionId: doc.versionId,
      ownerId: owner.id,
      authorId: owner.id,
      target: "{}",
      targetBytes: 2,
      path: "index.md",
      updatedAt: NOW,
      kind: "suggestion",
      suggestionState: "pending",
      edit,
      editBytes: edit.length,
      suggestionRevision: 1,
    });
    const input = { userId: owner.id, artifactId: doc.artifactId, now: NOW, threadId: odd };
    expect(value(await getSuggestion(db(), input)).edit).toBeNull();
    expect(await planned(owner.id, doc, odd)).toMatchObject({ ok: false, code: "invalid_input" });
    await republish(owner.id, doc, LONGER);
    await runJobs("suggestion_carry", doc.artifactId);
    expect(await thread(odd)).toMatchObject({ suggestionState: "outdated" });
  });

  it("refuses an edit over the owner's annotation quota", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    await db()
      .insert(schema.annotationUsage)
      .values({ ownerId: owner.id, messages: 0, bytes: 0 })
      .onConflictDoNothing();
    await db()
      .update(schema.annotationUsage)
      .set({ bytesLimit: 10 })
      .where(eq(schema.annotationUsage.ownerId, owner.id));
    expect(
      await submitSuggestion(db(), {
        userId: owner.id,
        artifactId: doc.artifactId,
        now: NOW,
        versionId: doc.versionId,
        edit: { operations: [textOp(MD, DOC, "Second", "Next")] },
        body: "Fix",
        humanCheck,
      }),
    ).toMatchObject({ ok: false, code: "quota_exceeded" });
  });

  it("answers decisions and plans on a comment thread as no suggestion", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const { createAnnotationThread } = await import("../src/annotations.ts");
    const comment = value(
      await createAnnotationThread(db(), {
        userId: owner.id,
        artifactId: doc.artifactId,
        now: NOW,
        versionId: doc.versionId,
        target: textOp(MD, DOC, "First", "x").target,
        body: "A comment",
        humanCheck,
      }),
    );
    const input = { userId: owner.id, artifactId: doc.artifactId, now: NOW, threadId: comment.id };
    expect(await rejectSuggestion(db(), { ...input, revision: 0 })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await planned(owner.id, doc, comment.id)).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(
      await acceptSuggestion(db(), env.ARTIFACTS, {
        ...input,
        digest: "a".repeat(64),
        contentDomain: DOMAIN,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("jobs that find their subject changed", () => {
  it("ends an attempt whose version moved before the job, and one whose thread is gone", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const threadId = await pending(doc, owner.id);
    await accepted(owner, doc, threadId);
    await republish(owner.id, doc, LONGER);
    await runJobs("suggestion_accept", doc.artifactId);
    expect((await attempts(doc.artifactId))[0]).toMatchObject({
      state: "ended",
      reason: "version_conflict",
    });

    const other = await publishDoc(owner.id);
    const gone = await pending(other, owner.id);
    await accepted(owner, other, gone);
    value(
      await deleteAnnotationThread(db(), {
        userId: owner.id,
        artifactId: other.artifactId,
        now: NOW + 20,
        threadId: gone,
      }),
    );
    await runJobs("suggestion_accept", other.artifactId);
    expect((await attempts(other.artifactId))[0]).toMatchObject({
      state: "ended",
      reason: "revoked",
    });
  });

  it("ends an attempt whose person's account went, and one delivered too often", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const threadId = await pending(doc, owner.id);
    await accepted(owner, doc, threadId);
    await db()
      .update(schema.acceptanceAttempts)
      .set({ userId: null })
      .where(eq(schema.acceptanceAttempts.artifactId, doc.artifactId));
    await runJobs("suggestion_accept", doc.artifactId);
    expect((await attempts(doc.artifactId))[0]).toMatchObject({
      state: "ended",
      reason: "revoked",
    });

    const other = await publishDoc(owner.id);
    const often = await pending(other, owner.id);
    await accepted(owner, other, often);
    await db()
      .update(schema.acceptanceAttempts)
      .set({ deliveries: 3 })
      .where(eq(schema.acceptanceAttempts.artifactId, other.artifactId));
    await runJobs("suggestion_accept", other.artifactId);
    expect((await attempts(other.artifactId))[0]).toMatchObject({
      state: "ended",
      reason: "failed",
    });
  });

  it("ends an attempt whose upload expired, and one whose prepare is refused", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const threadId = await pending(doc, owner.id);
    await accepted(owner, doc, threadId);
    const [attempt] = await attempts(doc.artifactId);
    const key = attempt?.id.slice(4) ?? "";
    // The upload was prepared and then expired before the job ran again.
    const [job] = await jobsOf("suggestion_accept", doc.artifactId);
    const broken = new Proxy(env.ARTIFACTS, {
      get(target, prop) {
        if (prop === "put") return async () => Promise.reject(new Error("crash"));
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await expect(
      runJob(db(), broken, { id: job?.id ?? 0, topic: "suggestion_accept" }, NOW + 2_000, JOB_DEPS),
    ).rejects.toThrow();
    await db()
      .update(schema.uploadSessions)
      .set({ state: "expired" })
      .where(eq(schema.uploadSessions.id, `upl_${key}`));
    await runJobs("suggestion_accept", doc.artifactId);
    expect((await attempts(doc.artifactId))[0]).toMatchObject({ state: "ended", reason: "failed" });

    // Two uploads already open for the account: the prepare is refused as over the limit.
    const other = await publishDoc(owner.id);
    const refused = await pending(other, owner.id);
    await accepted(owner, other, refused);
    await db()
      .update(schema.accountUsage)
      .set({ openUploads: 2 })
      .where(eq(schema.accountUsage.ownerId, owner.id));
    await runJobs("suggestion_accept", other.artifactId);
    await db()
      .update(schema.accountUsage)
      .set({ openUploads: 0 })
      .where(eq(schema.accountUsage.ownerId, owner.id));
    expect((await attempts(other.artifactId))[0]).toMatchObject({
      state: "ended",
      reason: "quota_exceeded",
    });
  });

  it("ends the attempt when the rendering at commit is not the one confirmed", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const threadId = await pending(doc, owner.id);
    await accepted(owner, doc, threadId);
    const raced = raceBeforeStatement(/update "acceptance_attempts" set "version_id"/, async () => {
      await db()
        .update(schema.artifacts)
        .set({ name: "Renamed" })
        .where(eq(schema.artifacts.id, doc.artifactId));
    });
    const [job] = await jobsOf("suggestion_accept", doc.artifactId);
    await runJob(
      raced,
      env.ARTIFACTS,
      { id: job?.id ?? 0, topic: "suggestion_accept" },
      NOW + 2_000,
      JOB_DEPS,
    );
    expect(await thread(threadId)).toMatchObject({
      suggestionState: "pending",
      attemptReason: "plan_changed",
    });
    expect((await artifactOf(doc.artifactId))?.currentVersionId).toBe(doc.versionId);
  });

  it("writes no new object when the result's bytes are already stored", async () => {
    const owner = await user("Owner");
    const first = await publishDoc(owner.id, { body: DOC.replace("Second", "Next") });
    const doc = await republish(owner.id, first, DOC);
    const threadId = await pending(doc, owner.id);
    await accepted(owner, doc, threadId);
    let puts = 0;
    const counted = new Proxy(env.ARTIFACTS, {
      get(target, prop) {
        if (prop === "put") {
          return (...args: Parameters<R2Bucket["put"]>) => {
            puts++;
            return target.put(...args);
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await runJobs("suggestion_accept", doc.artifactId, NOW + 2_000, db(), counted);
    expect(await currentText(doc.artifactId, "index.md")).toBe(DOC.replace("Second", "Next"));
    // Only the rendering's files, never the source the owner already stores.
    expect(puts).toBe(0);
  });

  it("stales version jobs of an archived artifact or with a malformed payload", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    await pending(doc, owner.id);
    const row = (subject: string | null, payload: unknown) =>
      ({
        id: 0,
        topic: "suggestion_carry",
        payload,
        availableAt: NOW,
        dispatchedAt: null,
        attempts: 0,
        createdAt: NOW,
        subject,
        generation: null,
      }) as const;
    expect(
      await runSuggestionCarry(db(), env.ARTIFACTS, row(doc.artifactId, {}), NOW, DOMAIN),
    ).toBe("stale");
    expect(
      await runSuggestionCarry(
        db(),
        env.ARTIFACTS,
        row(null, { versionId: doc.versionId }),
        NOW,
        DOMAIN,
      ),
    ).toBe("stale");
    await db()
      .update(schema.artifacts)
      .set({ state: "archived", archivedAt: NOW })
      .where(eq(schema.artifacts.id, doc.artifactId));
    expect(
      await runChangeListCheck(
        db(),
        env.ARTIFACTS,
        row(doc.artifactId, { versionId: doc.versionId }),
        NOW,
        DOMAIN,
      ),
    ).toBe("stale");
  });
});

describe("bounded runs", () => {
  it("carries one suggestion per run when bounded, writing the next job", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const a = await pending(doc, owner.id);
    const b = await pending(doc, owner.id, textOp(MD, DOC, "word", "term"));
    value(await planned(owner.id, doc, a));
    value(await planned(owner.id, doc, b, NOW + 11));
    const next = await republish(owner.id, doc, LONGER);
    const [job] = await jobsOf("suggestion_carry", doc.artifactId);
    const row = { ...(job as NonNullable<typeof job>) };
    expect(await runSuggestionCarry(db(), env.ARTIFACTS, row, NOW + 2_000, DOMAIN, 1)).toBe("done");
    expect(await jobsOf("suggestion_carry", doc.artifactId)).toHaveLength(2);
    await db().delete(schema.outbox).where(eq(schema.outbox.id, row.id));
    await runJobs("suggestion_carry", doc.artifactId);
    expect((await thread(a))?.versionId).toBe(next.versionId);
    expect((await thread(b))?.versionId).toBe(next.versionId);
    // Nothing waits any more.
    const [again] = await db()
      .insert(schema.outbox)
      .values({ ...row, id: undefined } as never)
      .returning();
    expect(await runSuggestionCarry(db(), env.ARTIFACTS, again as never, NOW + 3_000, DOMAIN)).toBe(
      "done",
    );
  });

  it("checks items in bounded runs that resume after the last one", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const proof = JSON.stringify({
      unit: "utf16",
      start: 0,
      end: 1,
      before: "x",
      after: "y",
      shownBefore: "x",
      shownAfter: "y",
      nodeLeft: "",
      nodeRight: "",
      identity: [],
    });
    for (const id of ["a", "b"]) {
      await db()
        .insert(schema.changeItems)
        .values({
          id: `${id}_${doc.artifactId}`,
          artifactId: doc.artifactId,
          ownerId: owner.id,
          origin: "draft",
          versionId: doc.versionId,
          path: "index.md",
          envelope: '{"format":1}',
          proof: id === "a" ? "{broken" : proof,
          bytes: 12 + (id === "a" ? 7 : proof.length),
          reason: "spans_nodes",
        });
    }
    await republish(owner.id, doc, LONGER);
    const [job] = await jobsOf("change_list_check", doc.artifactId);
    expect(
      await runChangeListCheck(db(), env.ARTIFACTS, job as never, NOW + 2_000, DOMAIN, 1),
    ).toBe("done");
    const jobs = await jobsOf("change_list_check", doc.artifactId);
    expect(jobs).toHaveLength(2);
    expect((jobs[1]?.payload as { after?: string } | undefined)?.after).toBe(`a_${doc.artifactId}`);
    await db()
      .delete(schema.outbox)
      .where(eq(schema.outbox.id, job?.id ?? 0));
    expect(await runJobs("change_list_check", doc.artifactId)).toEqual(["done"]);
  });

  it("outdates suggestions on a page that is gone or whose site changed around a scripted page", async () => {
    const owner = await user("Owner");
    const scripted = PAGE.replace("</body>", "<script>1</script></body>");
    const site = await publishVersion(owner.id, {
      "index.html": scripted,
      "other.html": PAGE,
      "app.js": { body: "1", contentType: "text/javascript" },
    });
    await db()
      .update(schema.artifacts)
      .set({ annotations: "open" })
      .where(eq(schema.artifacts.id, site.artifactId));
    const doc = { ...site, type: "site" as const, path: "index.html" };
    const onScripted = await pending(
      doc,
      owner.id,
      textOp({ type: "site", path: "index.html" }, scripted, "Second", "Next"),
    );
    const onOther = await pending(
      doc,
      owner.id,
      textOp({ type: "site", path: "other.html" }, PAGE, "Second", "Next"),
    );
    value(await planned(owner.id, doc, onScripted));
    value(await planned(owner.id, doc, onOther, NOW + 11));
    const { publishVersion: next } = await import("./version-support.ts");
    await next(
      owner.id,
      { "index.html": scripted, "app.js": { body: "2", contentType: "text/javascript" } },
      { base: site, now: NOW + 1_000 },
    );
    await runJobs("suggestion_carry", site.artifactId);
    expect(await thread(onScripted)).toMatchObject({ suggestionState: "outdated" });
    expect(await thread(onOther)).toMatchObject({ suggestionState: "outdated" });
  });
});

describe("less common refusals", () => {
  it("refuses a draft publish confirmed with another digest, and one raced by a change", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const edit = JSON.stringify({ operations: [textOp(MD, DOC, "Second", "Next")] });
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
    expect(
      await publishDraft(db(), env.ARTIFACTS, { ...input, digest: "0".repeat(64) }),
    ).toMatchObject({
      ok: false,
      detail: "plan_changed",
    });
    const plan = value(await planDraft(db(), env.ARTIFACTS, input));
    const raced = raceBeforeFirstWrite(async () => {
      await db()
        .update(schema.editDrafts)
        .set({ revision: 2 })
        .where(eq(schema.editDrafts.artifactId, doc.artifactId));
    });
    expect(
      await publishDraft(raced, env.ARTIFACTS, { ...input, digest: plan.digest }),
    ).toMatchObject({
      ok: false,
      code: "version_conflict",
    });
    expect(
      await publishDraft(db(), env.ARTIFACTS, {
        ...input,
        userId: (await user("Other")).id,
        digest: plan.digest,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
  });

  it("filters the change list by state, refuses a malformed cursor and a raced mark", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    for (const state of ["open", "dismissed"] as const) {
      await db()
        .insert(schema.changeItems)
        .values({
          id: `${state}_${doc.artifactId}`,
          artifactId: doc.artifactId,
          ownerId: owner.id,
          origin: "draft",
          versionId: doc.versionId,
          path: "index.md",
          envelope: '{"format":1}',
          bytes: 12,
          reason: "not_text",
          state,
          ...(state === "open" ? {} : { closedAt: NOW, closedBy: owner.id }),
        });
    }
    const input = { userId: owner.id, artifactId: doc.artifactId, now: NOW };
    const open = value(await listChangeItems(db(), { ...input, state: "open", limit: 10 }));
    expect(open.items.map((item) => item.state)).toEqual(["open"]);
    expect(await listChangeItems(db(), { ...input, limit: 10, cursor: btoa("x:") })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    const raced = raceBeforeFirstWrite(async () => {
      await db()
        .update(schema.changeItems)
        .set({ revision: 5 })
        .where(eq(schema.changeItems.id, `open_${doc.artifactId}`));
    });
    expect(
      await markChangeItem(raced, {
        ...input,
        itemId: `open_${doc.artifactId}`,
        state: "applied",
        baseRevision: 1,
      }),
    ).toMatchObject({ ok: false, code: "version_conflict" });
  });
});
