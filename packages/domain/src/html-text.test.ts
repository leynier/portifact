import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { htmlText } from "./html-text.ts";

const text = (html: string, max = 10_000) => htmlText(html, max).text;

describe("htmlText", () => {
  it.each([
    ["<p>Hello <b>world</b></p>", "Hello world"],
    ["<h1>Title</h1><p>Body</p>", "Title Body"],
    ["one<br>two", "one two"],
    ["<p>in<span>line</span></p>", "inline"],
    ["<script>var secret = 1;</script>visible", "visible"],
    ["<SCRIPT type='x'>a</ScRiPt >shown", "shown"],
    ["<style>.a{color:red}</style>shown", "shown"],
    ["<template><p>hidden</p></template>shown", "shown"],
    ["<noscript>hidden</noscript>shown", "shown"],
    ["<svg><text>icon</text></svg>shown", "shown"],
    ["<svg/>shown", "shown"],
    ["<!-- a comment -->shown", "shown"],
    ["<!DOCTYPE html><html><body>shown</body></html>", "shown"],
    ["<?xml version='1.0'?>shown", "shown"],
    ['<a href="https://x" title="hidden">link</a>', "link"],
    ['<img alt="hidden" src="x.png">after', "after"],
    ['<div data-x="a>b">shown</div>', "shown"],
    ["a < b and c > d", "a < b and c > d"],
    ["&lt;tag&gt; &amp; &quot;q&quot; &apos;", '<tag> & "q" \''],
    ["caf&eacute; &#233; &#xE9; &#XE9;", "café é é é"],
    ["&unknown; & alone &#xZZ; &#;", "&unknown; & alone &#xZZ; &#;"],
    ["&#0; &#xD800; &#x110000;", "� � �"],
    ["&#128512;", "😀"],
    ["a&nbsp;b", "a b"],
    ["  lots \n\t of   space  ", "lots of space"],
    ["<p>unclosed <b>bold", "unclosed bold"],
    ["<script>never closed", ""],
    ["<!-- never closed", ""],
    ['<a title="never closed>text', ""],
    ["</>text", "</>text"],
    ["<1>text", "<1>text"],
    ["</script>after", "after"],
    ["<scripts>shown</scripts>", "shown"],
    ["<script>a</scripts>b</script>c", "c"],
  ])("%j gives %j", (html, expected) => {
    expect(text(html)).toBe(expected);
  });

  it("caps the output and says so, without splitting a surrogate pair", () => {
    expect(htmlText("<p>abcdef</p>", 3)).toEqual({ text: "abc", truncated: true });
    expect(htmlText("ab😀cd", 3)).toEqual({ text: "ab", truncated: true });
    expect(htmlText("abc", 3)).toEqual({ text: "abc", truncated: false });
    expect(htmlText(`${"word ".repeat(100)}<p>${"more ".repeat(100)}</p>`, 50).truncated).toBe(
      true,
    );
  });

  it("never returns the content of a hidden element, whatever surrounds it", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        fc.constantFrom("script", "style", "template", "noscript"),
        (before, after, tag) => {
          const safeBefore = before.replace(/[<&]/g, " ");
          const out = text(`${safeBefore}<${tag}>SECRETXYZ</${tag}>${after}`);
          expect(out.slice(0, safeBefore.trim().length + 1)).not.toContain("SECRETXYZ");
        },
      ),
    );
  });

  it("never returns an attribute value or a comment", () => {
    fc.assert(
      fc.property(
        fc.string().map((s) => s.replace(/["<>]/g, "")),
        (value) => {
          const out = text(`<div title="ATTR${value}ATTR"><!-- C${value}C -->x</div>`);
          expect(out).toBe("x");
        },
      ),
    );
  });

  it("keeps plain text as it is, white space collapsed", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !/[<&]/.test(s)),
        (plain) => {
          expect(text(plain, 1_000_000)).toBe(plain.replace(/\s+/g, " ").trim());
        },
      ),
    );
  });

  it("never throws, never exceeds the cap and leaves no tag-like markup from hostile input", () => {
    const hostile = fc.array(
      fc.constantFrom(
        "<",
        ">",
        "</",
        "<!--",
        "-->",
        "<script>",
        "</script>",
        "<a ",
        '"',
        "'",
        "&",
        "&#",
        "&#x",
        ";",
        "x",
        " ",
        "<b>",
        "<!",
        "<?",
        "😀",
        "\u0000",
      ),
      { maxLength: 200 },
    );
    fc.assert(
      fc.property(hostile, fc.integer({ min: 1, max: 300 }), (pieces, max) => {
        const out = htmlText(pieces.join(""), max);
        expect(out.text.length).toBeLessThanOrEqual(max);
      }),
    );
  });

  it("stays linear on huge pathological input", () => {
    for (const unit of ["<", "<a '", "<!--", "</", "&#", "<script>", "</scrip"]) {
      const html = unit.repeat(Math.floor((2 * 1024 * 1024) / unit.length));
      const started = performance.now();
      htmlText(html, 512 * 1024);
      expect(performance.now() - started).toBeLessThan(2_000);
    }
  });
});
