// Rebasing the owner's draft onto a newer version (decision 0027, "The owner's draft"): when the
// current version is not the draft's base, each operation is carried by the same verified
// relocation as suggestions (`carryAll`), from the proofs the draft's plan establishes on its
// base; operations that do not relocate are handed back as conflicts for the author to drop or
// make again. Only the author, while they act for the owner, through the session; counted in
// the planning windows, since it renders.
import {
  DraftEdit,
  type EditOperation,
  type RebasedDraft,
  type TextOperation,
} from "@portifact/contracts";
import { type RegionalDb, schema } from "@portifact/db";
import { fail, ok, type Result } from "@portifact/domain";
import {
  type Carriable,
  type Carry,
  carryAll,
  newWork,
  proofsOfPlan,
  textEditOf,
} from "@portifact/domain/suggestions";
import { DOCUMENT_RENDERER } from "@portifact/render";
import { and, eq, type SQL, sql } from "drizzle-orm";
import { type AnnotationActor, annotationParts } from "./annotations.ts";
import { draftView, removeDraftBatch } from "./edit-drafts.ts";
import {
  admitPlanning,
  draftPlanOf,
  ownDraft,
  planBatchOn,
  readStoredPage,
  storedFiles,
} from "./suggestion-plans.ts";
import { otherFilesUnchanged, publishedFiles } from "./suggestion-versions.ts";

const dr = schema.editDrafts;
type ArtifactRow = typeof schema.artifacts.$inferSelect;
type DraftRow = typeof schema.editDrafts.$inferSelect;
type Conflict = RebasedDraft["conflicts"][number];

const draftChanged = () =>
  fail<never>("version_conflict", "The draft changed meanwhile. Reload and try again.");

/**
 * Where each of the draft's operations stands on `versionId`: carried (with its new position)
 * or a conflict with its reason. Nothing is written.
 */
async function relocate(
  db: RegionalDb,
  bucket: R2Bucket,
  artifact: ArtifactRow,
  draft: DraftRow,
  operations: EditOperation[],
  versionId: string,
  contentDomain: string,
): Promise<(EditOperation | Conflict)[]> {
  const all = (reason: string) => operations.map((operation) => ({ operation, reason }));
  const path = (operations[0] as EditOperation).target.path;
  // The proofs the draft's plan establishes on its base: only located operations have one.
  const planned = await draftPlanOf(db, bucket, { artifact, draft, contentDomain });
  if (!planned.ok) return all("not_on_page");
  const proofs = proofsOfPlan(planned.value.plan, operations, draft.baseVersionId);
  const where = { artifact, path, contentDomain };
  const before = await storedFiles(db, { ...where, versionId: draft.baseVersionId });
  const after = await storedFiles(db, { ...where, versionId });
  if (!before.ok || !after.ok) return all("not_on_page");
  const oldPage = await readStoredPage(bucket, before.value, { artifact }, false);
  const newPage = await readStoredPage(bucket, after.value, { artifact }, false);
  if (!newPage.ok) return all("not_on_page");
  if (!oldPage.ok || !oldPage.value.decoded || !newPage.value.decoded) return all("not_eligible");
  const out: (EditOperation | Conflict)[] = [];
  const items: Carriable[] = [];
  const at: number[] = [];
  for (const [index, operation] of operations.entries()) {
    const entry = proofs.operations[index];
    const text = textEditOf(operation);
    if (!entry || !text) {
      out[index] = { operation, reason: "not_planned" };
      continue;
    }
    at.push(index);
    items.push({ edit: { ...text, start: entry.start, end: entry.end }, proof: entry.proof });
  }
  if (items.length > 0) {
    const results: Carry[] = carryAll(
      newPage.value.kind,
      oldPage.value.source,
      newPage.value.source,
      items,
      {
        title: artifact.name,
        pageUrl: newPage.value.pageUrl,
        renderer: DOCUMENT_RENDERER,
        otherFilesUnchanged: otherFilesUnchanged(
          await publishedFiles(db, draft.baseVersionId),
          await publishedFiles(db, versionId),
          path,
        ),
        work: newWork(),
      },
    );
    results.forEach((result, i) => {
      const index = at[i] as number;
      const operation = operations[index] as TextOperation;
      if (result.status === "outdated") {
        out[index] = { operation, reason: result.reason };
        return;
      }
      const anchor = operation.target.anchor;
      if (anchor.kind !== "text") return;
      out[index] = {
        ...operation,
        target: {
          ...operation.target,
          anchor: { ...anchor, position: { start: result.edit.start, end: result.edit.end } },
        },
      };
    });
  }
  return out;
}

