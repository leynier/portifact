// Text anchors over normalized text: creation from code point offsets and resolution by position,
// quote and context. Pure string logic; `document.ts` maps DOM selections onto it.
import { ANCHOR_LIMITS, type TextAnchor } from "@portifact/contracts";
import { clamp, type NormalizedText } from "./normalize.ts";
import { type CreateResult, created, type Orphaned, orphaned, refused } from "./result.ts";

export const MATCH_LIMITS = {
  /** More occurrences than this make a quote ambiguous without scoring them all. */
  occurrences: 10_000,
  /** Shorter quotes are never matched approximately: one edit would change their meaning. */
  fuzzyMinQuote: 8,
  /** Edits allowed in an approximate match, as a share of the quote length. */
  fuzzyErrorRatio: 0.2,
  /** Code points searched on each side of the recorded position for an approximate match. */
  fuzzyWindow: 2_048,
} as const;

export interface TextSpan {
  readonly start: number;
  readonly end: number;
}

export interface LocatedText extends TextSpan {
  readonly confidence: "exact" | "fuzzy";
  /** The text found, which differs from the quote when the match is approximate. */
  readonly text: string;
}

export type TextResolution = LocatedText | Orphaned;

export interface ResolveTextOptions {
  /** Breaks a tie between equally good matches, for example by the anchor's DOM hint. */
  readonly prefer?: (span: TextSpan) => boolean;
}

/** Creates a text anchor for code points `[start, end)`, trimming a space at either edge. */
export function createTextAnchor(
  text: NormalizedText,
  start: number,
  end: number,
): CreateResult<TextAnchor> {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    return refused("invalid_range", "The selection range is invalid");
  }
  if (end > text.length) return refused("invalid_range", "The selection ends after the text");
  if (text.slice(start, start + 1) === " ") start++;
  if (end > start && text.slice(end - 1, end) === " ") end--;
  if (start >= end) return refused("empty_selection", "The selection holds no text");
  if (end - start > ANCHOR_LIMITS.quoteMaxCodePoints) {
    return refused(
      "quote_too_long",
      `The selection is longer than ${ANCHOR_LIMITS.quoteMaxCodePoints} characters`,
    );
  }
  const context = ANCHOR_LIMITS.contextMaxCodePoints;
  return created({
    kind: "text",
    quote: {
      exact: text.slice(start, end),
      prefix: text.slice(start - context, start),
      suffix: text.slice(end, end + context),
    },
    position: { start, end },
  });
}

interface Candidate extends TextSpan {
  readonly score: number;
}

/**
 * Locates a text anchor. Exact when the quote is at the recorded position with its full context.
 * Otherwise the occurrence of the quote with the most matching context wins, then an approximate
 * match near the recorded position. Ties that the recorded position or `prefer` cannot break
 * leave the anchor orphaned as ambiguous, never placed on a guess.
 */
export function resolveTextAnchor(
  text: NormalizedText,
  anchor: TextAnchor,
  options: ResolveTextOptions = {},
): TextResolution {
  const { exact, prefix, suffix } = anchor.quote;
  const context = new Context(text, prefix, suffix);
  const length = Array.from(exact).length;
  const recorded = anchor.position.start;

  const starts = text.occurrences(exact, MATCH_LIMITS.occurrences);
  if (starts === undefined) return orphaned("ambiguous");
  if (starts.length > 0) {
    const candidates = starts.map((start) => context.score(start, start + length));
    const atRecorded = candidates.find((candidate) => candidate.start === recorded);
    if (atRecorded && atRecorded.score === context.full) return located("exact", text, atRecorded);
    return locateBest("fuzzy", text, candidates, recorded, options.prefer);
  }

  const pattern = Array.from(exact);
  if (pattern.length < MATCH_LIMITS.fuzzyMinQuote) return orphaned("not_found");
  const from = clamp(recorded - MATCH_LIMITS.fuzzyWindow, 0, text.length);
  const to = clamp(anchor.position.end + MATCH_LIMITS.fuzzyWindow, 0, text.length);
  const maxErrors = Math.floor(pattern.length * MATCH_LIMITS.fuzzyErrorRatio);
  const matches = approximateMatches(Array.from(text.slice(from, to)), pattern, maxErrors);
  if (matches.length === 0) return orphaned("not_found");
  const candidates = matches.map((match) => context.score(from + match.start, from + match.end));
  return locateBest("fuzzy", text, candidates, recorded, options.prefer);
}

