// The plain text planner of decision 0027. A text document's page is its source in one `<pre>`,
// so the page's normalized text is the source normalized, and each normalized code point comes
// from a known cluster of the source (the clusters `packages/anchors` uses: a whitespace run, or a
// base character with its combining marks, normalized to NFC). An edit is certain when the source
// characters under the selection are exactly the selection (no whitespace or Unicode form differs
// there; the rest of the file is irrelevant), and the changed source normalizes to the expected
// page text. The new file's stored rendering is derived once for the plan's output.
import { normalizeText } from "@portifact/anchors";
import { type DocumentRenderer, PLAN_LIMITS } from "@portifact/contracts";
import { sha256Hex } from "./digest.ts";
import { changedRegion, codePoints, type TextEdit, validAfter } from "./edit.ts";
import {
  applyPatches,
  byOperation,
  type PlannedFile,
  type PlannedListed,
  type PlannedPatch,
  withoutOverlaps,
} from "./planned.ts";
import { newWork, type Work } from "./work.ts";

/** The identity of every text node of a text document: its `pre` inside the document's `main`. */
export const TEXT_IDENTITY: readonly string[] = [
  'pre[class="pf-text"]',
  'main[class="pf-document"]',
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

function mapEdit(source: string, map: SourceMap, edit: TextEdit): Mapped {
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
        nodeLeft: source.slice(Math.max(0, start - context), start),
        nodeRight: source.slice(end, end + context),
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
export async function planText(input: TextPlanInput): Promise<PlannedFile> {
  const { source, edits } = input;
  const work = input.work ?? newWork();
  const listed: PlannedListed[] = [];
  if (source.length > PLAN_LIMITS.documentUnits) {
    return {
      applied: [],
      listed: edits.map((edit, operation) => ({
        operation,
        reason: edit === null ? "not_text" : "too_large",
      })),
      work,
    };
  }
  const map = sourceMap(source, work);
  const found: (PlannedPatch & { edit: TextEdit })[] = [];
  for (const [operation, edit] of edits.entries()) {
    if (edit === null) {
      listed.push({ operation, reason: "not_text" });
      continue;
    }
    if (operation >= PLAN_LIMITS.operationsMax) {
      listed.push({ operation, reason: "too_large" });
      continue;
    }
    const mapped = mapEdit(source, map, edit);
    if (mapped.ok) found.push({ operation, ...mapped.patch, edit });
    else listed.push({ operation, reason: mapped.reason });
  }
  const kept = withoutOverlaps(found, listed);
  if (kept.length === 0) return { applied: [], listed: byOperation(listed), work };
  const next = applyPatches(source, kept);
  const expected = [...map.points];
  for (const item of [...kept].sort((a, b) => b.start - a.start)) {
    const change = changedRegion(item.edit);
    expected.splice(change.from, change.to - change.from, ...codePoints(change.inserted));
  }
  const strip = ({ edit: _edit, ...patch }: PlannedPatch & { edit: TextEdit }) => patch;
  if (normalizeText(next) !== normalizeText(expected.join(""))) {
    for (const item of kept) {
      listed.push({ operation: item.operation, reason: "would_change_page", proof: item.proof });
    }
    return { applied: [], listed: byOperation(listed), work };
  }
  const files = input.renderer.stored("text", next, {
    title: input.title,
    sourceSha256: await sha256Hex(next),
  });
  work.renders++;
  return {
    applied: kept.map(strip),
    listed: byOperation(listed),
    source: next,
    rendered: files.map((file) => ({ kind: file.kind, text: file.text })),
    work,
  };
}
