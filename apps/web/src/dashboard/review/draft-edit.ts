// The owner's draft as the viewer builds it (decision 0027, "The owner's draft"), with no DOM.
// Every operation addresses the draft's base version, which is what the frame shows: editing text
// the draft already changed replaces that operation (coalescing), so a draft never holds two
// operations on the same text, and the whole edit is sent at each save. A draft is for one page;
// the server checks everything again.
import {
  DRAFT_LIMITS,
  DraftEdit,
  type EditOperation,
  type TextOperation,
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

/** The draft's edit with `operation` added, replacing the operations on the same text. */
export function addToDraft(current: DraftEdit | null, operation: TextOperation): DraftChange {
  const kept = (current?.operations ?? []).filter(
    (existing) =>
      pageOf(existing) !== pageOf(operation) || !textOperationsOverlap([existing, operation]),
  );
  if (kept.some((existing) => pageOf(existing) !== pageOf(operation))) {
    return { ok: false, reason: "other_page" };
  }
  if (kept.length >= DRAFT_LIMITS.operationsMax) return { ok: false, reason: "full" };
  const parsed = DraftEdit.safeParse({ operations: [...kept, operation] });
  return parsed.success ? { ok: true, edit: parsed.data } : { ok: false, reason: "invalid" };
}

/** The draft's edit without the operation at `index`, or null when nothing is left. */
export function removeFromDraft(current: DraftEdit, index: number): DraftEdit | null {
  const operations = current.operations.filter((_, i) => i !== index);
  if (operations.length === 0) return null;
  const parsed = DraftEdit.safeParse({ operations });
  return parsed.success ? parsed.data : null;
}
