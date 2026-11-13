// The owner's draft (decision 0027, "The owner's draft"): saving, reading and discarding one's own
// draft on an artifact. Only its author, and only while they act for the owner (an admin or
// editor of a workspace, or the account of a personal space), through session-only routes; a
// draft answers as missing to anyone else. The edit is the author's own, validated by
// `DraftEdit` at the boundary and inert data here; planning and publishing it are
// `planDraft` and `publishDraft`.
//
// The viewer sends the whole edit at each save, already coalesced (editing text the draft
// changed replaces that operation), so the server keeps no operation history. A save is held to
// the revision the author holds, so two tabs never overwrite each other silently, and to the
// artifact's current version: a draft whose base is no longer current is replaced only by a save
// that names the current version. Rebasing by relocation is left to a later pull request.
import { DRAFT_LIMITS, type DraftEdit, type DraftView, utf8Length } from "@portifact/contracts";
import {
  bothSides,
  type Db,
  hitRateLimits,
  type RateLimitHit,
  type RegionalDb,
  schema,
} from "@portifact/db";
import { fail, ok, type Result } from "@portifact/domain";
import { and, eq, type SQL, sql } from "drizzle-orm";
import { type AnnotationActor, annotationParts } from "./annotations.ts";
import { notHeldSql } from "./legal-holds.ts";
import { draftMarker } from "./suggestion-markers.ts";
import { ownDraft, planBatchOn } from "./suggestion-plans.ts";
import { checkEditablePage } from "./suggestions.ts";

const dr = schema.editDrafts;
type DraftRow = typeof dr.$inferSelect;

/** The `rate_limits` key of a person's draft saves. */
export const draftSaveKey = (userId: string) => `suggestion-draft:user:${userId}`;

function draftView(row: DraftRow): DraftView {
  let edit: unknown = null;
  try {
    edit = JSON.parse(row.edit);
  } catch {
    edit = null;
  }
  return {
    artifactId: row.artifactId,
    baseVersionId: row.baseVersionId,
    edit,
    revision: row.revision,
    incarnation: row.incarnation,
    publishing: row.attemptId !== null,
    attemptReason: row.attemptReason,
    updatedAt: row.updatedAt,
  };
}

/** A new draft's incarnation: 16 random bytes in base64url, never reused. */
function newIncarnation(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

const draftChanged = () =>
  fail<never>("version_conflict", "The draft changed meanwhile. Reload and try again.");

/** One's own draft on the artifact. */
export async function getDraft(db: RegionalDb, input: AnnotationActor): Promise<Result<DraftView>> {
  const found = await ownDraft(db, input, "read");
  return found.ok ? ok(draftView(found.value.draft)) : found;
}

function causeIncludes(error: unknown, text: string): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (e.message.includes(text)) return true;
  }
  return false;
}

/**
 * Saves one's own draft: the whole edit, on the artifact's current version, at the revision the
 * author holds (null for a new draft). Counted in the person's save window first, after
 * authorization. At most `DRAFT_LIMITS.perUser` drafts per person in each region: the cap is the regional
 * `edit_drafts_limit` trigger, as preview codes' is (decision 0027, implementation notes).
 */
