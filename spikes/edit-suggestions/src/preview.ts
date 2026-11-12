// Preview documents of decision 0027 (rule 1 of the second round). A preview is built, never
// patched: the stored file (or the renderer's output for a document) is parsed by parse5 and a new
// document is written from the tree. Only elements known to be passive are kept; navigation (link
// destinations), embedded documents, forms, every attribute that loads a resource or names a URL,
// active metadata (`base`, `meta`, `link`), comments, scripts and foreign content are dropped;
// unknown HTML elements keep their children. Every kind gets the same head: a charset, the one
// preview policy and a style that stops animations, then the file's own inline styles, which the
// policy keeps from loading anything. The preview origin also sends the policy as a header and the
// viewer frames it with an empty `sandbox`.
import { renderMarkdown, renderText } from "@portifact/render";
import { childrenOf, HTML_NS, isElement, isText, type P5Node, parseHtml } from "./html-dom.ts";
import { escapeHtml } from "./html-resolver.ts";

export const PREVIEW_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'";

/** Elements kept in a preview: passive text, structure and tables. */
const KEPT = new Set([
  "html",
  "head",
  "body",
  "title",
  "style",
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
  "sup",
  "input",
]);
/** Elements dropped with everything inside them. */
const DROPPED = new Set([
  "script",
  "noscript",
  "template",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "portal",
  "applet",
  "form",
  "button",
  "select",
  "textarea",
  "option",
  "datalist",
  "base",
  "meta",
  "link",
  "video",
  "audio",
  "source",
  "track",
  "canvas",
  "map",
  "area",
  "picture",
  "xmp",
  "plaintext",
  "noembed",
  "noframes",
  "dialog",
  "slot",
  "head-only",
]);
/** Attributes kept: none of them loads, links or runs anything. */
const ATTRIBUTES = new Set([
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

function attributeText(name: string, value: string): string {
  return ` ${name}="${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`;
}

function write(node: P5Node, out: string[], styles: string[]): void {
  if (isText(node)) {
    out.push(escapeHtml(node.value));
    return;
  }
  if (!isElement(node)) {
    // Documents and fragments: their children. Comments and doctypes are dropped.
    if (node.nodeName === "#document" || node.nodeName === "#document-fragment") {
      for (const child of childrenOf(node)) write(child, out, styles);
    }
    return;
  }
  if (node.namespaceURI !== HTML_NS || DROPPED.has(node.tagName)) return;
  if (node.tagName === "style") {
    styles.push(
      childrenOf(node)
        .map((child) => (isText(child) ? child.value : ""))
        .join(""),
    );
    return;
  }
  if (node.tagName === "title") return;
  if (node.tagName === "head") {
    // The head contributes only its inline styles; everything else in it is metadata.
    for (const child of childrenOf(node)) {
      if (isElement(child) && child.tagName === "style") write(child, out, styles);
    }
    return;
  }
  if (node.tagName === "img") {
    const alt = node.attrs.find((attr) => attr.name === "alt")?.value;
    if (alt) out.push(`<span data-preview-image>${escapeHtml(alt)}</span>`);
    return;
  }
  if (node.tagName === "input") return;
  const kept = KEPT.has(node.tagName) && !["html", "body"].includes(node.tagName);
  if (kept) {
    const attrs = node.attrs
      .filter((attr) => !attr.namespace && ATTRIBUTES.has(attr.name))
      .map((attr) => attributeText(attr.name, attr.value))
      .join("");
    out.push(`<${node.tagName}${attrs}>`);
  }
  for (const child of childrenOf(node)) write(child, out, styles);
  if (kept && !["br", "hr", "wbr", "col"].includes(node.tagName)) out.push(`</${node.tagName}>`);
}

/** The preview document for a stored file of any kind, under the one preview policy. */
export function buildPreview(kind: "markdown" | "text" | "html", source: string): string {
  const html =
    kind === "markdown"
      ? `<!doctype html><html><head></head><body><main class="pf-document pf-markdown">${renderMarkdown(source).html}</main></body></html>`
      : kind === "text"
        ? `<!doctype html><html><head></head><body><main class="pf-document">${renderText(source).html}</main></body></html>`
        : source;
  const body: string[] = [];
  const styles: string[] = [];
  write(parseHtml(html).document, body, styles);
  // The file's styles cannot close the style element: `<` is not needed in CSS, so it is escaped.
  const inline = styles.map((style) => `<style>${style.replace(/</g, "\\3C ")}</style>`).join("");
  return [
    "<!doctype html>",
    "<html>",
    `<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_POLICY}"><style>${FREEZE}</style>${inline}</head>`,
    `<body>${body.join("")}</body>`,
    "</html>",
  ].join("");
}

/** The headers the preview origin sends with every preview document. */
export const PREVIEW_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": `${PREVIEW_POLICY}; frame-ancestors https://app.portifact.com; sandbox`,
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-site",
};
