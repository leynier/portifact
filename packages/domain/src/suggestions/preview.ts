// Preview documents of decision 0027 ("Previews"). A preview is built, never patched: the stored
// file (or the renderer's output for a document) is parsed by parse5 and a new document is written
// from the tree. Only elements known to be passive are kept; navigation (link destinations),
// embedded documents, forms, every attribute that loads a resource or names a URL, active metadata
// (`base`, `meta`, `link`), comments, scripts and foreign content are dropped; unknown HTML
// elements keep their children. Every kind gets the same head: a charset, the one preview policy
// and a style that stops animations, then the file's own inline styles, which the policy keeps
// from loading anything. The preview origin also sends the policy as a header and the viewer
// frames it with an empty `sandbox`.
import { type DocumentRenderer, type FileKind, PLAN_LIMITS } from "@portifact/contracts";
import { childrenOf, HTML_NS, isElement, isText, type P5Node, parseHtml } from "./html-dom.ts";
import { escapeHtml } from "./html-planner.ts";
import { newWork, type Work } from "./work.ts";

/** The one policy of every preview document, sent as a header and repeated in the document. */
export const PREVIEW_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'";

/** Elements written in a preview, with their kept attributes: passive text, structure and tables. */
const KEPT: ReadonlySet<string> = new Set([
  "div",
  "span",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "a",
  "em",
  "strong",
  "b",
  "i",
  "u",
  "s",
  "small",
  "mark",
  "code",
  "pre",
  "kbd",
  "samp",
  "var",
  "sub",
  "sup",
  "br",
  "hr",
  "wbr",
  "section",
  "article",
  "header",
  "footer",
  "nav",
  "main",
  "aside",
  "figure",
  "figcaption",
  "address",
  "abbr",
  "dfn",
  "bdi",
  "bdo",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "table",
  "caption",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "colgroup",
  "col",
  "blockquote",
  "q",
  "cite",
  "del",
  "ins",
  "time",
  "details",
  "summary",
]);
/**
 * Elements dropped with everything inside them. Any other element that is not kept writes only its
 * children, so elements that can hold nothing (`base`, `meta`, `link`, `embed`, `source`, `track`,
 * `area`) write nothing, and a template's contents are never its children in parse5.
 */
const DROPPED: ReadonlySet<string> = new Set([
  "script",
  "noscript",
  "iframe",
  "object",
  "portal",
  "applet",
  "form",
  "button",
  "select",
  "textarea",
  "option",
  "datalist",
  "video",
  "audio",
  "canvas",
  "map",
  "picture",
  "xmp",
  "plaintext",
  "noembed",
  "noframes",
  "dialog",
  "slot",
]);
/** Attributes kept: none of them loads, links or runs anything. */
const ATTRIBUTES: ReadonlySet<string> = new Set([
  "id",
  "class",
  "title",
  "lang",
  "dir",
  "style",
  "hidden",
  "role",
  "alt",
  "width",
  "height",
  "colspan",
  "rowspan",
  "headers",
  "scope",
  "start",
  "reversed",
  "type",
  "value",
  "datetime",
  "open",
  "span",
  "abbr",
  "translate",
  "disabled",
  "checked",
]);

const FREEZE = "*,*::before,*::after{animation:none!important;transition:none!important}";
const VOID = new Set(["br", "hr", "wbr", "col"]);

const attributeText = (name: string, value: string) =>
  ` ${name}="${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`;

type Step = { node: P5Node } | { close: string };

/** Writes the passive part of a tree, iteratively so a deep page cannot exhaust the stack. */
function write(root: P5Node): { body: string; styles: string[] } {
  const out: string[] = [];
  const styles: string[] = [];
  const stack: Step[] = [{ node: root }];
  const push = (children: P5Node[]) => {
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({ node: children[index] as P5Node });
    }
  };
  while (stack.length > 0) {
    const step = stack.pop() as Step;
    if ("close" in step) {
      out.push(step.close);
      continue;
    }
    const { node } = step;
    if (isText(node)) {
      out.push(escapeHtml(node.value));
      continue;
    }
    if (!isElement(node)) {
      // Documents: their children. Comments and doctypes are dropped.
      if (node.nodeName === "#document") push(childrenOf(node));
      continue;
    }
    if (node.namespaceURI !== HTML_NS || DROPPED.has(node.tagName)) continue;
    if (node.tagName === "style") {
      styles.push(
        childrenOf(node)
          .map((child) => (isText(child) ? child.value : ""))
          .join(""),
      );
      continue;
    }
    if (node.tagName === "title") continue;
    if (node.tagName === "head") {
      // The head contributes only its inline styles; everything else in it is metadata.
      push(childrenOf(node).filter((child) => isElement(child) && child.tagName === "style"));
      continue;
    }
    if (node.tagName === "img") {
      const alt = node.attrs.find((attr) => attr.name === "alt" && !attr.namespace)?.value;
      if (alt) out.push(`<span data-preview-image>${escapeHtml(alt)}</span>`);
      continue;
    }
    const kept = KEPT.has(node.tagName);
    if (kept) {
      const attrs = node.attrs
        .filter((attr) => !attr.namespace && ATTRIBUTES.has(attr.name))
        .map((attr) => attributeText(attr.name, attr.value))
        .join("");
      out.push(`<${node.tagName}${attrs}>`);
      if (!VOID.has(node.tagName)) stack.push({ close: `</${node.tagName}>` });
    }
    push(childrenOf(node));
  }
  return { body: out.join(""), styles };
}

/** The page a preview is built from: an HTML file as stored, a document as the renderer draws it. */
function pageOf(kind: FileKind, source: string, renderer: DocumentRenderer): string {
  if (kind === "html") return source;
  const main = kind === "markdown" ? "pf-document pf-markdown" : "pf-document";
  return `<!doctype html><html><head></head><body><main class="${main}">${renderer.body(kind, source)}</main></body></html>`;
}

/** Whether a file is small enough to preview (the plans' limits). */
export function previewable(kind: FileKind, source: string): boolean {
  return kind === "html"
    ? new TextEncoder().encode(source).length <= PLAN_LIMITS.htmlBytes
    : source.length <= PLAN_LIMITS.documentUnits;
}

/** The preview document for a file of any kind, under the one preview policy. */
export function buildPreview(
  kind: FileKind,
  source: string,
  renderer: DocumentRenderer,
  work: Work = newWork(),
): string {
  if (kind !== "html") work.renders++;
  const { body, styles } = write(parseHtml(pageOf(kind, source, renderer), work).document);
  // The file's styles cannot close the style element: `<` is never needed in CSS, so it is escaped.
  const inline = styles.map((style) => `<style>${style.replace(/</g, "\\3C ")}</style>`).join("");
  return [
    "<!doctype html>",
    "<html>",
    `<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_POLICY}"><style>${FREEZE}</style>${inline}</head>`,
    `<body>${body}</body>`,
    "</html>",
  ].join("");
}

/** The headers the preview origin sends with every preview document. */
export function previewHeaders(appOrigin: string): Readonly<Record<string, string>> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": `${PREVIEW_POLICY}; frame-ancestors ${appOrigin}; sandbox`,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-site",
  };
}
