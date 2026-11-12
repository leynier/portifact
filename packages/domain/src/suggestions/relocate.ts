// Carrying pending suggestions to a new version (decision 0027, "Suggestions and new versions").
// It is not anchor resolution: `exact` and `fuzzy` say where a quote is, not that its target is
// the same. An operation is carried only by a verified relocation:
//
// 1. Its file is the same bytes in the new version: carried as it is.
// 2. Otherwise the change between the two files is one contiguous region, the operation's source
//    range (persisted in UTF-16 units of the old file) lies wholly outside it and holds the same
//    text, and the new page, rendered once with a distinct private-use marker at every carried
//    range, shows each marker exactly once, in a text node with the same identity and the same
//    node-local context. Then its page position is found again.
//
// Anything else is outdated, keeping its original version and target. Every operation of one file
// is carried together: two renders (marked and unmarked) whatever their number.
import type { CarryOutdatedReason, DocumentRenderer, FileKind, Proof } from "@portifact/contracts";
import { changedRegion, codePoints, type TextEdit } from "./edit.ts";
import { sameIdentity } from "./identity.ts";
import { CONTEXT_WINDOW, type RenderedNode, renderedPage } from "./rendered.ts";
import { newWork, type Work } from "./work.ts";

export interface Carriable {
  edit: TextEdit;
  proof: Proof;
}

export type Carry =
  | { status: "carried"; edit: TextEdit; proof: Proof }
  | { status: "outdated"; reason: CarryOutdatedReason };

/** Private-use code points used as markers, one per operation of a batch. */
const MARKER_BASE = 0xe000;
const MARKERS = /[-]/;
/** Operations carried in one batch: one marker each, all in the private-use area's BMP block. */
export const MARKER_BATCH_MAX = 6_400;

export interface CarryOptions {
  title: string;
  pageUrl: string;
  renderer: DocumentRenderer;
  work?: Work;
}

export function carryAll(
  kind: FileKind,
  oldSource: string,
  newSource: string,
  items: readonly Carriable[],
  options: CarryOptions,
): Carry[] {
  if (oldSource === newSource) return items.map((item) => ({ status: "carried", ...item }));
  if (MARKERS.test(newSource) || items.length > MARKER_BATCH_MAX) {
    return items.map(() => ({ status: "outdated", reason: "marker_in_source" }));
  }
  const work = options.work ?? newWork();
  let prefix = 0;
  const shortest = Math.min(oldSource.length, newSource.length);
  while (prefix < shortest && oldSource[prefix] === newSource[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    oldSource[oldSource.length - 1 - suffix] === newSource[newSource.length - 1 - suffix]
  ) {
    suffix++;
  }
  const delta = newSource.length - oldSource.length;
  const results: Carry[] = items.map(() => ({ status: "outdated", reason: "changed" }));
  const moved: { index: number; start: number; end: number; marker: string }[] = [];
  items.forEach((item, index) => {
    const { start, end } = item.proof;
    let range: { start: number; end: number } | null = null;
    if (end < prefix) range = { start, end };
    else if (start > oldSource.length - suffix) range = { start: start + delta, end: end + delta };
    if (range && newSource.slice(range.start, range.end) === oldSource.slice(start, end)) {
      moved.push({ index, ...range, marker: String.fromCodePoint(MARKER_BASE + moved.length) });
    }
  });
  if (moved.length === 0) return results;
  let marked = newSource;
  for (const item of [...moved].sort((a, b) => b.start - a.start)) {
    marked = marked.slice(0, item.start) + item.marker + marked.slice(item.start);
  }
  const pageOptions = { ...options, work };
  const markedPage = renderedPage(kind, marked, pageOptions);
  const page = renderedPage(kind, newSource, pageOptions).points;
  // Markers before a position shift it in the marked page text; count them as we go.
  const markerAt = new Map<string, number>();
  let seen = 0;
  markedPage.points.forEach((point, at) => {
    const code = point.codePointAt(0) as number;
    if (code >= MARKER_BASE && code < MARKER_BASE + moved.length) {
      markerAt.set(point, markerAt.has(point) ? -1 : at - seen);
      seen++;
    }
  });
  const nodeOf = new Map<string, RenderedNode>();
  for (const node of markedPage.nodes) {
    for (const char of node.data) if (MARKERS.test(char)) nodeOf.set(char, node);
  }
  for (const item of moved) {
    const { edit, proof } = items[item.index] as Carriable;
    const at = markerAt.get(item.marker);
    const node = nodeOf.get(item.marker);
    if (at === undefined || at < 0 || !node) {
      results[item.index] = { status: "outdated", reason: "not_on_page" };
      continue;
    }
    // Same element, attributes and links, and the same text around it in its node.
    const clean = node.data.replace(/[-]/g, (char) => (char === item.marker ? char : ""));
    const local = clean.indexOf(item.marker);
    const after = proof.shownBefore + proof.nodeRight;
    const aroundOk =
      clean.slice(Math.max(0, local - proof.nodeLeft.length), local) === proof.nodeLeft &&
      clean.slice(local + 1, local + 1 + after.length) === after &&
      (!markedPage.anchored ||
        proof.nodeLeft.length >= CONTEXT_WINDOW ||
        local === proof.nodeLeft.length) &&
      (!markedPage.anchored ||
        proof.nodeRight.length >= CONTEXT_WINDOW ||
        local + 1 + after.length === clean.length);
    if (!sameIdentity(node.identity, proof.identity) || !aroundOk) {
      results[item.index] = { status: "outdated", reason: "target_changed" };
      continue;
    }
    const change = changedRegion(edit);
    const start = at - (change.from - edit.start);
    const end = start + codePoints(edit.before).length;
    if (start < 0 || page.slice(start, end).join("") !== edit.before) {
      results[item.index] = { status: "outdated", reason: "not_on_page" };
      continue;
    }
    results[item.index] = {
      status: "carried",
      edit: { ...edit, start, end },
      proof: { ...proof, start: item.start, end: item.end },
    };
  }
  return results;
}
