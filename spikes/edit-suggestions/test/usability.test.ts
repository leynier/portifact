// How often an ordinary correction applies (rule 11 of the second round): single-word typo fixes
// on every kind of file built from the same seeded corpus. A probe takes a word of at least four
// letters from the page text and swaps two of its inner letters, the shape of most typo fixes.
// The rates are a property of this corpus, not a production estimate; the record quotes them.
import { normalizeText } from "@portifact/anchors";
import { renderMarkdown } from "@portifact/render";
import { describe, expect, it } from "vitest";
import type { TextEdit } from "../src/edit.ts";
import { resolveHtmlEdit } from "../src/html-resolver.ts";
import { renderPage, resolveMarkdownEdit } from "../src/markdown-resolver.ts";
import { codePoints, pageText, parseDocument } from "../src/page.ts";
import { resolveTextEdit } from "../src/text-resolver.ts";
import { markdownDocument, random } from "./corpus.ts";

/** A typo fix on a random word of the page text, or null when the word is too short. */
function probe(rand: () => number, text: string): TextEdit | null {
  const words = [...text.matchAll(/\p{L}{4,}/gu)];
  const word = words[Math.floor(rand() * words.length)];
  if (!word) return null;
  const letters = codePoints(word[0]);
  const i = 1 + Math.floor(rand() * (letters.length - 2));
  if (letters[i] === letters[i + 1]) return null;
  const typo = [...letters];
  [typo[i], typo[i + 1]] = [letters[i + 1] as string, letters[i] as string];
  const start = codePoints(text.slice(0, word.index)).length;
  return { start, end: start + letters.length, before: word[0], after: typo.join("") };
}

interface Tally {
  probes: number;
  certain: number;
  reasons: Record<string, number>;
}

function run(
  resolve: (source: string, edit: TextEdit) => { status: string; reason?: string },
  sourceOf: (doc: number) => string,
  textOf: (source: string) => string,
): Tally {
  const tally: Tally = { probes: 0, certain: 0, reasons: {} };
  const rand = random(17);
  for (let doc = 0; doc < 40; doc++) {
    const source = sourceOf(doc);
    const text = textOf(source);
    for (let n = 0; n < 10; n++) {
      const edit = probe(rand, text);
      if (!edit) continue;
      tally.probes++;
      const result = resolve(source, edit);
      if (result.status === "certain") tally.certain++;
      else
        tally.reasons[result.reason as string] = (tally.reasons[result.reason as string] ?? 0) + 1;
    }
  }
  return tally;
}

const markdown = (doc: number) => markdownDocument(900 + doc, 12);
/** The same documents as static HTML pages: the renderer's body in a minimal page. */
const html = (doc: number) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Doc</title></head><body><main>${renderMarkdown(markdown(doc)).html}</main></body></html>`;

describe("typo fixes apply in most places", () => {
  it("measures each kind", () => {
    const results = {
      markdown: run(resolveMarkdownEdit, markdown, (source) => renderPage(source).text),
      text: run(resolveTextEdit, markdown, (source) => normalizeText(source)),
      html: run(resolveHtmlEdit, html, (source) => pageText(parseDocument(source).body)),
    };
    console.log("usability", JSON.stringify(results));
    for (const tally of Object.values(results)) expect(tally.probes).toBeGreaterThan(300);
    expect(results.markdown.certain / results.markdown.probes).toBeGreaterThan(0.8);
    expect(results.text.certain / results.text.probes).toBeGreaterThan(0.95);
    expect(results.html.certain / results.html.probes).toBeGreaterThan(0.95);
  });
});
