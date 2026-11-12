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
import {
  type DocumentRenderer,
  PLAN_LIMITS,
  type Proof,
  type RenderedBlock,
} from "@portifact/contracts";
import { utf8Length } from "./digest.ts";
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
  textNodesOf,
} from "./html-dom.ts";
import { IdentityCache, linkContext, linksAroundAll } from "./identity.ts";
import { type Located, onlyChangedText, PageIndex } from "./locate.ts";
import {
  applyPatches,
  byOperation,
  listedPatch,
  onlyApprovedBytes,
  PENDING_SHA256,
  PendingIdentities,
  type PlannedFile,
  type PlannedListed,
  type PlannedPatch,
  settled,
  unplaced,
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

/**
 * An operation located on the page and found in its block's source by raw context: a search
 * result, not yet a mapping. It becomes a proof (a place in the file) only once the rendered page
 * shows it is the selected text: by the verification render when it applies, else by the witness
 * render (`witnessed`).
 */
interface Candidate {
  operation: number;
  /** Where the raw-context search found the changed text in the source. */
  found: { start: number; end: number };
  located: Located;
  destinations: PlannedPatch["destinations"];
  inCode: boolean;
}

const MARKER_BASE = 0xe000;
const MARKERS = /[-]/g;
/** Candidates one witness render can mark: two private-use markers each. */
const WITNESS_MAX = 3_200;

export function planMarkdown(input: MarkdownPlanInput): PlannedFile {
  const { source, edits, pageUrl } = input;
  const work = input.work ?? newWork();
  const listed: PlannedListed[] = [];
  if (utf8Length(source) > PLAN_LIMITS.documentBytes) {
    return {
      applied: [],
      listed: edits.map((edit, operation) =>
        unplaced(operation, edit === null ? "not_text" : "too_large"),
      ),
      work,
      settle: settled,
    };
  }
  const base = parseHtml(input.page.html, work);
  // The parser always adds a body.
  const body = find(base.document, "body") as P5Element;
  const links = linkContext(base.document, pageUrl, "rendered");
  const index = new PageIndex(body, work);
  const identities = new PendingIdentities();
  const context = PLAN_LIMITS.proofContextUnits;
  const proofOf = (candidate: Candidate, after: string): Proof => {
    const { located } = candidate;
    const node = located.node;
    return identities.track(
      {
        unit: "utf16",
        ...candidate.found,
        before: located.deleted,
        after,
        shownBefore: located.deleted,
        shownAfter: located.inserted,
        nodeLeft: node.value.slice(Math.max(0, located.start - context), located.start),
        nodeRight: node.value.slice(located.end, located.end + context),
        identity: [],
      },
      node,
    );
  };
  const candidates: Candidate[] = [];
  for (const [operation, edit] of edits.entries()) {
    if (edit === null) {
      listed.push(unplaced(operation, "not_text"));
      continue;
    }
    if (operation >= PLAN_LIMITS.operationsMax) {
      listed.push(unplaced(operation, "too_large"));
      continue;
    }
    const result = index.locate(edit);
    if (!result.ok) {
      const known = result.covered !== null;
      const destinations = known ? linksAroundAll(result.covered ?? [], links) : [];
      listed.push({ operation, reason: result.reason, destinations, destinationsKnown: known });
      continue;
    }
    const { located } = result;
    const node = located.node;
    const destinations = linksAroundAll(result.covered, links);
    const unmapped = (reason: PlannedListed["reason"]) =>
      listed.push({ operation, reason, destinations, destinationsKnown: true });
    if (!validAfter(edit)) {
      unmapped("invalid_after");
      continue;
    }
    if (closest(node, isDiagram)) {
      unmapped("diagram");
      continue;
    }
    const blockElement = closest(
      node,
      (each) => isElement(each) && attribute(each, "data-pf-block") !== null,
    );
    const blockId = blockElement ? attribute(blockElement as P5Element, "data-pf-block") : null;
    const block = input.page.blocks.find((each) => each.id === blockId);
    if (!block) {
      unmapped("spans_blocks");
      continue;
    }
    const found = mapToSource(source, block, node.value, located);
    if (!found) {
      unmapped("not_found");
      continue;
    }
    const inCode = closest(node, (each) => isElement(each) && each.tagName === "code") !== null;
    candidates.push({ operation, found, located, destinations, inCode });
  }

  /**
   * The candidates the rendered page proves: the source with two distinct private-use markers
   * around each candidate's range, rendered once, must show them in the selected text node at the
   * selected offsets, the node otherwise unchanged. A range in a link destination, a title or an
   * image's address shows no marker in the text, so it proves nothing.
   */
  const witnessed = (items: readonly Candidate[]): Set<Candidate> => {
    const proven = new Set<Candidate>();
    if (items.length === 0 || items.length > WITNESS_MAX || /[-]/.test(source)) {
      return proven;
    }
    const start = (i: number) => String.fromCodePoint(MARKER_BASE + 2 * i);
    const end = (i: number) => String.fromCodePoint(MARKER_BASE + 2 * i + 1);
    // From the end of the file; at one position the end marker goes in first, so it follows.
    const marks = items
      .flatMap((candidate, i) => [
        { at: candidate.found.end, mark: end(i) },
        { at: candidate.found.start, mark: start(i) },
      ])
      .sort((a, b) => b.at - a.at);
    let marked = source;
    for (const { at, mark } of marks) marked = marked.slice(0, at) + mark + marked.slice(at);
    const files = input.renderer.stored("markdown", marked, {
      title: input.title,
      sourceSha256: PENDING_SHA256,
    });
    work.renders++;
    const page = parseHtml((files[0] as { text: string }).text, work).document;
    const markedTexts = textNodesOf(find(page, "body") as P5Element);
    const baseTexts = textNodesOf(body);
    if (markedTexts.length !== baseTexts.length) return proven;
    items.forEach((candidate, i) => {
      const at = baseTexts.indexOf(candidate.located.node);
      const data = (markedTexts[at] as { value: string }).value;
      const own = data.replace(MARKERS, (mark) =>
        mark === start(i) || mark === end(i) ? mark : "",
      );
      const from = own.indexOf(start(i));
      const to = own.indexOf(end(i)) - 1;
      const plain = own.replace(start(i), "").replace(end(i), "");
      const { located } = candidate;
      if (
        plain === located.node.value &&
        from === located.start &&
        to === located.end &&
        from >= 0
      ) {
        proven.add(candidate);
      }
    });
    return proven;
  };

  const settleOver = (applied: PlannedPatch[]) =>
    identities.settler(
      () => [...applied, ...listed],
      () => new IdentityCache(links, work),
    );
  const clash = (a: Candidate, b: Candidate) =>
    a !== b && a.found.start <= b.found.end && b.found.start <= a.found.end;
  const kept = candidates.filter((a) => !candidates.some((b) => clash(a, b)));
  const toWitness: { candidate: Candidate; reason: PlannedListed["reason"] }[] = candidates
    .filter((candidate) => !kept.includes(candidate))
    .map((candidate) => ({ candidate, reason: "overlap" as const }));
  const finish = (
    applied: PlannedPatch[],
    extra?: { source: string; rendered: PlannedFile["rendered"] },
  ) => {
    const proven = witnessed(toWitness.map((each) => each.candidate));
    for (const { candidate, reason } of toWitness) {
      const { operation, destinations } = candidate;
      listed.push(
        proven.has(candidate)
          ? listedPatch(
              {
                ...candidate,
                ...candidate.found,
                replacement: "",
                proof: proofOf(candidate, candidate.located.inserted),
              },
              reason,
            )
          : { operation, reason, destinations, destinationsKnown: true },
      );
    }
    const result = { applied, listed: byOperation(listed), work, settle: settleOver(applied) };
    return extra ? { ...result, source: extra.source, rendered: extra.rendered ?? [] } : result;
  };
  if (kept.length === 0) return finish([]);

  for (const pattern of [MINIMAL, FULL]) {
    const written = kept.map((candidate) => {
      const replacement = candidate.inCode
        ? candidate.located.inserted
        : candidate.located.inserted.replace(pattern, "\\$&");
      return { candidate, replacement };
    });
    const next = applyPatches(
      source,
      written.map(({ candidate, replacement }) => ({ ...candidate.found, replacement })),
    );
    // A result over the size limit is listed, never offered: confirmation would refuse it.
    if (utf8Length(next) > PLAN_LIMITS.documentBytes) {
      for (const candidate of kept) toWitness.push({ candidate, reason: "too_large" });
      return finish([]);
    }
    // The block map records the source's hash; it is filled in once sizes are checked.
    const files = input.renderer.stored("markdown", next, {
      title: input.title,
      sourceSha256: PENDING_SHA256,
    });
    work.renders++;
    const rebuilt: ParsedHtml = parseHtml((files[0] as { text: string }).text, work);
    const patches = written.map(({ candidate, replacement }) => ({
      ...candidate.found,
      replacement,
    }));
    if (
      onlyApprovedBytes(source, next, patches) &&
      onlyChangedText(
        base.document,
        rebuilt.document,
        kept.map((candidate) => candidate.located),
      )
    ) {
      // The verification render proved every kept candidate is the selected text.
      const applied = written.map(({ candidate, replacement }) => ({
        operation: candidate.operation,
        ...candidate.found,
        replacement,
        destinations: candidate.destinations,
        proof: proofOf(candidate, replacement),
      }));
      return finish(applied, {
        source: next,
        rendered: files.map((file) => ({ kind: file.kind, text: file.text })),
      });
    }
  }
  for (const candidate of kept) toWitness.push({ candidate, reason: "would_change_page" });
  return finish([]);
}
