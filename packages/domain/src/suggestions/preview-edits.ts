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
import { metered, SELECTOR_LIMITS } from "./selector-match.ts";
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
 * Why a preview of element operations cannot be built: an element is not on the stored page, a
 * move goes into the element itself or a removed element, or finding the elements would pass the
 * selector budget (`SELECTOR_LIMITS`).
 */
export type ElementPreviewRefusal =
  | "element_not_found"
  | "structure_conflict"
  | "preview_too_large";

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
  // Metered: the anchors query through the DOM surface. They swallow a query's exception and
  // read it as no match, so the budget is checked after each resolution and a resolution over it
  // is refused, never taken as an answer.
  const exact = (anchor: ElementAnchor): P5Node | ElementPreviewRefusal => {
    const resolved = metered(work, () => anchors.resolveElement(anchor));
    if (work.selectorSteps > SELECTOR_LIMITS.steps) return "preview_too_large";
    return resolved.confidence === "exact" ? unwrap(resolved.element) : "element_not_found";
  };
  for (const operation of elementOperations(operations)) {
    const element = exact(operation.target.anchor as ElementAnchor);
    if (typeof element === "string") return element;
    const path = pathOf(element);
    if (operation.kind === "structure") {
      if (operation.action !== "move") {
        edits.push({ kind: operation.action, path, destination: null });
        continue;
      }
      const destination = exact(operation.destination.target.anchor as ElementAnchor);
      if (typeof destination === "string") return destination;
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

/**
 * What duplicates may add to one preview, all operations together (review of pull request #288):
 * duplicating nested elements from the innermost outward copies earlier copies, so each copy is
 * measured before it is made and the preview is refused (`preview_too_large`) past these.
 */
export const PREVIEW_COPY_LIMITS = { nodes: 10_000, bytes: 256 * 1024 } as const;

/** The copies one preview made so far, against `PREVIEW_COPY_LIMITS`. */
export interface CopyBudget {
  nodes: number;
  bytes: number;
}

export const newCopyBudget = (): CopyBudget => ({ nodes: 0, bytes: 0 });

/** About the bytes a node writes in a preview, without its children. */
function nodeBytes(node: P5Node): number {
  if ("tagName" in node) {
    return (
      node.tagName.length * 2 +
      5 +
      node.attrs.reduce((total, attr) => total + attr.name.length + attr.value.length + 4, 0)
    );
  }
  const value = (node as { value?: string; data?: string }).value ?? "";
  return value.length;
}

/**
 * Whether copying `node` stays within the budget, counted before anything is allocated and
 * stopping as soon as it would pass; the budget is taken only when it fits.
 */
function takeCopy(node: P5Node, budget: CopyBudget): boolean {
  let nodes = budget.nodes;
  let bytes = budget.bytes;
  const stack: P5Node[] = [node];
  while (stack.length > 0) {
    const at = stack.pop() as P5Node;
    nodes += 1;
    bytes += nodeBytes(at);
    if (nodes > PREVIEW_COPY_LIMITS.nodes || bytes > PREVIEW_COPY_LIMITS.bytes) return false;
    for (const child of childrenOf(at)) stack.push(child);
  }
  budget.nodes = nodes;
  budget.bytes = bytes;
  return true;
}

/** A copy of a parsed node and everything under it, outside the tree, made iteratively. */
function copyOf(node: P5Node): P5Node {
  const shallow = (source: P5Node): P5Node =>
    "tagName" in source
      ? ({
          ...source,
          attrs: source.attrs.map((attr) => ({ ...attr })),
          childNodes: [],
          parentNode: null,
        } as P5Node)
      : ({ ...source, parentNode: null } as P5Node);
  const root = shallow(node);
  const stack: [P5Node, P5Node][] = [[node, root]];
  while (stack.length > 0) {
    const [source, copy] = stack.pop() as [P5Node, P5Node];
    for (const child of childrenOf(source)) {
      const childCopy = shallow(child);
      (childCopy as { parentNode: P5Node | null }).parentNode = copy;
      (copy as P5Element).childNodes.push(childCopy as P5Element["childNodes"][number]);
      stack.push([child, childCopy]);
    }
  }
  return root;
}

/** Whether `node` is still in the preview's document: not removed, nor inside a removed element. */
function connected(node: P5Node, document: P5Document): boolean {
  for (let at: P5Node | null = node; at; at = parentOf(at)) if (at === document) return true;
  return false;
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
 * ran. Refused rather than shown partly: `structure_conflict` when an element or a move's
 * destination is no longer in the document (an earlier operation removed it or what holds it) or
 * a move goes into its own element, `preview_too_large` when a duplicate would pass the copy
 * budget.
 */
export function applyStructure(
  edit: StructureEdit,
  element: P5Element,
  destination: P5Element | null,
  document: P5Document,
  budget: CopyBudget,
): "structure_conflict" | "preview_too_large" | null {
  if (!connected(element, document)) return "structure_conflict";
  if (edit.kind === "remove") {
    detach(element);
    return null;
  }
  if (edit.kind === "duplicate") {
    if (!takeCopy(element, budget)) return "preview_too_large";
    insertNextTo(copyOf(element), element, "after");
    return null;
  }
  if (!destination || !edit.destination || !connected(destination, document)) {
    return "structure_conflict";
  }
  if (within(destination, element)) return "structure_conflict";
  detach(element);
  insertNextTo(element, destination, edit.destination.place);
  return null;
}
