// The Markdown planner of decision 0027. It works from the stored document alone: the `published`
// entry at the version's entrypoint and its stored rendering and block map, which the plan has
// already verified the installed renderer reproduces. The stored page is parsed once and indexed
// once; every operation is located in base coordinates, mapped to one range of its block's source
// by exact raw context, and all certain operations are applied together as one patch. The patch is
// verified once: the rendering the commit would store for the new source must equal the old page
// with exactly those text node changes, every element, attribute (heading IDs included) and
// comment the same, and the source bytes outside the approved ranges unchanged. If not, nothing is
// applied and every operation is listed, so the split the person confirmed never changes. Diagram
// sources always go to the list: their drawing is not something a text comparison can verify.
import { type DocumentRenderer, PLAN_LIMITS, type RenderedBlock } from "@portifact/contracts";
import { sha256Hex } from "./digest.ts";
import { occurrences, type TextEdit, validAfter } from "./edit.ts";
import {
  attribute,
  find,
  isElement,
  type P5Element,
  type P5Node,
  type ParsedHtml,
  parentOf,
  parseHtml,
} from "./html-dom.ts";
import { identityOf, linksAround } from "./identity.ts";
import { type Located, onlyChangedText, PageIndex } from "./locate.ts";
import {
  applyPatches,
  byOperation,
  onlyApprovedBytes,
  type PlannedFile,
  type PlannedListed,
  type PlannedPatch,
  withoutOverlaps,
} from "./planned.ts";
import { newWork, type Work } from "./work.ts";

/** How much raw context to look for around the change, widest first. */
const CONTEXTS = [24, 12, 6, 3, 1, 0];

/** Characters that start Markdown syntax inside a line. */
const MINIMAL = /[\\`*_[\]<>&|~!#^]/g;
/** Every ASCII punctuation character, which CommonMark lets a backslash escape. */
const FULL = /[!-/:-@[-`{-~]/g;

/** Renders of new sources one Markdown plan may make (minimal escapes, then full escapes). */
export const VERIFICATION_RENDERS = 2;

function closest(node: P5Node, test: (element: P5Node) => boolean): P5Node | null {
  for (let parent = parentOf(node); parent; parent = parentOf(parent)) {
    if (test(parent)) return parent;
  }
  return null;
}

const classes = (node: P5Node) =>
  isElement(node) ? (attribute(node, "class") ?? "").split(/\s+/) : [];

const isDiagram = (node: P5Node) =>
  classes(node).includes("pf-mermaid") || classes(node).includes("language-mermaid");

/**
 * The source range of a located change: the node's raw text around it, widest first, must occur
 * once in the node and once in the block's source, matched exactly (no whitespace is flexible).
 */
function mapToSource(
  source: string,
  block: RenderedBlock,
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

export interface MarkdownPlanInput {
  source: string;
  edits: readonly (TextEdit | null)[];
  /** The stored page (already verified as the renderer's output for `source`) and its blocks. */
  page: { html: string; blocks: readonly RenderedBlock[] };
  /** The title the stored page was rendered with. */
  title: string;
  pageUrl: string;
  renderer: DocumentRenderer;
  work?: Work;
}

interface Candidate extends PlannedPatch {
  located: Located;
  inCode: boolean;
}

export async function planMarkdown(input: MarkdownPlanInput): Promise<PlannedFile> {
  const { source, edits, pageUrl } = input;
  const work = input.work ?? newWork();
  const listed: PlannedListed[] = [];
  if (source.length > PLAN_LIMITS.documentUnits) {
    return {
      applied: [],
      listed: edits.map((edit, operation) => ({
        operation,
        reason: edit === null ? "not_text" : "too_large",
      })),
      work,
    };
  }
  const base = parseHtml(input.page.html, work);
  // The parser always adds a body.
  const body = find(base.document, "body") as P5Element;
  const index = new PageIndex(body, work);
  const candidates: Candidate[] = [];
  for (const [operation, edit] of edits.entries()) {
    if (edit === null) {
      listed.push({ operation, reason: "not_text" });
      continue;
    }
    if (operation >= PLAN_LIMITS.operationsMax) {
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
    const node = located.node;
    const destinations = linksAround(node, pageUrl);
    if (closest(node, isDiagram)) {
      listed.push({ operation, reason: "diagram", destinations });
      continue;
    }
    const blockElement = closest(
      node,
      (each) => isElement(each) && attribute(each, "data-pf-block") !== null,
    );
    const blockId =
      blockElement && isElement(blockElement) ? attribute(blockElement, "data-pf-block") : null;
    const block = input.page.blocks.find((each) => each.id === blockId);
    if (!block) {
      listed.push({ operation, reason: "spans_blocks", destinations });
      continue;
    }
    const range = mapToSource(source, block, node.value, located);
    if (!range) {
      listed.push({ operation, reason: "not_found", destinations });
      continue;
    }
    const context = PLAN_LIMITS.proofContextUnits;
    candidates.push({
      operation,
      ...range,
      replacement: located.inserted,
      destinations,
      located,
      inCode: closest(node, (each) => isElement(each) && each.tagName === "code") !== null,
      proof: {
        unit: "utf16",
        ...range,
        before: located.deleted,
        after: located.inserted,
        shownBefore: located.deleted,
        shownAfter: located.inserted,
        nodeLeft: node.value.slice(Math.max(0, located.start - context), located.start),
        nodeRight: node.value.slice(located.end, located.end + context),
        identity: identityOf(node, pageUrl),
      },
    });
  }

  const kept = withoutOverlaps(candidates, listed);
  if (kept.length === 0) return { applied: [], listed: byOperation(listed), work };

  for (const pattern of [MINIMAL, FULL]) {
    const written = kept.map((candidate) => {
      const replacement = candidate.inCode
        ? candidate.located.inserted
        : candidate.located.inserted.replace(pattern, "\\$&");
      return { ...candidate, replacement, proof: { ...candidate.proof, after: replacement } };
    });
    const next = applyPatches(source, written);
    if (!onlyApprovedBytes(source, next, written)) break;
    const files = input.renderer.stored("markdown", next, {
      title: input.title,
      sourceSha256: await sha256Hex(next),
    });
    work.renders++;
    const rebuilt: ParsedHtml = parseHtml((files[0] as { text: string }).text, work);
    if (
      onlyChangedText(
        base.document,
        rebuilt.document,
        written.map((item) => item.located),
      )
    ) {
      const applied = written.map(({ located: _l, inCode: _c, ...patch }) => patch);
      return {
        applied,
        listed: byOperation(listed),
        source: next,
        rendered: files.map((file) => ({ kind: file.kind, text: file.text })),
        work,
      };
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
  return { applied: [], listed: byOperation(listed), work };
}
