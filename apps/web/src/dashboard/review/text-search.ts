// "Suggest a text change" for people who cannot select text in the frame (decision 0027,
// "Suggesting"): the viewer searches the stored page, never the frame. The page's HTML file is
// parsed here with `DOMParser`, which runs no script and loads nothing, and read with
// `packages/anchors` exactly as the bridge reads a page, so a match becomes the same text target
// a selection would. The server plans from the stored files anyway.
import {
  AnchorDocument,
  type AnchorElement,
  contentHash,
  createTextAnchor,
  normalizeText,
} from "@portifact/anchors";
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

/** The text model of a stored HTML page, built without running it. */
export function pageDocument(html: string): AnchorDocument {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  return new AnchorDocument(parsed.body as unknown as AnchorElement);
}

/** Every place the query's normalized text occurs, at most `maxMatches`. */
export function findMatches(doc: AnchorDocument, query: string): TextMatch[] {
  const needle = normalizeText(query).trim();
  if (needle === "") return [];
  const value = doc.text.value;
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
      before: doc.text.slice(Math.max(0, start - context), start),
      text: doc.text.slice(start, end),
      after: doc.text.slice(end, Math.min(doc.text.length, end + context)),
    });
    from = at + needle.length;
  }
  return matches;
}

/** The text target of a match on the page at `path`, or null when the anchors refuse it. */
export async function targetOf(
  doc: AnchorDocument,
  match: TextMatch,
  path: string,
): Promise<TextTarget | null> {
  const created = createTextAnchor(doc.text, match.start, match.end);
  if (!created.ok) return null;
  const target: AnnotationTarget = {
    schema: ANCHOR_SCHEMA_VERSION,
    path,
    contentHash: await contentHash(doc.text.value),
    anchor: created.value,
  };
  return target.anchor.kind === "text" ? (target as TextTarget) : null;
}
