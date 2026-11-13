// Carrying pending suggestions to a new version (decision 0027, rule 11, and rule 5 of the second
// round). It is not anchor resolution: `exact` and `fuzzy` say where a quote is, not that its
// target is the same. A suggestion is carried only by a verified relocation:
//
// 1. Its file is the same bytes in the new version: carried as it is.
// 2. Otherwise the change between the two files is one contiguous region, the suggestion's source
//    range (persisted in UTF-16 units of the old file) lies wholly outside it and holds the same
//    text, and the new page, rendered once with a distinct private-use marker at every carried
//    range, shows each marker exactly once, in a text node with the same identity (elements,
//    attributes, link destinations) and the same node-local context. Then its page position is
//    found again.
//
// Anything else is outdated, keeping its original version and target. All suggestions of one file
// are carried together: two renders (marked and unmarked) whatever their number.
import { changedRegion, type TextEdit } from "./edit.ts";
import { codePoints } from "./page.ts";
import type { Proof } from "./planned.ts";
import { CONTEXT_WINDOW, type FileKind, renderedPage, sameIdentity } from "./rendered.ts";

export interface Carriable {
  edit: TextEdit;
  proof: Proof;
}

export type Carry =
  | { status: "carried"; edit: TextEdit; proof: Proof }
  | {
      status: "outdated";
      reason: "changed" | "not_on_page" | "target_changed" | "marker_in_source";
    };

/** Private-use code points used as markers, one per suggestion of a batch. */
const MARKER_BASE = 0xe000;
export const CARRY_BATCH_MAX = 6_400;

export function carryAll(
  kind: FileKind,
  oldSource: string,
  newSource: string,
  items: readonly Carriable[],
): Carry[] {
  if (oldSource === newSource) return items.map((item) => ({ status: "carried", ...item }));
  if (/[-]/.test(newSource) || items.length > CARRY_BATCH_MAX) {
    return items.map(() => ({ status: "outdated", reason: "marker_in_source" }));
  }
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
  const markedPage = renderedPage(kind, marked);
  const markedText = codePoints(markedPage.text);
  const page = codePoints(renderedPage(kind, newSource).text);
  // Markers before a position shift it in the marked page text; count them as we go.
  const markerAt = new Map<string, number>();
  let seen = 0;
  markedText.forEach((point, at) => {
    const code = point.codePointAt(0) as number;
    if (code >= MARKER_BASE && code < MARKER_BASE + moved.length) {
      markerAt.set(point, markerAt.has(point) ? -1 : at - seen);
      seen++;
    }
  });
  for (const item of moved) {
    const { edit, proof } = items[item.index] as Carriable;
    const at = markerAt.get(item.marker);
    const node = markedPage.nodes.find((each) => each.data.includes(item.marker));
    if (at === undefined || at < 0 || !node) {
      results[item.index] = { status: "outdated", reason: "not_on_page" };
      continue;
    }
    // Same element, attributes and links, and the same text around it in its node.
    const clean = node.data.replace(/[-]/g, (char) => (char === item.marker ? char : ""));
    const local = clean.indexOf(item.marker);
    const after = proof.shownBefore + proof.nodeRight;
    const aroundOk =
      clean.slice(local - proof.nodeLeft.length, local) === proof.nodeLeft &&
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

/** One suggestion, as the first round's tests call it. */
export function carry(
  kind: FileKind,
  oldSource: string,
  newSource: string,
  edit: TextEdit,
  proof: Proof,
): Carry {
  return carryAll(kind, oldSource, newSource, [{ edit, proof }])[0] as Carry;
}
