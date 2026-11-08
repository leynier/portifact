import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { byTag, elements, fragment, text } from "./test-html.ts";
import { escapeText, renderText } from "./text.ts";

/** What a browser shows inside the `<pre>`: the parser turns CR and CRLF into LF. */
function shown(source: string): string {
  const root = fragment(renderText(source).html);
  const pre = byTag(root, "pre");
  expect(pre).toHaveLength(1);
  return text(pre[0] ?? root);
}

describe("renderText", () => {
  it("shows HTML literally instead of interpreting it", () => {
    const source = '<script>alert(1)</script>\n<img src=x onerror="alert(1)">\n&amp; &lt;';
    const root = fragment(renderText(source).html);
    expect(elements(root).map((e) => e.tagName)).toEqual(["pre"]);
    expect(shown(source)).toBe(source);
  });

  it("keeps a leading blank line, which the HTML parser would otherwise drop", () => {
    expect(shown("\nstarts blank")).toBe("\nstarts blank");
    expect(shown("\n\ntwo")).toBe("\n\ntwo");
  });

  it("keeps whitespace, tabs and trailing newlines exactly", () => {
    const source = "  indented\n\ttab\n\n\ntrailing   \n";
    expect(shown(source)).toBe(source);
  });

  it("cannot be closed early by the text", () => {
    const source = "</pre><script>alert(1)</script><pre>";
    expect(shown(source)).toBe(source);
  });

  it("round-trips any text a browser can show", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), (value) => {
        // NUL is rejected as binary before rendering, and browsers normalize line breaks.
        const source = value.replaceAll("\u0000", "");
        expect(shown(source)).toBe(source.replace(/\r\n?/g, "\n"));
      }),
      { numRuns: 300 },
    );
  });

  it("renders a document at the size limit", () => {
    const source = "<a&>\n".repeat(1_000_000);
    expect(renderText(source).html.length).toBeGreaterThan(source.length);
    expect(() => renderText(`${source}x`)).toThrow(/limited/);
  });
});

describe("escapeText", () => {
  it("escapes only what can start markup or a reference", () => {
    expect(escapeText(`<a href="x">&'</a>`)).toBe(`&lt;a href="x"&gt;&amp;'&lt;/a&gt;`);
  });
});
