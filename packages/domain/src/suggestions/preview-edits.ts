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

/**
 * What a structure operation does to the built copy: its element moved before or after another
 * element, copied right after itself, or removed. Never new markup.
 */
export interface StructureEdit {
  kind: "move" | "duplicate" | "remove";
  path: NodePath;
  /** A move's destination and on which side of it the element goes. */
  destination: { path: NodePath; place: "before" | "after" } | null;
}

export type ElementEdit = StyleEdit | StructureEdit;

/**
 * Why a preview of element operations cannot be built: an element is not on the stored page, or
 * a move goes into the element itself or a removed element.
 */
export type ElementPreviewRefusal = "element_not_found" | "structure_conflict";

/** Whether `node` is `ancestor` or inside it. */
function within(node: P5Node, ancestor: P5Node): boolean {
  for (let at: P5Node | null = node; at; at = parentOf(at)) if (at === ancestor) return true;
  return false;
}

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
  const exact = (anchor: ElementAnchor): P5Node | null => {
    const resolved = anchors.resolveElement(anchor);
    return resolved.confidence === "exact" ? unwrap(resolved.element) : null;
  };
  for (const operation of elementOperations(operations)) {
    const element = exact(operation.target.anchor as ElementAnchor);
    if (!element) return "element_not_found";
    const path = pathOf(element);
    if (operation.kind === "structure") {
      if (operation.action !== "move") {
        edits.push({ kind: operation.action, path, destination: null });
        continue;
      }
      const destination = exact(operation.destination.target.anchor as ElementAnchor);
      if (!destination) return "element_not_found";
      // An element cannot go next to itself or into itself.
      if (within(destination, element)) return "structure_conflict";
      edits.push({
        kind: "move",
        path,
        destination: { path: pathOf(destination), place: operation.destination.place },
      });
    } else if (operation.kind === "style") {
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

/** A copy of a parsed node and everything under it, outside the tree. */
function copyOf(node: P5Node): P5Node {
  if (!("tagName" in node)) {
    return { ...node, parentNode: null } as P5Node;
  }
  const element: P5Element = {
    ...node,
    attrs: node.attrs.map((attr) => ({ ...attr })),
    childNodes: [],
    parentNode: null,
  };
  for (const child of node.childNodes as P5Node[]) {
    const copy = copyOf(child);
    (copy as { parentNode: P5Node | null }).parentNode = element;
    element.childNodes.push(copy as P5Element["childNodes"][number]);
  }
  return element;
}

function detach(node: P5Node): void {
  const parent = parentOf(node);
  if (!parent) return;
  const siblings = childrenOf(parent);
  siblings.splice(siblings.indexOf(node), 1);
  (node as { parentNode: P5Node | null }).parentNode = null;
}

function insertNextTo(node: P5Node, reference: P5Node, place: "before" | "after"): void {
  const parent = parentOf(reference) as P5Node;
  const siblings = childrenOf(parent);
  siblings.splice(siblings.indexOf(reference) + (place === "after" ? 1 : 0), 0, node);
  (node as { parentNode: P5Node | null }).parentNode = parent;
}

/**
 * Makes a structure operation on the parsed copy, with its elements found before any operation
 * ran; false when it cannot (a move into its own element, or next to an element already removed),
 * so the preview is refused rather than shown partly.
 */
export function applyStructure(
  edit: StructureEdit,
  element: P5Element,
  destination: P5Element | null,
): boolean {
  if (edit.kind === "remove") {
    if (!parentOf(element)) return false;
    detach(element);
    return true;
  }
  if (edit.kind === "duplicate") {
    if (!parentOf(element)) return false;
    insertNextTo(copyOf(element), element, "after");
    return true;
  }
  if (!destination || !edit.destination || !parentOf(destination)) return false;
  if (within(destination, element)) return false;
  detach(element);
  insertNextTo(element, destination, edit.destination.place);
  return true;
}
