// The owner's draft (decision 0027, "The owner's draft"): saved, read and discarded only by its
// author while they act for the owner, held to the revision they hold and to the current version,
// and publishable through the plan and acceptance it shares with suggestions.
import { env } from "cloudflare:workers";
import { DRAFT_LIMITS, type DraftEdit } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { discardDraft, draftSaveKey, getDraft, saveDraft } from "../src/edit-drafts.ts";
import { publishDraft } from "../src/suggestion-accept.ts";
import { planDraft } from "../src/suggestion-plans.ts";
import { db, NOW, user, value } from "./fixtures.ts";
import {
  currentText,
  DOC,
  DOMAIN,
  type Doc,
  publishDoc,
  republish,
  runJobs,
  textOp,
} from "./suggestion-support.ts";

let owner: { id: string; email: string };
let doc: Doc;

beforeEach(async () => {
  owner = await user("Draft Owner");
  doc = await publishDoc(owner.id);
});

const as = (userId: string, now = NOW + 10) => ({ userId, artifactId: doc.artifactId, now });
const edit = (before: string, after: string): DraftEdit => ({
  operations: [textOp(doc, DOC, before, after)],
});

describe("saving one's own draft", () => {
  it("creates, updates at the held revision, reads and publishes it", async () => {
    const first = value(
      await saveDraft(db(), {
        ...as(owner.id),
        baseVersionId: doc.versionId,
        edit: edit("Second", "Next"),
        baseRevision: null,
        baseIncarnation: null,
      }),
    );
    expect(first).toMatchObject({ revision: 1, publishing: false, baseVersionId: doc.versionId });
    expect(first.incarnation).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const second = value(
      await saveDraft(db(), {
        ...as(owner.id),
        baseVersionId: doc.versionId,
        edit: edit("Second", "Later"),
        baseRevision: 1,
        baseIncarnation: first.incarnation,
      }),
    );
    expect(second.revision).toBe(2);
    expect(value(await getDraft(db(), as(owner.id)))).toEqual(second);
    const plan = value(
      await planDraft(db(), env.ARTIFACTS, { ...as(owner.id), contentDomain: DOMAIN }),
    );
    expect(plan.applied).toHaveLength(1);
    value(
      await publishDraft(db(), env.ARTIFACTS, {
        ...as(owner.id),
        digest: plan.digest,
        contentDomain: DOMAIN,
      }),
    );
    await runJobs("draft_publish", doc.artifactId);
    expect(await currentText(doc.artifactId, "index.md")).toContain("Later paragraph here.");
    expect(await getDraft(db(), as(owner.id))).toMatchObject({ ok: false, code: "not_found" });
  });

  it("refuses a stale revision, a new draft over an existing one and an old version", async () => {
    let incarnation: string | null = null;
    const save = (baseRevision: number | null, baseVersionId = doc.versionId) =>
      saveDraft(db(), {
        ...as(owner.id),
        baseVersionId,
        edit: edit("Second", "Next"),
        baseRevision,
        baseIncarnation: baseRevision === null ? null : (incarnation ?? "AAAAAAAAAAAAAAAAAAAAAA"),
      });
    expect(await save(1)).toMatchObject({ ok: false, code: "version_conflict" });
    incarnation = value(await save(null)).incarnation;
    expect(await save(null)).toMatchObject({ ok: false, code: "version_conflict" });
    expect(await save(2)).toMatchObject({ ok: false, code: "version_conflict" });
    const old = doc.versionId;
    await republish(owner.id, doc, `${DOC}\nMore.\n`);
    expect(await save(1, old)).toMatchObject({ ok: false, code: "version_conflict" });
  });

  it("refuses a file that is not a page, and a draft being published", async () => {
    const op = textOp(doc, DOC, "Second", "Next");
    const elsewhere = { ...op, target: { ...op.target, path: "missing.md" } } as typeof op;
    expect(
      await saveDraft(db(), {
        ...as(owner.id),
        baseVersionId: doc.versionId,
        edit: { operations: [elsewhere] },
        baseRevision: null,
        baseIncarnation: null,
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    value(
      await saveDraft(db(), {
        ...as(owner.id),
        baseVersionId: doc.versionId,
        edit: edit("Second", "Next"),
        baseRevision: null,
        baseIncarnation: null,
      }),
    );
    await db()
      .update(schema.editDrafts)
      .set({ attemptId: "att_running" })
      .where(eq(schema.editDrafts.artifactId, doc.artifactId));
    expect(
      await saveDraft(db(), {
        ...as(owner.id),
        baseVersionId: doc.versionId,
        edit: edit("Second", "Other"),
        baseRevision: 1,
        baseIncarnation: (await getDraft(db(), as(owner.id))).ok
          ? value(await getDraft(db(), as(owner.id))).incarnation
          : null,
      }),
    ).toMatchObject({ ok: false, code: "version_conflict" });
    expect(await discardDraft(db(), as(owner.id))).toMatchObject({
      ok: false,
      code: "version_conflict",
    });
  });

  it("answers anyone but the owner side as a missing artifact or draft", async () => {
    const reader = await user("Draft Reader");
    await db()
      .insert(schema.artifactReaders)
      .values({ artifactId: doc.artifactId, email: reader.email });
    const stranger = await user("Draft Stranger");
    for (const someone of [reader.id, stranger.id, "st_00000000000000000000"]) {
      const saved = await saveDraft(db(), {
        ...as(someone),
        baseVersionId: doc.versionId,
        edit: edit("Second", "Next"),
        baseRevision: null,
        baseIncarnation: null,
      });
      expect(saved.ok, someone).toBe(false);
      expect(["not_found", "forbidden"]).toContain(saved.ok ? "" : saved.code);
      expect(await getDraft(db(), as(someone))).toMatchObject({ ok: false });
    }
    expect(await db().select().from(schema.editDrafts)).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ artifactId: doc.artifactId })]),
    );
  });

  it("limits saves per person, counting refused saves too", async () => {
    await env.DB.prepare(
      "insert or replace into rate_limits (key, window_start, count) values (?, ?, ?)",
    )
      .bind(draftSaveKey(owner.id), NOW, DRAFT_LIMITS.savesPerUser)
      .run();
    const limited = await saveDraft(db(), {
      ...as(owner.id),
      baseVersionId: doc.versionId,
      edit: edit("Second", "Next"),
      baseRevision: null,
      baseIncarnation: null,
    });
    expect(limited).toMatchObject({ ok: false, code: "rate_limited" });
    expect(
      await db().select().from(schema.editDrafts).where(eq(schema.editDrafts.userId, owner.id)),
    ).toEqual([]);
  });

  it("maps the per-person draft cap to quota_exceeded", async () => {
    for (let i = 0; i < DRAFT_LIMITS.perUser; i++) {
      const other = await publishDoc(owner.id);
      await db().insert(schema.editDrafts).values({
        artifactId: other.artifactId,
        userId: owner.id,
        ownerId: owner.id,
        baseVersionId: other.versionId,
        edit: "{}",
        editBytes: 2,
        updatedAt: NOW,
      });
    }
    expect(
      await saveDraft(db(), {
        ...as(owner.id),
        baseVersionId: doc.versionId,
        edit: edit("Second", "Next"),
        baseRevision: null,
        baseIncarnation: null,
      }),
    ).toMatchObject({ ok: false, code: "quota_exceeded" });
  });
});

describe("discarding one's own draft", () => {
  it("deletes it, then answers it as missing", async () => {
    value(
      await saveDraft(db(), {
        ...as(owner.id),
        baseVersionId: doc.versionId,
        edit: edit("Second", "Next"),
        baseRevision: null,
        baseIncarnation: null,
      }),
    );
    expect(value(await discardDraft(db(), as(owner.id)))).toBe(true);
    expect(await discardDraft(db(), as(owner.id))).toMatchObject({ ok: false, code: "not_found" });
  });
});
