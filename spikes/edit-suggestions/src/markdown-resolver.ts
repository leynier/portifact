// The Markdown planner of decision 0027. It works from the stored document alone (the `published`
// entry at the version's entrypoint, rendered with the renderer version the plan is bound to):
// every text operation is located in the rendered page in base coordinates, mapped to one range
// of its block's source, and all certain operations are applied together as one patch. The patch
// is verified once: the rebuilt page must equal the old one with exactly those text node changes,
// every element and attribute (heading IDs included) and every other character the same. If it
// is not, nothing is applied and every operation goes to the change list, so the confirmed split
// between applied and listed never changes after the person saw it.
import { renderMarkdown, type SourceBlock } from "@portifact/render";
import {
  type Resolution,
  type TextEdit,
  type UncertainReason,
  uncertain,
  validAfter,
} from "./edit.ts";
import { locateChange, type NodeChange, onlyChanged, overlaps } from "./locate.ts";
import { occurrences, pageText, parseFragment } from "./page.ts";

/** How much raw context to look for around the change, widest first. */
const CONTEXTS = [24, 12, 6, 3, 1, 0];

/** Characters that start Markdown syntax inside a line. */
const MINIMAL = /[\\`*_[\]<>&|~!#^]/g;
/** Every ASCII punctuation character, which CommonMark lets a backslash escape. */
const FULL = /[!-/:-@[-`{-~]/g;

/**
 * Renders a plan may spend: the base page and at most two patched pages (the readable escaping,
 * then the full one). The planner never renders per operation or per candidate.
 */
export const RENDER_BUDGET = 3;

export interface SourcePatch {
  /** Index of the operation in the plan. */
  operation: number;
  start: number;
  end: number;
  /** The inserted text as the reviewer wrote it. */
  inserted: string;
  /** Inside a code span or block, where backslashes are literal, so it is written raw. */
  inCode: boolean;
}

export interface AppliedPatch {
  patch: SourcePatch;
  replacement: string;
  change: NodeChange;
  destinations: string[];
}

export interface Planned {
  /** Patches that are applied; empty when nothing applies. */
  applied: AppliedPatch[];
  listed: { operation: number; reason: UncertainReason }[];
  /** The new source, when anything applied. */
  source?: string;
  renders: number;
}

export function renderPage(source: string): {
  main: HTMLElement;
  blocks: SourceBlock[];
  text: string;
} {
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

function within(node: Node, tag: string): boolean {
  for (let element = node.parentElement; element; element = element.parentElement) {
    if (element.tagName.toLowerCase() === tag) return true;
  }
  return false;
}

/** The `href` of every link around a node: the destination the person must see (rule 3). */
export function destinationsOf(node: Node): string[] {
  const found: string[] = [];
  for (let element = node.parentElement; element; element = element.parentElement) {
    const href = element.tagName.toLowerCase() === "a" ? element.getAttribute("href") : null;
    if (href !== null) found.push(href);
  }
  return found;
}

/**
 * The source range of a located change: the node's raw text around it, widest first, must occur
 * once in the node and once in the block's source, matched exactly (no whitespace is flexible).
 */
function mapToSource(
  source: string,
  block: SourceBlock,
  data: string,
  change: NodeChange,
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

const sorted = (items: Planned["listed"]) => [...items].sort((a, b) => a.operation - b.operation);

export function planMarkdown(source: string, edits: readonly TextEdit[]): Planned {
  const listed: Planned["listed"] = [];
  const base = renderPage(source);
  let renders = 1;
  const candidates: Omit<AppliedPatch, "replacement">[] = [];
  for (const [operation, edit] of edits.entries()) {
    if (!validAfter(edit)) {
      listed.push({ operation, reason: "invalid_after" });
      continue;
    }
    const located = locateChange(base.main, edit);
    if (!located.ok) {
      listed.push({ operation, reason: located.reason });
      continue;
    }
    const block = blockOf(located.text, base.blocks);
    if (!block) {
      listed.push({ operation, reason: "spans_blocks" });
      continue;
    }
    const range = mapToSource(source, block, located.text.data, located.change);
    if (!range) {
      listed.push({ operation, reason: "not_found" });
      continue;
    }
    candidates.push({
      patch: {
        operation,
        ...range,
        inserted: located.change.inserted,
        inCode: within(located.text, "code"),
      },
      change: located.change,
      destinations: destinationsOf(located.text),
    });
  }

  // Operations are in base coordinates; two that touch the same text have no defined order, so
  // neither applies.
  const clashing = new Set<number>();
  for (const a of candidates) {
    for (const b of candidates) {
      const sameSource = a.patch.start <= b.patch.end && b.patch.start <= a.patch.end;
      if (a !== b && (overlaps(a.change, b.change) || sameSource)) clashing.add(a.patch.operation);
    }
  }
  const kept = candidates.filter((candidate) => !clashing.has(candidate.patch.operation));
  for (const operation of clashing) listed.push({ operation, reason: "overlap" });
  if (kept.length === 0) return { applied: [], listed: sorted(listed), renders };

  for (const pattern of [MINIMAL, FULL]) {
    if (renders >= RENDER_BUDGET) break;
    const written = kept.map((candidate) => ({
      ...candidate,
      replacement: candidate.patch.inCode
        ? candidate.patch.inserted
        : candidate.patch.inserted.replace(pattern, "\\$&"),
    }));
    let next = source;
    // Base coordinates: apply from the end so earlier ranges keep their offsets.
    for (const item of [...written].sort((a, b) => b.patch.start - a.patch.start)) {
      next = next.slice(0, item.patch.start) + item.replacement + next.slice(item.patch.end);
    }
    const rebuilt = renderPage(next);
    renders++;
    const changes = written.map((item) => item.change);
    if (onlyChanged(base.main, rebuilt.main, changes)) {
      return { applied: written, listed: sorted(listed), source: next, renders };
    }
  }
  for (const candidate of kept) {
    listed.push({ operation: candidate.patch.operation, reason: "would_change_page" });
  }
  return { applied: [], listed: sorted(listed), renders };
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
    range: { start: applied.patch.start, end: applied.patch.end },
    replacement: applied.replacement,
  };
}
