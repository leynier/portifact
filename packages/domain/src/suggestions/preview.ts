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
import { generate, ident, parse, walk } from "css-tree";
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

/** Animation and transition properties, prefixed or not, longhand or shorthand. */
const MOTION = /^(?:-[a-z]+-)?(?:animation|transition)(?:-|$)/;

/**
 * Bounds of the CSS a preview reads (second review of pull request #252, R8): nesting of blocks,
 * parentheses and brackets, and the units of all of a page's CSS together. css-tree parses and
 * walks recursively, so deeper input is refused before it is parsed.
 */
export const PREVIEW_CSS_LIMITS = { depth: 32, units: 512 * 1024 } as const;

/** Thrown inside the builder when a page's CSS is over its bounds or cannot be parsed. */
class CssTooComplex extends Error {}

/** The deepest nesting of `{`, `(` and `[` in CSS, outside comments and strings. */
export function cssDepth(css: string): number {
  let depth = 0;
  let deepest = 0;
  for (let at = 0; at < css.length; at++) {
    const char = css[at] as string;
    if (char === "\\") {
      at++;
    } else if (char === "/" && css[at + 1] === "*") {
      const end = css.indexOf("*/", at + 2);
      at = end < 0 ? css.length : end + 1;
    } else if (char === '"' || char === "'") {
      for (at++; at < css.length && css[at] !== char && css[at] !== "\n"; at++) {
        if (css[at] === "\\") at++;
      }
    } else if (char === "{" || char === "(" || char === "[") {
      depth++;
      deepest = Math.max(deepest, depth);
    } else if ((char === "}" || char === ")" || char === "]") && depth > 0) {
      depth--;
    }
  }
  return deepest;
}

/**
 * CSS without any animation or transition declaration, read by a CSS parser (css-tree), so no
 * author rule or inline `!important` can override the preview's freeze. A property's escapes are
 * decoded before it is matched, as browsers decode them. Everything else is kept and the policy
 * keeps it from loading anything. Throws `CssTooComplex` over the nesting bound or when the parser
 * fails; the builder then gives no preview rather than the original CSS.
 */
export function withoutMotion(css: string, context: "stylesheet" | "declarationList"): string {
  if (cssDepth(css) > PREVIEW_CSS_LIMITS.depth) throw new CssTooComplex();
  try {
    const ast = parse(css, {
      context,
      parseValue: false,
      parseRulePrelude: false,
      parseAtrulePrelude: false,
      parseCustomProperty: false,
    });
    walk(ast, {
      visit: "Declaration",
      enter(node, item, list) {
        if (MOTION.test(ident.decode(node.property).toLowerCase())) list.remove(item);
      },
    });
    return generate(ast);
  } catch {
    throw new CssTooComplex();
  }
}

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
  // All of a page's CSS together is bounded too, so many small rules cannot add up.
  let cssUnits = 0;
  const motionless = (css: string, context: "stylesheet" | "declarationList") => {
    cssUnits += css.length;
    if (cssUnits > PREVIEW_CSS_LIMITS.units) throw new CssTooComplex();
    return withoutMotion(css, context);
  };
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
        motionless(
          childrenOf(node)
            .map((child) => (isText(child) ? child.value : ""))
            .join(""),
          "stylesheet",
        ),
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
        .map((attr) =>
          attributeText(
            attr.name,
            attr.name === "style" ? motionless(attr.value, "declarationList") : attr.value,
          ),
        )
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
    : new TextEncoder().encode(source).length <= PLAN_LIMITS.documentBytes;
}

/** A built preview, or why there is none for this page. */
export type PreviewResult =
  | { state: "ready"; document: string }
  | { state: "unavailable"; reason: "css_too_complex" };

/**
 * The preview document for a file of any kind, under the one preview policy, or `unavailable` when
 * the page's CSS is over its bounds or cannot be parsed: never a preview that keeps the CSS as it
 * came, and never an error.
 */
export function buildPreview(
  kind: FileKind,
  source: string,
  renderer: DocumentRenderer,
  work: Work = newWork(),
): PreviewResult {
  if (kind !== "html") work.renders++;
  const document = parseHtml(pageOf(kind, source, renderer), work).document;
  let written: { body: string; styles: string[] };
  try {
    written = write(document);
  } catch (error) {
    if (error instanceof CssTooComplex) return { state: "unavailable", reason: "css_too_complex" };
    throw error;
  }
  // The file's styles cannot close the style element: `<` is never needed in CSS, so it is escaped.
  const inline = written.styles
    .map((style) => `<style>${style.replace(/</g, "\\3C ")}</style>`)
    .join("");
  return {
    state: "ready",
    document: [
      "<!doctype html>",
      "<html>",
      `<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_POLICY}"><style>${FREEZE}</style>${inline}</head>`,
      `<body>${written.body}</body>`,
      "</html>",
    ].join(""),
  };
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
