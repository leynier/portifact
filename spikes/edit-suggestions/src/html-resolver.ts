// The static HTML resolver of decision 0027. A site's page is static for an edit when the text
// the reviewer saw is exactly the text of the file parsed without running scripts (the target's
// `contentHash` against the hash of the parsed file's text): then no script wrote or changed any
// of it at that moment. The changed text, with its context, must occur exactly once in the whole
// file (text, attributes, scripts, styles and comments alike) and once in the page text. The new
// text is written HTML-escaped, and the result is certain only when parsing the new file gives
// the expected text and an identical skeleton, scripts and styles included.
import { contentHash } from "@portifact/anchors";
import {
  changedRegion,
  type Resolution,
  type TextEdit,
  uncertain,
  unitOffset,
  validAfter,
} from "./edit.ts";
import {
  codePoints,
  flexibleMatches,
  occurrences,
  pageText,
  parseDocument,
  skeleton,
  spliceCodePoints,
} from "./page.ts";

const CONTEXTS = [24, 12, 6, 3, 1, 0];
const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] as string);
}

interface StaticPage {
  text: string;
  skeleton: string;
}

function staticPage(html: string): StaticPage {
  const body = parseDocument(html).body;
  return { text: pageText(body), skeleton: skeleton(parseDocument(html).documentElement) };
}

export async function resolveHtmlEdit(
  html: string,
  edit: TextEdit,
  /** The target's `contentHash`: the hash of the page text the reviewer saw, from the bridge. */
  liveHash: string,
): Promise<Resolution> {
  if (!validAfter(edit)) return uncertain("invalid_after");
  const page = staticPage(html);
  if ((await contentHash(page.text)) !== liveHash) return uncertain("script_text");
  if (codePoints(page.text).slice(edit.start, edit.end).join("") !== edit.before)
    return uncertain("stale");
  const change = changedRegion(edit);
  const expected = spliceCodePoints(page.text, change.from, change.to, change.inserted);
  const a = unitOffset(page.text, change.from);
  const b = unitOffset(page.text, change.to);
  let found = false;
  for (const width of CONTEXTS) {
    const left = page.text.slice(Math.max(0, a - width), a);
    const right = page.text.slice(b, b + width);
    const needle = left + change.deleted + right;
    if (needle.length === 0 || occurrences(page.text, needle).length !== 1) continue;
    const matches = flexibleMatches(html, needle);
    if (matches.length !== 1) continue;
    found = true;
    const match = matches[0] as { start: number; end: number };
    const head = flexibleMatches(html.slice(match.start), left, 0)[0];
    const leftEnd = left.length === 0 ? match.start : match.start + (head?.end ?? 0);
    const tail = flexibleMatches(html.slice(0, match.end), right, 1_000).at(-1);
    const rightStart = right.length === 0 ? match.end : (tail?.start ?? -1);
    if (rightStart < leftEnd) continue;
    const replacement = escapeHtml(change.inserted);
    const next = html.slice(0, leftEnd) + replacement + html.slice(rightStart);
    const after = staticPage(next);
    if (after.text === expected && after.skeleton === page.skeleton) {
      return {
        status: "certain",
        source: next,
        range: { start: leftEnd, end: rightStart },
        replacement,
      };
    }
  }
  return uncertain(found ? "would_change_page" : "not_found");
}
