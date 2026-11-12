import { normalizeText } from "@portifact/anchors";
import { describe, expect, it } from "vitest";
import { check } from "../testing/suggestions/checker.ts";
import {
  HOSTILE_AFTERS,
  markdownDocument,
  PLAIN_AFTERS,
  random,
  randomEdit,
} from "../testing/suggestions/corpus.ts";
import {
  pageOf,
  pageTextOf,
  parseDocument,
  planOne,
  resolve,
} from "../testing/suggestions/harness.ts";
import { changedRegion } from "./edit.ts";
import { find, parseHtml, shownTextNodes } from "./html-dom.ts";
import { identityOf } from "./identity.ts";
import { TEXT_IDENTITY } from "./text-planner.ts";
import { newWork } from "./work.ts";

describe("the plain text planner", () => {
  it("maps edits with their exact whitespace, hostile text included, and never another range", async () => {
    const rand = random(3);
    const tally = { edits: 0, certain: 0, whitespace: 0, other: 0 };
    for (let doc = 0; doc < 20; doc++) {
      // Markdown sources make good plain text: odd spacing, line breaks, syntax and entities.
      const source = markdownDocument(500 + doc, 10).replaceAll("\n\n", "\n   \n\t");
      const text = normalizeText(source);
      for (let n = 0; n < 25; n++) {
        const edit = randomEdit(rand, text, [...PLAIN_AFTERS, ...HOSTILE_AFTERS]);
        if (!edit) continue;
        tally.edits++;
        const result = await resolve("text", source, edit);
        if (result.status !== "certain") {
          if (result.reason === "whitespace") tally.whitespace++;
          else tally.other++;
          continue;
        }
        tally.certain++;
        const change = changedRegion(edit);
        expect(source.slice(result.range.start, result.range.end)).toBe(change.deleted);
        expect(
          await check("text", source, result.source, edit, {
            ...result.range,
            replacement: result.replacement,
          }),
        ).toBeNull();
      }
    }
    expect(tally.edits).toBeGreaterThan(400);
    expect(tally.other).toBe(0);
    expect(tally.certain).toBeGreaterThan(tally.edits / 2);
  });

  it("indexes the same page text the bridge computes on the stored rendering", async () => {
    for (const source of ["alpha", "\n\nlead  in\ttabs\r\nand CRLF\n", "x <b>y</b> &amp; z", " "]) {
      expect(await pageTextOf("text", source)).toBe(normalizeText(source));
    }
  });

  it("names its text node with the identity the page gives it", async () => {
    const html = await pageOf("text", "one\ntwo");
    const body = find(parseHtml(html, newWork()).document, "body");
    const nodes = shownTextNodes(body as never).filter((node) => node.value.trim() !== "");
    expect(nodes).toHaveLength(1);
    expect(identityOf(nodes[0] as never, { base: "https://x.example/", file: "rendered" })).toEqual(
      TEXT_IDENTITY,
    );
    expect(parseDocument(html).body.textContent).toContain("one\ntwo");
  });

  it("refuses joining lines, and inserts at both ends", async () => {
    expect(
      await resolve("text", "one\ntwo", { start: 0, end: 7, before: "one two", after: "one-two" }),
    ).toEqual({
      status: "uncertain",
      reason: "whitespace",
    });
    expect(
      await resolve("text", "end\n", { start: 0, end: 3, before: "end", after: "ending" }),
    ).toMatchObject({
      status: "certain",
      source: "ending\n",
    });
    expect(
      await resolve("text", "start", { start: 0, end: 5, before: "start", after: "a start" }),
    ).toMatchObject({
      status: "certain",
      source: "a start",
    });
  });

  it("refuses stale edits, invalid text, empty selections and sources that are not NFC", async () => {
    expect(await resolve("text", "abc", { start: 0, end: 3, before: "xyz", after: "q" })).toEqual({
      status: "uncertain",
      reason: "stale",
    });
    expect(await resolve("text", "abc", { start: 1, end: 1, before: "", after: "q" })).toEqual({
      status: "uncertain",
      reason: "stale",
    });
    expect(
      await resolve("text", "abc", { start: 0, end: 3, before: "abc", after: "a\nb" }),
    ).toEqual({
      status: "uncertain",
      reason: "invalid_after",
    });
    expect(
      await resolve("text", "café", { start: 0, end: 4, before: "café", after: "bar" }),
    ).toEqual({
      status: "uncertain",
      reason: "not_nfc",
    });
  });

  it("applies a space next to a space, and a single word's deletion", async () => {
    expect(
      await resolve("text", "a b c", { start: 2, end: 3, before: "b", after: "b " }),
    ).toMatchObject({
      status: "certain",
      source: "a b  c",
    });
    expect(
      await resolve("text", "a needle b", { start: 2, end: 8, before: "needle", after: "" }),
    ).toMatchObject({
      status: "certain",
      source: "a  b",
    });
  });

  it("is not blocked by normalization elsewhere in the file", async () => {
    const source = "x y and café and alpha";
    const text = normalizeText(source);
    const start = Array.from(text.slice(0, text.indexOf("alpha"))).length;
    expect(
      await resolve("text", source, { start, end: start + 5, before: "alpha", after: "beta" }),
    ).toMatchObject({
      status: "certain",
    });
  });

  it("plans several operations in base coordinates, with overlaps refused", async () => {
    const source = "cat and dog and fox";
    const planned = await planOne("text", source, [
      { start: 0, end: 3, before: "cat", after: "lion" },
      { start: 16, end: 19, before: "fox", after: "wolf" },
      null,
    ]);
    expect(planned).toMatchObject({ source: "lion and dog and wolf" });
    expect(planned.listed).toEqual([
      { operation: 2, reason: "not_text", destinations: [], destinationsKnown: false },
    ]);
    expect(planned.rendered?.map((file) => file.kind)).toEqual(["rendered"]);
    const clash = await planOne("text", source, [
      { start: 0, end: 3, before: "cat", after: "dog" },
      { start: 0, end: 3, before: "cat", after: "fox" },
    ]);
    expect(clash.applied).toEqual([]);
    expect(clash.listed.map((item) => item.reason)).toEqual(["overlap", "overlap"]);
  });

  it("deletes the only word between two spaces, keeping both spaces as the page shows them", async () => {
    const joined = await planOne("text", "a b c", [{ start: 2, end: 3, before: "b", after: "" }]);
    expect(joined.source).toBe("a  c");
  });

  it("lists every operation of an oversized file without mapping it, and the 101st operation", async () => {
    const work = newWork();
    const big = await planOne(
      "text",
      "x".repeat(2_000_001),
      [{ start: 0, end: 1, before: "x", after: "y" }, null],
      work,
    );
    expect(big.listed.map((item) => item.reason)).toEqual(["too_large", "not_text"]);
    expect(work.maps).toBe(0);
    const many = await planOne(
      "text",
      "a",
      Array.from({ length: 101 }, () => ({ start: 0, end: 1, before: "a", after: "b" })),
    );
    expect(many.listed.filter((item) => item.reason === "too_large")).toHaveLength(1);
  });
});
