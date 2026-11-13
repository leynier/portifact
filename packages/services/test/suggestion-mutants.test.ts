// What the suggestion services' mutation run found unchecked (decision 0027): the bytes a page
// read admits, where the retention sweeps and the drafts scan resume, when a page outside the
// HTML subset is carried, and the recovery paths of an acceptance job. Each case asserts the
// behavior a reader or an operator sees: rows deleted or kept, cursors stored, bytes admitted,
// attempts ended and uploads released.
import { env } from "cloudflare:test";
import { PLAN_LIMITS, SUGGESTION_LIMITS } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { clearBudgetOverride, setBudgetOverride } from "../src/budget.ts";
import { saveCursor } from "../src/maintenance-cursors.ts";
import { runJob } from "../src/outbox.ts";
import { acceptSuggestion } from "../src/suggestion-accept.ts";
import { pruneDraftsWithoutRole, pruneSuggestionRecords } from "../src/suggestion-maintenance.ts";
import {
  planSuggestion,
  readStoredPage,
  storedFiles,
  storedReadCost,
} from "../src/suggestion-plans.ts";
import { submitSuggestion } from "../src/suggestions.ts";
import { db, NOW, user, value } from "./fixtures.ts";
import {
  artifactOf,
  attempts,
  DOC,
  DOMAIN,
  humanCheck,
  items,
  JOB_DEPS,
  jobsOf,
  PAGE,
  publishDoc,
  textOp,
  thread,
} from "./suggestion-support.ts";
import { publishVersion, workspace } from "./version-support.ts";

/** The value, which the test expects to be there. */
function the<T>(x: T | null | undefined): T {
  if (x === undefined || x === null) throw new Error("missing");
  return x;
}

/** A page outside the HTML subset: it runs a script. */
const SCRIPTED = PAGE.replace("</body>", "<script>1</script></body>");

async function filesOf(doc: { artifactId: string; versionId: string; path: string }) {
  const artifact = the(await artifactOf(doc.artifactId));
  return {
    artifact,
    files: value(
      await storedFiles(db(), {
        artifact,
        versionId: doc.versionId,
        path: doc.path,
        contentDomain: DOMAIN,
      }),
    ),
  };
}

describe("the bytes a stored page read admits", () => {
  it("is the source alone without a baseline, and with one its rendering and block map", async () => {
    const owner = await user("Owner");
    const { files } = await filesOf(await publishDoc(owner.id));
    const source = files.file.size;
    const rendered = the(files.rendered).size;
    const map = the(files.blockMap).size;
    expect(storedReadCost(files, false)).toBe(source);
    expect(storedReadCost(files, true)).toBe(source + rendered + map);
    // A page never reads a baseline, whatever is stored beside it.
    expect(storedReadCost({ ...files, kind: "html" }, true)).toBe(source);
  });

  it("leaves out a rendering over its bound and counts one at it", async () => {
    const owner = await user("Owner");
    const { files } = await filesOf(await publishDoc(owner.id));
    const bound = SUGGESTION_LIMITS.renderingReadBytes;
    const at = { ...files, rendered: { ...the(files.rendered), size: bound } };
    const over = { ...files, rendered: { ...the(files.rendered), size: bound + 1 } };
    const map = the(files.blockMap).size;
    expect(storedReadCost(at, true)).toBe(files.file.size + bound + map);
    expect(storedReadCost(over, true)).toBe(files.file.size + map);
  });

  it("admits nothing for a source stored over its cap, a byte order mark included", async () => {
    const owner = await user("Owner");
    const { files } = await filesOf(await publishDoc(owner.id));
    const cap = PLAN_LIMITS.documentBytes + 3;
    const at = { ...files, file: { ...files.file, size: cap } };
    const over = { ...files, file: { ...files.file, size: cap + 1 } };
    const derived = the(files.rendered).size + the(files.blockMap).size;
    expect(storedReadCost(at, true)).toBe(cap + derived);
    expect(storedReadCost(over, true)).toBe(0);
    expect(storedReadCost(over, false)).toBe(0);
  });

  it("answers a source stored over its cap as oversized and unread", async () => {
    const owner = await user("Owner");
    const { artifact, files } = await filesOf(await publishDoc(owner.id));
    const over = { ...files, file: { ...files.file, size: PLAN_LIMITS.documentBytes + 4 } };
    const page = value(await readStoredPage(env.ARTIFACTS, over, { artifact }));
    expect(page).toMatchObject({
      source: "",
      decoded: false,
      oversized: true,
      bom: false,
      read: 0,
    });
    expect(page.stored).toBeUndefined();
  });

  it("reads a document's baseline only when asked, and counts what it read", async () => {
    const owner = await user("Owner");
    const { artifact, files } = await filesOf(await publishDoc(owner.id));
    const withBaseline = value(await readStoredPage(env.ARTIFACTS, files, { artifact }, true));
    const sourceOnly = value(await readStoredPage(env.ARTIFACTS, files, { artifact }, false));
    expect(withBaseline.stored?.options.title).toBe(artifact.name);
    expect(withBaseline.read).toBe(storedReadCost(files, true));
    expect(sourceOnly.stored).toBeUndefined();
    expect(sourceOnly.read).toBe(files.file.size);
    expect(sourceOnly).toMatchObject({ source: DOC, decoded: true, oversized: false, bom: false });
  });
});

