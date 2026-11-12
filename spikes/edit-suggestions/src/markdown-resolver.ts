// The Markdown planner of decision 0027. It works from the stored document alone (the `published`
// entry at the version's entrypoint; the plan checks separately that the installed renderer
// reproduces the stored rendering). The page is rendered once and indexed once per plan; every
// operation is located in base coordinates, mapped to one range of its block's source by exact raw
// context, and all certain operations are applied together as one patch. The patch is verified
// once: the rebuilt page must equal the old one with exactly those text node changes, every
// element, attribute (heading IDs included) and comment the same, and the source bytes outside the
// approved ranges unchanged. If not, nothing is applied and every operation goes to the change
// list, so the split the person confirmed never changes. Diagram sources always go to the list:
// their drawing is not something a text comparison can verify.

import type { AnchorNode } from "@portifact/anchors";
import { renderMarkdown, type SourceBlock } from "@portifact/render";
import { type Destination, destination } from "./display.ts";
import { type Resolution, type TextEdit, uncertain, validAfter } from "./edit.ts";
import { type NodeChange, onlyChanged, PageIndex } from "./locate.ts";
import { occurrences, pageText, parseFragment, textNodes } from "./page.ts";
import {
  byOperation,
  onlyApprovedBytes,
  PLAN_OPERATIONS_MAX,
  type PlannedFile,
  type PlannedListed,
  type PlannedPatch,
  withoutOverlaps,
} from "./planned.ts";
import { work } from "./work.ts";

/** How much raw context to look for around the change, widest first. */
const CONTEXTS = [24, 12, 6, 3, 1, 0];

