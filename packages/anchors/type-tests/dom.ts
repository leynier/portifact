// Compile-time proof that real browser DOM objects satisfy the structural types in `src/dom.ts`,
// so the review bridge can pass `document.body` and `Selection` ranges without casts.
import { AnchorDocument, type DomRange } from "../src/index.ts";

export function fromSelection(selection: Selection): DomRange | undefined {
  if (selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  return {
    start: { node: range.startContainer, offset: range.startOffset },
    end: { node: range.endContainer, offset: range.endOffset },
  };
}

export function anchorSelection(body: HTMLElement, selection: Selection) {
  const range = fromSelection(selection);
  return range ? new AnchorDocument(body).createTextAnchor(range) : undefined;
}

export function anchorElement(body: HTMLElement, element: Element) {
  return new AnchorDocument(body).createElementAnchor(element);
}
