// The HTML subset eligible for automatic application (decision 0027, rule 3 of the second round).
// It is a positive list: a page qualifies only when every node of its file is one of these
// elements in the HTML namespace with only these attributes, and its parse needed no recovery
// beyond the listed codes. Everything else sends the page's edits to the change list, among them
// scripts and event handlers, templates and declarative shadow roots, foreign content (SVG,
// MathML), embedded browsing contexts and forms, `base` and `meta http-equiv`, and the raw-text
// and parser-changing contexts `xmp`, `plaintext`, `textarea`, `noscript`, `noembed`,
// `noframes` and `listing`. `title` and `style` are allowed in the head, but text inside them is
// never edited. The file must be UTF-8 (declared as `utf-8` when declared at all) and is served as
// `text/html`.
import {
  attribute,
  childrenOf,
  HTML_NS,
  isElement,
  isText,
  type P5Element,
  type P5Node,
  type ParsedHtml,
} from "./html-dom.ts";

const GLOBAL = new Set([
  "id",
  "class",
  "title",
  "lang",
  "dir",
  "style",
  "hidden",
  "role",
  "translate",
  "tabindex",
]);

/** Allowed elements, each with the attributes it may carry besides the global ones. */
const ELEMENTS: Readonly<Record<string, readonly string[]>> = {
  html: [],
  head: [],
  body: [],
  title: [],
  meta: ["charset", "name", "content"],
  link: ["rel", "href", "type", "media", "sizes"],
  style: ["media"],
  ...Object.fromEntries(
    [
      "div",
      "span",
      "p",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
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
      "ul",
      "dl",
      "dt",
      "dd",
      "caption",
      "thead",
      "tbody",
      "tfoot",
      "tr",
      "table",
      "summary",
    ].map((tag) => [tag, [] as string[]]),
  ),
  a: ["href", "rel", "hreflang", "type"],
  img: ["src", "alt", "width", "height", "loading", "decoding"],
  blockquote: ["cite"],
  q: ["cite"],
  del: ["cite", "datetime"],
  ins: ["cite", "datetime"],
  time: ["datetime"],
  ol: ["start", "reversed", "type"],
  li: ["value"],
  td: ["colspan", "rowspan", "headers"],
  th: ["colspan", "rowspan", "headers", "scope", "abbr"],
  col: ["span"],
  colgroup: ["span"],
  bdo: ["dir"],
  details: ["open"],
  // Only as a disabled checkbox, as task lists draw them (checked below).
  input: ["type", "disabled", "checked"],
};

/** Elements allowed only in the head. */
const HEAD_ONLY = new Set(["title", "meta", "link", "style"]);
const LINK_RELS = new Set(["stylesheet", "icon"]);
/** URL attributes and the schemes they may use; a relative URL is always allowed. */
const URLS: Readonly<Record<string, readonly string[]>> = {
  href: ["http:", "https:", "mailto:"],
  src: ["http:", "https:"],
};
/** Parse errors that change nothing the subset relies on. */
export const ALLOWED_PARSE_ERRORS = new Set(["missing-doctype"]);
/** Largest eligible file, in UTF-8 bytes, and largest number of nodes. */
export const HTML_LIMITS = { bytes: 1_048_576, nodes: 50_000 } as const;

export type SubsetRefusal =
  | "too_large"
  | "parse_error"
  | "element"
  | "attribute"
  | "url"
  | "encoding"
  | "head_only";

function safeUrl(name: string, value: string): boolean {
  const schemes = URLS[name];
  if (!schemes) return true;
  // Browsers strip controls and spaces before reading a scheme.
  const stripped = [...value]
    .filter((char) => (char.codePointAt(0) as number) > 0x20 && char !== "\u007f")
    .join("");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(stripped);
  return scheme === null || schemes.includes(`${(scheme[1] as string).toLowerCase()}:`);
}

function checkElement(element: P5Element, inHead: boolean): SubsetRefusal | null {
  if (element.namespaceURI !== HTML_NS) return "element";
  const allowed = Object.hasOwn(ELEMENTS, element.tagName) ? ELEMENTS[element.tagName] : undefined;
  if (!allowed) return "element";
  if (HEAD_ONLY.has(element.tagName) && !inHead) return "head_only";
  for (const attr of element.attrs) {
    if (attr.namespace) return "attribute";
    const name = attr.name;
    const known =
      GLOBAL.has(name) ||
      allowed.includes(name) ||
      name.startsWith("aria-") ||
      /^data-[a-z0-9-]+$/.test(name);
    if (!known) return "attribute";
    if (!safeUrl(name, attr.value)) return "url";
  }
  if (
    element.tagName === "input" &&
    (attribute(element, "type") !== "checkbox" || attribute(element, "disabled") === null)
  ) {
    return "element";
  }
  if (element.tagName === "link" && !LINK_RELS.has((attribute(element, "rel") ?? "").toLowerCase()))
    return "attribute";
  if (element.tagName === "meta") {
    const charset = attribute(element, "charset");
    if (charset !== null && charset.toLowerCase() !== "utf-8") return "encoding";
    if (charset === null && attribute(element, "name") === null) return "attribute";
  }
  return null;
}

/** Whether a parsed file is in the eligible subset; `null` when it is. */
export function subsetRefusal(html: string, parsed: ParsedHtml): SubsetRefusal | null {
  if (new TextEncoder().encode(html).length > HTML_LIMITS.bytes) return "too_large";
  if (parsed.errors.some((code) => !ALLOWED_PARSE_ERRORS.has(code))) return "parse_error";
  let nodes = 0;
  const visit = (node: P5Node, inHead: boolean): SubsetRefusal | null => {
    nodes++;
    if (nodes > HTML_LIMITS.nodes) return "too_large";
    if (isElement(node)) {
      const refused = checkElement(node, inHead);
      if (refused) return refused;
    } else if (
      !isText(node) &&
      !["#document", "#documentType", "#comment"].includes(node.nodeName)
    ) {
      return "element";
    }
    for (const child of childrenOf(node)) {
      const refused = visit(child, inHead || (isElement(node) && node.tagName === "head"));
      if (refused) return refused;
    }
    return null;
  };
  return visit(parsed.document, false);
}
