// The plain-text planner of decision 0027. A text document's page is its source in a `<pre>`, so
// the page's normalized text is the source normalized, and each normalized code point comes from
// a known cluster of the source (the same clusters `packages/anchors` uses: a whitespace run, or a
// base character with its combining marks, normalized to NFC). An edit is certain when the source
// characters under the selection are exactly the selection (no whitespace or Unicode form differs
// there; what the rest of the file does is irrelevant), and the changed source normalizes to the
// expected page text.

import { normalizeText } from "@portifact/anchors";
import { changedRegion, type Resolution, type TextEdit, uncertain, validAfter } from "./edit.ts";
import { codePoints } from "./page.ts";
import {
  byOperation,
  PLAN_OPERATIONS_MAX,
  type PlannedFile,
  type PlannedListed,
  type PlannedPatch,
  withoutOverlaps,
} from "./planned.ts";
import { work } from "./work.ts";

/** Largest text document a plan takes, in UTF-16 units (2 MB of ASCII). */
export const TEXT_LIMIT = 2_000_000;

const CLUSTER = /[\s\p{Cc}]+|[^\s\p{Cc}][\p{M}ᅠ-ᇿ]*/gu;
const SPACE_OR_CONTROL = /^[\s\p{Cc}]/u;

/** Normalized code points with the UTF-16 range of the source cluster each came from. */
function sourceMap(source: string): { points: string[]; rawStart: number[]; rawEnd: number[] } {
  work.maps++;
  const points: string[] = [];
  const rawStart: number[] = [];
  const rawEnd: number[] = [];
  let space: { start: number; end: number } | null = null;
  for (const match of source.matchAll(CLUSTER)) {
    const cluster = match[0];
    const start = match.index;
    const end = start + cluster.length;
    if (SPACE_OR_CONTROL.test(cluster)) {
      space = space ? { start: space.start, end } : { start, end };
      continue;
    }
    if (space && points.length > 0) {
      points.push(" ");
      rawStart.push(space.start);
      rawEnd.push(space.end);
    }
    space = null;
    for (const point of cluster.toWellFormed().normalize("NFC")) {
      points.push(point);
      rawStart.push(start);
      rawEnd.push(end);
    }
  }
  return { points, rawStart, rawEnd };
}

type Mapped =
  | { ok: true; patch: Omit<PlannedPatch, "operation"> }
  | { ok: false; reason: PlannedListed["reason"] };

function mapEdit(source: string, map: ReturnType<typeof sourceMap>, edit: TextEdit): Mapped {
  if (!validAfter(edit)) return { ok: false, reason: "invalid_after" };
  if (map.points.slice(edit.start, edit.end).join("") !== edit.before) {
    return { ok: false, reason: "stale" };
  }
  // The selected source characters must be the selection exactly (rule 7).
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
        nodeLeft: source.slice(Math.max(0, start - 32), start),
        nodeRight: source.slice(end, end + 32),
        identity: ['pre[class="pf-text"]'],
      },
    },
  };
}

/**
 * Several operations on one text document, in base coordinates: each is mapped against the stored
 * source, touching ranges are listed (`overlap`), the rest are applied together from the end and
 * the result is checked once against the page text with every change spliced in.
 */
export function planText(source: string, edits: readonly TextEdit[]): PlannedFile {
  const listed: PlannedListed[] = [];
  if (source.length > TEXT_LIMIT) {
    return {
      applied: [],
      listed: edits.map((_, operation) => ({ operation, reason: "too_large" })),
    };
  }
  const map = sourceMap(source);
  const found: (PlannedPatch & { edit: TextEdit })[] = [];
  for (const [operation, edit] of edits.entries()) {
    if (operation >= PLAN_OPERATIONS_MAX) {
      listed.push({ operation, reason: "too_large" });
      continue;
    }
    const mapped = mapEdit(source, map, edit);
    if (mapped.ok) found.push({ operation, ...mapped.patch, edit });
    else listed.push({ operation, reason: mapped.reason });
  }
  const kept = withoutOverlaps(found, listed);
  if (kept.length === 0) return { applied: [], listed: byOperation(listed) };
  // One pass each way: the new source and the expected page text, built from the end.
  const parts: string[] = [];
  let cursor = source.length;
  const expected = [...map.points];
  for (const item of [...kept].sort((a, b) => b.start - a.start)) {
    parts.push(source.slice(item.end, cursor), item.replacement);
    cursor = item.start;
    const change = changedRegion(item.edit);
    expected.splice(change.from, change.to - change.from, ...codePoints(change.inserted));
  }
  parts.push(source.slice(0, cursor));
  const next = parts.reverse().join("");
  if (normalizeText(next) !== normalizeText(expected.join(""))) {
    for (const item of kept) {
      listed.push({ operation: item.operation, reason: "would_change_page" });
    }
    return { applied: [], listed: byOperation(listed) };
  }
  return {
    applied: kept.map(({ edit: _edit, ...patch }) => patch),
    listed: byOperation(listed),
    source: next,
  };
}

export function resolveTextEdit(source: string, edit: TextEdit): Resolution {
  const planned = planText(source, [edit]);
  const applied = planned.applied[0];
  if (!applied || planned.source === undefined) {
    return uncertain(planned.listed[0]?.reason ?? "would_change_page");
  }
  return {
    status: "certain",
    source: planned.source,
    range: { start: applied.start, end: applied.end },
    replacement: applied.replacement,
  };
}
