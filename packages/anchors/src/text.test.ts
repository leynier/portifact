import { ANCHOR_LIMITS, TextAnchor } from "@portifact/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { NormalizedText } from "./normalize.ts";
import {
  approximateMatches,
  createTextAnchor,
  MATCH_LIMITS,
  resolveTextAnchor,
  type TextResolution,
} from "./text.ts";

const text = (raw: string) => NormalizedText.from(raw);

const anchorOf = (value: NormalizedText, start: number, end: number) => {
  const result = createTextAnchor(value, start, end);
  if (!result.ok) throw new Error(`expected an anchor: ${result.message}`);
  return result.value;
};

const span = (resolution: TextResolution) =>
  resolution.confidence === "orphaned"
    ? resolution
    : { confidence: resolution.confidence, start: resolution.start, end: resolution.end };

/** Edit distance, to check approximate matches independently of the matcher. */
function distance(a: readonly string[], b: readonly string[]): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(
        (row[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
        (row[j] as number) + 1,
        (next[j - 1] as number) + 1,
      );
    }
    row = next;
  }
  return row[b.length] as number;
}

describe("createTextAnchor", () => {
  const value = text("The quick brown fox jumps over the lazy dog");

  it("records the quote, bounded context and code point position", () => {
    expect(anchorOf(value, 10, 19)).toEqual({
      kind: "text",
      quote: { exact: "brown fox", prefix: "The quick ", suffix: " jumps over the lazy dog" },
      position: { start: 10, end: 19 },
    });
  });

  it("caps the prefix and suffix at the context length", () => {
    const long = text(`${"a".repeat(50)}X${"b".repeat(50)}`);
    const anchor = anchorOf(long, 50, 51);
    expect(anchor.quote.prefix).toBe("a".repeat(ANCHOR_LIMITS.contextMaxCodePoints));
    expect(anchor.quote.suffix).toBe("b".repeat(ANCHOR_LIMITS.contextMaxCodePoints));
  });

  it("trims a space at either edge of the selection", () => {
    expect(anchorOf(value, 9, 20).quote.exact).toBe("brown fox");
    expect(anchorOf(value, 9, 20).position).toEqual({ start: 10, end: 19 });
  });

  it("counts emoji as one code point each", () => {
    const emoji = text("hi \u{1F600}\u{1F601} there");
    expect(anchorOf(emoji, 3, 5).quote.exact).toBe("\u{1F600}\u{1F601}");
  });

  it.each([
    [-1, 3, "invalid_range"],
    [3, 2, "invalid_range"],
    [0.5, 3, "invalid_range"],
    [0, Number.NaN, "invalid_range"],
    [0, 999, "invalid_range"],
    [3, 3, "empty_selection"],
    [9, 10, "empty_selection"],
    [43, 43, "empty_selection"],
  ])("refuses [%d, %d) with %s", (start, end, reason) => {
    const result = createTextAnchor(value, start, end);
    expect(result).toMatchObject({ ok: false, code: "invalid_input", reason });
  });

  it("refuses a quote over the limit and accepts one at the limit", () => {
    const max = ANCHOR_LIMITS.quoteMaxCodePoints;
    const long = text("\u{1F600}".repeat(max + 1));
    expect(createTextAnchor(long, 0, max).ok).toBe(true);
    expect(createTextAnchor(long, 0, max + 1)).toMatchObject({
      ok: false,
      reason: "quote_too_long",
    });
  });

  it("always produces an anchor the contract accepts, whose quote is the selected text", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: "grapheme", maxLength: 120 }),
        fc.nat(),
        fc.nat(),
        (raw, a, b) => {
          const value = text(raw);
          const start = a % (value.length + 1);
          const end = start + (b % (value.length - start + 1));
          const result = createTextAnchor(value, start, end);
          if (!result.ok) {
            expect(["empty_selection"]).toContain(result.reason);
            expect(value.slice(start, end).trim()).toBe("");
            return;
          }
          expect(TextAnchor.safeParse(result.value).success).toBe(true);
          expect(result.value.quote.exact).toBe(value.slice(start, end).trim());
        },
      ),
    );
  });
});

