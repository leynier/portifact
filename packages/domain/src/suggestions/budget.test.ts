// Planning budgets, proven by counting work rather than timing it: one parse or render of the
// stored file and one anchor index per plan whatever the number of operations, at most two builds
// of the new file, two renders for a whole carry batch, and files over the limits refused before
// anything is parsed. Wall-clock times at the limits are measured outside `bun run test`.
import { describe, expect, it } from "vitest";
import {
  DOC_URL,
  editAt,
  pageTextOf,
  plan,
  planOne,
  RENDERER,
  TITLE,
} from "../testing/suggestions/harness.ts";
import { carryAll } from "./relocate.ts";
import { newWork } from "./work.ts";

const paragraphs = (count: number) =>
  Array.from({ length: count }, (_, i) => `Paragraph w${i}x says something short.`);

/** Edits replacing the unique word of `count` paragraphs spread through the page. */
function editsFor(text: string, count: number, total: number) {
  const step = Math.floor(total / count);
  return Array.from({ length: count }, (_, k) => editAt(text, `w${k * step}x`, `v${k * step}y`));
}

describe("work stays flat as operations grow", () => {
  it("Markdown: the baseline render, one parse and one index, then one verification", async () => {
    const blocks = paragraphs(200);
    const source = blocks.join("\n\n");
    const text = await pageTextOf("markdown", source);
    for (const count of [1, 20, 100]) {
      const work = newWork();
      const built = await plan("markdown", source, editsFor(text, count, blocks.length), { work });
      expect(built.applied).toHaveLength(count);
      expect(work).toEqual({ parses: 2, renders: 2, indexes: 1, maps: 0, decodes: 0 });
    }
  });

  it("HTML: one parse and one index, then one verification parse", async () => {
    const blocks = paragraphs(200);
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>${blocks.map((p) => `<p>${p}</p>`).join("\n")}</body></html>`;
    const text = await pageTextOf("html", html);
    for (const count of [1, 20, 100]) {
      const work = newWork();
      expect(
        (await plan("html", html, editsFor(text, count, blocks.length), { work })).applied,
      ).toHaveLength(count);
      // One source map per edited text node, each built once.
      expect(work).toEqual({ parses: 2, renders: 0, indexes: 1, maps: count, decodes: 0 });
    }
  });

  it("plain text: the baseline render, one source map and the output render", async () => {
    const source = paragraphs(200).join("\n");
    const text = await pageTextOf("text", source);
    for (const count of [1, 20, 100]) {
      const work = newWork();
      expect(
        (await plan("text", source, editsFor(text, count, 200), { work })).applied,
      ).toHaveLength(count);
      expect(work).toEqual({ parses: 0, renders: 2, indexes: 0, maps: 1, decodes: 0 });
    }
  });

  it("a carry batch takes two renders whatever its size", async () => {
    const blocks = paragraphs(200);
    const source = blocks.join("\n\n");
    const text = await pageTextOf("markdown", source);
    const next = `A new first paragraph.\n\n${source}`;
    for (const count of [1, 20, 100]) {
      const edits = editsFor(text, count, blocks.length);
      const planned = await planOne("markdown", source, edits);
      const items = planned.applied.map((patch) => ({
        edit: edits[patch.operation] as (typeof edits)[number],
        proof: patch.proof,
      }));
      const work = newWork();
      const results = carryAll("markdown", source, next, items, {
        title: TITLE,
        pageUrl: DOC_URL,
        renderer: RENDERER,
        otherFilesUnchanged: false,
        work,
      });
      expect(results.filter((result) => result.status === "carried")).toHaveLength(count);
      expect(work.renders).toBe(2);
    }
  });
});

describe("the limits refuse before any work", () => {
  it("lists every operation of an oversized file without parsing or rendering it", async () => {
    const change = { start: 0, end: 1, before: "x", after: "y" };
    const work = newWork();
    expect(
      (await planOne("markdown", "x".repeat(2_000_001), [change], work)).listed[0]?.reason,
    ).toBe("too_large");
    expect((await planOne("text", "x".repeat(2_000_001), [change], work)).listed[0]?.reason).toBe(
      "too_large",
    );
    expect(
      (await planOne("html", `<p>${"x".repeat(1_048_576)}</p>`, [change], work)).listed[0]?.reason,
    ).toBe("too_large");
    expect(work).toEqual({ parses: 0, renders: 0, indexes: 0, maps: 0, decodes: 0 });
  });
});
