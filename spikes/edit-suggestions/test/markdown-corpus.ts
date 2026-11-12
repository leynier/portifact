// The Markdown corpus run and its oracle, shared by the unit tests (a small corpus, in `bun run
// test`) and the benchmark script (the full corpus the record quotes, `bun run bench`).
import { AnchorDocument, type AnchorElement } from "@portifact/anchors";
import { renderMarkdown } from "@portifact/render";
import { parseFragment as parseFragment5 } from "parse5";
import { expect } from "vitest";
import { changedRegion, type Resolution } from "../src/edit.ts";
import { childrenOf, type P5Node } from "../src/html-dom.ts";
import { renderPage, resolveMarkdownEdit } from "../src/markdown-resolver.ts";
import { codePoints, parseFragment } from "../src/page.ts";
import { onlyApprovedBytes } from "../src/planned.ts";
import { type CorpusEdit, type EditShape, markdownDocument, random, randomEdit } from "./corpus.ts";

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
/** Text nodes at their DOM paths, read by a second parser (parse5, not the resolver's happy-dom). */
function paths(html: string): Map<string, string> {
  const found = new Map<string, string>();
  const visit = (node: P5Node, path: string) => {
    childrenOf(node).forEach((child, index) => {
      const here = `${path}/${child.nodeName}[${index}]`;
      if (child.nodeName === "#text") found.set(here, (child as { value: string }).value);
      else visit(child, here);
    });
  };
  visit(parseFragment5(html), "");
  return found;
}

function oracle(
  source: string,
  next: string,
  edit: CorpusEdit,
  range: { start: number; end: number; replacement: string },
): void {
  const oldHtml = renderMarkdown(source).html;
  const newHtml = renderMarkdown(next).html;
  expect(ids(newHtml)).toEqual(ids(oldHtml));
  expect(markup(newHtml)).toBe(markup(oldHtml));
  // Source bytes outside the approved range are the same.
  expect(onlyApprovedBytes(source, next, [range])).toBe(true);
  // Exactly one text node changed, at the same DOM path, as the second parser reads it.
  const before = paths(oldHtml);
  const after = paths(newHtml);
  expect([...after.keys()]).toEqual([...before.keys()]);
  expect([...before].filter(([path, data]) => after.get(path) !== data).length).toBeLessThanOrEqual(
    1,
  );

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

export interface Tally {
  edits: number;
  certain: number;
  byShape: Record<EditShape, { edits: number; certain: number }>;
  reasons: Record<string, number>;
}

export function runCorpus(
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
        oracle(source, result.source, edit, { ...result.range, replacement: result.replacement });
      } else {
        tally.reasons[result.reason] = (tally.reasons[result.reason] ?? 0) + 1;
      }
    }
  }
  return tally;
}