const ATTEMPTS = "suggestion_attempts_retention";

async function cursorRow(name: string) {
  const [row] = await db()
    .select()
    .from(schema.maintenanceCursors)
    .where(eq(schema.maintenanceCursors.name, name));
  return row;
}

/** `count` finished attempts at the same old time `at`, in ID order, on a new artifact. */
async function finished(count: number, at: number) {
  const owner = await user("Owner");
  const doc = await publishDoc(owner.id);
  const ids = Array.from({ length: count }, (_, i) => `fin_${doc.artifactId}_${i}`);
  await db()
    .insert(schema.acceptanceAttempts)
    .values(
      ids.map((id) => ({
        id,
        artifactId: doc.artifactId,
        ownerId: owner.id,
        origin: "draft" as const,
        userId: owner.id,
        digest: "a".repeat(64),
        baseVersionId: doc.versionId,
        state: "ended" as const,
        reason: "failed" as const,
        createdAt: at,
        updatedAt: at,
      })),
    );
  const left = async () =>
    (
      await db()
        .select({ id: schema.acceptanceAttempts.id })
        .from(schema.acceptanceAttempts)
        .where(eq(schema.acceptanceAttempts.artifactId, doc.artifactId))
    ).map((row) => row.id);
  return { ids, left };
}

describe("where the retention sweeps resume", () => {
  it("stores a full page's last key and continues after it on the next run", async () => {
    const at = 10_001;
    const rows = await finished(3, at);
    await saveCursor(db(), ATTEMPTS, JSON.stringify([at, ""]), NOW - 5);
    expect((await pruneSuggestionRecords(db(), NOW, 2)).attempts).toBe(2);
    expect(await rows.left()).toEqual([rows.ids[2]]);
    expect((await cursorRow(ATTEMPTS))?.cursor).toBe(JSON.stringify([at, rows.ids[1]]));
    await pruneSuggestionRecords(db(), NOW + 1, 2);
    expect(await rows.left()).toEqual([]);
  });

  it("ends the pass after a short page and leaves an unchanged cursor as it is", async () => {
    const at = 10_002;
    const rows = await finished(1, at);
    await saveCursor(db(), ATTEMPTS, JSON.stringify([at, ""]), NOW - 5);
    await pruneSuggestionRecords(db(), NOW, 500);
    expect(await rows.left()).toEqual([]);
    expect(await cursorRow(ATTEMPTS)).toMatchObject({ cursor: "", updatedAt: NOW });
    // Nothing moved: the stored cursor is not written again.
    await pruneSuggestionRecords(db(), NOW + 7, 500);
    expect((await cursorRow(ATTEMPTS))?.updatedAt).toBe(NOW);
  });

  it("keeps rows a cursor has passed, until the pass starts again", async () => {
    const at = 10_003;
    const rows = await finished(1, at);
    await saveCursor(db(), ATTEMPTS, JSON.stringify([at + 1, ""]), NOW - 5);
    await pruneSuggestionRecords(db(), NOW, 500);
    expect(await rows.left()).toEqual(rows.ids);
  });

  it.each([
    ["text that is not JSON", "not json"],
    ["a list of the wrong length", JSON.stringify([20_000])],
    ["a time that is not an integer", JSON.stringify([20_000.5, "z"])],
    ["a time that is text", JSON.stringify(["20000", "z"])],
    ["a key part that is not text", JSON.stringify([20_000, 7])],
    ["an object", JSON.stringify({ at: 20_000 })],
  ])("starts the pass again from %s", async (_name, cursor) => {
    const rows = await finished(1, 10_004);
    await saveCursor(db(), ATTEMPTS, cursor, NOW - 5);
    await pruneSuggestionRecords(db(), NOW, 500);
    expect(await rows.left()).toEqual([]);
  });
});

