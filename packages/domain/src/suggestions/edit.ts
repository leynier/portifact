// A text edit as the planners receive it: where the selection is in the page's normalized text
// (code points, as an anchor's `TextPosition`), the text it held and the text written instead.
// All of it is untrusted.
import {
  EDIT_LIMITS,
  type EditOperation,
  type RefusalReason,
  type TextOperation,
} from "@portifact/contracts";

export interface TextEdit {
  start: number;
  end: number;
  before: string;
  after: string;
}

/** Code points, since anchor positions count them. */
export const codePoints = (text: string): string[] => Array.from(text);

/** The text edit of a text operation, or null for a style or structure operation. */
export function textEditOf(operation: EditOperation): TextEdit | null {
  if (operation.kind !== "text") return null;
  const anchor = (operation as TextOperation).target.anchor;
  if (anchor.kind !== "text") return null;
  return {
    start: anchor.position.start,
    end: anchor.position.end,
    before: anchor.quote.exact,
    after: operation.after,
  };
}

const NORMALIZED = /^(?:[^\s\p{Cc}]| (?! ))*$/u;

/** Whether `after` is normalized single-line text that differs from `before`. */
export function validAfter(edit: TextEdit): boolean {
  return (
    edit.after !== edit.before &&
    edit.after.isWellFormed() &&
    edit.after === edit.after.normalize("NFC") &&
    NORMALIZED.test(edit.after) &&
    codePoints(edit.after).length <= EDIT_LIMITS.textMaxCodePoints
  );
}

/**
 * The part of the page text the edit really changes: `before` and `after` without their common
 * prefix and suffix, as code point offsets into the page and the deleted and inserted text.
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
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix++;
  }
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

/** Occurrences of `needle` in `haystack`, overlapping ones included, up to `limit + 1`. */
export function occurrences(haystack: string, needle: string, limit = 2): number[] {
  const found: number[] = [];
  if (needle.length === 0) return found;
  for (let at = haystack.indexOf(needle); at >= 0 && found.length <= limit; ) {
    found.push(at);
    at = haystack.indexOf(needle, at + 1);
  }
  return found;
}

export type { RefusalReason };
