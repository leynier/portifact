// Style and structure operations on a built preview (decision 0027, "Previews"): the elements an
// edit names are found on the page built from the stored file, by the element anchors' own rules
// (`AnchorDocument.resolveElement` over the parse5 tree, exact matches only), before anything is
// written; the change is then made to the parsed tree of the page the preview shows, and the
// preview is written from it as from any other tree, so nothing the operations name can load or
// run. A preview is a hint for the person, never a promise of how the live page looks, and these
// operations are never applied to a file.
import { AnchorDocument, type AnchorElement } from "@portifact/anchors";
import { checkStyle, type EditOperation, type ElementAnchor } from "@portifact/contracts";
import {
  adapt,
  childrenOf,
  find,
  type P5Document,
  type P5Element,
  type P5Node,
  parentOf,
  parseHtml,
  unwrap,
} from "./html-dom.ts";
import type { Work } from "./work.ts";

/** A place in a parsed page: the child indexes from the document down to the element. */
type NodePath = readonly number[];

/** What a style operation does to its element in a preview: declarations on its `style`. */
export interface StyleEdit {
  kind: "style";
  path: NodePath;
  declarations: readonly { property: string; value: string }[];
}

export type ElementEdit = StyleEdit;

/** Why a preview of element operations cannot be built. */
export type ElementPreviewRefusal = "element_not_found";

function pathOf(node: P5Node): number[] {
  const path: number[] = [];
  for (let at: P5Node = node, parent = parentOf(at); parent; at = parent, parent = parentOf(at)) {
    path.unshift(childrenOf(parent).indexOf(at));
  }
  return path;
}

/** The element at `path` in a parsed page, or null when the page has no element there. */
export function elementAt(document: P5Document, path: NodePath): P5Element | null {
  let node: P5Node = document;
  for (const index of path) {
    const next: P5Node | undefined = childrenOf(node)[index];
    if (!next) return null;
    node = next;
  }
  return "tagName" in node ? node : null;
}

const elementOperations = (operations: readonly EditOperation[]) =>
  operations.filter((operation) => operation.kind !== "text");

/** Whether an edit holds any operation a preview shows on an element. */
export const hasElementOperations = (operations: readonly EditOperation[]): boolean =>
  elementOperations(operations).length > 0;

/**
 * Where each style and structure operation's element is on `html` (the page built from the stored
 * file), or a refusal when one of them is not found there exactly, with its tag and text: an
 * element the live page's scripts drew, or that changed, has no place in the stored file.
 */
export function locateElementEdits(
  html: string,
  operations: readonly EditOperation[],
  work: Work,
): ElementEdit[] | ElementPreviewRefusal {
  const parsed = parseHtml(html, work);
  const body = find(parsed.document, "body") as P5Element;
  work.indexes++;
  const anchors = new AnchorDocument(adapt(body) as AnchorElement);
  const edits: ElementEdit[] = [];
  for (const operation of elementOperations(operations)) {
    const resolved = anchors.resolveElement(operation.target.anchor as ElementAnchor);
    if (resolved.confidence !== "exact") return "element_not_found";
    const path = pathOf(unwrap(resolved.element));
    if (operation.kind === "style") {
      edits.push({
        kind: "style",
        path,
        // The edit was validated by `Edit` already; a preview never writes outside the grammar.
        declarations: operation.changes
          .filter((change) => checkStyle(change.property, change.after) === true)
          .map((change) => ({ property: change.property, value: change.after })),
      });
    }
  }
  return edits;
}
