// The HTML planner of decision 0027, on parse5 (the production parser). A page qualifies only when
// its file is in the eligible subset (`html-subset.ts`). The parse is done once per plan: one tree,
// one anchor index. Each operation is located through the anchors, must sit in one editable text
// node with its exact whitespace, and is mapped to the file through that node's source location:
// literal characters one to one, CRLF to one line feed, and each complete character reference
// (`&amp;`, `&#38;`) to what it decodes to. A change whose ends fall inside a reference is refused.
// All certain operations are applied together from the end of the file, the result is parsed once,
// and it must be in the subset with the same skeleton (doctype, every element and attribute, every
// comment, the text of `title` and `style`), the same body text nodes but the changed ones, and the
// same bytes outside the approved ranges.
import { parseFragment } from "parse5";
import { type Destination, destination } from "./display.ts";
import { type Resolution, type TextEdit, uncertain, validAfter } from "./edit.ts";
import {
  adapt,
  find,
  htmlSkeleton,
  isElement,
  type P5Element,
  type P5Node,
  type P5Text,
  type ParsedHtml,
  parseHtml,
  textNodesOf,
  unwrap,
} from "./html-dom.ts";
import { HTML_LIMITS, subsetRefusal } from "./html-subset.ts";
import { PageIndex } from "./locate.ts";
import {
  byOperation,
  onlyApprovedBytes,
  PLAN_OPERATIONS_MAX,
  type PlannedFile,
  type PlannedListed,
  type PlannedPatch,
  withoutOverlaps,
} from "./planned.ts";

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

export const DEFAULT_PAGE_URL = "https://k7d2qm4xab.portifact.dev/index.html";

/** For each UTF-16 unit of a text node's value, the raw range of the file it came from. */
interface SourceMap {
  rawStart: number[];
  rawEnd: number[];
  /** Whether a unit starts a segment (a literal character or a whole reference). */
  boundary: boolean[];
}

const REFERENCE = /^&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i;

function decodeReference(reference: string): string {
  const fragment = parseFragment(`<p>${reference}</p>`);
  const paragraph = fragment.childNodes[0] as P5Element;
  const text = paragraph.childNodes[0] as P5Text | undefined;
  return text?.value ?? "";
}

