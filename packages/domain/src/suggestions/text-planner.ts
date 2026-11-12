// The plain text planner of decision 0027. A text document's page is its source in one `<pre>`,
// so the page's normalized text is the source normalized, and each normalized code point comes
// from a known cluster of the source (the clusters `packages/anchors` uses: a whitespace run, or a
// base character with its combining marks, normalized to NFC). An edit is certain when the source
// characters under the selection are exactly the selection (no whitespace or Unicode form differs
// there; the rest of the file is irrelevant), and the changed source normalizes to the expected
// page text. The new file's stored rendering is derived once for the plan's output.
import { normalizeText } from "@portifact/anchors";
import { type DocumentRenderer, PLAN_LIMITS } from "@portifact/contracts";
import { utf8Length } from "./digest.ts";
import { changedRegion, codePoints, type TextEdit, validAfter } from "./edit.ts";
import {
  applyPatches,
  byOperation,
  listedPatch,
  PENDING_SHA256,
  type PlannedFile,
  type PlannedListed,
  type PlannedPatch,
  settled,
  unplaced,
  withoutOverlaps,
} from "./planned.ts";
import { newWork, type Work } from "./work.ts";

/** The identity of a text document's one text node: its `pre`, `main`, `body` and root. */
export const TEXT_IDENTITY: readonly string[] = [
  'pre[:class="pf-text"]',
  'main[:class="pf-document"]',
  "body[]",
  'html[:lang="en"]',
];

const CLUSTER = /[\s\p{Cc}]+|[^\s\p{Cc}][\p{M}ᅠ-ᇿ]*/gu;
const SPACE_OR_CONTROL = /^[\s\p{Cc}]/u;

interface SourceMap {
  points: string[];
  rawStart: number[];
  rawEnd: number[];
}

/** Normalized code points with the UTF-16 range of the source cluster each came from. */
function sourceMap(source: string, work: Work): SourceMap {
  work.maps++;
  const map: SourceMap = { points: [], rawStart: [], rawEnd: [] };
  let space: { start: number; end: number } | null = null;
  for (const match of source.matchAll(CLUSTER)) {
    const cluster = match[0];
    const start = match.index;
    const end = start + cluster.length;
    if (SPACE_OR_CONTROL.test(cluster)) {
      space = space ? { start: space.start, end } : { start, end };
      continue;
    }
    if (space && map.points.length > 0) {
      map.points.push(" ");
      map.rawStart.push(space.start);
      map.rawEnd.push(space.end);
    }
    space = null;
    for (const point of cluster.toWellFormed().normalize("NFC")) {
      map.points.push(point);
      map.rawStart.push(start);
      map.rawEnd.push(end);
    }
  }
  return map;
}

type Mapped =
  | { ok: true; patch: Omit<PlannedPatch, "operation"> }
  | { ok: false; reason: PlannedListed["reason"] };

/**
 * Offsets of the rendered text node, whose data is the source with every CRLF and lone CR read as
 * one line feed (as the HTML parser does): the proof's context comes from it, the patch's offsets
 * from the source.
 */
class RenderedText {
  readonly text: string;
  private readonly pairs: number[] = [];

  constructor(source: string) {
    for (let at = source.indexOf("\r\n"); at >= 0; at = source.indexOf("\r\n", at + 2)) {
      this.pairs.push(at);
    }
    this.text = source.replace(/\r\n?/g, "\n");
  }

  /** The rendered offset of a source offset outside any CRLF pair. */
  offset(at: number): number {
    let low = 0;
    let high = this.pairs.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((this.pairs[middle] as number) + 1 < at) low = middle + 1;
      else high = middle;
    }
    return at - low;
  }
}

