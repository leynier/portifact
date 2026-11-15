// The owner's draft as the viewer builds it (decision 0027, "The owner's draft"), with no DOM.
// Every operation addresses the draft's base version, which is what the frame shows: editing text
// the draft already changed replaces that operation (coalescing), so a draft never holds two
// operations on the same text, and styling an element the draft already styles merges into that
// operation, the new values winning. The whole edit is sent at each save. A draft is for one page;
// the server checks everything again.
import {
  DRAFT_LIMITS,
  DraftEdit,
  EDIT_LIMITS,
  type EditOperation,
  type StyleOperation,
  textOperationsOverlap,
} from "@portifact/contracts";

export type DraftChange =
  | { ok: true; edit: DraftEdit }
  /** `other_page`: the draft holds another page's changes; `full`: it is at its limit. */
  | { ok: false; reason: "other_page" | "full" | "invalid" };

const pageOf = (operation: EditOperation) => {
  const target = operation.target;
  return `${target.path}\n${target.route ?? ""}`;
};

/** The same element: the anchor the bridge recorded for it, without its box (a hint only). */
const elementKey = (operation: EditOperation) => {
  const anchor = operation.target.anchor;
  return anchor.kind === "element"
    ? JSON.stringify([anchor.selectors, anchor.tagName, anchor.fingerprint])
    : null;
};

/** `operation`'s changes over the draft's earlier ones on the same element, at most eight. */
function mergedStyle(
  earlier: StyleOperation | undefined,
  operation: StyleOperation,
): StyleOperation {
  if (!earlier) return operation;
  const changed = new Set(operation.changes.map((change) => change.property));
  const kept = earlier.changes.filter((change) => !changed.has(change.property));
  return { ...operation, changes: [...kept, ...operation.changes] };
}

/**
 * The draft's edit with `operation` added: replacing the operations on the same text, or merged
 * into the style operation on the same element.
 */
export function addToDraft(current: DraftEdit | null, operation: EditOperation): DraftChange {
  const operations = current?.operations ?? [];
  const sameStyle = (existing: EditOperation): existing is StyleOperation =>
    operation.kind === "style" &&
    existing.kind === "style" &&
    pageOf(existing) === pageOf(operation) &&
    elementKey(existing) === elementKey(operation);
  const replaced = (existing: EditOperation) =>
    pageOf(existing) === pageOf(operation) &&
    (sameStyle(existing) || textOperationsOverlap([existing, operation]));
  const added =
    operation.kind === "style" ? mergedStyle(operations.find(sameStyle), operation) : operation;
  if (added.kind === "style" && added.changes.length > EDIT_LIMITS.styleChangesMax) {
    return { ok: false, reason: "invalid" };
  }
  const kept = operations.filter((existing) => !replaced(existing));
  if (kept.some((existing) => pageOf(existing) !== pageOf(operation))) {
    return { ok: false, reason: "other_page" };
  }
  if (kept.length >= DRAFT_LIMITS.operationsMax) return { ok: false, reason: "full" };
  const parsed = DraftEdit.safeParse({ operations: [...kept, added] });
  return parsed.success ? { ok: true, edit: parsed.data } : { ok: false, reason: "invalid" };
}

/** The draft's edit without the operation at `index`, or null when nothing is left. */
export function removeFromDraft(current: DraftEdit, index: number): DraftEdit | null {
  const operations = current.operations.filter((_, i) => i !== index);
  if (operations.length === 0) return null;
  const parsed = DraftEdit.safeParse({ operations });
  return parsed.success ? parsed.data : null;
}
