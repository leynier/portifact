// "Suggest a text change" for people who cannot select text in the frame (decision 0027,
// "Suggesting"): the viewer searches the page's text, never the frame. The server gives the shown
// text of the served page as `packages/anchors` reads it (`GET .../page-text`, to whoever may
// suggest), so a match here becomes the same text target a selection in the frame would. The
// server plans from the stored files anyway.
import { contentHash, createTextAnchor, NormalizedText, normalizeText } from "@portifact/anchors";
import { ANCHOR_SCHEMA_VERSION, type AnnotationTarget } from "@portifact/contracts";
import type { TextTarget } from "./suggest-session.ts";

export const TEXT_SEARCH = {
  /** Matches listed for one query; a longer list asks for more of the text. */
  maxMatches: 20,
  /** Code points of context shown on each side of a match. */
  contextCodePoints: 40,
} as const;

export interface TextMatch {
  /** Code point offsets in the page's normalized text, as text anchors count. */
  start: number;
  end: number;
  before: string;
  text: string;
  after: string;
}

/** The text model of the page text the server gave. */
export function pageText(text: string): NormalizedText {
  return NormalizedText.from(text);
}

/** Every place the query's normalized text occurs, at most `maxMatches`. */
export function findMatches(text: NormalizedText, query: string): TextMatch[] {
  const needle = normalizeText(query).trim();
  if (needle === "") return [];
  const value = text.value;
  const codePoints = (end: number) => Array.from(value.slice(0, end)).length;
  const matches: TextMatch[] = [];
  let from = 0;
  while (matches.length < TEXT_SEARCH.maxMatches) {
    const at = value.indexOf(needle, from);
    if (at === -1) break;
    const start = codePoints(at);
    const end = start + Array.from(needle).length;
    const context = TEXT_SEARCH.contextCodePoints;
    matches.push({
      start,
      end,
      before: text.slice(Math.max(0, start - context), start),
      text: text.slice(start, end),
      after: text.slice(end, Math.min(text.length, end + context)),
    });
    from = at + needle.length;
  }
  return matches;
}

/** The text target of a match on the page at `path`, or null when the anchors refuse it. */
export async function targetOf(
  text: NormalizedText,
  match: TextMatch,
  path: string,
): Promise<TextTarget | null> {
  const created = createTextAnchor(text, match.start, match.end);
  if (!created.ok) return null;
  const target: AnnotationTarget = {
    schema: ANCHOR_SCHEMA_VERSION,
    path,
    contentHash: await contentHash(text.value),
    anchor: created.value,
  };
  return target.anchor.kind === "text" ? (target as TextTarget) : null;
}
