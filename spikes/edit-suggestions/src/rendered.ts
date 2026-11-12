// A version's page as closure and relocation read it (decision 0027, rule 5 of the second round):
// the text nodes of the page built from the stored file, each with its identity (the elements
// around it, their attributes and their links' effective destinations). Text that a page does not
// show (comments, attributes, reference definitions, scripts) is never a text node of the body,
// so hidden syntax can never prove anything.
import { normalizeText } from "@portifact/anchors";
import { adapt, find, parseHtml, textNodesOf } from "./html-dom.ts";
import { DEFAULT_PAGE_URL, htmlIdentity } from "./html-resolver.ts";
import { PageIndex } from "./locate.ts";
import { DEFAULT_DOCUMENT_URL, markdownIdentity, renderPage } from "./markdown-resolver.ts";
import { textNodes } from "./page.ts";

export type FileKind = "markdown" | "text" | "html";

export interface RenderedNode {
  data: string;
  identity: string[];
}

export interface RenderedPage {
  nodes: RenderedNode[];
  /**
   * Whether node edges mean something. In a text document the one node is the whole file, whose
   * edges are not a boundary of the target, and all of its text is shown, so there is no hidden
   * syntax to guard against.
   */
  anchored: boolean;
  /** The normalized page text, in anchor code points. */
  text: string;
}

export function renderedPage(kind: FileKind, source: string): RenderedPage {
  if (kind === "markdown") {
    const page = renderPage(source);
    return {
      nodes: textNodes(page.main).map((node) => ({
        data: node.data,
        identity: markdownIdentity(node, DEFAULT_DOCUMENT_URL),
      })),
      text: page.text,
      anchored: true,
    };
  }
  if (kind === "text") {
    // The page is the source in one `<pre>`; the parser turns CRLF and CR into LF.
    const data = source.replace(/\r\n?/g, "\n");
    return {
      nodes: [{ data, identity: ['pre[class="pf-text"]'] }],
      text: normalizeText(source),
      anchored: false,
    };
  }
  const body = find(parseHtml(source).document, "body");
  if (!body) return { nodes: [], text: "", anchored: true };
  return {
    nodes: textNodesOf(body).map((node) => ({
      data: node.value,
      identity: htmlIdentity(node, DEFAULT_PAGE_URL),
    })),
    text: new PageIndex(adapt(body)).points.join(""),
    anchored: true,
  };
}

/**
 * Where `left + middle + right` occurs across the page's text nodes, each match inside one node.
 * Context shorter than its 32-unit window means the change was that close to the node's edge, so
 * the match must sit at the node's start (or end) too: a sentence quoted inside a longer node, such
 * as a comment shown as text, does not count.
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

/** The node-local context window the planners keep on each side. */
export const CONTEXT_WINDOW = 32;

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

export const sameIdentity = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((part, index) => part === b[index]);