function locateBest(
  confidence: "fuzzy",
  text: NormalizedText,
  candidates: readonly Candidate[],
  recorded: number,
  prefer: ((span: TextSpan) => boolean) | undefined,
): TextResolution {
  const best = candidates.reduce((max, candidate) => Math.max(max, candidate.score), 0);
  const tied = candidates.filter((candidate) => candidate.score === best);
  const chosen =
    tied.length === 1
      ? tied[0]
      : (tied.find((candidate) => candidate.start === recorded) ?? onlyOne(tied, prefer));
  return chosen ? located(confidence, text, chosen) : orphaned("ambiguous");
}

function onlyOne(
  candidates: readonly Candidate[],
  prefer: ((span: TextSpan) => boolean) | undefined,
): Candidate | undefined {
  if (!prefer) return undefined;
  const preferred = candidates.filter(prefer);
  return preferred.length === 1 ? preferred[0] : undefined;
}

function located(confidence: "exact" | "fuzzy", text: NormalizedText, span: TextSpan): LocatedText {
  return { confidence, start: span.start, end: span.end, text: text.slice(span.start, span.end) };
}

/** Scores a candidate by how many code points of the stored prefix and suffix still surround it. */
class Context {
  private readonly prefix: string[];
  private readonly suffix: string[];
  readonly full: number;

  constructor(
    private readonly text: NormalizedText,
    prefix: string,
    suffix: string,
  ) {
    this.prefix = Array.from(prefix);
    this.suffix = Array.from(suffix);
    this.full = this.prefix.length + this.suffix.length;
  }

  score(start: number, end: number): Candidate {
    const before = Array.from(this.text.slice(start - this.prefix.length, start));
    const after = Array.from(this.text.slice(end, end + this.suffix.length));
    let score = 0;
    while (
      score < before.length &&
      before[before.length - 1 - score] === this.prefix[this.prefix.length - 1 - score]
    ) {
      score++;
    }
    let matched = 0;
    while (matched < after.length && after[matched] === this.suffix[matched]) matched++;
    return { start, end, score: score + matched };
  }
}

/**
 * Substrings of `text` within `maxErrors` edits (insertions, deletions, substitutions) of
 * `pattern` at the lowest distance found, one per group of overlapping matches. Sellers'
 * algorithm: an edit-distance table where a match may start anywhere in the text, carrying each
 * cell's start so a match's span is known where it ends.
 */
export function approximateMatches(
  text: readonly string[],
  pattern: readonly string[],
  maxErrors: number,
): TextSpan[] {
  const m = pattern.length;
  let previous = new Int32Array(m + 1);
  let current = new Int32Array(m + 1);
  let previousStart = new Int32Array(m + 1);
  let currentStart = new Int32Array(m + 1);
  for (let i = 0; i <= m; i++) previous[i] = i;

  let best = maxErrors + 1;
  let spans: TextSpan[] = [];
  for (let j = 1; j <= text.length; j++) {
    const character = text[j - 1];
    current[0] = 0;
    currentStart[0] = j;
    for (let i = 1; i <= m; i++) {
      let distance = (previous[i - 1] as number) + (pattern[i - 1] === character ? 0 : 1);
      let start = previousStart[i - 1] as number;
      const skipText = (previous[i] as number) + 1;
      if (skipText < distance) {
        distance = skipText;
        start = previousStart[i] as number;
      }
      const skipPattern = (current[i - 1] as number) + 1;
      if (skipPattern < distance) {
        distance = skipPattern;
        start = currentStart[i - 1] as number;
      }
      current[i] = distance;
      currentStart[i] = start;
    }
    const distance = current[m] as number;
    if (distance < best) {
      best = distance;
      spans = [];
    }
    if (distance === best) spans.push({ start: currentStart[m] as number, end: j });
    [previous, current] = [current, previous];
    [previousStart, currentStart] = [currentStart, previousStart];
  }
  return representatives(spans, m);
}

/** One span per group of overlapping spans: the one closest to the pattern length, then the first. */
function representatives(spans: readonly TextSpan[], length: number): TextSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const groups: TextSpan[][] = [];
  let groupEnd = -1;
  for (const span of sorted) {
    const group = groups.at(-1);
    if (group && span.start < groupEnd) {
      group.push(span);
      groupEnd = Math.max(groupEnd, span.end);
    } else {
      groups.push([span]);
      groupEnd = span.end;
    }
  }
  return groups.map((group) =>
    group.reduce((chosen, span) =>
      Math.abs(span.end - span.start - length) < Math.abs(chosen.end - chosen.start - length)
        ? span
        : chosen,
    ),
  );
}
