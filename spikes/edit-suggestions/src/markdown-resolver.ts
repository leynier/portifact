// The Markdown resolver of decision 0027: from a text edit in the rendered page to one range of
// the source, or "uncertain". It never trusts its own mapping. A candidate is certain only when
// rendering the changed source gives exactly the page the reviewer saw with the edit applied:
// the same normalized text with `after` in place of `before`, and the same markup skeleton (no
// element, attribute or link added, removed or changed). Anything else goes to the change list.
import { renderMarkdown, type SourceBlock } from "@portifact/render";
import {
  changedRegion,
  type Resolution,
  type TextEdit,
  uncertain,
  unitOffset,
  validAfter,
} from "./edit.ts";
import {
  codePoints,
  flexibleMatches,
  occurrences,
  pageText,
  parseFragment,
  skeleton,
  spliceCodePoints,
} from "./page.ts";

/** How much rendered context to look for around the change, widest first. */
const CONTEXTS = [24, 12, 6, 3, 1, 0];

/** Characters that start Markdown syntax inside a line. Always escaped in the inserted text. */
const MINIMAL = /[\\`*_[\]<>&|~!#^]/g;
/** Every ASCII punctuation character, which CommonMark lets a backslash escape. */
const FULL = /[!-/:-@[-`{-~]/g;

/** The ways to write the inserted text, tried in order until one verifies. */
export const ESCAPES: readonly ((text: string) => string)[] = [
  (text) => text.replace(MINIMAL, "\\$&"),
  (text) => text.replace(FULL, "\\$&"),
  // Inside code spans and fences backslashes are literal, so the raw text is the only spelling
  // that can verify there; anywhere else it fails verification whenever it would add markup.
  (text) => text,
];

interface Leaf {
  block: SourceBlock;
  /** UTF-16 offsets of the block's text in the page text. */
  start: number;
  end: number;
  text: string;
}

/** Blocks with no block inside them, with where their text sits in the page text. */
function leaves(main: HTMLElement, blocks: SourceBlock[], text: string): Leaf[] {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const found: Leaf[] = [];
  let cursor = 0;
  for (const element of Array.from(main.querySelectorAll("[data-pf-block]"))) {
    if (element.querySelector("[data-pf-block]")) continue;
    const block = byId.get(element.getAttribute("data-pf-block") ?? "");
    const blockText = pageText(element);
    if (!block || blockText.length === 0) continue;
    const at = text.indexOf(blockText, cursor);
    if (at < 0) continue;
    found.push({ block, start: at, end: at + blockText.length, text: blockText });
    cursor = at + blockText.length;
  }
  return found;
}

export interface RenderedPage {
  text: string;
  skeleton: string;
}

export function renderPage(
  source: string,
): RenderedPage & { main: HTMLElement; blocks: SourceBlock[] } {
  const rendered = renderMarkdown(source);
  const main = parseFragment(rendered.html);
  return { text: pageText(main), skeleton: skeleton(main), main, blocks: rendered.blocks };
}

export function resolveMarkdownEdit(source: string, edit: TextEdit): Resolution {
  if (!validAfter(edit)) return uncertain("invalid_after");
  const page = renderPage(source);
  const points = codePoints(page.text);
  if (points.slice(edit.start, edit.end).join("") !== edit.before) return uncertain("stale");
  const change = changedRegion(edit);
  const expected = spliceCodePoints(page.text, change.from, change.to, change.inserted);

  const from = unitOffset(page.text, change.from);
  const to = unitOffset(page.text, change.to);
  const leaf = leaves(page.main, page.blocks, page.text).find(
    (candidate) => candidate.start <= from && to <= candidate.end,
  );
  if (!leaf) return uncertain("spans_blocks");

  const slice = source.slice(leaf.block.start, leaf.block.end);
  const a = from - leaf.start;
  const b = to - leaf.start;
  let found = false;
  for (const width of CONTEXTS) {
    const left = leaf.text.slice(Math.max(0, a - width), a);
    const right = leaf.text.slice(b, b + width);
    const needle = left + change.deleted + right;
    if (needle.length === 0) continue;
    if (occurrences(leaf.text, needle).length !== 1) continue;
    const matches = flexibleMatches(slice, needle);
    if (matches.length !== 1) continue;
    found = true;
    const match = matches[0] as { start: number; end: number };
    // The context on each side is kept; only the deleted text between them is replaced. Spaces
    // in the context may stand for line breaks, so locate the context's ends in the source.
    const leftEnd = endOfPrefix(slice, match.start, left);
    const rightStart = startOfSuffix(slice, match.end, right);
    if (leftEnd === undefined || rightStart === undefined || rightStart < leftEnd) continue;
    for (const spell of ESCAPES) {
      const replacement = spell(change.inserted);
      const start = leaf.block.start + leftEnd;
      const end = leaf.block.start + rightStart;
      const next = source.slice(0, start) + replacement + source.slice(end);
      const rendered = renderPage(next);
      if (rendered.text === expected && rendered.skeleton === page.skeleton) {
        return { status: "certain", source: next, range: { start, end }, replacement };
      }
    }
  }
  return uncertain(found ? "would_change_page" : "not_found");
}

/** Where the normalized `prefix` ends when it starts at `at` in `source` (spaces match runs). */
function endOfPrefix(source: string, at: number, prefix: string): number | undefined {
  if (prefix.length === 0) return at;
  const match = flexibleMatches(source.slice(at), prefix, 0)[0];
  return match && match.start === 0 ? at + match.end : undefined;
}

/** Where the normalized `suffix` starts when it ends at `end` in `source`. */
function startOfSuffix(source: string, end: number, suffix: string): number | undefined {
  if (suffix.length === 0) return end;
  const head = source.slice(0, end);
  const matches = flexibleMatches(head, suffix, 1_000);
  const last = matches.at(-1);
  return last && last.end === end ? last.start : undefined;
}
