import { AnchorDocument, type AnchorElement } from "@portifact/anchors";
import { renderMarkdown } from "@portifact/render";
import { describe, expect, it } from "vitest";
import { changedRegion, type Resolution } from "../src/edit.ts";
import { renderPage, resolveMarkdownEdit } from "../src/markdown-resolver.ts";
import { codePoints, parseFragment } from "../src/page.ts";
import {
  type CorpusEdit,
  type EditShape,
  HOSTILE_AFTERS,
  markdownDocument,
  PLAIN_AFTERS,
  random,
  randomEdit,
} from "./corpus.ts";

/** Every value of every `id` and `href` attribute, in order: IDs and references (rule 6). */
const ids = (html: string) =>
  [...html.matchAll(/ (id|href)="([^"]*)"/g)].map((m) => `${m[1]}=${m[2]}`);
/** The HTML with every text run removed; nothing else is dropped, spans and IDs included. */
const markup = (html: string) => html.replace(/>[^<]*</g, "><");

/** The raw text of every text node, in order, by a walk written here, not the resolver's. */
function rawText(root: Node): { text: string; starts: Map<Node, number> } {
  let text = "";
  const starts = new Map<Node, number>();
  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      starts.set(node, text.length);
      text += (node as Text).data;
    }
    for (const child of Array.from(node.childNodes)) visit(child);
  };
  visit(root);
  return { text, starts };
}

/**
 * The oracle, written apart from the resolver's comparison: IDs and references by a regular
 * expression over the HTML, the markup with text removed, and the raw text of the new page
 * compared with the old raw text changed exactly at the reviewer's location (found through
 * `packages/anchors`, which defines positions), whitespace included. It also checks that the
 * change stays inside one block of the old block map.
 */
function oracle(source: string, next: string, edit: CorpusEdit): void {
  const oldHtml = renderMarkdown(source).html;
  const newHtml = renderMarkdown(next).html;
  expect(ids(newHtml)).toEqual(ids(oldHtml));
  expect(markup(newHtml)).toBe(markup(oldHtml));

  const oldMain = parseFragment(oldHtml);
  const document = new AnchorDocument(oldMain as unknown as AnchorElement);
  const points = codePoints(document.text.value);
  const located = document.resolveText({
    kind: "text",
    quote: {
      exact: edit.before,
      prefix: points.slice(Math.max(0, edit.start - 32), edit.start).join(""),
      suffix: points.slice(edit.end, edit.end + 32).join(""),
    },
    position: { start: edit.start, end: edit.end },
  });
  if (located.confidence !== "exact") throw new Error("the oracle could not place the edit");
  const old = rawText(oldMain);
  const at =
    (old.starts.get(located.range.start.node as unknown as Node) as number) +
    located.range.start.offset;
  expect(old.text.slice(at, at + edit.before.length)).toBe(edit.before);
  const change = changedRegion(edit);
  const prefix = codePoints(edit.before)
    .slice(0, change.from - edit.start)
    .join("").length;
  const expected =
    old.text.slice(0, at + prefix) +
    change.inserted +
    old.text.slice(at + prefix + change.deleted.length);
  expect(rawText(parseFragment(newHtml)).text).toBe(expected);

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
  byShape: Record<EditShape, { edits: number; certain: number }>;
  reasons: Record<string, number>;
}

function runCorpus(
  documents: number,
  editsPer: number,
  afters: readonly string[],
  seed: number,
): Tally {
  const tally: Tally = {
    edits: 0,
    certain: 0,
    byShape: {
      replacement: { edits: 0, certain: 0 },
      insertion: { edits: 0, certain: 0 },
      deletion: { edits: 0, certain: 0 },
    },
    reasons: {},
  };
  const rand = random(seed);
  for (let doc = 0; doc < documents; doc++) {
    const source = markdownDocument(seed * 1_000 + doc, 12);
    const page = renderPage(source);
    for (let n = 0; n < editsPer; n++) {
      const edit = randomEdit(rand, page.text, afters);
      if (!edit) continue;
      tally.edits++;
      tally.byShape[edit.shape].edits++;
      const result: Resolution = resolveMarkdownEdit(source, edit);
      if (result.status === "certain") {
        tally.certain++;
        tally.byShape[edit.shape].certain++;
        oracle(source, result.source, edit);
      } else {
        tally.reasons[result.reason] = (tally.reasons[result.reason] ?? 0) + 1;
      }
    }
  }
  return tally;
}

describe("Markdown resolver", () => {
  it("maps plain edits and every applied one passes the independent oracle", () => {
    const tally = runCorpus(60, 25, PLAIN_AFTERS, 7);
    console.log("markdown plain", JSON.stringify(tally));
    expect(tally.edits).toBeGreaterThan(1_200);
    expect(tally.certain / tally.edits).toBeGreaterThan(0.4);
    for (const shape of ["replacement", "insertion", "deletion"] as const) {
      expect(tally.byShape[shape].certain, shape).toBeGreaterThan(0);
    }
  });

  it("writes hostile after-text as text: no element, attribute, ID or reference appears", () => {
    const tally = runCorpus(60, 25, HOSTILE_AFTERS, 11);
    console.log("markdown hostile", JSON.stringify(tally));
    expect(tally.edits).toBeGreaterThan(1_200);
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
