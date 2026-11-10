// Content search (premium plan T8, decision 0012): what text an artifact gives the index, how it
// is prepared for SQLite FTS5's unicode61 tokenizer, how a query becomes a MATCH expression that
// cannot reach FTS5's syntax, and how a marked snippet becomes plain text with ranges. Pure: the
// services read the bytes, apply these rules and write the rows.
import { type PlanFeature, SEARCH_LIMITS, type SnippetRange } from "@portifact/contracts";
import { htmlText } from "./html-text.ts";
import { fail, ok, type Result } from "./result.ts";

export const CONTENT_SEARCH_FEATURE: PlanFeature = "contentSearch";

/**
 * Separates adjacent CJK characters in the indexed text, so unicode61 makes one token of each and
 * a word is found inside a run with no spaces. One byte, a control character unicode61 treats as
 * a separator; removed from every input first and from snippets on the way out.
 */
export const SEGMENT = "\u001f";
/** Snippet markers FTS5 puts around a match: private-use characters removed from every input. */
export const MARK_OPEN = String.fromCharCode(0xe000);
export const MARK_CLOSE = String.fromCharCode(0xe001);

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const TERM = /[\p{L}\p{N}\p{M}]+/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u{e000}\u{e001}]/gu;

/**
 * Text as the index keeps it: no control characters (C0 but tabs and new lines, DEL and C1, so a
 * snippet cannot carry a terminal escape) and none of the index's own markers.
 */
export function cleanText(text: string): string {
  return text.replace(CONTROL, " ");
}

/**
 * The text as given to FTS5: CJK characters separated, and ё folded to е (unicode61 keeps them
 * apart, a Russian reader does not). Expects `cleanText` output; strips stray separators anyway.
 */
export function segmentText(text: string): string {
  const folded = text.replaceAll(SEGMENT, " ").replaceAll("ё", "е").replaceAll("Ё", "Е");
  let out = "";
  let previousCjk = false;
  for (const char of folded) {
    const cjk = CJK.test(char);
    if (cjk && previousCjk) out += SEGMENT;
    out += char;
    previousCjk = cjk;
  }
  return out;
}

/** An owner ID as one unicode61 token: the owner column holds it and every query filters on it. */
export function ownerToken(ownerId: string): string {
  let hex = "";
  for (const byte of new TextEncoder().encode(ownerId)) hex += byte.toString(16).padStart(2, "0");
  return `o${hex}`;
}

/**
 * The MATCH expression for a query: null when it has nothing to search for, `invalid_input` when
 * it is longer than the boundary allows or holds more different words, or a longer Chinese or
 * Japanese run, than `SEARCH_LIMITS` lets one query read (refused, never cut, so an accepted query
 * never matches more than asked). Each run of letters, marks and digits becomes a quoted phrase
 * and every phrase must match, so quotes, operators, column filters, NEAR and parentheses a user
 * types are only separators: they can neither cause a syntax error nor widen the search. A word
 * repeated, in any case, counts once. A run with CJK characters becomes a phrase of single
 * characters, which finds it inside a longer run. Whole words only: no prefix search.
 */
export function buildMatchExpression(query: string): Result<string | null> {
  if (query.length > SEARCH_LIMITS.queryChars) {
    return fail("invalid_input", `Search for 1 to ${SEARCH_LIMITS.queryChars} characters.`);
  }
  const phrases = new Map<string, string>();
  for (const [term] of query.normalize("NFC").matchAll(TERM)) {
    const tokens = segmentText(term).split(SEGMENT);
    if (tokens.length > SEARCH_LIMITS.queryPhraseTokens) {
      return fail(
        "invalid_input",
        `Search for runs of at most ${SEARCH_LIMITS.queryPhraseTokens} Chinese or Japanese characters.`,
      );
    }
    const phrase = tokens.join(" ");
    const key = phrase.toLowerCase();
    if (!phrases.has(key)) phrases.set(key, `"${phrase}"`);
    if (phrases.size > SEARCH_LIMITS.queryTerms) {
      return fail(
        "invalid_input",
        `Search for at most ${SEARCH_LIMITS.queryTerms} different words.`,
      );
    }
  }
  return ok(phrases.size === 0 ? null : [...phrases.values()].join(" AND "));
}

/**
 * The expression limited to one owner's rows and to the body: the owner column must hold the
 * owner's token, and the user's words are matched only against the text, never the owner column.
 */
export function ownerMatch(ownerId: string, expression: string): string {
  return `owner : ${ownerToken(ownerId)} AND body : (${expression})`;
}

/**
 * FTS5's marked snippet as plain text and highlight ranges (UTF-16 code units). Separators are
 * dropped, adjacent highlights (CJK characters are one token each) are joined, and an unbalanced
 * marker is ignored.
 */
export function parseSnippet(marked: string): { text: string; highlights: SnippetRange[] } {
  let text = "";
  const highlights: SnippetRange[] = [];
  let start = -1;
  for (const char of marked) {
    if (char === SEGMENT) continue;
    if (char === MARK_OPEN) {
      start = text.length;
    } else if (char === MARK_CLOSE) {
      if (start >= 0 && text.length > start) {
        const last = highlights.at(-1);
        if (last && last[1] === start) last[1] = text.length;
        else highlights.push([start, text.length]);
      }
      start = -1;
    } else {
      text += char;
    }
  }
  return { text, highlights };
}

/**
 * Characters of one indexed chunk. FTS5's `snippet()` costs grow with the hits in a row, so the
 * text is indexed in small rows: a frequent word in a large file stays cheap to show.
 */
export const CHUNK_CHARS = 4_000;

/**
 * The text in chunks of at most `max` characters, cut at white space in the last fifth of a chunk
 * when there is some (else mid-run, never inside a surrogate pair). A phrase across a cut is not
 * found; a word is never split where white space allows.
 */
export function chunkText(text: string, max = CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = -1;
    for (let i = max; i >= Math.floor(max * 0.8); i--) {
      if (/\s/.test(rest[i] as string)) {
        cut = i;
        break;
      }
    }
    if (cut === -1) {
      const code = rest.charCodeAt(max - 1);
      cut = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
    }
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/** The longest prefix of `text` that fits `maxBytes` of UTF-8, never splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (text.length * 3 <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = utf8Length(char);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}

export function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * A file's text as the index keeps it: the visible text of an HTML page or the source as it is,
 * cleaned, trimmed and cut to `maxBytes` of UTF-8. The extractor never builds more than
 * `maxBytes` characters (a character is at least a byte), so what one file holds is bounded by
 * the budget left, not by the file. `cut` says something was left out.
 */
export function indexText(
  raw: string,
  html: boolean,
  maxBytes: number,
): { text: string; bytes: number; cut: boolean } {
  const budget = Math.max(0, maxBytes);
  const extracted = html
    ? htmlText(raw, budget)
    : { text: raw.slice(0, budget), truncated: raw.length > budget };
  const cleaned = cleanText(extracted.text).trim();
  const text = truncateUtf8(cleaned, budget);
  return {
    text,
    bytes: utf8Length(text),
    cut: extracted.truncated || text.length < cleaned.length,
  };
}
