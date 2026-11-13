// What a target is, beyond its text (decision 0027, "Suggestions and new versions"): each element
// from the text node up to the document's root, with its attributes (positional block numbers left
// out, long values by their SHA-256) and, for a link, its effective destination; and every link
// around or inside a change, as the person is shown it. A carry or a closure counts only when the
// identity is the same, so a hidden body or a changed root is a changed target. Elements are read
// by the browser's namespace rules: only an HTML `base` sets the document's base URL, and only
// HTML `a` and `area` and SVG `a` are links.
import { type Destination, PLAN_LIMITS } from "@portifact/contracts";
import { sha256HexSync } from "./digest.ts";
import { type DestinationAt, destination } from "./display.ts";
import {
  HTML_NS,
  isElement,
  type P5Document,
  type P5Element,
  type P5Node,
  parentOf,
  walk,
} from "./html-dom.ts";
import type { Work } from "./work.ts";

/** Attributes the renderer numbers by position, which move when an earlier block is added. */
const POSITIONAL = new Set(["data-pf-block"]);
const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK = "http://www.w3.org/1999/xlink";

/** How a page's links resolve, and in which stored file their attributes sit. */
export interface LinkContext {
  /** The page's base URL: its first HTML `base` element's when a browser honours it, else its own. */
  base: string;
  file: "source" | "rendered";
}

/** Schemes HTML refuses for a document's base URL: a base with one is ignored. */
const IGNORED_BASE_SCHEMES = new Set(["javascript:", "data:"]);

/**
 * A page's link context, by HTML's rule for a document's base URL: the first HTML `base` with an
 * `href` decides, a later one never does, and when that URL cannot be parsed against the page's
 * or its scheme is `javascript` or `data`, the base is the page's own URL, as in a browser.
 */
export function linkContext(
  document: P5Document,
  pageUrl: string,
  file: LinkContext["file"],
): LinkContext {
  for (const node of walk(document)) {
    if (!isElement(node) || node.tagName !== "base" || node.namespaceURI !== HTML_NS) continue;
    const href = node.attrs.find((attr) => attr.name === "href" && !attr.namespace);
    if (!href) continue;
    try {
      const url = new URL(href.value, pageUrl);
      return { base: IGNORED_BASE_SCHEMES.has(url.protocol) ? pageUrl : url.href, file };
    } catch {
      return { base: pageUrl, file };
    }
  }
  return { base: pageUrl, file };
}

/** A link's destination attribute: `href` on HTML `a` and `area`, `href` or `xlink:href` on SVG `a`. */
function hrefOf(element: P5Element): { name: string; value: string } | null {
  const html =
    element.namespaceURI === HTML_NS && (element.tagName === "a" || element.tagName === "area");
  const svg = element.namespaceURI === SVG_NS && element.tagName === "a";
  if (!html && !svg) return null;
  const plain = element.attrs.find((attr) => attr.name === "href" && !attr.namespace);
  if (plain) return { name: "href", value: plain.value };
  const xlink = svg
    ? element.attrs.find((attr) => attr.name === "href" && attr.namespace === XLINK)
    : undefined;
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

/**
 * Identity entries per element, built once per parsed page: an element's entry, its long values
 * hashed (counted in `Work.hashes`), is the same for every text node beneath it.
 */
export class IdentityCache {
  private readonly entries = new Map<P5Element, string>();

  constructor(
    readonly context: LinkContext,
    private readonly work: Work,
  ) {}

  private compact(value: string): string {
    if (value.length <= PLAN_LIMITS.identityValueUnits) return value;
    this.work.hashes++;
    return `sha256:${sha256HexSync(value)}`;
  }

  private entry(element: P5Element): string {
    const cached = this.entries.get(element);
    if (cached !== undefined) return cached;
    const attrs = element.attrs
      .filter((attr) => !POSITIONAL.has(attr.name))
      .map(
        (attr) =>
          `${attr.namespace ?? ""}:${attr.name}=${JSON.stringify(this.compact(attr.value))}`,
      )
      .sort();
    const link = linkOf(element, this.context);
    if (link) attrs.push(`effective=${this.compact(link.effective)}`);
    const entry = `${element.tagName}[${attrs.join(",")}]`;
    this.entries.set(element, entry);
    return entry;
  }

  /** The identity of a text node: every element from its parent up to the root. */
  of(node: P5Node): string[] {
    const chain: string[] = [];
    for (let parent = parentOf(node); parent && isElement(parent); parent = parentOf(parent)) {
      chain.push(this.entry(parent));
    }
    return chain;
  }
}

/** Every link on the nodes of a selected interval, or around them, each element once, in order. */
export function linksAroundAll(nodes: readonly P5Node[], context: LinkContext): Destination[] {
  const seen = new Set<P5Element>();
  const found: Destination[] = [];
  const consider = (element: P5Element) => {
    if (seen.has(element)) return;
    seen.add(element);
    const link = linkOf(element, context);
    if (link) found.push(link);
  };
  for (const node of nodes) {
    if (isElement(node)) consider(node);
    for (let parent = parentOf(node); parent && isElement(parent); parent = parentOf(parent)) {
      consider(parent);
    }
  }
  return found;
}

export const sameIdentity = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((part, index) => part === b[index]);