const DRAFTS = "suggestion_drafts_roles";

async function draftOf(artifactId: string, ownerId: string, userId: string, attemptId?: string) {
  const edit = JSON.stringify({ operations: [] });
  await db()
    .insert(schema.editDrafts)
    .values({
      artifactId,
      userId,
      ownerId,
      baseVersionId: the(await artifactOf(artifactId)).currentVersionId ?? "",
      edit,
      editBytes: edit.length,
      updatedAt: NOW,
      ...(attemptId ? { attemptId } : {}),
    });
}

async function draftUsers(artifactId: string) {
  return (
    await db()
      .select({ userId: schema.editDrafts.userId })
      .from(schema.editDrafts)
      .where(eq(schema.editDrafts.artifactId, artifactId))
  )
    .map((row) => row.userId)
    .sort();
}

describe("the drafts of people who no longer act for the owner", () => {
  it("deletes a personal artifact's drafts but its owner's and a publishing one, from its cursor", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const [a, b, c] = [await user("A"), await user("B"), await user("C")];
    await draftOf(doc.artifactId, owner.id, owner.id);
    await draftOf(doc.artifactId, owner.id, a.id);
    await draftOf(doc.artifactId, owner.id, b.id);
    await draftOf(doc.artifactId, owner.id, c.id, "att_running");
    await saveCursor(db(), DRAFTS, `${doc.artifactId}|`, NOW - 5);
    const page = [owner.id, a.id, b.id, c.id].sort();
    expect(await pruneDraftsWithoutRole(db(), NOW, { pageSize: 4, maxPages: 1 })).toEqual({
      deleted: 2,
    });
    expect(await draftUsers(doc.artifactId)).toEqual([owner.id, c.id].sort());
    expect((await cursorRow(DRAFTS))?.cursor).toBe(`${doc.artifactId}|${page.at(-1)}`);
  });

  it("keeps a workspace's admins and editors, not a member or another workspace's editor", async () => {
    const team = await workspace(() => user("Member"));
    const other = await workspace(() => user("Other"));
    const doc = await publishDoc(team.editor.id, { ownerId: team.id });
    for (const person of [team.admin, team.editor, team.member, other.editor]) {
      await draftOf(doc.artifactId, team.id, person.id);
    }
    await saveCursor(db(), DRAFTS, `${doc.artifactId}|`, NOW - 5);
    expect(await pruneDraftsWithoutRole(db(), NOW, { pageSize: 4, maxPages: 1 })).toEqual({
      deleted: 2,
    });
    expect(await draftUsers(doc.artifactId)).toEqual([team.admin.id, team.editor.id].sort());
  });

  it("ends the pass after a short page", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    await draftOf(doc.artifactId, owner.id, (await user("Gone")).id);
    await saveCursor(db(), DRAFTS, `${doc.artifactId}|`, NOW - 5);
    await pruneDraftsWithoutRole(db(), NOW, { pageSize: 10_000, maxPages: 1 });
    expect(await draftUsers(doc.artifactId)).toEqual([]);
    expect((await cursorRow(DRAFTS))?.cursor).toBe("");
  });
});