/** Maps a text node's value to the file, or null when the source cannot be read one to one. */
function mapNode(html: string, node: P5Text): SourceMap | null {
  const location = node.sourceCodeLocation;
  if (!location) return null;
  const map: SourceMap = { rawStart: [], rawEnd: [], boundary: [] };
  let decoded = "";
  let at = location.startOffset;
  const end = location.endOffset;
  while (at < end) {
    const char = html[at] as string;
    let raw = 1;
    let value = char;
    if (char === "&" && /^&[#a-z0-9]/i.test(html.slice(at, at + 2))) {
      // Anything that looks like a reference must be a whole one; a bare ampersand is literal.
      const reference = REFERENCE.exec(html.slice(at, Math.min(end, at + 40)));
      if (!reference) return null;
      raw = reference[0].length;
      value = decodeReference(reference[0]);
    } else if (char === "\r") {
      raw = html[at + 1] === "\n" ? 2 : 1;
      value = "\n";
    } else if (char === "\u0000") {
      return null;
    }
    for (let unit = 0; unit < value.length; unit++) {
      map.rawStart.push(at);
      map.rawEnd.push(at + raw);
      map.boundary.push(unit === 0);
    }
    decoded += value;
    at += raw;
  }
  return decoded === node.value ? map : null;
}

const parentOf = (node: P5Node) => (node as { parentNode?: P5Node | null }).parentNode ?? null;

/** The target's identity: the elements from the text node up to the body (decision 0027). */
export function htmlIdentity(node: P5Node, pageUrl: string): string[] {
  const chain: string[] = [];
  for (let parent = parentOf(node); parent && isElement(parent); parent = parentOf(parent)) {
    if (parent.tagName === "body") break;
    const attrs = parent.attrs.map((attr) => `${attr.name}=${JSON.stringify(attr.value)}`).sort();
    const href = parent.tagName === "a" ? attrOf(parent, "href") : null;
    if (href !== null) attrs.push(`effective=${destination(href, pageUrl).effective}`);
    chain.push(`${parent.tagName}[${attrs.join(",")}]`);
  }
  return chain;
}

const attrOf = (element: P5Element, name: string) =>
  element.attrs.find((attr) => attr.name === name)?.value ?? null;

function linksAround(node: P5Node, pageUrl: string): Destination[] {
  const found: Destination[] = [];
  for (let parent = parentOf(node); parent && isElement(parent); parent = parentOf(parent)) {
    const href = parent.tagName === "a" ? attrOf(parent, "href") : null;
    if (href !== null) found.push(destination(href, pageUrl));
  }
  return found;
}

type NodeChanges = Map<P5Text, { start: number; end: number; inserted: string }[]>;

export function planHtml(
  html: string,
  edits: readonly TextEdit[],
  pageUrl = DEFAULT_PAGE_URL,
): PlannedFile {
  const listed: PlannedListed[] = [];
  // Over the size limit, nothing is parsed at all.
  if (new TextEncoder().encode(html).length > HTML_LIMITS.bytes) {
    return {
      applied: [],
      listed: edits.map((_, operation) => ({ operation, reason: "too_large" })),
    };
  }
  const parsed = parseHtml(html);
  const refused = subsetRefusal(html, parsed);
  const body = find(parsed.document, "body");
  if (refused || !body) {
    const reason = refused === "too_large" ? "too_large" : "not_eligible";
    return { applied: [], listed: edits.map((_, operation) => ({ operation, reason })) };
  }
  const index = new PageIndex(adapt(body));
  const found: PlannedPatch[] = [];
  const changes: NodeChanges = new Map();
  for (const [operation, edit] of edits.entries()) {
    if (operation >= PLAN_OPERATIONS_MAX) {
      listed.push({ operation, reason: "too_large" });
      continue;
    }
    if (!validAfter(edit)) {
      listed.push({ operation, reason: "invalid_after" });
      continue;
    }
    const result = index.locate(edit);
    if (!result.ok) {
      listed.push({ operation, reason: result.reason });
      continue;
    }
    const { located } = result;
    const node = unwrap(located.text) as P5Text;
    const destinations = linksAround(node, pageUrl);
    // Only body text is indexed, and the subset keeps `title` and `style` in the head, so text
    // inside them can never be selected here.
    const map = mapNode(html, node);
    const at = (unit: number) => unit === node.value.length || (map?.boundary[unit] ?? false);
    if (!map || !at(located.start) || !at(located.end)) {
      listed.push({ operation, reason: "entity", destinations });
      continue;
    }
    const nodeEnd = node.sourceCodeLocation?.endOffset ?? 0;
    const start =
      located.start < node.value.length ? (map.rawStart[located.start] as number) : nodeEnd;
    const end = located.end > located.start ? (map.rawEnd[located.end - 1] as number) : start;
    const replacement = escapeHtml(located.inserted);
    found.push({
      operation,
      start,
      end,
      replacement,
      destinations,
      proof: {
        unit: "utf16",
        start,
        end,
        before: html.slice(start, end),
        after: replacement,
        shownBefore: located.deleted,
        shownAfter: located.inserted,
        nodeLeft: node.value.slice(Math.max(0, located.start - 32), located.start),
        nodeRight: node.value.slice(located.end, located.end + 32),
        identity: htmlIdentity(node, pageUrl),
      },
    });
    const own = changes.get(node) ?? [];
    own.push({ start: located.start, end: located.end, inserted: located.inserted });
    changes.set(node, own);
  }
  const kept = withoutOverlaps(found, listed);
  if (kept.length === 0) return { applied: [], listed: byOperation(listed) };
  let next = html;
  for (const item of [...kept].sort((a, b) => b.start - a.start)) {
    next = next.slice(0, item.start) + item.replacement + next.slice(item.end);
  }
  if (!sameExceptText(html, parsed, next, kept, changes)) {
    for (const item of kept) {
      listed.push({
        operation: item.operation,
        reason: "would_change_page",
        destinations: item.destinations,
        proof: item.proof,
      });
    }
    return { applied: [], listed: byOperation(listed) };
  }
  return { applied: kept, listed: byOperation(listed), source: next };
}

/** The verification: the new file parsed once, in the subset, changed only in the edited text. */
function sameExceptText(
  html: string,
  parsed: ParsedHtml,
  next: string,
  kept: readonly PlannedPatch[],
  changes: NodeChanges,
): boolean {
  if (!onlyApprovedBytes(html, next, kept)) return false;
  const rebuilt = parseHtml(next);
  if (subsetRefusal(next, rebuilt)) return false;
  if (htmlSkeleton(parsed.document) !== htmlSkeleton(rebuilt.document)) return false;
  const before = textNodesOf(parsed.document);
  const after = textNodesOf(rebuilt.document);
  if (before.length !== after.length) return false;
  for (const [index, node] of before.entries()) {
    let expected = node.value;
    const own = [...(changes.get(node) ?? [])].sort((a, b) => b.start - a.start);
    for (const change of own) {
      expected = expected.slice(0, change.start) + change.inserted + expected.slice(change.end);
    }
    if ((after[index] as P5Text).value !== expected) return false;
  }
  return true;
}

/** One operation as a plan of its own, in the shape the single-edit tests use. */
export function resolveHtmlEdit(
  html: string,
  edit: TextEdit,
): Resolution & { destinations?: Destination[] } {
  const planned = planHtml(html, [edit]);
  const applied = planned.applied[0];
  if (!applied || planned.source === undefined) {
    return uncertain(planned.listed[0]?.reason ?? "would_change_page");
  }
  return {
    status: "certain",
    source: planned.source,
    range: { start: applied.start, end: applied.end },
    replacement: applied.replacement,
    destinations: applied.destinations,
  };
}
