import { renderMarkdown } from "@portifact/render";
import { describe, expect, it } from "vitest";
import { planMarkdown, renderPage, resolveMarkdownEdit } from "../src/markdown-resolver.ts";
import { HOSTILE_AFTERS, markdownDocument, PLAIN_AFTERS } from "./corpus.ts";
import { runCorpus } from "./markdown-corpus.ts";

describe("Markdown resolver", () => {
  it("maps plain edits and every applied one passes the independent oracle", () => {
    // A small corpus here; the full one the record quotes runs in `bun run bench`.
    const tally = runCorpus(15, 25, PLAIN_AFTERS, 7);
    console.log("markdown plain", JSON.stringify(tally));
    expect(tally.edits).toBeGreaterThan(300);
    expect(tally.certain / tally.edits).toBeGreaterThan(0.4);
    for (const shape of ["replacement", "insertion", "deletion"] as const) {
      expect(tally.byShape[shape].certain, shape).toBeGreaterThan(0);
    }
  });

  it("writes hostile after-text as text: no element, attribute, ID or reference appears", () => {
    const tally = runCorpus(15, 25, HOSTILE_AFTERS, 11);
    console.log("markdown hostile", JSON.stringify(tally));
    expect(tally.edits).toBeGreaterThan(300);
    expect(tally.certain).toBeGreaterThan(0);
  });

  it("refuses every heading edit that changes an ID", () => {
    expect(
      resolveMarkdownEdit("# Title\n\nBody.", {
        start: 0,
        end: 5,
        before: "Title",
        after: "Other",
      }),
    ).toEqual({ status: "uncertain", reason: "would_change_page" });
  });

  it("writes Markdown syntax as escaped text", () => {
    const source = "Plain words in a paragraph.";
    const result = resolveMarkdownEdit(source, {
      start: 6,
      end: 11,
      before: "words",
      after: "**words**",
    });
    expect(result).toMatchObject({
      status: "certain",
      source: "Plain \\*\\*words\\*\\* in a paragraph.",
    });
    expect(renderMarkdown((result as { source: string }).source).html).not.toContain("<strong>");
  });

  it("keeps a URL as text: linkify runs on the source, which the escapes break", () => {
    const source = "Plain words in a paragraph.";
    const result = resolveMarkdownEdit(source, {
      start: 6,
      end: 11,
      before: "words",
      after: "https://evil.example",
    });
    expect(result).toMatchObject({
      status: "certain",
      source: "Plain https\\:\\/\\/evil\\.example in a paragraph.",
    });
    expect(renderMarkdown((result as { source: string }).source).html).not.toContain("<a");
  });

  it("edits inside inline formatting, links and code", () => {
    const source = "Some **bold text** and a [link text](https://example.com) and `code span`.";
    const text = renderPage(source).text;
    const at = (word: string) => text.indexOf(word);
    for (const [before, after] of [
      ["bold", "strong"],
      ["link", "anchor"],
      ["code", "inline"],
    ] as const) {
      const result = resolveMarkdownEdit(source, {
        start: at(before),
        end: at(before) + before.length,
        before,
        after,
      });
      expect(result.status).toBe("certain");
    }
    const linked = resolveMarkdownEdit(source, {
      start: at("link"),
      end: at("link") + 4,
      before: "link",
      after: "anchor",
    }) as { source: string };
    expect(linked.source).toContain("[anchor text](https://example.com)");
  });

  it("refuses a selection across formatting when the change crosses it, and across blocks", () => {
    const source = "Some **bold text** here.\n\nSecond paragraph.";
    const text = renderPage(source).text;
    const across = text.slice(text.indexOf("bold"), text.indexOf(" here"));
    expect(
      resolveMarkdownEdit(source, {
        start: text.indexOf("Some"),
        end: text.indexOf(" here"),
        before: `Some ${across}`,
        after: "Other words",
      }),
    ).toMatchObject({ status: "uncertain" });
    const start = text.indexOf("here.");
    expect(
      resolveMarkdownEdit(source, {
        start,
        end: start + "here. Second".length,
        before: "here. Second",
        after: "joined",
      }),
    ).toEqual({ status: "uncertain", reason: "spans_nodes" });
  });

  it("handles entities, repeated text and tables", () => {
    const entity = "Fish &amp; chips are good.";
    const text = renderPage(entity).text;
    // "&" is found once in the source, inside "&amp;"; replacing it there breaks the entity, so
    // verification refuses it.
    expect(resolveMarkdownEdit(entity, { start: 5, end: 6, before: "&", after: "and" })).toEqual({
      status: "uncertain",
      reason: "would_change_page",
    });
    expect(
      resolveMarkdownEdit(entity, { start: 7, end: 12, before: "chips", after: "fries" }).status,
    ).toBe("certain");
    expect(text).toBe("Fish & chips are good.");

    const repeated = "Same words here.\n\nSame words here.";
    const second = renderPage(repeated).text.lastIndexOf("words");
    const result = resolveMarkdownEdit(repeated, {
      start: second,
      end: second + 5,
      before: "words",
      after: "text",
    });
    // The context of a repeated sentence is the block, so the second one is changed, not the first.
    expect(result).toMatchObject({
      status: "certain",
      source: "Same words here.\n\nSame text here.",
    });

    const table = "| a | b |\n| --- | --- |\n| one | two |";
    const cell = renderPage(table).text.indexOf("two");
    expect(
      resolveMarkdownEdit(table, { start: cell, end: cell + 3, before: "two", after: "x | y" }),
    ).toMatchObject({
      status: "certain",
      source: "| a | b |\n| --- | --- |\n| one | x \\| y |",
    });
  });

  it("refuses stale and invalid edits", () => {
    expect(
      resolveMarkdownEdit("Hello world.", { start: 0, end: 5, before: "Howdy", after: "Hi" }),
    ).toEqual({
      status: "uncertain",
      reason: "stale",
    });
    expect(
      resolveMarkdownEdit("Hello world.", { start: 0, end: 5, before: "Hello", after: "a\n\n# b" }),
    ).toEqual({
      status: "uncertain",
      reason: "invalid_after",
    });
  });

  it("resolves an edit in a long document with two renders", () => {
    // Counted work, not time: `bench/limits.bench.ts` measures time at the size limits.
    const source = markdownDocument(99, 2_000);
    const page = renderPage(source);
    const at = Array.from(page.text.slice(0, page.text.lastIndexOf("review"))).length;
    const planned = planMarkdown(source, [
      { start: at, end: at + 6, before: "review", after: "check" },
    ]);
    expect(source.length).toBeGreaterThan(150_000);
    expect(planned.applied).toHaveLength(1);
    expect(planned.renders).toBe(2);
  });
});
