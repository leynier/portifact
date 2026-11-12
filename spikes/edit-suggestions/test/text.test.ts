import { normalizeText } from "@portifact/anchors";
import { describe, expect, it } from "vitest";
import { changedRegion } from "../src/edit.ts";
import { planText, resolveTextEdit } from "../src/text-resolver.ts";
import { HOSTILE_AFTERS, markdownDocument, PLAIN_AFTERS, random, randomEdit } from "./corpus.ts";

describe("plain text resolver", () => {
  it("maps edits with their exact whitespace, hostile text included, and never another range", () => {
    const rand = random(3);
    const tally = { edits: 0, certain: 0, whitespace: 0, other: 0 };
    for (let doc = 0; doc < 40; doc++) {
      // Markdown sources make good plain text: odd spacing, line breaks, syntax and entities.
      const source = markdownDocument(500 + doc, 10).replaceAll("\n\n", "\n   \n\t");
      const text = normalizeText(source);
      for (let n = 0; n < 25; n++) {
        const edit = randomEdit(rand, text, [...PLAIN_AFTERS, ...HOSTILE_AFTERS]);
        if (!edit) continue;
        tally.edits++;
        const result = resolveTextEdit(source, edit);
        if (result.status !== "certain") {
          if (result.reason === "whitespace") tally.whitespace++;
          else tally.other++;
          continue;
        }
        tally.certain++;
        // The oracle works on the raw source, not on normalized text: the replaced characters
        // are exactly the changed part of the selection, and nothing else of the file moved.
        const change = changedRegion(edit);
        expect(source.slice(result.range.start, result.range.end)).toBe(change.deleted);
        expect(result.source).toBe(
          source.slice(0, result.range.start) + change.inserted + source.slice(result.range.end),
        );
      }
    }
    console.log("text", JSON.stringify(tally));
    expect(tally.edits).toBeGreaterThan(900);
    expect(tally.other).toBe(0);
    expect(tally.certain).toBeGreaterThan(tally.edits / 2);
  });

  it("refuses joining lines, and inserts at both ends", () => {
    expect(
      resolveTextEdit("one\ntwo", { start: 0, end: 7, before: "one two", after: "one-two" }),
    ).toEqual({ status: "uncertain", reason: "whitespace" });
    expect(
      resolveTextEdit("end\n", { start: 0, end: 3, before: "end", after: "ending" }),
    ).toMatchObject({ status: "certain", source: "ending\n" });
    expect(
      resolveTextEdit("start", { start: 0, end: 5, before: "start", after: "a start" }),
    ).toMatchObject({ status: "certain", source: "a start" });
  });

  it("refuses stale edits, invalid text and sources that are not NFC", () => {
    expect(resolveTextEdit("abc", { start: 0, end: 3, before: "xyz", after: "q" })).toEqual({
      status: "uncertain",
      reason: "stale",
    });
    expect(resolveTextEdit("abc", { start: 0, end: 3, before: "abc", after: "a\nb" })).toEqual({
      status: "uncertain",
      reason: "invalid_after",
    });
    expect(resolveTextEdit("café", { start: 0, end: 4, before: "café", after: "bar" })).toEqual({
      status: "uncertain",
      reason: "not_nfc",
    });
  });

  it("refuses an edit whose new text would merge with the space around it", () => {
    expect(resolveTextEdit("a b c", { start: 2, end: 3, before: "b", after: "b " })).toMatchObject({
      status: "uncertain",
    });
  });

  it("plans several operations in base coordinates, with overlaps refused", () => {
    const source = "cat and dog and fox";
    const planned = planText(source, [
      { start: 0, end: 3, before: "cat", after: "lion" },
      { start: 16, end: 19, before: "fox", after: "wolf" },
    ]);
    expect(planned).toMatchObject({ listed: [], source: "lion and dog and wolf" });
    // The draft example of finding 14: "cat" became "dog" and then "fox". Base coordinates and a
    // coalesced draft give one operation; two on the same text are refused, not ordered.
    const clash = planText(source, [
      { start: 0, end: 3, before: "cat", after: "dog" },
      { start: 0, end: 3, before: "cat", after: "fox" },
    ]);
    expect(clash.applied).toEqual([]);
    expect(clash.listed.map((item) => item.reason)).toEqual(["overlap", "overlap"]);
    expect(planText(source, [{ start: 0, end: 3, before: "cow", after: "x" }]).listed).toEqual([
      { operation: 0, reason: "stale" },
    ]);
  });
});
