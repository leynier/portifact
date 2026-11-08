// Test helper: parses rendered HTML the way a browser does (parse5 implements the WHATWG parser),
// so assertions are about the DOM a visitor gets, not about the string.
import { type DefaultTreeAdapterMap, parse, parseFragment } from "parse5";

type Node = DefaultTreeAdapterMap["node"];
export type Element = DefaultTreeAdapterMap["element"];

function isElement(node: Node): node is Element {
  return "tagName" in node;
}

function children(node: Node): Node[] {
  return "childNodes" in node ? node.childNodes : [];
}

function pushReversed(stack: Node[], nodes: Node[]): void {
  for (let index = nodes.length - 1; index >= 0; index -= 1) stack.push(nodes[index] as Node);
}

/** Every element in document order, iteratively so deep trees cannot overflow the stack. */
export function elements(root: Node): Element[] {
  const found: Element[] = [];
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as Node;
    if (isElement(node)) found.push(node);
    pushReversed(stack, children(node));
  }
  return found;
}

export function fragment(html: string): Node {
  return parseFragment(html);
}

export function document(html: string): Node {
  return parse(html);
}

export function attr(element: Element, name: string): string | undefined {
  return element.attrs.find((a) => a.name === name)?.value;
}

/** Concatenated text of a node, as `textContent` would return it. */
export function text(node: Node): string {
  let out = "";
  const stack: Node[] = [node];
  while (stack.length > 0) {
    const current = stack.pop() as Node;
    if (current.nodeName === "#text" && "value" in current) out += current.value;
    pushReversed(stack, children(current));
  }
  return out;
}

export function byTag(root: Node, tag: string): Element[] {
  return elements(root).filter((element) => element.tagName === tag);
}
