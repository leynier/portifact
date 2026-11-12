// The plain-text resolver of decision 0027. A text document's page is its source in a `<pre>`,
// so the page's normalized text is the source normalized, and each normalized code point comes
// from a known range of the source. The edit maps to the source range of the code points it
// replaces, and is certain when normalizing the changed source gives the expected page text.
import { normalizeText } from "@portifact/anchors";
import { changedRegion, type Resolution, type TextEdit, uncertain, validAfter } from "./edit.ts";
import { codePoints, spliceCodePoints } from "./page.ts";

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
