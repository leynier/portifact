// Element anchors on the server (decision 0027, "Previews"): the selectors of an element anchor are
// in the restricted grammar of `isSafeSelector` (type, `#id`, `.class`, a stable attribute with a
// quoted value and `:nth-of-type(n)`, joined by descendant or child combinators), so this small
// matcher reads them on a parse5 tree with the browser's meaning: a selector is matched against
// the whole document and a query returns the matching descendants of its root in document order.
// Nothing else is supported, and a selector outside the grammar matches nothing.
import { isSafeSelector } from "@portifact/contracts";
import type { DefaultTreeAdapterMap } from "parse5";

// Its own tree helpers, so `html-dom.ts`, which uses this module, is not imported back.
type P5Node = DefaultTreeAdapterMap["node"];
type P5Element = DefaultTreeAdapterMap["element"];
const HTML_NS = "http://www.w3.org/1999/xhtml";
const isElement = (node: P5Node): node is P5Element => "tagName" in node;
const childrenOf = (node: P5Node): P5Node[] =>
  "childNodes" in node ? (node.childNodes as P5Node[]) : [];
const parentOf = (node: P5Node): P5Node | null =>
  (node as { parentNode?: P5Node | null }).parentNode ?? null;

interface Compound {
  tag: string | null;
  ids: string[];
  classes: string[];
  attributes: { name: string; value: string }[];
  nth: number | null;
}

interface Selector {
  /** Left to right. */
  compounds: Compound[];
  /** `combinators[i]` joins `compounds[i]` and `compounds[i + 1]`. */
  combinators: ("child" | "descendant")[];
}

const IDENT = /^-?[A-Za-z_][A-Za-z0-9_-]*/;
const TAG = /^[a-z][a-z0-9-]*/;

/** Splits a selector at its combinators, never inside a quoted attribute value. */
function split(selector: string): { parts: string[]; combinators: Selector["combinators"] } {
  const parts: string[] = [];
  const combinators: Selector["combinators"] = [];
  let current = "";
  let quoted = false;
  for (let at = 0; at < selector.length; at++) {
    const char = selector[at] as string;
    if (char === '"') quoted = !quoted;
    if (!quoted && char === " ") {
      parts.push(current);
      current = "";
      if (selector.slice(at, at + 3) === " > ") {
        combinators.push("child");
        at += 2;
      } else {
        combinators.push("descendant");
      }
      continue;
    }
    current += char;
  }
  parts.push(current);
  return { parts, combinators };
}

function compound(text: string): Compound | null {
  const result: Compound = { tag: null, ids: [], classes: [], attributes: [], nth: null };
  let rest = text;
  const tag = TAG.exec(rest);
  if (tag) {
    result.tag = tag[0];
    rest = rest.slice(tag[0].length);
  }
  while (rest.length > 0) {
    if (rest[0] === "#" || rest[0] === ".") {
      const ident = IDENT.exec(rest.slice(1));
      if (!ident) return null;
      (rest[0] === "#" ? result.ids : result.classes).push(ident[0]);
      rest = rest.slice(1 + ident[0].length);
    } else if (rest[0] === "[") {
      const match = /^\[([a-z-]+)="([^"]*)"\]/.exec(rest);
      if (!match) return null;
      result.attributes.push({ name: match[1] as string, value: match[2] as string });
      rest = rest.slice(match[0].length);
    } else {
      const match = /^:nth-of-type\(([1-9][0-9]*)\)/.exec(rest);
      if (!match || result.nth !== null) return null;
      result.nth = Number(match[1]);
      rest = rest.slice(match[0].length);
    }
  }
  return result;
}

/** A selector of the anchors' grammar, read; null for anything else. */
export function parseSelector(selector: string): Selector | null {
  if (!isSafeSelector(selector)) return null;
  const { parts, combinators } = split(selector);
  const compounds: Compound[] = [];
  for (const part of parts) {
    const read = compound(part);
    if (!read) return null;
    compounds.push(read);
  }
  return { compounds, combinators };
}

const attributeOf = (element: P5Element, name: string): string | null =>
  element.attrs.find((attr) => attr.name === name && !attr.namespace)?.value ?? null;

/** The element's place among its siblings of the same tag, from 1. */
function typeIndex(element: P5Element): number {
  const parent = parentOf(element);
  if (!parent) return 1;
  let index = 0;
  for (const sibling of childrenOf(parent)) {
    if (isElement(sibling) && sibling.tagName === element.tagName) index++;
    if (sibling === element) return index;
  }
  return index;
}

function matchesCompound(element: P5Element, part: Compound): boolean {
  // Only HTML elements: the anchors' type selectors are lowercase HTML names.
  if (element.namespaceURI !== HTML_NS) return false;
  if (part.tag !== null && element.tagName !== part.tag) return false;
  if (part.ids.length > 0 && part.ids.some((id) => attributeOf(element, "id") !== id)) {
    return false;
  }
  if (part.classes.length > 0) {
    const classes = (attributeOf(element, "class") ?? "").split(/[\t\n\f\r ]+/);
    if (part.classes.some((name) => !classes.includes(name))) return false;
  }
  for (const { name, value } of part.attributes) {
    if (attributeOf(element, name) !== value) return false;
  }
  return part.nth === null || typeIndex(element) === part.nth;
}

const parentElement = (node: P5Node): P5Element | null => {
  const parent = parentOf(node);
  return parent && isElement(parent) ? parent : null;
};

/** Whether `element` matches the selector's compounds up to `index`, right to left. */
function matchesFrom(element: P5Element, selector: Selector, index: number): boolean {
  if (!matchesCompound(element, selector.compounds[index] as Compound)) return false;
  if (index === 0) return true;
  if (selector.combinators[index - 1] === "child") {
    const parent = parentElement(element);
    return parent !== null && matchesFrom(parent, selector, index - 1);
  }
  for (let ancestor = parentElement(element); ancestor; ancestor = parentElement(ancestor)) {
    if (matchesFrom(ancestor, selector, index - 1)) return true;
  }
  return false;
}

export function matches(element: P5Element, selector: Selector): boolean {
  return matchesFrom(element, selector, selector.compounds.length - 1);
}

/**
 * The descendants of `root` that match `selector`, in document order, as `querySelectorAll` gives
 * them: the selector is read against the whole document, so a path that starts above the root
 * still matches. Iterative, so a deep page cannot exhaust the stack.
 */
export function querySelectorAll(root: P5Node, selector: string): P5Element[] {
  const parsed = parseSelector(selector);
  if (!parsed) return [];
  const found: P5Element[] = [];
  const stack: P5Node[] = [...childrenOf(root)].reverse();
  while (stack.length > 0) {
    const node = stack.pop() as P5Node;
    if (!isElement(node)) continue;
    if (matches(node, parsed)) found.push(node);
    const children = childrenOf(node);
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push(children[index] as P5Node);
    }
  }
  return found;
}
