// @vitest-environment happy-dom
import { AnchorDocument, type AnchorElement, createTextAnchor } from "@portifact/anchors";
import { newWork, servedPageText } from "@portifact/domain/suggestions";
import { describe, expect, it } from "vitest";
import { findMatches, pageText, TEXT_SEARCH, targetOf } from "./text-search.ts";

const PAGE =
  '<!doctype html><html><head><title>T</title><script>document.body.textContent="ran"</script></head><body><h1>Notes</h1><p>Hello <b>brave</b> new world</p><p>A brave café 😀 brave end</p><script>window.ran=1</script></body></html>';
const BODY = "<h1>Notes</h1><p>Hello <b>brave</b> new world</p><p>A brave café 😀 brave end</p>";

/** The text the server gives for `PAGE` (`GET .../page-text`). */
const served = () => pageText(servedPageText(PAGE, newWork()));

describe("the text search over the page's text", () => {
  it("searches the shown text only, never markup or scripts", () => {
    const text = served();
    expect(text.value).toContain("Hello brave new world");
    expect(text.value).not.toContain("ran");
    expect(findMatches(text, "script")).toEqual([]);
  });

  it("finds each place with its context, in code points", () => {
    const text = served();
    const matches = findMatches(text, "  brave ");
    expect(matches.map((m) => m.text)).toEqual(["brave", "brave", "brave"]);
    // After the emoji (two UTF-16 units, one code point) offsets still count code points.
    const last = matches[2];
    expect(last && text.slice(last.start, last.end)).toBe("brave");
    expect(last?.before.endsWith("café 😀 ")).toBe(true);
    expect(findMatches(text, "   ")).toEqual([]);
    expect(findMatches(text, "missing")).toEqual([]);
  });

  it("lists at most the bound", () => {
    const text = pageText(`<p>${"ab ".repeat(TEXT_SEARCH.maxMatches + 5)}</p>`);
    expect(findMatches(text, "ab")).toHaveLength(TEXT_SEARCH.maxMatches);
  });

  it("makes the same text target a selection of that text in the frame would", async () => {
    const text = served();
    const [first] = findMatches(text, "brave new");
    if (!first) throw new Error("no match");
    const target = await targetOf(text, first, "index.html");
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
    // The bridge's anchors over the live body read the same text and give the same anchor.
    document.body.innerHTML = BODY;
    const live = new AnchorDocument(document.body as unknown as AnchorElement);
    expect(live.text.value).toBe(text.value);
    const selected = createTextAnchor(live.text, first.start, first.end);
    expect(selected.ok && selected.value).toEqual(target?.anchor);
    document.body.innerHTML = "";
  });

  it("refuses a match the anchors refuse", async () => {
    expect(
      await targetOf(served(), { start: 5, end: 3, before: "", text: "", after: "" }, "x.html"),
    ).toBeNull();
  });
});
