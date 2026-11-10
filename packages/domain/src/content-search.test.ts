import { SEARCH_LIMITS } from "@portifact/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildMatchExpression,
  cleanText,
  indexText,
  MARK_CLOSE,
  MARK_OPEN,
  ownerMatch,
  ownerToken,
  parseSnippet,
  SEGMENT,
  segmentText,
  truncateUtf8,
  utf8Length,
} from "./content-search.ts";

/** The expression of a query the builder accepts; fails the test otherwise. */
const match = (query: string) => {
  const built = buildMatchExpression(query);
  if (!built.ok) throw new Error(built.message);
  return built.value;
};

describe("buildMatchExpression", () => {
  it.each([
    ["roadmap", '"roadmap"'],
    ["  Quarterly   report ", '"Quarterly" AND "report"'],
    ['say "hi"', '"say" AND "hi"'],
    ['""', null],
    ["a OR b", '"a" AND "OR" AND "b"'],
    ["NOT secret", '"NOT" AND "secret"'],
    ["NEAR(a b, 2)", '"NEAR" AND "a" AND "b" AND "2"'],
    ["owner : x", '"owner" AND "x"'],
    ["{owner body} : x", '"owner" AND "body" AND "x"'],
    ["body:secret", '"body" AND "secret"'],
    ["a* ^b -c +d", '"a" AND "b" AND "c" AND "d"'],
    ["(((((", null],
    ["", null],
    ["   ", null],
    ["🙂 😀", null],
    ["canción", '"canción"'],
    ["отчёт", '"отчет"'],
    ["会議", `"会 議"`],
    ["東京の会議 notes", `"東 京 の 会 議" AND "notes"`],
    ["abc中文", `"abc中 文"`],
    ["e\u0301te", '"éte"'],
    // A term repeated, in any case, counts once.
    ["plan Plan PLAN roadmap plan", '"plan" AND "roadmap"'],
  ])("%j gives %j", (query, expected) => {
    expect(match(query)).toBe(expected);
  });

  it("refuses too many different words, too long a Chinese or Japanese run and too long a query, never cutting them", () => {
    const words = Array.from({ length: SEARCH_LIMITS.queryTerms }, (_, i) => `w${i}`);
    expect(String(match(words.join(" "))).split(" AND ")).toHaveLength(SEARCH_LIMITS.queryTerms);
    expect(buildMatchExpression([...words, "extra"].join(" "))).toEqual({
      ok: false,
      code: "invalid_input",
      message: `Search for at most ${SEARCH_LIMITS.queryTerms} different words.`,
    });
    // 100 repeated words are one word.
    expect(match("x ".repeat(100))).toBe('"x"');
    const run = "会".repeat(SEARCH_LIMITS.queryPhraseTokens);
    expect(String(match(run)).split(" ")).toHaveLength(SEARCH_LIMITS.queryPhraseTokens);
    expect(buildMatchExpression(`${run}議`)).toEqual({
      ok: false,
      code: "invalid_input",
      message: `Search for runs of at most ${SEARCH_LIMITS.queryPhraseTokens} Chinese or Japanese characters.`,
    });
    expect(buildMatchExpression("a".repeat(SEARCH_LIMITS.queryChars + 1))).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
  });

  it("only ever produces at most the capped quoted phrases of letters, marks, digits and separators", () => {
    const phrase = `"[\\p{L}\\p{N}\\p{M} ${SEGMENT}]+"`;
    const shape = new RegExp(`^${phrase}( AND ${phrase})*$`, "u");
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: SEARCH_LIMITS.queryChars }), (query) => {
        const built = buildMatchExpression(query);
        if (!built.ok) {
          expect(built.code).toBe("invalid_input");
          return;
        }
        if (built.value === null) return;
        expect(built.value).toMatch(shape);
        const phrases = built.value.split(" AND ");
        expect(phrases.length).toBeLessThanOrEqual(SEARCH_LIMITS.queryTerms);
        for (const quoted of phrases) {
          expect(quoted.split(" ").length).toBeLessThanOrEqual(SEARCH_LIMITS.queryPhraseTokens);
        }
      }),
    );
  });

  it("keeps every different term of an accepted query, so a longer query never matches more", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z]{1,8}$/), {
          minLength: 1,
          maxLength: SEARCH_LIMITS.queryTerms,
        }),
        (words) => {
          expect(match(words.join(" "))?.split(" AND ")).toHaveLength(words.length);
        },
      ),
    );
  });
});