function mapEdit(source: string, map: SourceMap, rendered: RenderedText, edit: TextEdit): Mapped {
  if (!validAfter(edit)) return { ok: false, reason: "invalid_after" };
  if (
    edit.start < 0 ||
    edit.end <= edit.start ||
    map.points.slice(edit.start, edit.end).join("") !== edit.before
  ) {
    return { ok: false, reason: "stale" };
  }
  // The selected source characters must be the selection exactly.
  const rawFrom = map.rawStart[edit.start] as number;
  const rawTo = map.rawEnd[edit.end - 1] as number;
  const raw = source.slice(rawFrom, rawTo);
  if (raw !== edit.before) {
    return { ok: false, reason: raw.normalize("NFC") === edit.before ? "not_nfc" : "whitespace" };
  }
  const change = changedRegion(edit);
  // Inside an exact selection, code points and source units correspond one to one.
  const prefix = codePoints(edit.before)
    .slice(0, change.from - edit.start)
    .join("").length;
  const start = rawFrom + prefix;
  const end = start + change.deleted.length;
  const context = PLAN_LIMITS.proofContextUnits;
  const shownStart = rendered.offset(start);
  const shownEnd = shownStart + change.deleted.length;
  return {
    ok: true,
    patch: {
      start,
      end,
      replacement: change.inserted,
      destinations: [],
      proof: {
        unit: "utf16",
        start,
        end,
        before: change.deleted,
        after: change.inserted,
        shownBefore: change.deleted,
        shownAfter: change.inserted,
        nodeLeft: rendered.text.slice(Math.max(0, shownStart - context), shownStart),
        nodeRight: rendered.text.slice(shownEnd, shownEnd + context),
        identity: [...TEXT_IDENTITY],
      },
    },
  };
}

export interface TextPlanInput {
  source: string;
  edits: readonly (TextEdit | null)[];
  title: string;
  renderer: DocumentRenderer;
  work?: Work;
}

/**
 * Several operations on one text document, in base coordinates: each is mapped against the stored
 * source, touching ranges are listed (`overlap`), the rest are applied together from the end and
 * the result is checked once against the page text with every change spliced in.
 */
export function planText(input: TextPlanInput): PlannedFile {
  const { source, edits } = input;
  const work = input.work ?? newWork();
  const listed: PlannedListed[] = [];
  if (utf8Length(source) > PLAN_LIMITS.documentBytes) {
    return {
      applied: [],
      listed: edits.map((edit, operation) =>
        unplaced(operation, edit === null ? "not_text" : "too_large"),
      ),
      work,
      settle: settled,
    };
  }
  const map = sourceMap(source, work);
  const rendered = new RenderedText(source);
  const found: (PlannedPatch & { edit: TextEdit })[] = [];
  for (const [operation, edit] of edits.entries()) {
    if (edit === null) {
      listed.push(unplaced(operation, "not_text"));
      continue;
    }
    if (operation >= PLAN_LIMITS.operationsMax) {
      listed.push(unplaced(operation, "too_large"));
      continue;
    }
    const mapped = mapEdit(source, map, rendered, edit);
    // A text document has no links, so its links are always known: there are none.
    if (mapped.ok) found.push({ operation, ...mapped.patch, edit });
    else
      listed.push({ operation, reason: mapped.reason, destinations: [], destinationsKnown: true });
  }
  const kept = withoutOverlaps(found, listed);
  if (kept.length === 0) return { applied: [], listed: byOperation(listed), work, settle: settled };
  const next = applyPatches(source, kept);
  // A result over the size limit is listed, never offered: confirmation would refuse it.
  if (utf8Length(next) > PLAN_LIMITS.documentBytes) {
    for (const item of kept) listed.push(listedPatch(item, "too_large"));
    return { applied: [], listed: byOperation(listed), work, settle: settled };
  }
  const expected = [...map.points];
  for (const item of [...kept].sort((a, b) => b.start - a.start)) {
    const change = changedRegion(item.edit);
    expected.splice(change.from, change.to - change.from, ...codePoints(change.inserted));
  }
  const strip = ({ edit: _edit, ...patch }: PlannedPatch & { edit: TextEdit }) => patch;
  if (normalizeText(next) !== normalizeText(expected.join(""))) {
    for (const item of kept) listed.push(listedPatch(item, "would_change_page"));
    return { applied: [], listed: byOperation(listed), work, settle: settled };
  }
  const files = input.renderer.stored("text", next, {
    title: input.title,
    sourceSha256: PENDING_SHA256,
  });
  work.renders++;
  return {
    applied: kept.map(strip),
    listed: byOperation(listed),
    source: next,
    rendered: files.map((file) => ({ kind: file.kind, text: file.text })),
    work,
    // A text document's identity is a constant: there is nothing to hash.
    settle: settled,
  };
}
