// A page as the resolvers see it: parsed without running scripts, its normalized text (the text
// anchors refer to, built by `packages/anchors` exactly as the bridge builds it) and its markup
// skeleton, which is everything about the page except its text.
import { AnchorDocument, type AnchorElement } from "@portifact/anchors";
import { Window } from "happy-dom";

// One window for every parse: a happy-dom window holds timers and listeners until it is closed,
// so a window per parse runs the corpus out of memory.
const window = new Window({ url: "https://k7d2qm4xab.portifact.dev/" });
const parser = new window.DOMParser();

/** Parses a whole HTML document. Scripts never run: the parser builds the tree only. */
export function parseDocument(html: string): Document {
  return parser.parseFromString(html, "text/html") as unknown as Document;
}

/** Parses an HTML fragment (a rendered document body) into a detached `main` element. */
export function parseFragment(html: string): HTMLElement {
  const main = window.document.createElement("main") as unknown as HTMLElement;
  main.innerHTML = html;
  return main;
}

/** The normalized text of `root`, as the bridge computes it for anchors. */
export function pageText(root: Element): string {
  return new AnchorDocument(root as unknown as AnchorElement).text.value;
}

/**
 * Everything about the markup but the text: every element with all of its sorted attributes
 * (heading IDs and highlight spans included: a change to either is a change outside the edited
 * text, decision 0027, rule 6) and the full content of `script`, `style`, `textarea` and `title`.
 */
export function skeleton(root: Element): string {
  const parts: string[] = [];
  const walk = (element: Element) => {
    const tag = element.tagName.toLowerCase();
    const attributes = Array.from(element.attributes)
      .map((attribute) => `${attribute.name}=${JSON.stringify(attribute.value)}`)
      .sort();
    parts.push(`<${tag}${attributes.length > 0 ? ` ${attributes.join(" ")}` : ""}>`);
    if (tag === "script" || tag === "style" || tag === "textarea" || tag === "title") {
      parts.push(JSON.stringify(element.textContent ?? ""));
    }
    for (const child of Array.from(element.children)) walk(child);
    parts.push(`</${tag}>`);
  };
  walk(root);
  return parts.join("");
}

/** Every text node under `root` in document order, with its exact data. */
export function textNodes(root: Node): Text[] {
  const found: Text[] = [];
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) found.push(child as Text);
      else if (child.nodeType === 1) walk(child);
    }
  };
  walk(root);
  return found;
}

/** Code point slicing and splicing, since anchor positions count code points. */
export function codePoints(text: string): string[] {
  return Array.from(text);
}

export function spliceCodePoints(text: string, start: number, end: number, insert: string): string {
  const points = codePoints(text);
  return [...points.slice(0, start), insert, ...points.slice(end)].join("");
}

/** Occurrences of `needle` in `haystack`, overlapping ones included, up to `limit + 1`. */
export function occurrences(haystack: string, needle: string, limit = 2): number[] {
  const found: number[] = [];
  if (needle.length === 0) return found;
  let at = haystack.indexOf(needle);
  while (at >= 0 && found.length <= limit) {
    found.push(at);
    at = haystack.indexOf(needle, at + 1);
  }
  return found;
}
