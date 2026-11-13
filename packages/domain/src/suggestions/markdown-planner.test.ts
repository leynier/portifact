import { renderMarkdown } from "@portifact/render";
import { describe, expect, it } from "vitest";
import { check } from "../testing/suggestions/checker.ts";
import {
  type CorpusEdit,
  type EditShape,
  HOSTILE_AFTERS,
  markdownDocument,
  PLAIN_AFTERS,
  random,
  randomEdit,
} from "../testing/suggestions/corpus.ts";
import { edit, editAt, pageTextOf, planOne, resolve } from "../testing/suggestions/harness.ts";
import { newWork } from "./work.ts";

interface Tally {
  edits: number;
  certain: number;
  byShape: Record<EditShape, { edits: number; certain: number }>;
  reasons: Record<string, number>;
}

/**
 * Plans random edits on a seeded corpus and checks every applied one independently. The corpus
 * runs in several tests that share one generator and one tally, in order, so the edits are the
 * same as in one run and no single test outgrows the time limit on a loaded CI runner; the last
 * test judges the whole corpus.
 */
function corpus(
  name: string,
  afters: readonly string[],
  seed: number,
  verdict: (tally: Tally) => void,
): void {
  const documents = 15;
  const editsPer = 25;
  const perTest = 3;
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
  let done = 0;
  const one = async (doc: number) => {
    const source = markdownDocument(seed * 1_000 + doc, 12);
    const text = await pageTextOf("markdown", source);
    for (let n = 0; n < editsPer; n++) {
      const corpusEdit: CorpusEdit | null = randomEdit(rand, text, afters);
      if (!corpusEdit) continue;
      tally.edits++;
      tally.byShape[corpusEdit.shape].edits++;
      const result = await resolve("markdown", source, corpusEdit);
      if (result.status === "certain") {
        tally.certain++;
        tally.byShape[corpusEdit.shape].certain++;
        const failure = await check("markdown", source, result.source, corpusEdit, {
          ...result.range,
          replacement: result.replacement,
        });
        expect(failure, JSON.stringify(corpusEdit)).toBeNull();
      } else {
        tally.reasons[result.reason] = (tally.reasons[result.reason] ?? 0) + 1;
      }
    }
    done += 1;
  };
  for (let first = 0; first < documents; first += perTest) {
    it(`${name} (documents ${first + 1} to ${first + perTest} of ${documents})`, async () => {
      for (let doc = first; doc < first + perTest; doc++) await one(doc);
    });
  }
  it(`${name} (the whole corpus)`, () => {
    expect(done).toBe(documents);
    verdict(tally);
  });
}

