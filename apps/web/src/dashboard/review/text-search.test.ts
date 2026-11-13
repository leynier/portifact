// @vitest-environment happy-dom
import { AnchorDocument, type AnchorElement } from "@portifact/anchors";
import { describe, expect, it } from "vitest";
import { findMatches, pageDocument, TEXT_SEARCH, targetOf } from "./text-search.ts";

const PAGE =
  '<!doctype html><html><head><title>T</title><script>document.body.textContent="ran"</script></head><body><h1>Notes</h1><p>Hello <b>brave</b> new world</p><p>A brave café 😀 brave end</p><script>window.ran=1</script></body></html>';

describe("the text search over the stored page", () => {
  it("parses the page without running it", () => {
    const doc = pageDocument(PAGE);
    expect(doc.text.value).toContain("Hello brave new world");
    expect((window as unknown as { ran?: number }).ran).toBeUndefined();
  });

  it("finds each place with its context, in code points", () => {
    const doc = pageDocument(PAGE);
    const matches = findMatches(doc, "  brave ");
    expect(matches.map((m) => m.text)).toEqual(["brave", "brave", "brave"]);
    // After the emoji (two UTF-16 units, one code point) offsets still count code points.
    const last = matches[2];
    expect(last && doc.text.slice(last.start, last.end)).toBe("brave");
    expect(last?.before.endsWith("café 😀 ")).toBe(true);
    expect(findMatches(doc, "   ")).toEqual([]);
    expect(findMatches(doc, "missing")).toEqual([]);
  });

  it("lists at most the bound", () => {
    const doc = pageDocument(`<body><p>${"ab ".repeat(TEXT_SEARCH.maxMatches + 5)}</p></body>`);
    expect(findMatches(doc, "ab")).toHaveLength(TEXT_SEARCH.maxMatches);
  });

  it("makes the same text target a selection of that text would", async () => {
    const doc = pageDocument(PAGE);
    const [first] = findMatches(doc, "brave new");
    if (!first) throw new Error("no match");
    const target = await targetOf(doc, first, "index.html");
    expect(target).toMatchObject({
      schema: 1,
      path: "index.html",
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      anchor: {
        kind: "text",
        quote: { exact: "brave new" },
        position: { start: first.start, end: first.end },
      },
    });
    // The same anchor a selection over the live body gives.
    document.body.innerHTML =
      "<h1>Notes</h1><p>Hello <b>brave</b> new world</p><p>A brave café 😀 brave end</p>";
    const live = new AnchorDocument(document.body as unknown as AnchorElement);
    expect(live.text.value).toBe(doc.text.value);
  });

  it("refuses a match the anchors refuse", async () => {
    const doc = pageDocument(PAGE);
    expect(
      await targetOf(doc, { start: 5, end: 3, before: "", text: "", after: "" }, "x.html"),
    ).toBeNull();
  });
});
