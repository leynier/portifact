// A suggestion as read paths show it (decision 0027): its own route and the `suggestion` block of
// a thread view (`?fields=suggestion`). Pure over the thread row, so the thread views use it
// without importing the suggestion services.
import {
  Edit,
  type SuggestionProofs,
  type SuggestionState,
  type SuggestionView,
} from "@portifact/contracts";
import type { schema } from "@portifact/db";
import { plannedOn } from "@portifact/domain/suggestions";

type ThreadRow = typeof schema.annotationThreads.$inferSelect;

/** The stored proofs of a suggestion, or null when it has none (or they cannot be read). */
export function storedProofs(row: Pick<ThreadRow, "editProofs">): SuggestionProofs | null {
  if (row.editProofs === null) return null;
  try {
    return JSON.parse(row.editProofs) as SuggestionProofs;
  } catch {
    return null;
  }
}

/** The submitted edit of a suggestion still holding one. */
export function storedEdit(row: Pick<ThreadRow, "edit">): Edit | null {
  if (row.edit === null) return null;
  const parsed = Edit.safeParse(JSON.parse(row.edit));
  return parsed.success ? parsed.data : null;
}

export function suggestionView(row: ThreadRow): SuggestionView {
  const edit = storedEdit(row);
  return {
    threadId: row.id,
    artifactId: row.artifactId,
    versionId: row.versionId,
    state: row.suggestionState as SuggestionState,
    edit,
    revision: row.suggestionRevision,
    attemptReason: row.attemptReason,
    decidedAt: row.decidedAt,
    resultVersionId: row.resultVersionId,
    originVersionId: row.originVersionId,
    planned: plannedOn(storedProofs(row), row.versionId),
  };
}
