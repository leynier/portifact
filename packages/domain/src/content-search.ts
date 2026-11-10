// Content search (premium plan T8, decision 0012): what text an artifact gives the index, how it
// is prepared for SQLite FTS5's unicode61 tokenizer, how a query becomes a MATCH expression that
// cannot reach FTS5's syntax, and how a marked snippet becomes plain text with ranges. Pure: the
// services read the bytes, apply these rules and write the rows.
import { type PlanFeature, SEARCH_LIMITS, type SnippetRange } from "@portifact/contracts";

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
 * The MATCH expression for a query, or null when it has nothing to search for (or is longer than
 * the boundary allows, which it refuses anyway). Each run of letters, marks and digits becomes a
 * quoted phrase and every phrase must match, so quotes, operators, column filters, NEAR and
 * parentheses a user types are only separators: they can neither cause a syntax error nor widen
 * the search. A run with CJK characters becomes a phrase of single characters, which finds it
 * inside a longer run. Whole words only: no prefix search.
 */
export function buildMatchExpression(query: string): string | null {
  if (query.length > SEARCH_LIMITS.queryChars) return null;
  const phrases: string[] = [];
  for (const [term] of query.normalize("NFC").matchAll(TERM)) {
    const tokens = segmentText(term).split(SEGMENT);
    phrases.push(`"${tokens.join(" ")}"`);
  }
  return phrases.length === 0 ? null : phrases.join(" AND ");
}

/** The expression limited to one owner's rows: the owner column must hold its token. */
export function ownerMatch(ownerId: string, expression: string): string {
  return `owner : ${ownerToken(ownerId)} AND (${expression})`;
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

export interface ExtractedFile {
  path: string;
  text: string;
  /** The text was cut at a cap (the bytes read or the extracted text). */
  truncated: boolean;
}

export interface IndexPlan {
  files: { path: string; text: string; bytes: number }[];
  bytes: number;
  /** Something was left out: a file over a cap, files over the per-version count, or a budget. */
  partial: boolean;
}

/**
 * Which text of a version goes into the index, in the order given (the entrypoint first): each
 * file up to the per-file cap, the version up to its cap and the owner's remaining budget, and
 * at most `filesPerVersion` files. Files with no text after extraction are left out.
 */
export function planIndex(
  files: ExtractedFile[],
  ownerRemainingBytes: number,
  limits: {
    fileTextBytes: number;
    versionTextBytes: number;
    filesPerVersion: number;
  } = SEARCH_LIMITS,
): IndexPlan {
  let budget = Math.max(0, Math.min(limits.versionTextBytes, ownerRemainingBytes));
  let partial = files.length > limits.filesPerVersion;
  const planned: IndexPlan["files"] = [];
  let total = 0;
  for (const file of files.slice(0, limits.filesPerVersion)) {
    if (file.truncated) partial = true;
    const text = file.text.trim();
    if (text.length === 0) continue;
    const cap = Math.min(limits.fileTextBytes, budget);
    const kept = truncateUtf8(text, cap);
    if (kept.length < text.length) partial = true;
    if (kept.length === 0) continue;
    const bytes = utf8Length(kept);
    planned.push({ path: file.path, text: kept, bytes });
    budget -= bytes;
    total += bytes;
  }
  return { files: planned, bytes: total, partial };
}
