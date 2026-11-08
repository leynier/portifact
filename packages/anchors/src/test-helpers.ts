// Shared helpers for tests that run anchors against a real DOM implementation (happy-dom).
import { type Document, Window } from "happy-dom";
import type { AnchorElement, AnchorNode, DomPoint, DomRange } from "./dom.ts";
import { normalizeText } from "./normalize.ts";

export interface Page {
  readonly document: Document;
  /** Typed as the anchors' DOM surface without a cast, which proves happy-dom satisfies it. */
  readonly body: AnchorElement;
}

export function page(html: string): Page {
  const { document } = new Window({ url: "https://k7d2qm4xab.portifact.dev/" });
  document.body.innerHTML = html;
  return { document, body: document.body };
}

/** Text nodes under a node in document order. */
export function textNodes(root: AnchorNode): AnchorNode[] {
  const found: AnchorNode[] = [];
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === 3) found.push(child);
    else found.push(...textNodes(child));
  }
  return found;
}

/** The point `offset` UTF-16 units after the start of the first text node containing `needle`. */
export function at(root: AnchorNode, needle: string, offset = 0): DomPoint {
  for (const node of textNodes(root)) {
    const index = (node as unknown as { data: string }).data.indexOf(needle);
    if (index >= 0) return { node, offset: index + offset };
  }
  throw new Error(`no text node contains ${needle}`);
}

/** The normalized text a DOM range covers, as the browser's own Range reports it. */
export function rangeText(document: Document, range: DomRange): string {
  const domRange = document.createRange();
  domRange.setStart(range.start.node as never, range.start.offset);
  domRange.setEnd(range.end.node as never, range.end.offset);
  return normalizeText(domRange.toString());
}
