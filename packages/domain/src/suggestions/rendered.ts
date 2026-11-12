// A version's page as closure and relocation read it (decision 0027, "Suggestions and new
// versions" and "Closing by itself"): the text nodes the page built from the stored file shows,
// each with its identity. Text a page does not show (comments, attributes, reference definitions,
// scripts, Portifact's own chrome) is never one of them, so hidden syntax can never prove anything.
import { type DocumentRenderer, type FileKind, PLAN_LIMITS } from "@portifact/contracts";
import { find, type P5Element, parseHtml, shownTextNodes } from "./html-dom.ts";
import { identityOf, linkContext } from "./identity.ts";
import { PageIndex } from "./locate.ts";
import type { Work } from "./work.ts";

export interface RenderedNode {
  data: string;
  identity: string[];
}

export interface RenderedPage {
  nodes: RenderedNode[];
  /**
   * Whether node edges mean something. In a text document the one node is the whole file, whose
   * edges are not a boundary of the target, and all of its text is shown.
   */
  anchored: boolean;
  /** The normalized page text, in anchor code points. */
  points: string[];
}

export interface PageOptions {
  /** The title stored renderings use (documents only). */
  title: string;
  pageUrl: string;
  renderer: DocumentRenderer;
  work: Work;
}

/** The page a stored file is served as: an HTML file itself, a document's stored rendering. */
export function pageHtml(kind: FileKind, source: string, options: PageOptions): string {
  if (kind === "html") return source;
  options.work.renders++;
  const files = options.renderer.stored(kind, source, { title: options.title, sourceSha256: "" });
  return (files[0] as { text: string }).text;
}

export function renderedPage(kind: FileKind, source: string, options: PageOptions): RenderedPage {
  const { work } = options;
  const parsed = parseHtml(pageHtml(kind, source, options), work);
  // The parser always adds a body.
  const body = find(parsed.document, "body") as P5Element;
  const links = linkContext(
    parsed.document,
    options.pageUrl,
    kind === "html" ? "source" : "rendered",
  );
  return {
    nodes: shownTextNodes(body).map((node) => ({
      data: node.value,
      identity: identityOf(node, links),
    })),
    anchored: kind !== "text",
    points: new PageIndex(body, work).points,
  };
}

/** The node-local context window the planners keep on each side. */
export const CONTEXT_WINDOW = PLAN_LIMITS.proofContextUnits;

/** Where `needle` occurs across the page's text nodes, each match inside one node. */
export function matches(page: RenderedPage, needle: string): { node: number; at: number }[] {
  const found: { node: number; at: number }[] = [];
  page.nodes.forEach((node, index) => {
    for (let at = node.data.indexOf(needle); at >= 0; at = node.data.indexOf(needle, at + 1)) {
      found.push({ node: index, at });
    }
  });
  return found;
}

/**
 * Where `left + middle + right` occurs across the page's text nodes, each match inside one node.
 * Context shorter than its window means the change was that close to the node's edge, so the
 * match must sit at the node's edge too: a sentence quoted inside a longer node, such as a comment
 * shown as text, does not count.
 */
export function anchoredMatches(
  page: RenderedPage,
  left: string,
  middle: string,
  right: string,
): { node: number; at: number }[] {
  const needle = left + middle + right;
  return matches(page, needle).filter(({ node, at }) => {
    const data = (page.nodes[node] as RenderedNode).data;
    const startOk = !page.anchored || left.length >= CONTEXT_WINDOW || at === 0;
    const endOk =
      !page.anchored || right.length >= CONTEXT_WINDOW || at + needle.length === data.length;
    return startOk && endOk;
  });
}
