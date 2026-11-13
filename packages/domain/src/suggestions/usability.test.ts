// How often an ordinary correction applies: single-word typo fixes on every kind of file built from
// the same seeded corpus. A probe takes a word of at least four letters from the page text and
// swaps two of its inner letters. A small corpus here; the rates are properties of this corpus.
import type { FileKind } from "@portifact/contracts";
import { renderMarkdown } from "@portifact/render";
import { describe, expect, it } from "vitest";
import { markdownDocument, random } from "../testing/suggestions/corpus.ts";
import { pageTextOf, resolve, type TextEdit } from "../testing/suggestions/harness.ts";

function probe(rand: () => number, text: string): TextEdit | null {
  const words = [...text.matchAll(/\p{L}{4,}/gu)];
  const word = words[Math.floor(rand() * words.length)];
  if (!word) return null;
  const letters = Array.from(word[0]);
  const i = 1 + Math.floor(rand() * (letters.length - 2));
  if (letters[i] === letters[i + 1]) return null;
  const typo = [...letters];
  [typo[i], typo[i + 1]] = [letters[i + 1] as string, letters[i] as string];
  const start = Array.from(text.slice(0, word.index)).length;
  return { start, end: start + letters.length, before: word[0], after: typo.join("") };
}

const markdown = (doc: number) => markdownDocument(900 + doc, 12);
const html = (doc: number) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Doc</title></head><body><main>${renderMarkdown(markdown(doc)).html}</main></body></html>`;

async function measure(kind: FileKind, sourceOf: (doc: number) => string, documents: number) {
  const tally = { probes: 0, certain: 0 };
  const rand = random(17);
  for (let doc = 0; doc < documents; doc++) {
    const source = sourceOf(doc);
    const text = await pageTextOf(kind, source);
    for (let n = 0; n < 10; n++) {
      const edit = probe(rand, text);
      if (!edit) continue;
      tally.probes++;
      if ((await resolve(kind, source, edit)).status === "certain") tally.certain++;
    }
  }
  return tally;
}

describe("typo fixes apply in most places", () => {
  it("in Markdown, plain text and subset HTML", async () => {
    const results = {
      markdown: await measure("markdown", markdown, 12),
      text: await measure("text", markdown, 12),
      html: await measure("html", html, 12),
    };
    for (const tally of Object.values(results)) expect(tally.probes).toBeGreaterThan(100);
    expect(results.markdown.certain / results.markdown.probes).toBeGreaterThan(0.8);
    expect(results.text.certain / results.text.probes).toBeGreaterThan(0.95);
    expect(results.html.certain / results.html.probes).toBeGreaterThan(0.95);
  });
});