describe("the Markdown planner", () => {
  corpus(
    "maps plain edits, and every applied one passes the independent checker",
    PLAIN_AFTERS,
    7,
    (tally) => {
      expect(tally.edits).toBeGreaterThan(300);
      expect(tally.certain / tally.edits).toBeGreaterThan(0.4);
      for (const shape of ["replacement", "insertion", "deletion"] as const) {
        expect(tally.byShape[shape].certain, shape).toBeGreaterThan(0);
      }
    },
  );

  corpus(
    "writes hostile text as text: no element, attribute, ID or reference appears",
    HOSTILE_AFTERS,
    11,
    (tally) => {
      expect(tally.edits).toBeGreaterThan(300);
      expect(tally.certain).toBeGreaterThan(0);
    },
  );

  it("refuses a heading edit that changes an ID", async () => {
    const source = "# Title\n\nBody.";
    expect(
      await resolve("markdown", source, await edit("markdown", source, "Title", "Other")),
    ).toEqual({
      status: "uncertain",
      reason: "would_change_page",
    });
  });

  it("writes Markdown syntax as escaped text", async () => {
    const source = "Plain words in a paragraph.";
    const result = await resolve(
      "markdown",
      source,
      await edit("markdown", source, "words", "**words**"),
    );
    expect(result).toMatchObject({
      status: "certain",
      source: "Plain \\*\\*words\\*\\* in a paragraph.",
    });
    expect(renderMarkdown((result as { source: string }).source).html).not.toContain("<strong>");
  });

  it("keeps a URL as text: the full escapes break linkify", async () => {
    const source = "Plain words in a paragraph.";
    const result = await resolve(
      "markdown",
      source,
      await edit("markdown", source, "words", "https://evil.example"),
    );
    expect(result).toMatchObject({
      status: "certain",
      source: "Plain https\\:\\/\\/evil\\.example in a paragraph.",
    });
    expect(renderMarkdown((result as { source: string }).source).html).not.toContain("<a");
  });

  it("edits inside inline formatting, links and code, keeping each link", async () => {
    const source = "Some **bold text** and a [link text](https://example.com) and `code span`.";
    for (const [before, after] of [
      ["bold", "strong"],
      ["link", "anchor"],
      ["code", "inline"],
    ] as const) {
      const result = await resolve(
        "markdown",
        source,
        await edit("markdown", source, before, after),
      );
      expect(result.status, before).toBe("certain");
    }
    const linked = await resolve(
      "markdown",
      source,
      await edit("markdown", source, "link", "anchor"),
    );
    expect((linked as { source: string }).source).toContain("[anchor text](https://example.com)");
    expect(linked).toMatchObject({
      destinations: [{ authored: "https://example.com", effective: "https://example.com/" }],
    });
  });

  it("refuses a change across formatting and across blocks", async () => {
    const source = "Some **bold text** here.\n\nSecond paragraph.";
    const text = await pageTextOf("markdown", source);
    expect(
      await resolve("markdown", source, editAt(text, "Some bold text", "Other words")),
    ).toMatchObject({ status: "uncertain" });
    expect(await resolve("markdown", source, editAt(text, "here. Second", "joined"))).toEqual({
      status: "uncertain",
      reason: "spans_nodes",
    });
  });

  it("handles entities, repeated text and tables", async () => {
    const entity = "Fish &amp; chips are good.";
    // "&" is in the source only inside "&amp;": replacing it there breaks the entity.
    expect(await resolve("markdown", entity, await edit("markdown", entity, "&", "and"))).toEqual({
      status: "uncertain",
      reason: "would_change_page",
    });
    expect(
      (await resolve("markdown", entity, await edit("markdown", entity, "chips", "fries"))).status,
    ).toBe("certain");

    const repeated = "Same words here.\n\nSame words here.";
    expect(
      await resolve("markdown", repeated, await edit("markdown", repeated, "words", "text", 1)),
    ).toMatchObject({ status: "certain", source: "Same words here.\n\nSame text here." });

    const table = "| a | b |\n| --- | --- |\n| one | two |";
    expect(
      await resolve("markdown", table, await edit("markdown", table, "two", "x | y")),
    ).toMatchObject({ status: "certain", source: "| a | b |\n| --- | --- |\n| one | x \\| y |" });
  });

  it("refuses stale and invalid edits, and lists style and structure operations", async () => {
    const source = "Hello world.";
    expect(
      await resolve("markdown", source, { start: 0, end: 5, before: "Howdy", after: "Hi" }),
    ).toEqual({
      status: "uncertain",
      reason: "stale",
    });
    expect(
      await resolve("markdown", source, { start: 0, end: 5, before: "Hello", after: "a\n\n# b" }),
    ).toEqual({ status: "uncertain", reason: "invalid_after" });
    const planned = await planOne("markdown", source, [null]);
    expect(planned.listed).toEqual([
      { operation: 0, reason: "not_text", destinations: [], destinationsKnown: false },
    ]);
  });

  it("refuses text the block map does not cover and text it cannot find once", async () => {
    // Footnote labels are drawn by the renderer: no block's source holds the drawn text.
    const footnote = "Text[^1] here.\n\n[^1]: The note.";
    const text = await pageTextOf("markdown", footnote);
    const label = text.includes("Footnotes") ? "Footnotes" : "1";
    const result = await resolve("markdown", footnote, editAt(text, label, "Notes"));
    expect(result.status).toBe("uncertain");
    // The character after a backslash escape is not in the source as shown.
    const escaped = "A \\*star\\* b";
    const star = await resolve("markdown", escaped, await edit("markdown", escaped, "*star*", "x"));
    expect(star.status).toBe("uncertain");
  });

  it("lists every operation of an oversized source, and the 101st operation", async () => {
    const work = newWork();
    const big = await planOne(
      "markdown",
      "x".repeat(2_000_001),
      [{ start: 0, end: 1, before: "x", after: "y" }, null],
      work,
    );
    expect(big.listed.map((item) => item.reason)).toEqual(["too_large", "not_text"]);
    expect(work).toEqual({ parses: 0, renders: 0, indexes: 0, maps: 0, decodes: 0, hashes: 0 });
    const source = "alpha";
    const one = await edit("markdown", source, "alpha", "beta");
    const many = await planOne(
      "markdown",
      source,
      Array.from({ length: 101 }, () => one),
    );
    expect(many.listed.filter((item) => item.reason === "too_large")).toHaveLength(1);
  });

  it("refuses an edit inside a diagram's source", async () => {
    const source = "```mermaid\nA-->B\n```";
    expect(
      await resolve("markdown", source, await edit("markdown", source, "B", "C")),
    ).toMatchObject({
      status: "uncertain",
      reason: "diagram",
    });
  });
});