describe("resolveTextAnchor", () => {
  const value = text("one two three two one");

  it("is exact at the recorded position with its context", () => {
    const anchor = anchorOf(value, 14, 17);
    expect(resolveTextAnchor(value, anchor)).toEqual({
      confidence: "exact",
      start: 14,
      end: 17,
      text: "two",
    });
  });

  it("follows the quote by its context when the text before it changed", () => {
    const anchor = anchorOf(value, 14, 17);
    const edited = text("zero one two three two one");
    expect(span(resolveTextAnchor(edited, anchor))).toEqual({
      confidence: "fuzzy",
      start: 19,
      end: 22,
    });
  });

  it("is fuzzy, not exact, when the quote sits at the recorded position with other context", () => {
    const anchor = anchorOf(value, 4, 7);
    const edited = text("one two four");
    expect(span(resolveTextAnchor(edited, anchor))).toEqual({
      confidence: "fuzzy",
      start: 4,
      end: 7,
    });
  });

  it("uses the recorded position to break a tie in context", () => {
    const repeated = text("x a x a x");
    const anchor = { ...anchorOf(repeated, 2, 3), quote: { exact: "a", prefix: "q", suffix: "" } };
    expect(
      span(resolveTextAnchor(repeated, { ...anchor, position: { start: 6, end: 7 } })),
    ).toEqual({
      confidence: "fuzzy",
      start: 6,
      end: 7,
    });
  });

  it("leaves a tie it cannot break orphaned as ambiguous", () => {
    const repeated = text("x a x a x");
    const anchor = { ...anchorOf(repeated, 2, 3), quote: { exact: "a", prefix: "", suffix: "" } };
    const moved = { ...anchor, position: { start: 0, end: 1 } };
    expect(resolveTextAnchor(repeated, moved)).toEqual({
      confidence: "orphaned",
      reason: "ambiguous",
    });
  });

  it("lets a preference break a tie only when it picks exactly one match", () => {
    const repeated = text("x a x a x a x");
    const anchor = {
      ...anchorOf(repeated, 2, 3),
      quote: { exact: "a", prefix: "", suffix: "" },
      position: { start: 0, end: 1 },
    };
    const one = resolveTextAnchor(repeated, anchor, { prefer: (s) => s.start === 6 });
    expect(span(one)).toEqual({ confidence: "fuzzy", start: 6, end: 7 });
    const two = resolveTextAnchor(repeated, anchor, { prefer: (s) => s.start > 2 });
    expect(two).toEqual({ confidence: "orphaned", reason: "ambiguous" });
  });

  it("is ambiguous when the quote occurs more often than the search limit", () => {
    const many = text("a ".repeat(MATCH_LIMITS.occurrences + 1));
    const anchor = anchorOf(many, 0, 1);
    expect(resolveTextAnchor(many, anchor)).toEqual({
      confidence: "orphaned",
      reason: "ambiguous",
    });
  });

  it("finds a slightly edited quote near the recorded position, with the text found", () => {
    const original = text("Intro. The annotation anchors survive small edits. Outro.");
    const anchor = anchorOf(original, 7, 50);
    const edited = text("Intro. The annotation anchor survives small edits. Outro.");
    const result = resolveTextAnchor(edited, anchor);
    expect(result).toMatchObject({
      confidence: "fuzzy",
      text: "The annotation anchor survives small edits.",
    });
  });

  it("orphans a quote with too many edits, or too short to match approximately", () => {
    const original = text("Intro. The annotation anchors survive small edits. Outro.");
    const anchor = anchorOf(original, 7, 50);
    const rewritten = text("Intro. Something else entirely is written here now. Outro.");
    expect(resolveTextAnchor(rewritten, anchor)).toEqual({
      confidence: "orphaned",
      reason: "not_found",
    });
    const short = anchorOf(text("say hello now"), 4, 9);
    expect(resolveTextAnchor(text("say jello now"), short)).toEqual({
      confidence: "orphaned",
      reason: "not_found",
    });
  });

  it("matches approximately only within the window around the recorded position", () => {
    const quote = "approximate matching window";
    const far = text(`${"z ".repeat(MATCH_LIMITS.fuzzyWindow + 100)}approximate matchng window`);
    const anchor = {
      kind: "text" as const,
      quote: { exact: quote, prefix: "", suffix: "" },
      position: { start: 0, end: Array.from(quote).length },
    };
    expect(resolveTextAnchor(far, anchor)).toEqual({ confidence: "orphaned", reason: "not_found" });
  });

  it("resolves every anchor it created exactly while the text is unchanged", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: "grapheme", maxLength: 150 }),
        fc.nat(),
        fc.nat(),
        (raw, a, b) => {
          const value = text(raw);
          const start = a % (value.length + 1);
          const end = start + (b % (value.length - start + 1));
          const result = createTextAnchor(value, start, end);
          if (!result.ok) return;
          const resolved = resolveTextAnchor(value, result.value);
          expect(span(resolved)).toEqual({ confidence: "exact", ...result.value.position });
        },
      ),
    );
  });

  it("follows the quote when text is inserted before it, and never lands on other text", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.string({ minLength: 4, maxLength: 30 }),
        fc.string({ maxLength: 40 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        (before, quote, after, inserted) => {
          const value = text(`${before} ${quote} ${after}`);
          const target = text(quote).value;
          fc.pre(target.length > 0);
          const start = Array.from(text(before).value).length + (text(before).length > 0 ? 1 : 0);
          const result = createTextAnchor(value, start, start + Array.from(target).length);
          fc.pre(result.ok);
          if (!result.ok) return;
          const edited = text(`${inserted} ${before} ${quote} ${after}`);
          const resolved = resolveTextAnchor(edited, result.value);
          if (resolved.confidence !== "orphaned")
            expect(resolved.text).toBe(result.value.quote.exact);
          else expect(resolved.reason).toBe("ambiguous");
        },
      ),
    );
  });

  it("returns only matches within the allowed edits of the quote", () => {
    // The counterexample CI found first stays in every run.
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom("a", "b", "c", " "), minLength: 8, maxLength: 24 }),
        fc.string({ unit: fc.constantFrom("a", "b", "c", "d"), maxLength: 60 }),
        (quoteRaw, noise) => {
          const quote = text(quoteRaw).value;
          fc.pre(Array.from(quote).length >= MATCH_LIMITS.fuzzyMinQuote);
          const anchor = {
            kind: "text" as const,
            quote: { exact: quote, prefix: "", suffix: "" },
            position: { start: 0, end: Array.from(quote).length },
          };
          const resolved = resolveTextAnchor(text(noise), anchor);
          if (resolved.confidence === "orphaned") return;
          const allowed = Math.floor(Array.from(quote).length * MATCH_LIMITS.fuzzyErrorRatio);
          expect(distance(Array.from(resolved.text), Array.from(quote))).toBeLessThanOrEqual(
            allowed,
          );
        },
      ),
      { examples: [["aabaacaa", "aaaaaa"]] },
    );
  });
});

