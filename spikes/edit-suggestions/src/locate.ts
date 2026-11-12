// Where a text edit lands in a page built from the stored file, and the check that a rebuilt page
// differs from the old one only there (decision 0027, rules 3, 6 and 7). Locating goes through
// `packages/anchors`, which defines what a position in the page text means; the edit must then
// fall inside one text node, with the node's raw text equal to the selection character for
// character, so no line break, tab or run of spaces is hidden by normalization.
import { AnchorDocument, type AnchorElement } from "@portifact/anchors";
import type { TextAnchor } from "@portifact/contracts";
import { changedRegion, type TextEdit, type UncertainReason } from "./edit.ts";
import { codePoints, skeleton, textNodes } from "./page.ts";

/** One change to one text node: the raw UTF-16 range of its data and the text that replaces it. */
export interface NodeChange {
  node: number;
  start: number;
  end: number;
  deleted: string;
  inserted: string;
}

const CONTEXT = 32;

/** The text anchor the bridge would have built for this selection, from the page text. */
function anchorFor(text: string, edit: TextEdit): TextAnchor {
  const points = codePoints(text);
  return {
    kind: "text",
    quote: {
      exact: edit.before,
      prefix: points.slice(Math.max(0, edit.start - CONTEXT), edit.start).join(""),
      suffix: points.slice(edit.end, edit.end + CONTEXT).join(""),
    },
    position: { start: edit.start, end: edit.end },
  };
}

export function locateChange(
  root: Element,
  edit: TextEdit,
): { ok: true; change: NodeChange; text: Text } | { ok: false; reason: UncertainReason } {
  const document = new AnchorDocument(root as unknown as AnchorElement);
  if (codePoints(document.text.value).slice(edit.start, edit.end).join("") !== edit.before) {
    return { ok: false, reason: "stale" };
  }
  const located = document.resolveText(anchorFor(document.text.value, edit));
  if (located.confidence !== "exact") return { ok: false, reason: "stale" };
  const { start, end } = located.range;
  if (start.node !== end.node || start.node.nodeType !== 3)
    return { ok: false, reason: "spans_nodes" };
  const node = start.node as unknown as Text;
  if (node.data.slice(start.offset, end.offset) !== edit.before)
    return { ok: false, reason: "whitespace" };
  const change = changedRegion(edit);
  const prefix = codePoints(edit.before)
    .slice(0, change.from - edit.start)
    .join("");
  const at = start.offset + prefix.length;
  const index = textNodes(root).indexOf(node);
  return {
    ok: true,
    text: node,
    change: {
      node: index,
      start: at,
      end: at + change.deleted.length,
      deleted: change.deleted,
      inserted: change.inserted,
    },
  };
}

/**
 * Whether `next` is `old` with exactly `changes` applied: the same skeleton (every element and
 * attribute, IDs included) and the same text nodes, each with its exact data, except the changed
 * ones, whose data is the old data with the raw range replaced.
 */
export function onlyChanged(old: Element, next: Element, changes: readonly NodeChange[]): boolean {
  if (skeleton(old) !== skeleton(next)) return false;
  const before = textNodes(old).map((node) => node.data);
  const after = textNodes(next).map((node) => node.data);
  if (before.length !== after.length) return false;
  const expected = [...before];
  const ordered = [...changes].sort((a, b) => b.node - a.node || b.start - a.start);
  for (const change of ordered) {
    const data = expected[change.node] as string;
    if (data.slice(change.start, change.end) !== change.deleted) return false;
    expected[change.node] = data.slice(0, change.start) + change.inserted + data.slice(change.end);
  }
  return expected.every((data, index) => data === after[index]);
}

/** Whether two changes touch the same text (adjacent insertions at one point included). */
export function overlaps(a: NodeChange, b: NodeChange): boolean {
  return a.node === b.node && a.start <= b.end && b.start <= a.end;
}