describe("a page outside the HTML subset is carried only with every other file unchanged", () => {
  /** A suggestion on a scripted page of a two-page site, planned so it has proofs. */
  async function scriptedSuggestion() {
    const owner = await user("Owner");
    const site = await publishVersion(
      owner.id,
      { "a.html": SCRIPTED, "b.html": PAGE },
      { entrypoint: "a.html" },
    );
    await db()
      .update(schema.artifacts)
      .set({ annotations: "open" })
      .where(eq(schema.artifacts.id, site.artifactId));
    const input = { userId: owner.id, artifactId: site.artifactId, now: NOW + 10 };
    const t = value(
      await submitSuggestion(db(), {
        ...input,
        versionId: site.versionId,
        edit: {
          operations: [textOp({ type: "site", path: "a.html" }, SCRIPTED, "Second", "Next")],
        },
        body: "Fix",
        humanCheck,
      }),
    );
    value(
      await planSuggestion(db(), env.ARTIFACTS, {
        ...input,
        threadId: t.id,
        contentDomain: DOMAIN,
      }),
    );
    return { owner, site, threadId: t.id };
  }

  async function carryTo(
    files: Record<string, string>,
    s: Awaited<ReturnType<typeof scriptedSuggestion>>,
  ) {
    const next = await publishVersion(s.owner.id, files, {
      base: s.site,
      entrypoint: "a.html",
      now: NOW + 1_000,
    });
    for (const job of await jobsOf("suggestion_carry", s.site.artifactId)) {
      await runJob(
        db(),
        env.ARTIFACTS,
        { id: job.id, topic: "suggestion_carry" },
        NOW + 2_000,
        JOB_DEPS,
      );
    }
    return { next, thread: the(await thread(s.threadId)) };
  }

  it("carries it when the new version has the same files", async () => {
    const s = await scriptedSuggestion();
    const { next, thread: t } = await carryTo({ "a.html": SCRIPTED, "b.html": PAGE }, s);
    expect(t).toMatchObject({ suggestionState: "pending", versionId: next.versionId });
  });

  it.each([
    ["another file changed", { "a.html": SCRIPTED, "b.html": PAGE.replace("Title", "Other") }],
    ["a file added", { "a.html": SCRIPTED, "b.html": PAGE, "c.html": PAGE }],
    ["a file removed", { "a.html": SCRIPTED }],
  ])("outdates it when %s", async (_name, files) => {
    const s = await scriptedSuggestion();
    const { thread: t } = await carryTo(files, s);
    expect(t).toMatchObject({ suggestionState: "outdated", versionId: s.site.versionId });
  });
});

/** An owner's pending suggestion on a page whose acceptance only lists items (no version). */
async function listingAcceptance() {
  const owner = await user("Owner");
  const doc = await publishDoc(owner.id, { type: "site", body: SCRIPTED });
  const input = {
    userId: owner.id,
    artifactId: doc.artifactId,
    now: NOW + 10,
    contentDomain: DOMAIN,
  };
  const t = value(
    await submitSuggestion(db(), {
      ...input,
      versionId: doc.versionId,
      edit: { operations: [textOp(doc, SCRIPTED, "Second", "Next")] },
      body: "Fix",
      humanCheck,
    }),
  );
  const params = { ...input, threadId: t.id };
  const plan = value(await planSuggestion(db(), env.ARTIFACTS, params));
  expect(plan.output).toBeNull();
  value(await acceptSuggestion(db(), env.ARTIFACTS, { ...params, digest: plan.digest }));
  const [job] = await jobsOf("suggestion_accept", doc.artifactId);
  return { owner, doc, threadId: t.id, job: the(job) };
}

