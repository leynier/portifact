// Planning at the size limits (rule 8 of the second round): 100-operation plans on the largest files
// a plan takes and a batched carry. Wall-clock times in Node on the machine running it, not Workers
// CPU; the record quotes the numbers this prints, with the machine. Run with `bun run --cwd
// spikes/edit-suggestions bench`; never part of `bun run test`, where `test/budget.test.ts` asserts
// the same properties on small inputs by counting work.
import { cpus, totalmem } from "node:os";
import { describe, expect, it } from "vitest";
import { planHtml } from "../src/html-resolver.ts";
import { HTML_LIMITS } from "../src/html-subset.ts";
import { MARKDOWN_LIMIT, planMarkdown, renderPage } from "../src/markdown-resolver.ts";
import { codePoints, pageText, parseDocument } from "../src/page.ts";
import { carryAll } from "../src/relocate.ts";
import { planText, TEXT_LIMIT } from "../src/text-resolver.ts";

/** Paragraphs with a unique word each, so every operation can be located. */
function paragraphs(count: number, words = 20): string[] {
  return Array.from(
    { length: count },
    (_, i) => `Paragraph w${i}x says ${"filler ".repeat(words).trim()} end.`,
  );
}

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

const timed = <T>(run: () => T): [T, number] => {
  const started = performance.now();
  const result = run();
  return [result, Math.round(performance.now() - started)];
};

describe("planning budgets at the limits", () => {
  it("names the machine", () => {
    const cpu = cpus();
    console.log(
      "machine",
      JSON.stringify({
        cpu: cpu[0]?.model,
        cores: cpu.length,
        memoryGb: Math.round(totalmem() / 2 ** 30),
        node: process.version,
      }),
    );
  });

  it("plans 1, 20 and 100 operations on a Markdown document near 2 MB", () => {
    const blocks = paragraphs(11_000);
    const source = blocks.join("\n\n");
    expect(source.length).toBeLessThanOrEqual(MARKDOWN_LIMIT);
    expect(source.length).toBeGreaterThan(1_800_000);
    const text = renderPage(source).text;
    const times: Record<string, number> = {};
    for (const count of [1, 20, 100]) {
      const [planned, ms] = timed(() => planMarkdown(source, editsFor(text, count, blocks.length)));
      expect(planned.applied).toHaveLength(count);
      expect(planned.renders).toBe(2);
      times[count] = ms;
    }
    console.log("budget markdown", JSON.stringify({ bytes: source.length, ms: times }));
    // Loose bound: the point is that 100 operations cost about what 1 does (one index, one patch).
    expect((times[100] as number) / Math.max(1, times[1] as number)).toBeLessThan(4);
  });

  it("plans 1, 20 and 100 operations on an HTML page near 1 MB", () => {
    const blocks = paragraphs(5_800);
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>${blocks.map((p) => `<p>${p}</p>`).join("\n")}</body></html>`;
    expect(new TextEncoder().encode(html).length).toBeLessThanOrEqual(HTML_LIMITS.bytes);
    expect(html.length).toBeGreaterThan(900_000);
    const text = pageText(parseDocument(html).body);
    const times: Record<string, number> = {};
    for (const count of [1, 20, 100]) {
      const [planned, ms] = timed(() => planHtml(html, editsFor(text, count, blocks.length)));
      expect(planned.applied).toHaveLength(count);
      times[count] = ms;
    }
    console.log("budget html", JSON.stringify({ bytes: html.length, ms: times }));
    expect((times[100] as number) / Math.max(1, times[1] as number)).toBeLessThan(4);
  });

  it("plans 100 operations on a text document near 2 MB", () => {
    const source = paragraphs(11_000).join("\n");
    expect(source.length).toBeLessThanOrEqual(TEXT_LIMIT);
    const text = source.replace(/\s+/g, " ");
    const [planned, ms] = timed(() => planText(source, editsFor(text, 100, 11_000)));
    expect(planned.applied).toHaveLength(100);
    console.log("budget text", JSON.stringify({ bytes: source.length, ms }));
  });

  it("refuses files over the limits without parsing them", () => {
    const [markdown, ms] = timed(() =>
      planMarkdown("x".repeat(MARKDOWN_LIMIT + 1), [{ start: 0, end: 1, before: "x", after: "y" }]),
    );
    expect(markdown.listed[0]?.reason).toBe("too_large");
    expect(markdown.renders).toBe(0);
    expect(ms).toBeLessThan(1_000);
    expect(
      planText("x".repeat(TEXT_LIMIT + 1), [{ start: 0, end: 1, before: "x", after: "y" }])
        .listed[0]?.reason,
    ).toBe("too_large");
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

  it("carries 200 suggestions of one changed file with two renders", () => {
    const blocks = paragraphs(11_000);
    const source = blocks.join("\n\n");
    const text = renderPage(source).text;
    const edits = editsFor(text, 200, blocks.length);
    // A plan takes at most 100 operations; the 200 suggestions were accepted in two plans.
    const planned = {
      applied: [
        ...planMarkdown(source, edits.slice(0, 100)).applied,
        ...planMarkdown(source, edits.slice(100)).applied.map((patch) => ({
          ...patch,
          operation: patch.operation + 100,
        })),
      ],
    };
    const items = planned.applied.map((patch) => ({
      edit: edits[patch.operation] as (typeof edits)[number],
      proof: patch.proof,
    }));
    expect(items).toHaveLength(200);
    const next = `A new first paragraph.\n\n${source}`;
    const [results, ms] = timed(() => carryAll("markdown", source, next, items));
    expect(results.filter((result) => result.status === "carried")).toHaveLength(200);
    console.log("budget carry", JSON.stringify({ bytes: source.length, suggestions: 200, ms }));
  });
});
