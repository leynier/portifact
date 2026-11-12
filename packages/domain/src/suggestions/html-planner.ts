// The HTML planner of decision 0027, on parse5. A page qualifies only when its file is in the
// eligible subset (`html-subset.ts`). The file is parsed once per plan: one tree, one anchor
// index. Each operation is located through the anchors, must sit in one text node with its exact
// whitespace, and is mapped to the file through that node's source location: literal characters
// one to one, CRLF to one line feed, and each complete character reference (`&amp;`, `&#38;`) to
// what it decodes to; a change whose ends fall inside a reference is refused. All certain
// operations are applied together from the end of the file, the result is parsed once, and it must
// be in the subset with the same skeleton, the same text nodes but the changed ones, and the same
// bytes outside the approved ranges.
import { PLAN_LIMITS } from "@portifact/contracts";
import { parseFragment } from "parse5";
import { type TextEdit, validAfter } from "./edit.ts";
import { find, type P5Element, type P5Text, parseHtml } from "./html-dom.ts";
import { subsetRefusal } from "./html-subset.ts";
import { identityOf, linksAround } from "./identity.ts";
import { type Located, onlyChangedText, PageIndex } from "./locate.ts";
import {
  applyPatches,
  byOperation,
  onlyApprovedBytes,
  type PlannedFile,
  type PlannedListed,
  type PlannedPatch,
  withoutOverlaps,
} from "./planned.ts";
import { newWork, type Work } from "./work.ts";

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Text written into HTML as text: every character that could start markup is a reference. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] as string);
}

/** For each UTF-16 unit of a text node's value, the raw range of the file it came from. */
interface SourceMap {
  rawStart: number[];
  rawEnd: number[];
  /** Whether a unit starts a segment (a literal character or a whole reference). */
  boundary: boolean[];
}

const REFERENCE = /^&(?:#[0-9]{1,8}|#x[0-9a-f]{1,8}|[a-z][a-z0-9]{0,31});/i;

/** Decodes one complete character reference, cached for the plan. */
function decodeReference(reference: string, cache: Map<string, string>): string {
  const cached = cache.get(reference);
  if (cached !== undefined) return cached;
  const paragraph = parseFragment(`<p>${reference}</p>`).childNodes[0] as P5Element;
  const value = (paragraph.childNodes[0] as P5Text | undefined)?.value ?? "";
  cache.set(reference, value);
  return value;
}

/** Maps a text node's value to the file, or null when the source cannot be read one to one. */
function mapNode(html: string, node: P5Text, cache: Map<string, string>): SourceMap | null {
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
    const reference = char === "&" ? REFERENCE.exec(html.slice(at, Math.min(end, at + 42))) : null;
    if (reference) {
      raw = reference[0].length;
      value = decodeReference(reference[0], cache);
    } else if (char === "\r") {
      raw = html[at + 1] === "\n" ? 2 : 1;
      value = "\n";
    }
    for (let unit = 0; unit < value.length; unit++) {
      map.rawStart.push(at);
      map.rawEnd.push(at + raw);
      map.boundary.push(unit === 0);
    }
    decoded += value;
    at += raw;
  }
  // Anything the parser read differently (a bare ampersand it took as a reference, a NUL) fails.
  return decoded === node.value ? map : null;
}

/** The page URL a stored HTML file is served at, for link destinations. */
export interface HtmlPlanInput {
  html: string;
  edits: readonly (TextEdit | null)[];
  pageUrl: string;
  work?: Work;
}

export function planHtml(input: HtmlPlanInput): PlannedFile {
  const { html, edits, pageUrl } = input;
  const work = input.work ?? newWork();
  const listed: PlannedListed[] = [];
  const all = (reason: PlannedListed["reason"]): PlannedFile => ({
    applied: [],
    listed: edits.map((edit, operation) => ({
      operation,
      reason: edit === null ? "not_text" : reason,
    })),
    work,
  });
  // Over the size limit, nothing is parsed at all.
  if (new TextEncoder().encode(html).length > PLAN_LIMITS.htmlBytes) return all("too_large");
  const parsed = parseHtml(html, work);
  const refused = subsetRefusal(html, parsed);
  const body = find(parsed.document, "body");
  if (refused || !body) return all(refused === "too_large" ? "too_large" : "not_eligible");
  const index = new PageIndex(body, work);
  const cache = new Map<string, string>();
  const found: (PlannedPatch & { located: Located })[] = [];
  for (const [operation, edit] of edits.entries()) {
    if (edit === null) {
      listed.push({ operation, reason: "not_text" });
      continue;
    }
    if (operation >= PLAN_LIMITS.operationsMax) {
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
    const node = located.node;
    const destinations = linksAround(node, pageUrl);
    const map = mapNode(html, node, cache);
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
    const context = PLAN_LIMITS.proofContextUnits;
    found.push({
      operation,
      start,
      end,
      replacement,
      destinations,
      located,
      proof: {
        unit: "utf16",
        start,
        end,
        before: html.slice(start, end),
        after: replacement,
        shownBefore: located.deleted,
        shownAfter: located.inserted,
        nodeLeft: node.value.slice(Math.max(0, located.start - context), located.start),
        nodeRight: node.value.slice(located.end, located.end + context),
        identity: identityOf(node, pageUrl),
      },
    });
  }
  const kept = withoutOverlaps(found, listed);
  const strip = ({ located: _located, ...patch }: PlannedPatch & { located: Located }) => patch;
  if (kept.length === 0) return { applied: [], listed: byOperation(listed), work };
  const next = applyPatches(html, kept);
  const verified =
    onlyApprovedBytes(html, next, kept) &&
    (() => {
      const rebuilt = parseHtml(next, work);
      return (
        subsetRefusal(next, rebuilt) === null &&
        onlyChangedText(
          parsed.document,
          rebuilt.document,
          kept.map((item) => item.located),
        )
      );
    })();
  if (!verified) {
    for (const item of kept) {
      const { proof, destinations } = strip(item);
      listed.push({ operation: item.operation, reason: "would_change_page", destinations, proof });
    }
    return { applied: [], listed: byOperation(listed), work };
  }
  return { applied: kept.map(strip), listed: byOperation(listed), source: next, work };
}