describe("the acceptance job at its own time", () => {
  it("ends a listing acceptance for capacity while annotation writes are paused, and completes it when only uploads are", async () => {
    const paused = await listingAcceptance();
    const uploads = await listingAcceptance();
    await setBudgetOverride(db().global, {
      level: "protect100",
      steps: 2,
      until: null,
      note: null,
      now: NOW,
    });
    try {
      await runJob(
        db(),
        env.ARTIFACTS,
        { id: paused.job.id, topic: "suggestion_accept" },
        NOW + 2_000,
        JOB_DEPS,
      );
    } finally {
      await clearBudgetOverride(db().global, NOW);
    }
    expect(await attempts(paused.doc.artifactId)).toMatchObject([
      { state: "ended", reason: "capacity_unavailable" },
    ]);
    expect(await items(paused.doc.artifactId)).toEqual([]);
    await setBudgetOverride(db().global, {
      level: "protect100",
      steps: 1,
      until: null,
      note: null,
      now: NOW,
    });
    try {
      await runJob(
        db(),
        env.ARTIFACTS,
        { id: uploads.job.id, topic: "suggestion_accept" },
        NOW + 2_000,
        JOB_DEPS,
      );
    } finally {
      await clearBudgetOverride(db().global, NOW);
    }
    expect(await thread(uploads.threadId)).toMatchObject({ suggestionState: "accepted" });
    expect((await items(uploads.doc.artifactId)).length).toBeGreaterThan(0);
  });

  it("keeps every other file of a site as it was, and replaces only the suggested page", async () => {
    const owner = await user("Owner");
    const site = await publishVersion(
      owner.id,
      { "a.html": PAGE, "b.html": PAGE.replace("Title", "Other") },
      { entrypoint: "a.html" },
    );
    await db()
      .update(schema.artifacts)
      .set({ annotations: "open" })
      .where(eq(schema.artifacts.id, site.artifactId));
    const input = {
      userId: owner.id,
      artifactId: site.artifactId,
      now: NOW + 10,
      contentDomain: DOMAIN,
    };
    const t = value(
      await submitSuggestion(db(), {
        ...input,
        versionId: site.versionId,
        edit: {
          operations: [
            textOp(
              { type: "site", path: "b.html" },
              PAGE.replace("Title", "Other"),
              "Second",
              "Next",
            ),
          ],
        },
        body: "Fix",
        humanCheck,
      }),
    );
    const plan = value(await planSuggestion(db(), env.ARTIFACTS, { ...input, threadId: t.id }));
    value(
      await acceptSuggestion(db(), env.ARTIFACTS, {
        ...input,
        threadId: t.id,
        digest: plan.digest,
      }),
    );
    const [job] = await jobsOf("suggestion_accept", site.artifactId);
    await runJob(
      db(),
      env.ARTIFACTS,
      { id: the(job).id, topic: "suggestion_accept" },
      NOW + 2_000,
      JOB_DEPS,
    );
    const files = async (versionId: string) =>
      Object.fromEntries(
        (
          await db()
            .select({ path: schema.versionFiles.path, sha256: schema.versionFiles.sha256 })
            .from(schema.versionFiles)
            .where(
              and(
                eq(schema.versionFiles.versionId, versionId),
                eq(schema.versionFiles.kind, "published"),
              ),
            )
        ).map((row) => [row.path, row.sha256]),
      );
    const before = await files(site.versionId);
    const after = await files(the(the(await artifactOf(site.artifactId)).currentVersionId));
    expect(after["a.html"]).toBe(before["a.html"]);
    expect(after["b.html"]).toBe(plan.output?.sha256);
    expect(after["b.html"]).not.toBe(before["b.html"]);
    expect(Object.keys(after).sort()).toEqual(["a.html", "b.html"]);
  });

  it("releases the upload of an attempt that ended without releasing it", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const input = {
      userId: owner.id,
      artifactId: doc.artifactId,
      now: NOW + 10,
      contentDomain: DOMAIN,
    };
    const t = value(
      await submitSuggestion(db(), {
        ...input,
        versionId: doc.versionId,
        edit: { operations: [textOp(doc, DOC, "Second", "Next")] },
        body: "Fix",
        humanCheck,
      }),
    );
    const plan = value(await planSuggestion(db(), env.ARTIFACTS, { ...input, threadId: t.id }));
    value(
      await acceptSuggestion(db(), env.ARTIFACTS, {
        ...input,
        threadId: t.id,
        digest: plan.digest,
      }),
    );
    const [job] = await jobsOf("suggestion_accept", doc.artifactId);
    const message = { id: the(job).id, topic: "suggestion_accept" as const };
    const broken = new Proxy(env.ARTIFACTS, {
      get(target, key) {
        if (key === "put")
          return async () => {
            throw new Error("r2-unavailable");
          };
        const member = Reflect.get(target, key, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    await expect(runJob(db(), broken, message, NOW + 2_000, JOB_DEPS)).rejects.toThrow(
      "r2-unavailable",
    );
    const usage = async () =>
      (
        await db()
          .select()
          .from(schema.accountUsage)
          .where(eq(schema.accountUsage.ownerId, owner.id))
      )[0]?.openUploads;
    expect(await usage()).toBe(1);
    // A crash between ending the attempt and releasing its upload: the next delivery releases it.
    await db()
      .update(schema.acceptanceAttempts)
      .set({ state: "ended", reason: "failed" })
      .where(eq(schema.acceptanceAttempts.artifactId, doc.artifactId));
    await runJob(db(), env.ARTIFACTS, message, NOW + 3_000, JOB_DEPS);
    expect(await usage()).toBe(0);
  });

  it("ends the attempt as failed when its upload was closed meanwhile, and keeps a ready one", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const input = {
      userId: owner.id,
      artifactId: doc.artifactId,
      now: NOW + 10,
      contentDomain: DOMAIN,
    };
    const t = value(
      await submitSuggestion(db(), {
        ...input,
        versionId: doc.versionId,
        edit: { operations: [textOp(doc, DOC, "Second", "Next")] },
        body: "Fix",
        humanCheck,
      }),
    );
    const plan = value(await planSuggestion(db(), env.ARTIFACTS, { ...input, threadId: t.id }));
    value(
      await acceptSuggestion(db(), env.ARTIFACTS, {
        ...input,
        threadId: t.id,
        digest: plan.digest,
      }),
    );
    const [job] = await jobsOf("suggestion_accept", doc.artifactId);
    const message = { id: the(job).id, topic: "suggestion_accept" as const };
    const broken = new Proxy(env.ARTIFACTS, {
      get(target, key) {
        if (key === "put")
          return async () => {
            throw new Error("r2-unavailable");
          };
        const member = Reflect.get(target, key, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    await expect(runJob(db(), broken, message, NOW + 2_000, JOB_DEPS)).rejects.toThrow(
      "r2-unavailable",
    );
    const [attempt] = await attempts(doc.artifactId);
    const session = eq(schema.uploadSessions.versionId, the(the(attempt).versionId));
    // A ready upload is still this attempt's: the next delivery completes it.
    await db().update(schema.uploadSessions).set({ state: "ready" }).where(session);
    await runJob(db(), env.ARTIFACTS, message, NOW + 3_000, JOB_DEPS);
    expect(await thread(t.id)).toMatchObject({ suggestionState: "accepted" });

    // Another owner, so the new file is not already stored and its write fails again.
    const other = await user("Other owner");
    const second = await publishDoc(other.id);
    const input2 = { ...input, userId: other.id, artifactId: second.artifactId };
    const t2 = value(
      await submitSuggestion(db(), {
        ...input2,
        versionId: second.versionId,
        edit: { operations: [textOp(second, DOC, "Second", "Next")] },
        body: "Fix",
        humanCheck,
      }),
    );
    const plan2 = value(await planSuggestion(db(), env.ARTIFACTS, { ...input2, threadId: t2.id }));
    value(
      await acceptSuggestion(db(), env.ARTIFACTS, {
        ...input2,
        threadId: t2.id,
        digest: plan2.digest,
      }),
    );
    const [job2] = await jobsOf("suggestion_accept", second.artifactId);
    const message2 = { id: the(job2).id, topic: "suggestion_accept" as const };
    await expect(runJob(db(), broken, message2, NOW + 2_000, JOB_DEPS)).rejects.toThrow(
      "r2-unavailable",
    );
    const [attempt2] = await attempts(second.artifactId);
    await db()
      .update(schema.uploadSessions)
      .set({ state: "expired" })
      .where(eq(schema.uploadSessions.versionId, the(the(attempt2).versionId)));
    await runJob(db(), env.ARTIFACTS, message2, NOW + 3_000, JOB_DEPS);
    expect(await attempts(second.artifactId)).toMatchObject([{ state: "ended", reason: "failed" }]);
    expect(await thread(t2.id)).toMatchObject({ suggestionState: "pending" });
  });
});
