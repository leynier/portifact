// Planning budgets (rule 8 of the second round), proven by counting work rather than timing it:
// one parse or render of the stored file and one anchor index per plan whatever the number of
// operations, at most two builds of the new file, two renders for a whole carry batch, and files
// over the limits refused before anything is parsed. Inputs are small, so this runs in a few
// seconds under coverage on a slow runner; `bench/limits.bench.ts` measures time at the limits.
import { beforeEach, describe, expect, it } from "vitest";
import { planHtml } from "../src/html-resolver.ts";
import { HTML_LIMITS } from "../src/html-subset.ts";
import { MARKDOWN_LIMIT, planMarkdown, renderPage } from "../src/markdown-resolver.ts";
import { codePoints, pageText, parseDocument } from "../src/page.ts";
import { carryAll } from "../src/relocate.ts";
import { planText, TEXT_LIMIT } from "../src/text-resolver.ts";
import { resetWork, work } from "../src/work.ts";

const paragraphs = (count: number) =>
  Array.from({ length: count }, (_, i) => `Paragraph w${i}x says something short.`);

/** Edits replacing the unique word of `count` paragraphs spread through the page. */
function editsFor(text: string, count: number, total: number) {
  const step = Math.floor(total / count);
  return Array.from({ length: count }, (_, k) => {
    const word = `w${k * step}x`;
    const unit = text.indexOf(` ${word} `) + 1;
    const start = codePoints(text.slice(0, unit)).length;
    return { start, end: start + codePoints(word).length, before: word, after: `v${k * step}y` };
  });
}

beforeEach(resetWork);

describe("work stays flat as operations grow", () => {
  it("Markdown: one render and one index, then one verification render, for 1, 20 or 100 operations", () => {
    const blocks = paragraphs(200);
    const source = blocks.join("\n\n");
    const text = renderPage(source).text;
    for (const count of [1, 20, 100]) {
      const edits = editsFor(text, count, blocks.length);
      resetWork();
      const planned = planMarkdown(source, edits);
      expect(planned.applied).toHaveLength(count);
      expect(work).toEqual({ parses: 0, renders: 2, indexes: 1, maps: 0 });
      expect(planned.renders).toBe(2);
    }
  });

  it("HTML: one parse and one index, then one verification parse, for 1, 20 or 100 operations", () => {
    const blocks = paragraphs(200);
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>${blocks.map((p) => `<p>${p}</p>`).join("\n")}</body></html>`;
    const text = pageText(parseDocument(html).body);
    for (const count of [1, 20, 100]) {
      const edits = editsFor(text, count, blocks.length);
      resetWork();
      expect(planHtml(html, edits).applied).toHaveLength(count);
      expect(work).toEqual({ parses: 2, renders: 0, indexes: 1, maps: 0 });
    }
  });

  it("plain text: one source map for 1, 20 or 100 operations", () => {
    const source = paragraphs(200).join("\n");
    const text = source.replace(/\s+/g, " ");
    for (const count of [1, 20, 100]) {
      resetWork();
      expect(planText(source, editsFor(text, count, 200)).applied).toHaveLength(count);
      expect(work.maps).toBe(1);
    }
  });

  it("carries a batch in two renders whatever its size", () => {
    const blocks = paragraphs(200);
    const source = blocks.join("\n\n");
    const text = renderPage(source).text;
    const next = `A new first paragraph.\n\n${source}`;
    for (const count of [1, 20, 100]) {
      const edits = editsFor(text, count, blocks.length);
      const items = planMarkdown(source, edits).applied.map((patch) => ({
        edit: edits[patch.operation] as (typeof edits)[number],
        proof: patch.proof,
      }));
      resetWork();
      const results = carryAll("markdown", source, next, items);
      expect(results.filter((result) => result.status === "carried")).toHaveLength(count);
      expect(work.renders).toBe(2);
    }
  });
});

describe("the limits refuse before any work", () => {
  it("lists every operation of an oversized file without parsing or rendering it", () => {
    const edit = { start: 0, end: 1, before: "x", after: "y" };
    const markdown = planMarkdown("x".repeat(MARKDOWN_LIMIT + 1), [edit]);
    expect(markdown.listed[0]?.reason).toBe("too_large");
    expect(planText("x".repeat(TEXT_LIMIT + 1), [edit]).listed[0]?.reason).toBe("too_large");
    expect(planHtml(`<p>${"x".repeat(HTML_LIMITS.bytes)}</p>`, [edit]).listed[0]?.reason).toBe(
      "too_large",
    );
    expect(work).toEqual({ parses: 0, renders: 0, indexes: 0, maps: 0 });
  });

  it("takes at most 100 operations per plan", () => {
    const operations = Array.from({ length: 101 }, () => ({
      start: 0,
      end: 1,
      before: "a",
      after: "b",
    }));
    expect(
      planText("a", operations).listed.filter((item) => item.reason === "too_large"),
    ).toHaveLength(1);
  });
});
