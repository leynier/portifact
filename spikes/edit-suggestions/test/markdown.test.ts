import { contentHash } from "@portifact/anchors";
import { renderMarkdown, renderMarkdownDocument } from "@portifact/render";
import { describe, expect, it } from "vitest";
import { changedRegion, type Resolution } from "../src/edit.ts";
import { renderPage, resolveMarkdownEdit } from "../src/markdown-resolver.ts";
import { pageText, parseDocument, spliceCodePoints } from "../src/page.ts";
import { HOSTILE_AFTERS, markdownDocument, PLAIN_AFTERS, random, randomEdit } from "./corpus.ts";

/**
 * The oracle, written apart from the resolver: render the new source as a whole published
 * document (another entry point of the renderer), parse it with a fresh parser and compare the
 * hash of its text with the expected page's, and compare the HTML with every text run removed
 * (a string comparison, not the resolver's skeleton walk). Heading IDs follow the heading's text
 * and highlight spans follow the code, so both are dropped on each side.
 */
function markup(html: string): string {
  return html
    .replace(/(<h[1-6][^>]*?) id="[^"]*"/g, "$1")
    .replace(/<\/?span[^>]*>/g, "")
    .replace(/>[^<]*</g, "><");
}

async function oracle(source: string, next: string, expectedText: string): Promise<void> {
  const document = parseDocument(renderMarkdownDocument(next, { title: "t" }).html);
  const main = document.querySelector("main") as Element;
  expect(await contentHash(pageText(main))).toBe(await contentHash(expectedText));
  expect(markup(renderMarkdown(next).html)).toBe(markup(renderMarkdown(source).html));
  // The change stays inside one block of the old block map.
  const blocks = renderMarkdown(source).blocks;
  let first = 0;
  while (first < source.length && source[first] === next[first]) first++;
  let tail = 0;
  while (
    tail < source.length - first &&
    tail < next.length - first &&
    source[source.length - 1 - tail] === next[next.length - 1 - tail]
  ) {
    tail++;
  }
  expect(blocks.some((block) => block.start <= first && source.length - tail <= block.end)).toBe(
    true,
  );
}

interface Tally {
  edits: number;
  certain: number;
  reasons: Record<string, number>;
}

async function runCorpus(
  documents: number,
  editsPer: number,
  afters: readonly string[],
  seed: number,
): Promise<Tally> {
  const tally: Tally = { edits: 0, certain: 0, reasons: {} };
  const rand = random(seed);
  for (let doc = 0; doc < documents; doc++) {
    const source = markdownDocument(seed * 1_000 + doc, 12);
    const page = renderPage(source);
    for (let n = 0; n < editsPer; n++) {
      const edit = randomEdit(rand, page.text, afters);
      if (!edit) continue;
      tally.edits++;
      const result: Resolution = resolveMarkdownEdit(source, edit);
      if (result.status === "certain") {
        tally.certain++;
        const change = changedRegion(edit);
        await oracle(
          source,
          result.source,
          spliceCodePoints(page.text, change.from, change.to, change.inserted),
        );
      } else {
        tally.reasons[result.reason] = (tally.reasons[result.reason] ?? 0) + 1;
      }
    }
  }
  return tally;
}

describe("Markdown resolver", () => {
  it("maps plain edits with certainty and never applies a wrong one", async () => {
    const tally = await runCorpus(60, 25, PLAIN_AFTERS, 7);
    console.log("markdown plain", JSON.stringify(tally));
    expect(tally.edits).toBeGreaterThan(1_200);
    // Measured: about four in five edits are certain; the rest cross blocks or formatting.
    expect(tally.certain / tally.edits).toBeGreaterThan(0.7);
  });

  it("never lets hostile after-text add markup", async () => {
    const tally = await runCorpus(60, 25, HOSTILE_AFTERS, 11);
    console.log("markdown hostile", JSON.stringify(tally));
    expect(tally.edits).toBeGreaterThan(1_200);
    // Most hostile text is written escaped and still applies; what would become markup does not.
    expect(tally.certain).toBeGreaterThan(0);
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
    ).toEqual({ status: "uncertain", reason: "spans_blocks" });
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

  it("resolves an edit in a long document in bounded time", () => {
    const source = markdownDocument(99, 2_000);
    const page = renderPage(source);
    const at = Array.from(page.text.slice(0, page.text.lastIndexOf("review"))).length;
    const started = performance.now();
    const result = resolveMarkdownEdit(source, {
      start: at,
      end: at + 6,
      before: "review",
      after: "check",
    });
    const elapsed = performance.now() - started;
    console.log(
      "markdown long",
      JSON.stringify({ bytes: source.length, ms: Math.round(elapsed), status: result.status }),
    );
    expect(source.length).toBeGreaterThan(150_000);
    expect(elapsed).toBeLessThan(20_000);
  });
});
