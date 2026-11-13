// The adversarial review of PR #267 (decision 0027, "The owner's draft"): each test reproduces a
// finding against the draft services and fails without its fix.
import { schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { discardDraft, saveDraft } from "../src/edit-drafts.ts";
import { placeLegalHold } from "../src/legal-holds.ts";
import { db, NOW, user, value } from "./fixtures.ts";
import { raceBeforeStatement } from "./race.ts";
import { DOC, publishDoc, textOp } from "./suggestion-support.ts";

describe("discarding a draft (finding 1)", () => {
  it("preserves a draft when a legal hold lands before its discard", async () => {
    const owner = await user("Draft author");
    const doc = await publishDoc(owner.id);
    const input = { userId: owner.id, artifactId: doc.artifactId, now: NOW + 10 };
    value(
      await saveDraft(db(), {
        ...input,
        baseVersionId: doc.versionId,
        baseRevision: null,
        baseIncarnation: null,
        edit: { operations: [textOp(doc, DOC, "Second", "Next")] },
      }),
    );
    let held = false;
    const raced = raceBeforeStatement(/^delete from "edit_drafts"/i, async () => {
      await db()
        .update(schema.artifacts)
        .set({ state: "suspended" })
        .where(eq(schema.artifacts.id, doc.artifactId));
      value(
        await placeLegalHold(db(), {
          artifactId: doc.artifactId,
          ground: "Preserve evidence",
          releaseAt: null,
          now: NOW + 11,
        }),
      );
      held = true;
    });
    const result = await discardDraft(raced, input);
    expect(held).toBe(true);
    const rows = await db()
      .select()
      .from(schema.editDrafts)
      .where(eq(schema.editDrafts.artifactId, doc.artifactId));
    expect(rows, JSON.stringify(result)).toHaveLength(1);
    expect(result.ok).toBe(false);
  });
});

describe("saving over a discarded draft (finding 2)", () => {
  it("does not overwrite a replacement draft from a discarded incarnation", async () => {
    const author = await user("Two tabs");
    const doc = await publishDoc(author.id);
    const input = {
      userId: author.id,
      artifactId: doc.artifactId,
      now: NOW + 10,
      baseVersionId: doc.versionId,
      baseRevision: null as number | null,
      baseIncarnation: null as string | null,
      edit: { operations: [textOp(doc, DOC, "Second", "Original")] },
    };
    // Tab A holds the first incarnation at revision 1.
    const first = value(await saveDraft(db(), input));
    const raced = raceBeforeStatement(/^update "edit_drafts"/i, async () => {
      // Tab B discards it and starts a replacement, which is at revision 1 again.
      value(await discardDraft(db(), input));
      value(
        await saveDraft(db(), {
          ...input,
          edit: { operations: [textOp(doc, DOC, "Second", "Replacement")] },
        }),
      );
    });
    const result = await saveDraft(raced, {
      ...input,
      baseRevision: 1,
      baseIncarnation: first.incarnation,
      edit: { operations: [textOp(doc, DOC, "Second", "Stale tab")] },
    });
    const [row] = await db()
      .select()
      .from(schema.editDrafts)
      .where(eq(schema.editDrafts.artifactId, doc.artifactId));
    expect(row?.edit, JSON.stringify(result)).toContain("Replacement");
    expect(result).toMatchObject({ ok: false, code: "version_conflict" });
  });
});