describe("owner tokens", () => {
  it("are one token of letters and digits, distinct for distinct owners", () => {
    expect(ownerToken("ws_abc")).toBe("o77735f616263");
    expect(ownerToken("ws_abc")).not.toBe(ownerToken("ws_abcd"));
    // The user's words only ever match the body column.
    expect(ownerMatch("u", '"x"')).toBe('owner : o75 AND body : ("x")');
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(ownerToken(a)).toMatch(/^o[0-9a-f]*$/);
        if (a !== b) expect(ownerToken(a)).not.toBe(ownerToken(b));
      }),
    );
  });
});

describe("text preparation", () => {
  it("removes control characters and the index's markers, keeping new lines and tabs", () => {
    expect(
      cleanText(`a\u0000b${SEGMENT}c${MARK_OPEN}d${MARK_CLOSE}e\u007ff\ng\th\u001b[1mi\u009bj`),
    ).toBe("a b c d e f\ng\th [1mi j");
  });

  it("separates adjacent CJK characters only, and folds ё", () => {
    expect(segmentText("ab中文cd 日本")).toBe(`ab中${SEGMENT}文cd 日${SEGMENT}本`);
    expect(segmentText("Ёлка ёж")).toBe("Елка еж");
    expect(segmentText(`x${SEGMENT}y`)).toBe("x y");
  });
});

describe("parseSnippet", () => {
  it.each([
    [`The ${MARK_OPEN}quarterly${MARK_CLOSE} report`, "The quarterly report", [[4, 13]]],
    [
      `我们的${MARK_OPEN}中${MARK_CLOSE}${SEGMENT}${MARK_OPEN}文${MARK_CLOSE}文档`,
      "我们的中文文档",
      [[3, 5]],
    ],
    [
      `${MARK_OPEN}a${MARK_CLOSE} b ${MARK_OPEN}c${MARK_CLOSE}`,
      "a b c",
      [
        [0, 1],
        [4, 5],
      ],
    ],
    [`x${MARK_OPEN}${MARK_CLOSE}y`, "xy", []],
    [`x${MARK_CLOSE}y${MARK_OPEN}z`, "xyz", []],
    ["…plain…", "…plain…", []],
  ])("%j", (marked, text, highlights) => {
    expect(parseSnippet(marked)).toEqual({ text, highlights });
  });

  it("gives ranges inside the text for any marked input", () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.string(), fc.constantFrom(MARK_OPEN, MARK_CLOSE, SEGMENT))),
        (parts) => {
          const { text, highlights } = parseSnippet(parts.join(""));
          for (const [start, end] of highlights) {
            expect(start).toBeLessThan(end);
            expect(end).toBeLessThanOrEqual(text.length);
          }
          expect(text).not.toContain(MARK_OPEN);
          expect(text).not.toContain(SEGMENT);
        },
      ),
    );
  });
});

describe("UTF-8 sizes", () => {
  it("counts and truncates by bytes without splitting a character", () => {
    expect(utf8Length("aé中😀")).toBe(1 + 2 + 3 + 4);
    expect(truncateUtf8("aé中😀", 6)).toBe("aé中");
    expect(truncateUtf8("aé中😀", 9)).toBe("aé中");
    expect(truncateUtf8("aé中😀", 10)).toBe("aé中😀");
    expect(truncateUtf8("abc", 0)).toBe("");
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), fc.nat(64), (text, max) => {
        const cut = truncateUtf8(text, max);
        expect(utf8Length(cut)).toBeLessThanOrEqual(max);
        expect(text.startsWith(cut)).toBe(true);
      }),
    );
  });
});

describe("indexText", () => {
  it("keeps a source as it is and the visible text of a page, cleaned and trimmed", () => {
    expect(indexText("  # Plan\u0000 here  ", false, 100)).toEqual({
      text: "# Plan  here",
      bytes: 12,
      cut: false,
    });
    expect(indexText("<p>Plan</p><script>x</script>", true, 100)).toEqual({
      text: "Plan",
      bytes: 4,
      cut: false,
    });
  });

  it("never holds more characters than the budget's bytes, and says it cut", () => {
    expect(indexText("abcdef", false, 3)).toEqual({ text: "abc", bytes: 3, cut: true });
    expect(indexText("<p>abcdef</p>", true, 3)).toEqual({ text: "abc", bytes: 3, cut: true });
    expect(indexText("中文字", false, 4)).toEqual({ text: "中", bytes: 3, cut: true });
    expect(indexText("abc", false, 0)).toEqual({ text: "", bytes: 0, cut: true });
    expect(indexText("abc", false, -5)).toEqual({ text: "", bytes: 0, cut: true });
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), fc.boolean(), fc.nat(200), (raw, html, max) => {
        const kept = indexText(raw, html, max);
        expect(kept.text.length).toBeLessThanOrEqual(max);
        expect(kept.bytes).toBeLessThanOrEqual(max);
        expect(kept.bytes).toBe(utf8Length(kept.text));
      }),
    );
  });
});
