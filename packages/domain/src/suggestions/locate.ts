// Where a text edit lands in a page built from the stored file, and the check that a rebuilt page
// differs from the old one only there (decision 0027, "Locating and mapping" and "Verification").
// Locating goes through `packages/anchors`, which defines what a position in the page text means,
// with one anchor index per plan; the edit must fall inside one text node whose raw data equals the
// selection character for character, so no line break, tab or run of spaces is hidden.
import { AnchorDocument, type AnchorElement, type AnchorText } from "@portifact/anchors";
import { ANCHOR_LIMITS, type RefusalReason, type TextAnchor } from "@portifact/contracts";
import { changedRegion, codePoints, type TextEdit } from "./edit.ts";
import {
  adapt,
  type P5Document,
  type P5Element,
  type P5Text,
  skeleton,
  textNodesOf,
  unwrap,
} from "./html-dom.ts";
import type { Work } from "./work.ts";

/** A located change in one text node: UTF-16 offsets into its data. */
export interface Located {
  node: P5Text;
  start: number;
  end: number;
  deleted: string;
  inserted: string;
}

/** The text anchor the bridge would have built for this selection, from the page text. */
function anchorFor(text: readonly string[], edit: TextEdit): TextAnchor {
  const context = ANCHOR_LIMITS.contextMaxCodePoints;
  return {
    kind: "text",
    quote: {
      exact: edit.before,
      prefix: text.slice(Math.max(0, edit.start - context), edit.start).join(""),
      suffix: text.slice(edit.end, edit.end + context).join(""),
    },
    position: { start: edit.start, end: edit.end },
  };
}

/** One anchor index of a page's body, built once and used for every operation of a plan. */
export class PageIndex {
  readonly points: string[];
  private readonly document: AnchorDocument;

  constructor(body: P5Element, work: Work) {
    work.indexes++;
    this.document = new AnchorDocument(adapt(body) as AnchorElement);
    this.points = codePoints(this.document.text.value);
  }

  locate(edit: TextEdit): { ok: true; located: Located } | { ok: false; reason: RefusalReason } {
    if (
      edit.start < 0 ||
      edit.end < edit.start ||
      this.points.slice(edit.start, edit.end).join("") !== edit.before
    ) {
      return { ok: false, reason: "stale" };
    }
    const found = this.document.resolveText(anchorFor(this.points, edit));
    if (found.confidence !== "exact") return { ok: false, reason: "stale" };
    const { start, end } = found.range;
    if (start.node !== end.node || start.node.nodeType !== 3) {
      return { ok: false, reason: "spans_nodes" };
    }
    const data = (start.node as AnchorText).data;
    if (data.slice(start.offset, end.offset) !== edit.before) {
      return { ok: false, reason: "whitespace" };
    }
    const change = changedRegion(edit);
    const prefix = codePoints(edit.before)
      .slice(0, change.from - edit.start)
      .join("").length;
    const at = start.offset + prefix;
    return {
      ok: true,
      located: {
        node: unwrap(start.node) as P5Text,
        start: at,
        end: at + change.deleted.length,
        deleted: change.deleted,
        inserted: change.inserted,
      },
    };
  }
}

/**
 * Whether `next` is `old` with exactly `changes` applied: the same skeleton (every element and
 * attribute, IDs included, every comment, the head's title and styles) and the same text nodes,
 * each with its exact data, except the changed ones, whose data is the old data with each raw
 * range replaced.
 */
export function onlyChangedText(
  old: P5Document,
  next: P5Document,
  changes: readonly Located[],
): boolean {
  if (skeleton(old) !== skeleton(next)) return false;
  const before = textNodesOf(old);
  const after = textNodesOf(next);
  if (before.length !== after.length) return false;
  const byNode = new Map<P5Text, Located[]>();
  for (const change of changes)
    byNode.set(change.node, [...(byNode.get(change.node) ?? []), change]);
  return before.every((node, index) => {
    let expected = node.value;
    for (const change of [...(byNode.get(node) ?? [])].sort((a, b) => b.start - a.start)) {
      if (expected.slice(change.start, change.end) !== change.deleted) return false;
      expected = expected.slice(0, change.start) + change.inserted + expected.slice(change.end);
    }
    return (after[index] as P5Text).value === expected;
  });
}
