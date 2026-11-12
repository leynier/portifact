// What a target is, beyond its text (decision 0027, "Suggestions and new versions"): each element
// from the text node up to the document's root, with its attributes (positional block numbers left
// out, long values by their SHA-256) and, for a link, its effective destination; and every link
// around a change, as the person is shown it. A carry or a closure counts only when the identity
// is the same, so a hidden body or a changed root is a changed target.
import { type Destination, PLAN_LIMITS } from "@portifact/contracts";
import { sha256HexSync } from "./digest.ts";
import { type DestinationAt, destination } from "./display.ts";
import {
  isElement,
  type P5Document,
  type P5Element,
  type P5Node,
  parentOf,
  walk,
} from "./html-dom.ts";

/** Attributes the renderer numbers by position, which move when an earlier block is added. */
const POSITIONAL = new Set(["data-pf-block"]);
const XLINK = "http://www.w3.org/1999/xlink";

/** How a page's links resolve, and in which stored file their attributes sit. */
export interface LinkContext {
  /** The page's base URL (its `base` element's, else its own), null when it cannot be read. */
  base: string | null;
  file: "source" | "rendered";
}

/** A page's link context: the first `base` with an `href` decides the base URL, as browsers do. */
export function linkContext(
  document: P5Document,
  pageUrl: string,
  file: LinkContext["file"],
): LinkContext {
  for (const node of walk(document)) {
    if (!isElement(node) || node.tagName !== "base") continue;
    const href = node.attrs.find((attr) => attr.name === "href" && !attr.namespace);
    if (!href) continue;
    try {
      return { base: new URL(href.value, pageUrl).href, file };
    } catch {
      return { base: null, file };
    }
  }
  return { base: pageUrl, file };
}

/** A link element's destination attribute: `href`, or `xlink:href` on an SVG link. */
function hrefOf(element: P5Element): { name: string; value: string } | null {
  if (element.tagName !== "a" && element.tagName !== "area") return null;
  const plain = element.attrs.find((attr) => attr.name === "href" && !attr.namespace);
  if (plain) return { name: "href", value: plain.value };
  const xlink = element.attrs.find((attr) => attr.name === "href" && attr.namespace === XLINK);
  return xlink ? { name: "xlink:href", value: xlink.value } : null;
}

/** Where the attribute (`name=value`) holding a value sits in the parsed file. */
function valueAt(element: P5Element, name: string, file: LinkContext["file"]): DestinationAt {
  const location = element.sourceCodeLocation?.attrs?.[name];
  return location ? { file, start: location.startOffset, end: location.endOffset } : null;
}

/** A link element's destination as the person is shown it, or null for any other element. */
export function linkOf(element: P5Element, context: LinkContext): Destination | null {
  const href = hrefOf(element);
  if (!href) return null;
  return destination(href.value, context.base, valueAt(element, href.name, context.file));
}

const compactValue = (value: string) =>
  value.length > PLAN_LIMITS.identityValueUnits ? `sha256:${sha256HexSync(value)}` : value;

export function identityOf(node: P5Node, context: LinkContext): string[] {
  const chain: string[] = [];
  for (let parent = parentOf(node); parent && isElement(parent); parent = parentOf(parent)) {
    const attrs = parent.attrs
      .filter((attr) => !POSITIONAL.has(attr.name))
      .map(
        (attr) =>
          `${attr.namespace ?? ""}:${attr.name}=${JSON.stringify(compactValue(attr.value))}`,
      )
      .sort();
    const link = linkOf(parent, context);
    if (link) attrs.push(`effective=${compactValue(link.effective)}`);
    chain.push(`${parent.tagName}[${attrs.join(",")}]`);
  }
  return chain;
}

/** Every link around any of the nodes, each element once, in the order first met. */
export function linksAroundAll(nodes: readonly P5Node[], context: LinkContext): Destination[] {
  const seen = new Set<P5Element>();
  const found: Destination[] = [];
  for (const node of nodes) {
    for (let parent = parentOf(node); parent && isElement(parent); parent = parentOf(parent)) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      const link = linkOf(parent, context);
      if (link) found.push(link);
    }
  }
  return found;
}

export const sameIdentity = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((part, index) => part === b[index]);
