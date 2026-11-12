// The HTML resolver of decision 0027. Automatic application is offered only for an inert page
// (rule 4): its file has no script element, no event handler attribute, no `javascript:` URL and
// nothing that embeds or starts another active document. Nothing the live frame reports is
// trusted (rule 3): the page is the stored file parsed without scripts, which for an inert page
// is the page every reader sees. The edit is located there through the anchors, must sit inside
// one text node with its exact whitespace, is mapped to one range of the file by raw context that
// occurs once in the whole file, written HTML-escaped, and verified by parsing the new file:
// the same skeleton (every element and attribute) and the same text nodes but the changed one.
import { type Resolution, type TextEdit, uncertain, validAfter } from "./edit.ts";
import { locateChange, type NodeChange, onlyChanged } from "./locate.ts";
import { destinationsOf } from "./markdown-resolver.ts";
import { occurrences, parseDocument, skeleton } from "./page.ts";
import { byOperation, type PlannedFile, withoutOverlaps } from "./planned.ts";

const CONTEXTS = [24, 12, 6, 3, 1, 0];
const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] as string);
}

/** Attributes that hold a URL a browser may follow or load. */
const URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "action",
  "formaction",
  "xlink:href",
  "data",
  "poster",
  "background",
  "ping",
]);
/** Elements that run or embed another active document. */
const ACTIVE_ELEMENTS = new Set(["script", "iframe", "frame", "object", "embed", "portal"]);

/** A URL the browser would treat as `javascript:` (it strips controls and whitespace first). */
function isScriptUrl(value: string): boolean {
  const stripped = [...value]
    .filter((char) => (char.codePointAt(0) as number) > 0x20 && char !== "\u007f")
    .join("");
  return /^javascript:/i.test(stripped);
}

/**
 * The same rule over the file's raw bytes, deliberately coarse: parsers disagree (happy-dom drops
 * a `<script>` inside `<svg>` that browsers run), so a page whose bytes merely look like a script
 * tag, an event handler or a `javascript:` URL anywhere is not inert either. False refusals only
 * send edits to the change list.
 */
export function rawInert(html: string): boolean {
  return !/<\s*script\b|\son[a-z]+\s*=|javascript\s*:|srcdoc\s*=/i.test(html);
}

/** Whether a page's file can run nothing (decision 0027, rule 4). */
export function isInert(document: Document): boolean {
  for (const element of Array.from(document.querySelectorAll("*"))) {
    const tag = element.tagName.toLowerCase();
    if (ACTIVE_ELEMENTS.has(tag)) return false;
    if (tag === "meta" && element.getAttribute("http-equiv")?.toLowerCase() === "refresh")
      return false;
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || name === "srcdoc") return false;
      if (URL_ATTRIBUTES.has(name) && isScriptUrl(attribute.value)) return false;
      if (name === "srcset" && /javascript:/i.test(attribute.value)) return false;
    }
  }
  return true;
}

export function resolveHtmlEdit(
  html: string,
  edit: TextEdit,
): Resolution & { destinations?: string[]; change?: NodeChange } {
  if (!validAfter(edit)) return uncertain("invalid_after");
  const document = parseDocument(html);
  if (!isInert(document) || !rawInert(html)) return uncertain("not_inert");
  const located = locateChange(document.body, edit);
  if (!located.ok) return uncertain(located.reason);
  const { change } = located;
  const data = located.text.data;
  let found = false;
  for (const width of CONTEXTS) {
    const left = data.slice(Math.max(0, change.start - width), change.start);
    const right = data.slice(change.end, change.end + width);
    const needle = left + change.deleted + right;
    if (needle.length === 0 || occurrences(data, needle).length !== 1) continue;
    // Once in the whole file: text, attributes, styles and comments alike.
    const matches = occurrences(html, needle);
    if (matches.length !== 1) continue;
    found = true;
    const start = (matches[0] as number) + left.length;
    const end = start + change.deleted.length;
    const replacement = escapeHtml(change.inserted);
    const next = html.slice(0, start) + replacement + html.slice(end);
    const rebuilt = parseDocument(next);
    // The head (title, styles) through the skeleton; the body's text node by node.
    const sameHead = skeleton(document.documentElement) === skeleton(rebuilt.documentElement);
    if (sameHead && onlyChanged(document.body, rebuilt.body, [change])) {
      return {
        status: "certain",
        source: next,
        range: { start, end },
        replacement,
        destinations: destinationsOf(located.text),
        change,
      };
    }
  }
  return uncertain(found ? "would_change_page" : "not_found");
}

/**
 * Several operations on one inert page, in base coordinates: each is resolved against the stored
 * file, operations whose ranges touch are listed (`overlap`), the rest are applied together from
 * the end and verified once by parsing the combined result. If that fails, nothing applies.
 */
export function planHtml(html: string, edits: readonly TextEdit[]): PlannedFile {
  const listed: PlannedFile["listed"] = [];
  const found: {
    operation: number;
    start: number;
    end: number;
    replacement: string;
    change: NodeChange;
    destinations: string[];
  }[] = [];
  edits.forEach((edit, operation) => {
    const result = resolveHtmlEdit(html, edit);
    if (result.status !== "certain" || !result.change) {
      listed.push({ operation, reason: result.status === "certain" ? "not_found" : result.reason });
      return;
    }
    found.push({
      operation,
      ...result.range,
      replacement: result.replacement,
      change: result.change,
      destinations: result.destinations ?? [],
    });
  });
  const kept = withoutOverlaps(found, listed);
  if (kept.length === 0) return { applied: [], listed: byOperation(listed) };
  let next = html;
  for (const item of [...kept].sort((a, b) => b.start - a.start)) {
    next = next.slice(0, item.start) + item.replacement + next.slice(item.end);
  }
  const before = parseDocument(html);
  const after = parseDocument(next);
  const same =
    skeleton(before.documentElement) === skeleton(after.documentElement) &&
    onlyChanged(
      before.body,
      after.body,
      kept.map((item) => item.change),
    );
  if (!same) {
    for (const item of kept)
      listed.push({ operation: item.operation, reason: "would_change_page" });
    return { applied: [], listed: byOperation(listed) };
  }
  return { applied: kept, listed: byOperation(listed), source: next };
}
