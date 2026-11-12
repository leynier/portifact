// The plain-text resolver of decision 0027. A text document's page is its source in a `<pre>`,
// so the page's normalized text is the source normalized, and each normalized code point comes
// from a known range of the source. The edit maps to the source range of the code points it
// replaces, and is certain when the selected source characters are exactly the selection (no
// whitespace differs) and normalizing the changed source gives the expected page text.
import { normalizeText } from "@portifact/anchors";
import { changedRegion, type Resolution, type TextEdit, uncertain, validAfter } from "./edit.ts";
import { codePoints, spliceCodePoints } from "./page.ts";
import { byOperation, type PlannedFile, withoutOverlaps } from "./planned.ts";

/**
 * Normalized code points with the UTF-16 range of the source each came from. A copy of the map
 * `packages/anchors` keeps internally (`normalizeWithMap`, not exported), reduced to NFC
 * sources: a source that is not NFC is refused rather than mapped.
 */
function sourceMap(source: string): { text: string; rawStart: number[]; rawEnd: number[] } {
  const rawStart: number[] = [];
  const rawEnd: number[] = [];
  let text = "";
  let space: { start: number; end: number } | null = null;
  let unit = 0;
  for (const point of source) {
    const start = unit;
    unit += point.length;
    if (/[\s\p{Cc}]/u.test(point)) {
      space = space ? { start: space.start, end: unit } : { start, end: unit };
      continue;
    }
    if (space && text.length > 0) {
      text += " ";
      rawStart.push(space.start);
      rawEnd.push(space.end);
    }
    space = null;
    text += point.toWellFormed();
    rawStart.push(start);
    rawEnd.push(unit);
  }
  return { text, rawStart, rawEnd };
}

export function resolveTextEdit(source: string, edit: TextEdit): Resolution {
  if (!validAfter(edit)) return uncertain("invalid_after");
  if (source.normalize("NFC") !== source || !source.isWellFormed()) return uncertain("not_nfc");
  const map = sourceMap(source);
  const points = codePoints(map.text);
  if (points.slice(edit.start, edit.end).join("") !== edit.before) return uncertain("stale");
  // Every whitespace character of a text document is shown as it is: the selection must be the
  // source's characters exactly, so no line break, tab or run of spaces is hidden (rule 7).
  const rawBefore = source.slice(
    map.rawStart[edit.start] as number,
    map.rawEnd[edit.end - 1] as number,
  );
  if (rawBefore !== edit.before) return uncertain("whitespace");
  const change = changedRegion(edit);
  // An insertion at the very end goes right after the last character, before trailing space.
  const start =
    change.from < points.length
      ? (map.rawStart[change.from] as number)
      : (map.rawEnd[points.length - 1] ?? source.length);
  const end = change.from < change.to ? (map.rawEnd[change.to - 1] as number) : start;
  const next = source.slice(0, start) + change.inserted + source.slice(end);
  const expected = spliceCodePoints(map.text, change.from, change.to, change.inserted);
  if (normalizeText(next) !== expected) return uncertain("would_change_page");
  return { status: "certain", source: next, range: { start, end }, replacement: change.inserted };
}

/**
 * Several operations on one text document, in base coordinates: each is resolved against the
 * stored source, touching ranges are listed (`overlap`), the rest are applied together from the
 * end and the result is checked once against the page text with every change spliced in.
 */
export function planText(source: string, edits: readonly TextEdit[]): PlannedFile {
  const listed: PlannedFile["listed"] = [];
  const found: {
    operation: number;
    start: number;
    end: number;
    replacement: string;
    edit: TextEdit;
    destinations: string[];
  }[] = [];
  for (const [operation, edit] of edits.entries()) {
    const result = resolveTextEdit(source, edit);
    if (result.status !== "certain") {
      listed.push({ operation, reason: result.reason });
      continue;
    }
    found.push({
      operation,
      ...result.range,
      replacement: result.replacement,
      edit,
      destinations: [],
    });
  }
  const kept = withoutOverlaps(found, listed);
  if (kept.length === 0) return { applied: [], listed: byOperation(listed) };
  let next = source;
  let expected = normalizeText(source);
  const byStart = [...kept].sort((a, b) => b.start - a.start);
  for (const item of byStart) {
    next = next.slice(0, item.start) + item.replacement + next.slice(item.end);
    const change = changedRegion(item.edit);
    expected = spliceCodePoints(expected, change.from, change.to, change.inserted);
  }
  if (normalizeText(next) !== expected) {
    for (const item of kept)
      listed.push({ operation: item.operation, reason: "would_change_page" });
    return { applied: [], listed: byOperation(listed) };
  }
  return { applied: kept, listed: byOperation(listed), source: next };
}
