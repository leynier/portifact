// A text edit as the resolvers receive it: where the reviewer's selection is in the page's
// normalized text (code points, as `TextPosition` in an anchor), the text it held and the text
// the reviewer wrote instead. All of it is untrusted.
import { codePoints } from "./page.ts";

export interface TextEdit {
  start: number;
  end: number;
  before: string;
  after: string;
}

export type UncertainReason =
  /** The page no longer has `before` at the position: the version or the page changed. */
  | "stale"
  /** `after` is not normalized single-line text, or equals `before`. */
  | "invalid_after"
  /** The changed text crosses a block (two paragraphs, two cells, a heading and a paragraph). */
  | "spans_blocks"
  /** The changed text was not found in the source exactly once with its context. */
  | "not_found"
  /** Re-rendering the changed source does not give the page the reviewer saw with the edit. */
  | "would_change_page"
  /** The page's text differs from the file's static text: a script wrote or changed it. */
  | "script_text"
  /** The source is not in Unicode NFC, so normalized offsets do not map one to one. */
  | "not_nfc"
  /** The selection crosses whitespace the page keeps (a line break, a tab, several spaces). */
  | "whitespace"
  /** The selection is not inside one text node of the page. */
  | "spans_nodes"
  /** An HTML page outside the eligible subset (decision 0027, rule 4). */
  | "not_eligible"
  /** A character reference in the file that cannot be mapped to the edited text. */
  | "entity"
  /** Inside a diagram's source, whose drawing a text check cannot verify. */
  | "diagram"
  /** The stored rendering cannot be reproduced by the installed renderer. */
  | "renderer_changed"
  /** The file or the plan is over its size or work limit. */
  | "too_large"
  /** Another operation of the same plan touches the same text. */
  | "overlap"
  /** The plan's render budget ran out. */
  | "budget";

/** What the viewer says for each refusal (English here; translated in every catalog). */
export const REFUSAL_MESSAGES: Readonly<Record<UncertainReason, string>> = {
  stale: "The page changed since this text was selected. Select it again.",
  invalid_after: "The new text must be one line of plain text that differs from the old.",
  spans_blocks: "The change crosses two blocks, so it goes to the change list.",
  not_found:
    "This text cannot be matched to one place in the source, so it goes to the change list.",
  would_change_page:
    "Applying this would change something else on the page (a heading link, a reference or markup), so it goes to the change list.",
  script_text: "A script on this page writes this text, so it goes to the change list.",
  not_nfc: "This text is stored in another Unicode form, so it goes to the change list.",
  whitespace:
    "The selection crosses line breaks or spacing the page keeps, so it goes to the change list.",
  spans_nodes: "The selection crosses formatting or a link, so it goes to the change list.",
  not_eligible:
    "This page uses features Portifact does not edit automatically (scripts, forms, embedded content and others), so it goes to the change list.",
  entity:
    "This text is written with a character reference Portifact cannot map, so it goes to the change list.",
  diagram: "Changes to a diagram's source go to the change list.",
  renderer_changed:
    "This document was rendered by an earlier version of Portifact, so changes go to the change list.",
  too_large:
    "This file or change is too large to apply automatically, so it goes to the change list.",
  overlap: "Two changes touch the same text. Combine them into one.",
  budget: "This change needs more work than one plan allows, so it goes to the change list.",
};

export type Resolution =
  | {
      status: "certain";
      /** The whole new source of the file. */
      source: string;
      /** The UTF-16 range of the old source that was replaced, and what replaced it. */
      range: { start: number; end: number };
      replacement: string;
    }
  | { status: "uncertain"; reason: UncertainReason };

export const uncertain = (reason: UncertainReason): Resolution => ({ status: "uncertain", reason });

/** Normalized text: no control characters, no whitespace but single inner spaces. */
const NORMALIZED = /^(?:[^\s\p{Cc}]| (?! ))*$/u;

export function validAfter(edit: TextEdit): boolean {
  return (
    edit.after !== edit.before &&
    edit.after.isWellFormed() &&
    edit.after === edit.after.normalize("NFC") &&
    NORMALIZED.test(edit.after) &&
    codePoints(edit.after).length <= 1_024
  );
}

/**
 * The part of the page text the edit really changes: `before` and `after` without their common
 * prefix and suffix. Returns code point offsets into the page and the deleted and inserted text.
 */
export function changedRegion(edit: TextEdit): {
  from: number;
  to: number;
  deleted: string;
  inserted: string;
} {
  const before = codePoints(edit.before);
  const after = codePoints(edit.after);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  return {
    from: edit.start + prefix,
    to: edit.end - suffix,
    deleted: before.slice(prefix, before.length - suffix).join(""),
    inserted: after.slice(prefix, after.length - suffix).join(""),
  };
}