const isConflict = (value: EditOperation | Conflict): value is Conflict => "reason" in value;

/**
 * Rebases one's own draft onto the artifact's current version, at the revision and incarnation
 * the author holds. The carried operations become the draft on the current version (a new
 * revision, the same incarnation); when none carries, the draft is removed. Every write is held
 * to the draft as read, the artifact as authorized at its current version and the author's live
 * role (`planBatchOn`), so a publish, a save or a role loss in between wins.
 */
export async function rebaseDraft(
  db: RegionalDb,
  bucket: R2Bucket,
  input: AnnotationActor & { baseRevision: number; baseIncarnation: string; contentDomain: string },
): Promise<Result<RebasedDraft>> {
  const found = await ownDraft(db, input, "moderate");
  if (!found.ok) return found;
  const { loaded, draft } = found.value;
  const { artifact } = loaded;
  if (draft.attemptId !== null) {
    return fail("version_conflict", "This draft is being published. Try again in a moment.");
  }
  if (draft.revision !== input.baseRevision || draft.incarnation !== input.baseIncarnation) {
    return draftChanged();
  }
  const current = artifact.currentVersionId;
  if (current === null) return fail("not_found", "Draft not found.");
  if (draft.baseVersionId === current) return ok({ draft: draftView(draft), conflicts: [] });
  const admitted = await admitPlanning(db, input.userId, artifact.id, input.now);
  if (!admitted.ok) return admitted;
  const parsed = DraftEdit.safeParse(JSON.parse(draft.edit));
  if (!parsed.success) return fail("invalid_input", "The draft cannot be read.");
  const placed = await relocate(
    db,
    bucket,
    artifact,
    draft,
    parsed.data.operations,
    current,
    input.contentDomain,
  );
  const conflicts = placed.filter(isConflict);
  const carried = placed.filter((value): value is EditOperation => !isConflict(value));
  const edit = carried.length > 0 ? DraftEdit.safeParse({ operations: carried }) : null;
  // A carried edit is valid by construction; one that is not hands everything back.
  const kept = edit?.success ? edit.data : null;
  if (edit && !edit.success) {
    conflicts.push(...carried.map((operation) => ({ operation, reason: "overlap" })));
  }
  const on = await planBatchOn(db, loaded);
  if (!on) return fail("not_found", "Draft not found.");
  const t = schema.artifacts;
  const asRead = and(
    eq(dr.artifactId, artifact.id),
    eq(dr.userId, input.userId),
    eq(dr.revision, draft.revision),
    eq(dr.incarnation, draft.incarnation),
    sql`${dr.attemptId} is null`,
    sql`${annotationParts.artifactGuard(loaded, "moderate", input.now)}`,
    sql`exists (select 1 from ${t} where ${t.id} = ${artifact.id} and ${t.currentVersionId} = ${current})`,
    on.standing,
  );
  if (kept === null) {
    // Removed with the marker that keeps it gone through a restore (decision 0027).
    const [, deleted] = await removeDraftBatch(db, on.w, asRead as SQL, input.now);
    return deleted.length === 1 ? ok({ draft: null, conflicts }) : draftChanged();
  }
  const text = JSON.stringify(kept);
  const updated = await on.w
    .update(dr)
    .set({
      baseVersionId: current,
      edit: text,
      editBytes: new TextEncoder().encode(text).length,
      revision: sql`${dr.revision} + 1`,
      attemptReason: null,
      updatedAt: input.now,
    })
    .where(asRead)
    .returning();
  const row = updated[0];
  return row ? ok({ draft: draftView(row), conflicts }) : draftChanged();
}
