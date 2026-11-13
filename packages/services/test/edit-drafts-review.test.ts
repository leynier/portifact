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
