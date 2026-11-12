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
  /** An HTML page with scripts, event handlers or `javascript:` URLs (decision 0027, rule 4). */
  | "not_inert"
  /** Another operation of the same plan touches the same text. */
  | "overlap"
  /** The plan's render budget ran out. */
  | "budget";

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
