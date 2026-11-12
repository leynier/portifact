// Pages as the planners read them (decision 0027): parsed by parse5, the production parser, with
// source locations and scripting enabled (as browsers parse a page that may run scripts, so
// `noscript` is raw text), never run. Every kind goes through it: an HTML file as stored, a
// document as its stored rendering. The parse5 tree is given to `packages/anchors` through a
// small adapter with the DOM surface anchors need, so positions mean exactly what they mean in the
// bridge, which anchors the page's `body`.
import { type AnchorElement, type AnchorNode, isSkipped } from "@portifact/anchors";
import { type DefaultTreeAdapterMap, parse } from "parse5";
import type { Work } from "./work.ts";

export type P5Node = DefaultTreeAdapterMap["node"];
export type P5Element = DefaultTreeAdapterMap["element"];
export type P5Text = DefaultTreeAdapterMap["textNode"];
export type P5Document = DefaultTreeAdapterMap["document"];

export const HTML_NS = "http://www.w3.org/1999/xhtml";

export interface ParsedHtml {
  document: P5Document;
  /** Parse error codes the parser reported (its recovery rules applied). */
  errors: string[];
}

export function parseHtml(html: string, work: Work): ParsedHtml {
  work.parses++;
  const errors: string[] = [];
  const document = parse(html, {
    sourceCodeLocationInfo: true,
    scriptingEnabled: true,
    onParseError: (error) => errors.push(error.code),
  });
  return { document, errors };
}

export const isElement = (node: P5Node): node is P5Element => "tagName" in node;
export const isText = (node: P5Node): node is P5Text => node.nodeName === "#text";

export function childrenOf(node: P5Node): P5Node[] {
  return "childNodes" in node ? (node.childNodes as P5Node[]) : [];
}

export const parentOf = (node: P5Node): P5Node | null =>
  (node as { parentNode?: P5Node | null }).parentNode ?? null;

export function attribute(element: P5Element, name: string): string | null {
  return element.attrs.find((attr) => attr.name === name && !attr.namespace)?.value ?? null;
}

/**
 * Every node in document order, iteratively (a deep tree must not exhaust the stack). Template
 * contents are not children in parse5 and are not walked: the subset refuses every `template`,
 * and previews drop them.
 */
export function* walk(root: P5Node): Generator<P5Node> {
  const stack: P5Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as P5Node;
    yield node;
    const children = childrenOf(node);
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push(children[index] as P5Node);
    }
  }
}

export function find(node: P5Node, tag: string): P5Element | undefined {
  for (const each of walk(node)) if (isElement(each) && each.tagName === tag) return each;
  return undefined;
}

/** Adapter nodes, one per parse5 node, so identity is kept across anchors' walks. */
const adapters = new WeakMap<P5Node, AdaptedNode>();

class AdaptedNode implements AnchorElement {
  constructor(readonly node: P5Node) {}

  get nodeType(): number {
    if (isElement(this.node)) return 1;
    if (isText(this.node)) return 3;
    return this.node.nodeName === "#comment" ? 8 : 9;
  }

  get parentNode(): AnchorNode | null {
    const parent = parentOf(this.node);
    return parent ? adapt(parent) : null;
  }

  get childNodes(): AnchorNode[] {
    return childrenOf(this.node).map(adapt);
  }

  get tagName(): string {
    return isElement(this.node) ? this.node.tagName.toUpperCase() : "";
  }

  get data(): string {
    return isText(this.node) ? this.node.value : "";
  }

  getAttribute(name: string): string | null {
    return isElement(this.node) ? attribute(this.node, name) : null;
  }

  querySelectorAll(): ArrayLike<AnchorElement> {
    // Element anchors are not resolved on the server: the planners only resolve text.
    return [];
  }
}

export function adapt(node: P5Node): AdaptedNode {
  let adapted = adapters.get(node);
  if (!adapted) {
    adapted = new AdaptedNode(node);
    adapters.set(node, adapted);
  }
  return adapted;
}

export const unwrap = (node: AnchorNode): P5Node => (node as AdaptedNode).node;

/** Every text node under a node, in document order. */
export function textNodesOf(node: P5Node): P5Text[] {
  const found: P5Text[] = [];
  for (const each of walk(node)) if (isText(each)) found.push(each);
  return found;
}

/**
 * The text nodes a page shows, by the anchors' own rules (`isSkipped`): under `body`, outside
 * unshown elements (scripts, styles, templates, embedded content and the like), `hidden`
 * subtrees and Portifact's chrome (`data-portifact-ignore`). A hidden body or root shows nothing.
 * Comments, attributes and scripts are never text nodes here, so hidden syntax proves nothing.
 */
export function shownTextNodes(body: P5Element): P5Text[] {
  for (let node: P5Node | null = body; node; node = parentOf(node)) {
    if (isElement(node) && isSkipped(adapt(node))) return [];
  }
  const found: P5Text[] = [];
  const stack: P5Node[] = [...childrenOf(body)].reverse();
  while (stack.length > 0) {
    const node = stack.pop() as P5Node;
    if (isText(node)) {
      found.push(node);
      continue;
    }
    if (isElement(node) && isSkipped(adapt(node))) continue;
    const children = childrenOf(node);
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push(children[index] as P5Node);
    }
  }
  return found;
}

/**
 * Everything about a document but its text nodes' text: the doctype, every element with its
 * namespace and sorted attributes, every comment, and the text of `title` and `style`. A comment,
 * an attribute (a heading ID included) or an element that changes is a change outside the edited
 * text.
 */
export function skeleton(document: P5Document): string {
  const parts: string[] = [];
  for (const node of walk(document)) {
    if (node.nodeName === "#documentType") {
      parts.push(`<!doctype ${(node as { name: string }).name}>`);
    } else if (node.nodeName === "#comment") {
      parts.push(`<!--${JSON.stringify((node as { data: string }).data)}-->`);
    } else if (isText(node)) {
      const parent = parentOf(node);
      const raw = parent && isElement(parent) && ["title", "style"].includes(parent.tagName);
      parts.push(raw ? JSON.stringify(node.value) : "#");
    } else if (isElement(node)) {
      const attributes = node.attrs
        .map((attr) => `${attr.namespace ?? ""}:${attr.name}=${JSON.stringify(attr.value)}`)
        .sort()
        .join(" ");
      const depth = depthOf(node);
      parts.push(`${depth}<${node.namespaceURI}|${node.tagName} ${attributes}>`);
    }
  }
  return parts.join("");
}

function depthOf(node: P5Node): number {
  let depth = 0;
  for (let parent = parentOf(node); parent; parent = parentOf(parent)) depth++;
  return depth;
}