/** Characters that start Markdown syntax inside a line. */
const MINIMAL = /[\\`*_[\]<>&|~!#^]/g;
/** Every ASCII punctuation character, which CommonMark lets a backslash escape. */
const FULL = /[!-/:-@[-`{-~]/g;

/** The base page and at most two patched pages, whatever the number of operations. */
export const RENDER_BUDGET = 3;
/** Largest Markdown source a plan takes, in UTF-16 units (2 MB of ASCII). */
export const MARKDOWN_LIMIT = 2_000_000;

export const DEFAULT_DOCUMENT_URL = "https://k7d2qm4xab.portifact.dev/";

export function renderPage(source: string): {
  main: HTMLElement;
  blocks: SourceBlock[];
  text: string;
} {
  work.renders++;
  const rendered = renderMarkdown(source);
  const main = parseFragment(rendered.html);
  return { main, blocks: rendered.blocks, text: pageText(main) };
}

/** The `data-pf-block` element closest around a node, and its entry in the block map. */
function blockOf(node: Node, blocks: SourceBlock[]): SourceBlock | undefined {
  let element = node.parentElement;
  while (element && !element.hasAttribute("data-pf-block")) element = element.parentElement;
  const id = element?.getAttribute("data-pf-block");
  return blocks.find((block) => block.id === id);
}

function within(node: Node, test: (element: Element) => boolean): boolean {
  for (let element = node.parentElement; element; element = element.parentElement) {
    if (test(element)) return true;
  }
  return false;
}

const isDiagram = (element: Element) =>
  element.classList.contains("pf-mermaid") || element.classList.contains("language-mermaid");

/** Every link around a node, with its effective destination (rule 7 of the second round). */
export function destinationsOf(node: Node, pageUrl = DEFAULT_DOCUMENT_URL): Destination[] {
  const found: Destination[] = [];
  for (let element = node.parentElement; element; element = element.parentElement) {
    const href = element.tagName.toLowerCase() === "a" ? element.getAttribute("href") : null;
    if (href !== null) found.push(destination(href, pageUrl));
  }
  return found;
}

/**
 * The target's identity: the elements from the text node up to the document, with their
 * attributes except the positional block number, and each link's effective destination.
 */
export function markdownIdentity(node: Node, pageUrl = DEFAULT_DOCUMENT_URL): string[] {
  const chain: string[] = [];
  for (let element = node.parentElement; element; element = element.parentElement) {
    const tag = element.tagName.toLowerCase();
    if (tag === "main") break;
    const attrs = Array.from(element.attributes)
      .filter((attr) => attr.name !== "data-pf-block")
      .map((attr) => `${attr.name}=${JSON.stringify(attr.value)}`)
      .sort();
    const href = tag === "a" ? element.getAttribute("href") : null;
    if (href !== null) attrs.push(`effective=${destination(href, pageUrl).effective}`);
    chain.push(`${tag}[${attrs.join(",")}]`);
  }
  return chain;
}

/**
 * The source range of a located change: the node's raw text around it, widest first, must occur
 * once in the node and once in the block's source, matched exactly (no whitespace is flexible).
 */
function mapToSource(
  source: string,
  block: SourceBlock,
  data: string,
  change: { start: number; end: number; deleted: string },
): { start: number; end: number } | null {
  const slice = source.slice(block.start, block.end);
  for (const width of CONTEXTS) {
    const left = data.slice(Math.max(0, change.start - width), change.start);
    const right = data.slice(change.end, change.end + width);
    const needle = left + change.deleted + right;
    if (needle.length === 0 || occurrences(data, needle).length !== 1) continue;
    const found = occurrences(slice, needle);
    if (found.length !== 1) continue;
    const start = block.start + (found[0] as number) + left.length;
    return { start, end: start + change.deleted.length };
  }
  return null;
}

export interface MarkdownPlanned extends PlannedFile {
  renders: number;
}

interface Candidate extends PlannedPatch {
  change: NodeChange;
  inserted: string;
  inCode: boolean;
}

export function planMarkdown(
  source: string,
  edits: readonly TextEdit[],
  pageUrl = DEFAULT_DOCUMENT_URL,
): MarkdownPlanned {
  const listed: PlannedListed[] = [];
  if (source.length > MARKDOWN_LIMIT) {
    return {
      applied: [],
      listed: edits.map((_, operation) => ({ operation, reason: "too_large" })),
      renders: 0,
    };
  }
  const base = renderPage(source);
  let renders = 1;
  const index = new PageIndex(base.main as unknown as AnchorNode);
  const nodes = textNodes(base.main);
  const candidates: Candidate[] = [];
  for (const [operation, edit] of edits.entries()) {
    if (operation >= PLAN_OPERATIONS_MAX) {
      listed.push({ operation, reason: "too_large" });
      continue;
    }
    if (!validAfter(edit)) {
      listed.push({ operation, reason: "invalid_after" });
      continue;
    }
    const result = index.locate(edit);
    if (!result.ok) {
      listed.push({ operation, reason: result.reason });
      continue;
    }
    const { located } = result;
    const text = located.text as unknown as Text;
    const destinations = destinationsOf(text, pageUrl);
    if (within(text, isDiagram)) {
      listed.push({ operation, reason: "diagram", destinations });
      continue;
    }
    const block = blockOf(text, base.blocks);
    if (!block) {
      listed.push({ operation, reason: "spans_blocks", destinations });
      continue;
    }
    const range = mapToSource(source, block, text.data, located);
    if (!range) {
      listed.push({ operation, reason: "not_found", destinations });
      continue;
    }
    candidates.push({
      operation,
      ...range,
      replacement: located.inserted,
      destinations,
      inserted: located.inserted,
      inCode: within(text, (element) => element.tagName.toLowerCase() === "code"),
      change: {
        node: nodes.indexOf(text),
        start: located.start,
        end: located.end,
        deleted: located.deleted,
        inserted: located.inserted,
      },
      proof: {
        unit: "utf16",
        ...range,
        before: located.deleted,
        after: located.inserted,
        shownBefore: located.deleted,
        shownAfter: located.inserted,
        nodeLeft: text.data.slice(Math.max(0, located.start - 32), located.start),
        nodeRight: text.data.slice(located.end, located.end + 32),
        identity: markdownIdentity(text, pageUrl),
      },
    });
  }

  const kept = withoutOverlaps(candidates, listed);
  if (kept.length === 0) return { applied: [], listed: byOperation(listed), renders };

  for (const pattern of [MINIMAL, FULL]) {
    if (renders >= RENDER_BUDGET) break;
    const written = kept.map((candidate) => {
      const replacement = candidate.inCode
        ? candidate.inserted
        : candidate.inserted.replace(pattern, "\\$&");
      return { ...candidate, replacement, proof: { ...candidate.proof, after: replacement } };
    });
    let next = source;
    // Base coordinates: apply from the end so earlier ranges keep their offsets.
    for (const item of [...written].sort((a, b) => b.start - a.start)) {
      next = next.slice(0, item.start) + item.replacement + next.slice(item.end);
    }
    const rebuilt = renderPage(next);
    renders++;
    const sameBytes = onlyApprovedBytes(source, next, written);
    if (
      sameBytes &&
      onlyChanged(
        base.main,
        rebuilt.main,
        written.map((item) => item.change),
      )
    ) {
      const applied = written.map(({ change: _c, inserted: _i, inCode: _k, ...patch }) => patch);
      return { applied, listed: byOperation(listed), source: next, renders };
    }
  }
  for (const candidate of kept) {
    listed.push({
      operation: candidate.operation,
      reason: "would_change_page",
      destinations: candidate.destinations,
      proof: candidate.proof,
    });
  }
  return { applied: [], listed: byOperation(listed), renders };
}

/** One operation as a plan of its own, in the shape the single-edit tests use. */
export function resolveMarkdownEdit(source: string, edit: TextEdit): Resolution {
  const planned = planMarkdown(source, [edit]);
  const applied = planned.applied[0];
  if (!applied || planned.source === undefined) {
    return uncertain(planned.listed[0]?.reason ?? "would_change_page");
  }
  return {
    status: "certain",
    source: planned.source,
    range: { start: applied.start, end: applied.end },
    replacement: applied.replacement,
  };
}
