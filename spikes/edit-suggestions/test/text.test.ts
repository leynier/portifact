import { normalizeText } from "@portifact/anchors";
import { describe, expect, it } from "vitest";
import { changedRegion } from "../src/edit.ts";
import { spliceCodePoints } from "../src/page.ts";
import { resolveTextEdit } from "../src/text-resolver.ts";
import { HOSTILE_AFTERS, markdownDocument, PLAIN_AFTERS, random, randomEdit } from "./corpus.ts";

describe("plain text resolver", () => {
  it("maps every edit of a text document with certainty, hostile text included", () => {
    const rand = random(3);
    let edits = 0;
    let certain = 0;
    for (let doc = 0; doc < 40; doc++) {
      // Markdown sources make good plain text: odd spacing, line breaks, syntax and entities.
      const source = markdownDocument(500 + doc, 10).replaceAll("\n\n", "\n   \n\t");
      const text = normalizeText(source);
      for (let n = 0; n < 25; n++) {
        const edit = randomEdit(rand, text, [...PLAIN_AFTERS, ...HOSTILE_AFTERS]);
        if (!edit) continue;
        edits++;
        const result = resolveTextEdit(source, edit);
        if (result.status !== "certain") continue;
        certain++;
        const change = changedRegion(edit);
        // The oracle: the page of a text document is its source, escaped in a `<pre>`, so the
        // page text is the normalized source; the inserted text is literal whatever it holds.
        expect(normalizeText(result.source)).toBe(
          spliceCodePoints(text, change.from, change.to, change.inserted),
        );
        expect(
          result.source.slice(result.range.start, result.range.start + change.inserted.length),
        ).toBe(change.inserted);
      }
    }
    console.log("text", JSON.stringify({ edits, certain }));
    expect(edits).toBeGreaterThan(900);
    expect(certain).toBe(edits);
  });

  it("replaces line breaks the reviewer joined, and inserts at both ends", () => {
    expect(
      resolveTextEdit("one\ntwo", { start: 0, end: 7, before: "one two", after: "one-two" }),
    ).toMatchObject({
      status: "certain",
      source: "one-two",
    });
    expect(
      resolveTextEdit("end\n", { start: 0, end: 3, before: "end", after: "ending" }),
    ).toMatchObject({
      status: "certain",
      source: "ending\n",
    });
    expect(
      resolveTextEdit("start", { start: 0, end: 5, before: "start", after: "a start" }),
    ).toMatchObject({
      status: "certain",
      source: "a start",
    });
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
    // Deleting the word but keeping a trailing space in after makes two spaces collapse.
    expect(resolveTextEdit("a b c", { start: 2, end: 3, before: "b", after: "b " })).toMatchObject({
      status: "uncertain",
    });
  });
});
