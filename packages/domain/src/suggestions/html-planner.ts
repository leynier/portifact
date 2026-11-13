// The HTML planner of decision 0027, on parse5. The file is parsed once per plan: one tree, one
// anchor index. Each operation is located through the anchors and its links collected across the
// whole selection, whatever happens next. It must sit in one text node with its exact whitespace,
// and is mapped to the file through that node's source location (one map per node and plan):
// literal characters one to one, CRLF to one line feed, and each complete character reference
// (`&amp;`, `&#38;`) to what it decodes to; a change whose ends fall inside a reference is refused.
// Only a mapped operation has a proven place in the file. A page outside the eligible subset
// (`html-subset.ts`) lists every operation, mapped ones with their place. All certain
// operations are applied together from the end of the file, the result is parsed once, and it must
// be in the subset with the same skeleton, the same text nodes but the changed ones, and the same
// bytes outside the approved ranges.
import { PLAN_LIMITS } from "@portifact/contracts";
import { parseFragment } from "parse5";
import { utf8Length } from "./digest.ts";
import { type TextEdit, validAfter } from "./edit.ts";
import { find, type P5Element, type P5Text, parseHtml } from "./html-dom.ts";
import { subsetRefusal } from "./html-subset.ts";
import { IdentityCache, linkContext, linksAroundAll } from "./identity.ts";
import { type Located, onlyChangedText, PageIndex } from "./locate.ts";
import {
  applyPatches,
  byOperation,
  listedPatch,
  onlyApprovedBytes,
  PendingIdentities,
  type PlannedFile,
  type PlannedListed,
  type PlannedPatch,
  settled,
  unplaced,
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

/** Decodes one complete character reference, once per distinct reference and plan. */
function decodeReference(reference: string, cache: Map<string, string>, work: Work): string {
  const cached = cache.get(reference);
  if (cached !== undefined) return cached;
  work.decodes++;
  const paragraph = parseFragment(`<p>${reference}</p>`).childNodes[0] as P5Element;
  const value = (paragraph.childNodes[0] as P5Text | undefined)?.value ?? "";
  cache.set(reference, value);
  return value;
}

/** Maps a text node's value to the file, or null when the source cannot be read one to one. */
function mapNode(
  html: string,
  node: P5Text,
  cache: Map<string, string>,
  work: Work,
): SourceMap | null {
  work.maps++;
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
      value = decodeReference(reference[0], cache, work);
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

export interface HtmlPlanInput {
  html: string;
  edits: readonly (TextEdit | null)[];
  /** The URL the page is served at, for link destinations. */
  pageUrl: string;
  work?: Work;
}

export function planHtml(input: HtmlPlanInput): PlannedFile {
  const { html, edits, pageUrl } = input;
  const work = input.work ?? newWork();
  const listed: PlannedListed[] = [];
  const all = (reason: PlannedListed["reason"]): PlannedFile => ({
    applied: [],
    listed: edits.map((edit, operation) =>
      unplaced(operation, edit === null ? "not_text" : reason),
    ),
    work,
    settle: settled,
  });
  // Over the size limit, nothing is parsed at all.
  if (new TextEncoder().encode(html).length > PLAN_LIMITS.htmlBytes) return all("too_large");
  const parsed = parseHtml(html, work);
  const refused = subsetRefusal(html, parsed);
  // Over the node budget, nothing is indexed or mapped either: only ordinary refusals within the
  // budget go on to place their operations.
  if (refused === "too_large") return all("too_large");
  // The parser always adds a body.
  const body = find(parsed.document, "body") as P5Element;
  const links = linkContext(parsed.document, pageUrl, "source");
  const index = new PageIndex(body, work);
  const decodes = new Map<string, string>();
  const maps = new Map<P5Text, SourceMap | null>();
  const mapOf = (node: P5Text) => {
    if (!maps.has(node)) maps.set(node, mapNode(html, node, decodes, work));
    return maps.get(node) ?? null;
  };
  const found: (PlannedPatch & { located: Located })[] = [];
  const identities = new PendingIdentities();
  for (const [operation, edit] of edits.entries()) {
    if (edit === null) {
      listed.push(unplaced(operation, "not_text"));
      continue;
    }
    if (operation >= PLAN_LIMITS.operationsMax) {
      listed.push(unplaced(operation, "too_large"));
      continue;
    }
    const result = index.locate(edit);
    if (!result.ok) {
      const known = result.covered !== null;
      const destinations = known ? linksAroundAll(result.covered ?? [], links) : [];
      listed.push({ operation, reason: result.reason, destinations, destinationsKnown: known });
      continue;
    }
    const { located } = result;
    const node = located.node;
    const destinations = linksAroundAll(result.covered, links);
    if (!validAfter(edit)) {
      listed.push({ operation, reason: "invalid_after", destinations, destinationsKnown: true });
      continue;
    }
    const map = mapOf(node);
    const at = (unit: number) => unit === node.value.length || (map?.boundary[unit] ?? false);
    if (!map || !at(located.start) || !at(located.end)) {
      listed.push({ operation, reason: "entity", destinations, destinationsKnown: true });
      continue;
    }
    const nodeEnd = node.sourceCodeLocation?.endOffset ?? 0;
    const start =
      located.start < node.value.length ? (map.rawStart[located.start] as number) : nodeEnd;
    const end = located.end > located.start ? (map.rawEnd[located.end - 1] as number) : start;
    const replacement = escapeHtml(located.inserted);
    const context = PLAN_LIMITS.proofContextUnits;
    const patch = {
      operation,
      start,
      end,
      replacement,
      destinations,
      located,
      proof: {
        unit: "utf16" as const,
        start,
        end,
        before: html.slice(start, end),
        after: replacement,
        shownBefore: located.deleted,
        shownAfter: located.inserted,
        nodeLeft: node.value.slice(Math.max(0, located.start - context), located.start),
        nodeRight: node.value.slice(located.end, located.end + context),
        identity: [] as string[],
      },
    };
    identities.track(patch.proof, node);
    if (refused) listed.push(listedPatch(patch, "not_eligible"));
    else found.push(patch);
  }
  const kept = withoutOverlaps(found, listed);
  const strip = ({ located: _located, ...patch }: PlannedPatch & { located: Located }) => patch;
  const done = (applied: PlannedPatch[], source?: string): PlannedFile => {
    const result = { applied, listed: byOperation(listed), work };
    const items = () => [...result.applied, ...result.listed];
    const settle = identities.settler(items, () => new IdentityCache(links, work));
    return source === undefined ? { ...result, settle } : { ...result, source, settle };
  };
  if (kept.length === 0) return done([]);
  const next = applyPatches(html, kept);
  // A result over the size limit is listed, never offered: confirmation would refuse it.
  if (utf8Length(next) > PLAN_LIMITS.htmlBytes) {
    for (const item of kept) listed.push(listedPatch(strip(item), "too_large"));
    return done([]);
  }
  const rebuilt = parseHtml(next, work);
  const verified =
    onlyApprovedBytes(html, next, kept) &&
    subsetRefusal(next, rebuilt) === null &&
    onlyChangedText(
      parsed.document,
      rebuilt.document,
      kept.map((item) => item.located),
    );
  if (!verified) {
    for (const item of kept) listed.push(listedPatch(strip(item), "would_change_page"));
    return done([]);
  }
  return done(kept.map(strip), next);
}
