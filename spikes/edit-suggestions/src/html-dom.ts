// HTML as the server reads it (decision 0027): the stored file decoded as UTF-8, parsed by parse5,
// the production parser, with source locations and with scripting enabled (as browsers parse a
// page that may run scripts, so `noscript` is raw text), never run. The parse5 tree is given to
// `packages/anchors` through a small adapter with the DOM surface anchors need, so positions mean
// exactly what they mean in the bridge.

import type { AnchorElement, AnchorNode } from "@portifact/anchors";
import { type DefaultTreeAdapterMap, parse } from "parse5";
import { work } from "./work.ts";

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

export function parseHtml(html: string): ParsedHtml {
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

export function attribute(element: P5Element, name: string): string | null {
  return element.attrs.find((attr) => attr.name === name && !attr.namespace)?.value ?? null;
}

/**
 * Every node in document order. Template contents are not children in parse5 and are not walked:
 * the subset refuses every `template` element, so nothing inside one is ever planned.
 */
export function* walk(node: P5Node): Generator<P5Node> {
  yield node;
  for (const child of childrenOf(node)) yield* walk(child);
}

export function find(node: P5Node, tag: string): P5Element | undefined {
  for (const each of walk(node)) if (isElement(each) && each.tagName === tag) return each;
  return undefined;
}

/** Adapter nodes, one per parse5 node, so identity is kept across anchors' walks. */
const adapters = new WeakMap<P5Node, AdaptedNode>();

class AdaptedNode implements AnchorNode {
  constructor(readonly node: P5Node) {}

  get nodeType(): number {
    if (isElement(this.node)) return 1;
    if (isText(this.node)) return 3;
    return this.node.nodeName === "#comment" ? 8 : 9;
  }

  get parentNode(): AnchorNode | null {
    const parent = (this.node as { parentNode?: P5Node | null }).parentNode;
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
    // Element anchors are not resolved on the server in this spike.
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
 * Everything about the document but the text of the body: the doctype, every element with its
 * namespace and sorted attributes, comments, and the text of `title` and `style`. A comment or an
 * attribute that changes is a change outside the edited text.
 */
export function htmlSkeleton(document: P5Document): string {
  const parts: string[] = [];
  const visit = (node: P5Node, inRawText: boolean) => {
    if (node.nodeName === "#documentType")
      parts.push(`<!doctype ${(node as { name: string }).name}>`);
    else if (node.nodeName === "#comment")
      parts.push(`<!--${JSON.stringify((node as { data: string }).data)}-->`);
    else if (isText(node) && inRawText) parts.push(JSON.stringify(node.value));
    else if (isElement(node)) {
      const attributes = node.attrs
        .map((attr) => `${attr.namespace ?? ""}${attr.name}=${JSON.stringify(attr.value)}`)
        .sort()
        .join(" ");
      parts.push(
        `<${node.namespaceURI === HTML_NS ? "" : `${node.namespaceURI}:`}${node.tagName} ${attributes}>`,
      );
      for (const child of childrenOf(node))
        visit(child, node.tagName === "title" || node.tagName === "style");
      parts.push(`</${node.tagName}>`);
      return;
    }
    if (!isElement(node)) for (const child of childrenOf(node)) visit(child, inRawText);
  };
  visit(document, false);
  return parts.join("");
}
