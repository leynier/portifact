// The HTML subset eligible for automatic application (decision 0027, "Which files"). It is a
// positive list: a page qualifies only when every node of its file is one of these elements in the
// HTML namespace with only these attributes, and its parse needed no recovery beyond a missing
// doctype. Everything else sends the page's edits to the change list, among them scripts and event
// handlers, templates and declarative shadow roots, foreign content (SVG, MathML), embedded
// browsing contexts and forms, `base` and `meta http-equiv`, and the raw-text and parser-changing
// contexts `xmp`, `plaintext`, `textarea`, `noscript`, `noembed`, `noframes` and `listing`.
// `title` and `style` are allowed in the head, where nothing is ever edited.
import { PLAN_LIMITS } from "@portifact/contracts";
import {
  attribute,
  childrenOf,
  HTML_NS,
  isElement,
  isText,
  type P5Element,
  type P5Node,
  type ParsedHtml,
  parseHtml,
} from "./html-dom.ts";
import { newWork, type Work } from "./work.ts";

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

const PLAIN = [
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
];

/** Allowed elements, each with the attributes it may carry besides the global ones. */
const ELEMENTS: Readonly<Record<string, readonly string[]>> = {
  html: [],
  head: [],
  body: [],
  title: [],
  meta: ["charset", "name", "content"],
  link: ["rel", "href", "type", "media", "sizes"],
  style: ["media"],
  ...Object.fromEntries(PLAIN.map((tag) => [tag, [] as string[]])),
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
export const ALLOWED_PARSE_ERRORS: ReadonlySet<string> = new Set(["missing-doctype"]);

export type SubsetRefusal =
  | "too_large"
  | "parse_error"
  | "element"
  | "attribute"
  | "url"
  | "encoding"
  | "head_only";

/** Whether a URL attribute's value uses an allowed scheme, after what browsers strip. */
export function safeUrl(name: string, value: string): boolean {
  const schemes = URLS[name];
  if (!schemes) return true;
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
      (name.startsWith("data-") && /^[a-z0-9-]+$/.test(name.slice("data-".length)));
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

const OTHER_NODES = new Set(["#document", "#documentType", "#comment"]);

/** Whether a parsed file is in the eligible subset; `null` when it is. */
export function subsetRefusal(html: string, parsed: ParsedHtml): SubsetRefusal | null {
  if (new TextEncoder().encode(html).length > PLAN_LIMITS.htmlBytes) return "too_large";
  // The node budget is judged over the whole page whatever else refuses it: a parse error or an
  // element outside the subset never hides a page that is too large to index and map.
  let refused: SubsetRefusal | null = parsed.errors.some((code) => !ALLOWED_PARSE_ERRORS.has(code))
    ? "parse_error"
    : null;
  let nodes = 0;
  const stack: { node: P5Node; inHead: boolean }[] = [{ node: parsed.document, inHead: false }];
  while (stack.length > 0) {
    const { node, inHead } = stack.pop() as { node: P5Node; inHead: boolean };
    nodes++;
    if (nodes > PLAN_LIMITS.htmlNodes) return "too_large";
    if (refused === null) {
      if (isElement(node)) refused = checkElement(node, inHead);
      else if (!isText(node) && !OTHER_NODES.has(node.nodeName)) refused = "element";
    }
    const childInHead = inHead || (isElement(node) && node.tagName === "head");
    for (const child of childrenOf(node)) stack.push({ node: child, inHead: childInHead });
  }
  return refused;
}

/**
 * Decodes a stored HTML file as the subset requires (UTF-8, fatal on invalid bytes, a UTF-8 byte
 * order mark dropped), or null when it is not UTF-8.
 */
export function decodeHtml(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Whether a stored HTML file is in the eligible subset, parsing it on its own: `null` when it is,
 * else why not. Over the size limit nothing is parsed. The one entry point for callers outside the
 * planners (a carry, a preview), so none of them parses or checks the subset another way.
 */
export function htmlEligibility(html: string, work: Work = newWork()): SubsetRefusal | null {
  if (new TextEncoder().encode(html).length > PLAN_LIMITS.htmlBytes) return "too_large";
  return subsetRefusal(html, parseHtml(html, work));
}