export async function saveDraft(
  db: RegionalDb,
  input: AnnotationActor & {
    baseVersionId: string;
    edit: DraftEdit;
    baseRevision: number | null;
    baseIncarnation: string | null;
  },
): Promise<Result<DraftView>> {
  const authorized = await annotationParts.authorize(db, input, "moderate");
  if (!authorized.ok) return authorized;
  const loaded = authorized.value;
  if (loaded.role !== "owner") return fail("not_found", "Artifact not found.");
  const { artifact } = loaded;
  const [hit] = (await hitRateLimits(
    db.global.$client,
    [draftSaveKey(input.userId)],
    DRAFT_LIMITS.savesWindowMs,
    input.now,
  )) as [RateLimitHit];
  if (hit.count > DRAFT_LIMITS.savesPerUser) {
    return fail("rate_limited", "Too many draft saves in a short time. Wait a few minutes.");
  }
  if (artifact.currentVersionId !== input.baseVersionId) {
    return fail("version_conflict", "Edit the current version of the artifact.");
  }
  const path = (input.edit.operations[0] as { target: { path: string } }).target.path;
  const page = await checkEditablePage(db, artifact.type, input.baseVersionId, path);
  if (!page.ok) return page;
  const [existing] = await db
    .select()
    .from(dr)
    .where(and(eq(dr.artifactId, artifact.id), eq(dr.userId, input.userId)))
    .limit(1);
  // The revision and the incarnation the author holds: a replacement draft starts at revision 1
  // again, so the revision alone does not tell it from the discarded one.
  if (
    (existing?.revision ?? null) !== input.baseRevision ||
    (existing?.incarnation ?? null) !== input.baseIncarnation
  ) {
    return draftChanged();
  }
  if (existing && existing.attemptId !== null) {
    return fail("version_conflict", "This draft is being published. Try again in a moment.");
  }
  const editJson = JSON.stringify(input.edit);
  const editBytes = utf8Length(editJson);
  const on = await planBatchOn(db, loaded);
  if (!on) return fail("not_found", "Artifact not found.");
  const { w } = on;
  const t = schema.artifacts;
  const guard = sql`${annotationParts.artifactGuard(loaded, "moderate", input.now)} and exists (select 1 from ${t} where ${t.id} = ${artifact.id} and ${t.currentVersionId} = ${input.baseVersionId}) and ${on.standing}`;
  let written: { revision: number }[];
  try {
    written = existing
      ? await w
          .update(dr)
          .set({
            baseVersionId: input.baseVersionId,
            edit: editJson,
            editBytes,
            revision: sql`${dr.revision} + 1`,
            attemptReason: null,
            updatedAt: input.now,
          })
          .where(
            and(
              eq(dr.artifactId, artifact.id),
              eq(dr.userId, input.userId),
              eq(dr.revision, existing.revision),
              eq(dr.incarnation, existing.incarnation),
              sql`${dr.attemptId} is null`,
              guard,
            ),
          )
          .returning({ revision: dr.revision })
      : // Columns in schema order: artifact, user, owner, base version, edit, edit bytes,
        // revision, attempt, attempt reason, created, updated, incarnation.
        await w
          .insert(dr)
          .select(
            sql`select ${artifact.id}, ${input.userId}, ${artifact.ownerId}, ${input.baseVersionId}, ${editJson}, ${editBytes}, 1, null, null, ${input.now}, ${input.now}, ${newIncarnation()} where ${guard} and not exists (select 1 from ${dr} where ${dr.artifactId} = ${artifact.id} and ${dr.userId} = ${input.userId})`,
          )
          .returning({ revision: dr.revision });
  } catch (error) {
    if (causeIncludes(error, "edit_drafts_limit")) {
      return fail(
        "quota_exceeded",
        `You can keep at most ${DRAFT_LIMITS.perUser} drafts in this region. Publish or discard one first.`,
      );
    }
    throw error;
  }
  if (written.length === 0) {
    // Answer what a fresh request would: the refusal that now applies, else a conflict.
    const again = await annotationParts.authorize(db, input, "moderate");
    if (!again.ok) return again;
    if (again.value.role !== "owner") return fail("not_found", "Artifact not found.");
    return draftChanged();
  }
  const saved = await ownDraft(db, input, "read");
  return saved.ok ? ok(draftView(saved.value.draft)) : saved;
}

/**
 * Discards one's own draft. Never refused by budget protection or a plan; a draft being
 * published is left to its job.
 */
export async function discardDraft(db: RegionalDb, input: AnnotationActor): Promise<Result<true>> {
  const found = await ownDraft(db, input, "read");
  if (!found.ok) return found;
  const { draft } = found.value;
  if (draft.attemptId !== null) {
    return fail("version_conflict", "This draft is being published. Try again in a moment.");
  }
  // A discard is a deletion: held to no open legal hold, the owner it was authorized on and the
  // author's live role, inside the statement (decision 0027, "Withdrawal, deletion and
  // retention"), so a hold or a role loss landing after the read wins. An unheld archived or
  // suspended artifact's draft can still be discarded.
  const { loaded } = found.value;
  const on = await planBatchOn(db, loaded);
  if (!on) return fail("not_found", "Draft not found.");
  const t = schema.artifacts;
  const asRead = and(
    eq(dr.artifactId, draft.artifactId),
    eq(dr.userId, input.userId),
    eq(dr.revision, draft.revision),
    eq(dr.incarnation, draft.incarnation),
    sql`${dr.attemptId} is null`,
    sql`exists (select 1 from ${t} where ${t.id} = ${draft.artifactId} and ${t.ownerId} = ${loaded.artifact.ownerId})`,
    notHeldSql(sql`${dr.artifactId}`),
    on.standing,
  ) as SQL;
  const [, deleted] = await removeDraftBatch(db, on.w, asRead, input.now);
  if (deleted.length === 1) return ok(true);
  // Answer what a fresh request would: the refusal that now applies (a hold's message among
  // them), else a conflict.
  const again = await ownDraft(db, input, "read");
  return again.ok ? draftChanged() : again;
}

/**
 * Removes the drafts `where` selects, each with the marker that keeps it gone through a restore
 * (`edit_draft`, decision 0027), the marker first and on the same condition, so a draft is never
 * removed without one and a refused removal writes none. `w` is the handle the caller's guard was
 * built for (`planBatchOn`); with one database the batch runs on the handle that writes both.
 */
export async function removeDraftBatch(
  db: RegionalDb,
  w: Db,
  where: SQL,
  now: number,
): Promise<[unknown, { revision: number }[]]> {
  const shared = bothSides(db);
  const x: Db = shared ?? w;
  return (await x.batch([
    draftMarker(x, shared !== null, where, now),
    x.delete(dr).where(where).returning({ revision: dr.revision }),
  ])) as [unknown, { revision: number }[]];
}
