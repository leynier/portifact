import { SEARCH_LIMITS } from "@portifact/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildMatchExpression,
  cleanText,
  MARK_CLOSE,
  MARK_OPEN,
  ownerMatch,
  ownerToken,
  parseSnippet,
  planIndex,
  SEGMENT,
  segmentText,
  truncateUtf8,
  utf8Length,
} from "./content-search.ts";

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
    ["éte", '"éte"'],
  ])("%j gives %j", (query, expected) => {
    expect(buildMatchExpression(query)).toBe(expected);
  });

  it("refuses a query longer than the boundary allows instead of cutting it", () => {
    expect(buildMatchExpression("a".repeat(SEARCH_LIMITS.queryChars))).toBe(
      `"${"a".repeat(SEARCH_LIMITS.queryChars)}"`,
    );
    expect(buildMatchExpression(`${"a ".repeat(SEARCH_LIMITS.queryChars)}`)).toBeNull();
  });

  it("only ever produces quoted phrases of letters, marks, digits and separators joined by AND", () => {
    const phrase = `"[\\p{L}\\p{N}\\p{M} ${SEGMENT}]+"`;
    const shape = new RegExp(`^${phrase}( AND ${phrase})*$`, "u");
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: SEARCH_LIMITS.queryChars }), (query) => {
        const expression = buildMatchExpression(query);
        if (expression !== null) expect(expression).toMatch(shape);
      }),
    );
  });

  it("keeps every term of the query, so a longer query never matches more", () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z]{1,8}$/), { minLength: 1, maxLength: 20 }),
        (words) => {
          const expression = buildMatchExpression(words.join(" ")) ?? "";
          expect(expression.split(" AND ")).toHaveLength(words.length);
        },
      ),
    );
  });
});

describe("owner tokens", () => {
  it("are one token of letters and digits, distinct for distinct owners", () => {
    expect(ownerToken("ws_abc")).toBe("o77735f616263");
    expect(ownerToken("ws_abc")).not.toBe(ownerToken("ws_abcd"));
    expect(ownerMatch("u", '"x"')).toBe('owner : o75 AND ("x")');
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

describe("planIndex", () => {
  const limits = { fileTextBytes: 10, versionTextBytes: 25, filesPerVersion: 3 };
  const file = (path: string, text: string, truncated = false) => ({ path, text, truncated });

  it("keeps everything that fits", () => {
    expect(planIndex([file("a", "one"), file("b", "two")], 1_000, limits)).toEqual({
      files: [
        { path: "a", text: "one", bytes: 3 },
        { path: "b", text: "two", bytes: 3 },
      ],
      bytes: 6,
      partial: false,
    });
  });

  it("cuts a file at its cap, the version at its cap and stops at the owner's budget", () => {
    const plan = planIndex(
      [file("a", "x".repeat(12)), file("b", "y".repeat(10)), file("c", "z".repeat(10))],
      1_000,
      limits,
    );
    expect(plan.files.map((f) => f.bytes)).toEqual([10, 10, 5]);
    expect(plan.partial).toBe(true);
    const budget = planIndex([file("a", "abc"), file("b", "def")], 4, limits);
    expect(budget.files).toEqual([
      { path: "a", text: "abc", bytes: 3 },
      { path: "b", text: "d", bytes: 1 },
    ]);
    expect(budget.partial).toBe(true);
    expect(planIndex([file("a", "abc")], 0, limits)).toEqual({
      files: [],
      bytes: 0,
      partial: true,
    });
    expect(planIndex([file("a", "abc")], -5, limits).files).toEqual([]);
  });

  it("counts files over the per-version count, truncated reads and skips empty files", () => {
    expect(
      planIndex([file("a", "1"), file("b", "2"), file("c", "3"), file("d", "4")], 100, limits)
        .partial,
    ).toBe(true);
    expect(planIndex([file("a", "1", true)], 100, limits).partial).toBe(true);
    expect(planIndex([file("a", "   "), file("b", "x")], 100, limits)).toEqual({
      files: [{ path: "b", text: "x", bytes: 1 }],
      bytes: 1,
      partial: false,
    });
  });

  it("uses the contract's caps by default", () => {
    expect(planIndex([file("a", "x")], 10).files).toHaveLength(1);
  });
});
