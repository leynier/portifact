// Where a text edit lands in a page built from the stored file, and the check that a rebuilt page
// differs from the old one only there (decision 0027, rules 3, 6 and 7). Locating goes through
// `packages/anchors`, which defines what a position in the page text means, with one anchor index
// built once per plan; the edit must fall inside one text node, with the node's raw text equal to
// the selection character for character, so no line break, tab or run of spaces is hidden.
import { AnchorDocument, type AnchorElement, type AnchorNode } from "@portifact/anchors";
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

export interface Located {
  /** The text node, in the page's own node type (happy-dom or the parse5 adapter). */
  text: AnchorNode & { data: string };
  start: number;
  end: number;
  deleted: string;
  inserted: string;
}

const CONTEXT = 32;

/** The text anchor the bridge would have built for this selection, from the page text. */
function anchorFor(text: readonly string[], edit: TextEdit): TextAnchor {
  return {
    kind: "text",
    quote: {
      exact: edit.before,
      prefix: text.slice(Math.max(0, edit.start - CONTEXT), edit.start).join(""),
      suffix: text.slice(edit.end, edit.end + CONTEXT).join(""),
    },
    position: { start: edit.start, end: edit.end },
  };
}

/** One anchor index for a page, built once and used for every operation of a plan. */
export class PageIndex {
  readonly document: AnchorDocument;
  readonly points: string[];

  constructor(root: AnchorNode) {
    this.document = new AnchorDocument(root as AnchorElement);
    this.points = codePoints(this.document.text.value);
  }

  locate(edit: TextEdit): { ok: true; located: Located } | { ok: false; reason: UncertainReason } {
    if (this.points.slice(edit.start, edit.end).join("") !== edit.before) {
      return { ok: false, reason: "stale" };
    }
    const found = this.document.resolveText(anchorFor(this.points, edit));
    if (found.confidence !== "exact") return { ok: false, reason: "stale" };
    const { start, end } = found.range;
    if (start.node !== end.node || start.node.nodeType !== 3) {
      return { ok: false, reason: "spans_nodes" };
    }
    const text = start.node as AnchorNode & { data: string };
    if (text.data.slice(start.offset, end.offset) !== edit.before) {
      return { ok: false, reason: "whitespace" };
    }
    const change = changedRegion(edit);
    const prefix = codePoints(edit.before)
      .slice(0, change.from - edit.start)
      .join("");
    const at = start.offset + prefix.length;
    return {
      ok: true,
      located: {
        text,
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
 * attribute, IDs included, and every comment) and the same text nodes, each with its exact data,
 * except the changed ones, whose data is the old data with the raw range replaced.
 */
export function onlyChanged(old: Element, next: Element, changes: readonly NodeChange[]): boolean {
  if (skeleton(old) !== skeleton(next)) return false;
  if (commentsOf(old).join("\u0000") !== commentsOf(next).join("\u0000")) return false;
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

function commentsOf(root: Node): string[] {
  const found: string[] = [];
  const visit = (node: Node) => {
    if (node.nodeType === 8) found.push((node as Comment).data);
    for (const child of Array.from(node.childNodes)) visit(child);
  };
  // For a whole document, comments before and after the root element count too.
  const document = root.ownerDocument;
  visit(document && document.documentElement === root ? document : root);
  return found;
}