describe("approximateMatches", () => {
  const chars = (value: string) => Array.from(value);

  it("finds nothing when the closest substring needs one edit more than allowed", () => {
    // Found by the property test in CI (seed 1763099554): a quote of 8 code points allows 1
    // edit, and "aaaaaa" is 2 deletions away from "aabaacaa".
    expect(approximateMatches(chars("aaaaaa"), chars("aabaacaa"), 1)).toEqual([]);
    expect(approximateMatches(chars("aaaaaa"), chars("aabaacaa"), 2)).not.toEqual([]);
  });

  it("finds the closest substring and reports its span", () => {
    expect(approximateMatches(chars("xxhelloxx"), chars("helo"), 1)).toEqual([
      { start: 2, end: 6 },
    ]);
  });

  it("returns one match per separate region at the best distance", () => {
    expect(approximateMatches(chars("abcd--abed"), chars("abcd"), 1)).toEqual([
      { start: 0, end: 4 },
    ]);
    expect(approximateMatches(chars("abxd--abyd"), chars("abcd"), 1)).toEqual([
      { start: 0, end: 4 },
      { start: 6, end: 10 },
    ]);
  });

  it("keeps touching matches apart", () => {
    expect(approximateMatches(chars("abxdabyd"), chars("abcd"), 1)).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 8 },
    ]);
  });

  it("returns nothing beyond the allowed edits", () => {
    expect(approximateMatches(chars("zzzz"), chars("abcd"), 1)).toEqual([]);
  });
});
