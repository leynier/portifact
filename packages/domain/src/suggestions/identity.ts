// What a target is, beyond its text (decision 0027, "Suggestions and new versions"): each element
// from the text node up to the body, with its attributes (positional block numbers left out) and,
// for a link, its effective destination; and every link around a change, as the person is shown
// it. A carry or a closure counts only when the identity is the same.
import type { Destination } from "@portifact/contracts";
import { destination } from "./display.ts";
import { attribute, isElement, type P5Node, parentOf } from "./html-dom.ts";

/** Attributes the renderer numbers by position, which move when an earlier block is added. */
const POSITIONAL = new Set(["data-pf-block"]);

export function identityOf(node: P5Node, pageUrl: string): string[] {
  const chain: string[] = [];
  for (let parent = parentOf(node); parent && isElement(parent); parent = parentOf(parent)) {
    if (parent.tagName === "body") break;
    const attrs = parent.attrs
      .filter((attr) => !POSITIONAL.has(attr.name))
      .map((attr) => `${attr.name}=${JSON.stringify(attr.value)}`)
      .sort();
    const href = parent.tagName === "a" ? attribute(parent, "href") : null;
    if (href !== null) attrs.push(`effective=${destination(href, pageUrl).effective}`);
    chain.push(`${parent.tagName}[${attrs.join(",")}]`);
  }
  return chain;
}

/** Every link around a node, innermost first, with its effective destination. */
export function linksAround(node: P5Node, pageUrl: string): Destination[] {
  const found: Destination[] = [];
  for (let parent = parentOf(node); parent && isElement(parent); parent = parentOf(parent)) {
    const href = parent.tagName === "a" ? attribute(parent, "href") : null;
    if (href !== null) found.push(destination(href, pageUrl));
  }
  return found;
}

export const sameIdentity = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((part, index) => part === b[index]);
