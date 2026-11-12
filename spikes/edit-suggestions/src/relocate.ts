// Carrying a pending suggestion to a new version (decision 0027, rule 11). It is not anchor
// resolution: `exact` and `fuzzy` describe where a quote is found, not that the text around it is
// the same. A suggestion is carried only by a verified relocation:
//
// 1. Its file is the same bytes in the new version: carried as it is.
// 2. Otherwise the change between the two sources is one contiguous region (common prefix and
//    suffix), and the suggestion's source range lies wholly outside it. Its range is shifted by
//    the region's change in length, the shifted source text must equal the original, and its page
//    position is found again by rendering the new source with a private-use marker at the range
//    (the marker must appear exactly once in the page text, and the before must sit there).
//
// Anything else is outdated. The original version and target stay with the suggestion; only the
// carried coordinates are new.
import { normalizeText } from "@portifact/anchors";
import { changedRegion, type TextEdit } from "./edit.ts";
import { renderPage } from "./markdown-resolver.ts";
import { codePoints } from "./page.ts";

const MARKER = "";

export type Carry =
  | { status: "carried"; edit: TextEdit; sourceRange: { start: number; end: number } }
  | { status: "outdated"; reason: "changed" | "not_on_page" | "marker_in_source" };

function pageOf(kind: "markdown" | "text", source: string): string {
  return kind === "markdown" ? renderPage(source).text : normalizeText(source);
}

export function carry(
  kind: "markdown" | "text",
  oldSource: string,
  newSource: string,
  edit: TextEdit,
  sourceRange: { start: number; end: number },
): Carry {
  if (oldSource === newSource) return { status: "carried", edit, sourceRange };
  if (newSource.includes(MARKER)) return { status: "outdated", reason: "marker_in_source" };
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
  let moved: { start: number; end: number };
  if (sourceRange.end < prefix) moved = sourceRange;
  else if (sourceRange.start > oldSource.length - suffix) {
    moved = { start: sourceRange.start + delta, end: sourceRange.end + delta };
  } else return { status: "outdated", reason: "changed" };
  if (
    newSource.slice(moved.start, moved.end) !== oldSource.slice(sourceRange.start, sourceRange.end)
  ) {
    return { status: "outdated", reason: "changed" };
  }
  const marked = newSource.slice(0, moved.start) + MARKER + newSource.slice(moved.start);
  const markedPage = codePoints(pageOf(kind, marked));
  const at = markedPage.indexOf(MARKER);
  if (at < 0 || markedPage.indexOf(MARKER, at + 1) >= 0)
    return { status: "outdated", reason: "not_on_page" };
  // The source range is the changed part; the selection starts that many code points earlier.
  const change = changedRegion(edit);
  const start = at - (change.from - edit.start);
  const end = start + codePoints(edit.before).length;
  const page = codePoints(pageOf(kind, newSource));
  if (start < 0 || page.slice(start, end).join("") !== edit.before) {
    return { status: "outdated", reason: "not_on_page" };
  }
  return { status: "carried", edit: { ...edit, start, end }, sourceRange: moved };
}
