import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { NormalizedText, normalizeText, normalizeWithMap } from "./normalize.ts";

/** Strings rich in what normalization handles: whitespace, controls, marks, emoji and surrogates. */
const tricky = fc.string({
  unit: fc.oneof(
    fc.constantFrom(
      " ",
      "\n",
      "\r\n",
      "\r",
      "\t",
      "\u00a0",
      "\u0000",
      "\u2028",
      "\u0301",
      "\u0308",
    ),
    fc.constantFrom(
      "e",
      "a",
      "\u1100",
      "\u1161",
      "\u11a8",
      "\uac00",
      "\u{1F600}",
      "\u200d",
      "\ud800",
    ),
    fc.string({ unit: "binary", minLength: 1, maxLength: 1 }),
    fc.string({ unit: "grapheme", minLength: 1, maxLength: 1 }),
  ),
  maxLength: 60,
});

describe("normalizeText", () => {
  it("collapses whitespace and control runs to one space and trims the ends", () => {
    expect(normalizeText("  Hello,\r\n\t world\u0000!  ")).toBe("Hello, world !");
    expect(normalizeText("a\u00a0\u2028b")).toBe("a b");
    expect(normalizeText(" \n\t ")).toBe("");
  });

  it("treats CRLF, CR and LF line breaks alike", () => {
    expect(normalizeText("a\r\nb")).toBe(normalizeText("a\nb"));
    expect(normalizeText("a\rb")).toBe("a b");
  });

  it("composes characters to NFC", () => {
    expect(normalizeText("cafe\u0301")).toBe("caf\u00e9");
    expect(normalizeText("\u1100\u1161\u11a8")).toBe("\uac01");
    expect(normalizeText("\uac00\u11a8")).toBe("\uac01");
  });

  it("keeps every code point when NFC expands one unit into several", () => {
    const expanded = NormalizedText.from("\ufb2c\ufb2c");
    expect(Array.from(expanded.value).length).toBe(6);
    expect(expanded.length).toBe(6);
    expect(expanded.slice(3, 6)).toBe(expanded.value.slice(3));
    expect(expanded.slice(0, 3)).toBe(expanded.value.slice(0, 3));
    const { rawStart, rawEnd } = normalizeWithMap("x\ufb2c");
    expect(Array.from(rawStart)).toEqual([0, 1, 1, 1]);
    expect(Array.from(rawEnd)).toEqual([1, 2, 2, 2]);
  });

  it("replaces lone surrogates and keeps emoji sequences whole", () => {
    expect(normalizeText("a\ud800b")).toBe("a\ufffdb");
    const family = "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}";
    expect(normalizeText(` ${family} `)).toBe(family);
  });

  it("is idempotent, NFC and leaves only single inner spaces", () => {
    fc.assert(
      fc.property(tricky, (raw) => {
        const once = normalizeText(raw);
        expect(normalizeText(once)).toBe(once);
        expect(once.normalize("NFC")).toBe(once);
        expect(once.isWellFormed()).toBe(true);
        expect(once).not.toMatch(/[\t\n\r\u00a0\p{Cc}]| {2}|^ | $/u);
      }),
    );
  });
});

describe("normalizeWithMap", () => {
  it("maps every code point back to the raw range it came from", () => {
    const raw = "  ab\r\n\u{1F600}e\u0301";
    const { text, rawStart, rawEnd } = normalizeWithMap(raw);
    expect(text.value).toBe("ab \u{1F600}\u00e9");
    expect(Array.from(rawStart)).toEqual([2, 3, 4, 6, 8]);
    expect(Array.from(rawEnd)).toEqual([3, 4, 6, 8, 10]);
  });

  it("produces monotonic ranges whose raw text normalizes to each code point", () => {
    fc.assert(
      fc.property(tricky, (raw) => {
        const { text, rawStart, rawEnd } = normalizeWithMap(raw);
        const codePoints = Array.from(text.value);
        expect(rawStart.length).toBe(codePoints.length);
        for (let i = 0; i < codePoints.length; i++) {
          const start = rawStart[i] as number;
          const end = rawEnd[i] as number;
          expect(end).toBeGreaterThan(start);
          if (i > 0) expect(start).toBeGreaterThanOrEqual(rawStart[i - 1] as number);
          const piece = normalizeText(raw.slice(start, end));
          expect(piece === "" ? " " : piece).toContain(codePoints[i]);
        }
      }),
    );
  });
});

describe("NormalizedText", () => {
  const text = NormalizedText.from("a\u{1F600}b \u{1F600}c");

  it("measures and slices in code points", () => {
    expect(text.value).toBe("a\u{1F600}b \u{1F600}c");
    expect(text.length).toBe(6);
    expect(text.slice(1, 3)).toBe("\u{1F600}b");
    expect(text.slice(-5, 99)).toBe(text.value);
  });

  it("converts between code point and UTF-16 offsets", () => {
    expect(text.unitOffset(2)).toBe(3);
    expect(text.unitOffset(6)).toBe(text.value.length);
    expect(text.codePointOffset(3)).toBe(2);
    expect(text.codePointOffset(2)).toBe(1);
    expect(text.codePointOffset(999)).toBe(6);
  });

  it("lists occurrences in code points and refuses to list past the limit", () => {
    expect(text.occurrences("\u{1F600}", 10)).toEqual([1, 4]);
    expect(text.occurrences("\u{1F600}", 2)).toEqual([1, 4]);
    expect(text.occurrences("\u{1F600}", 1)).toBeUndefined();
    expect(text.occurrences("zz", 10)).toEqual([]);
    expect(NormalizedText.from("aaa").occurrences("aa", 10)).toEqual([0, 1]);
  });

  it("round-trips code point offsets for any text", () => {
    fc.assert(
      fc.property(tricky, fc.nat(), (raw, seed) => {
        const value = NormalizedText.from(raw);
        const offset = seed % (value.length + 1);
        expect(value.codePointOffset(value.unitOffset(offset))).toBe(offset);
        expect(value.slice(0, offset) + value.slice(offset, value.length)).toBe(value.value);
        expect(Array.from(value.slice(0, offset)).length).toBe(offset);
      }),
    );
  });
});
