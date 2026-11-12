// The patch plan of decision 0027 ("Automatic application: the patch plan"). The server builds it
// from the stored file alone. For a document it first verifies the baseline: the installed
// renderer must reproduce the stored rendering and block map byte for byte from the stored file
// with the stored options, or nothing applies (`renderer_changed`). The plan holds one canonical
// envelope per operation; the lines the person sees are rendered from those envelopes and the
// change list exports them unchanged. It commits to the complete output: the new file's hash and
// size and, for a document, the new rendering's and block map's hashes and the options. Its digest
// is the hash of the canonical JSON of all of that, and confirming recomputes it from the plan's
// contents and re-derives the output from the bytes to be written, so a plan whose contents or
// bytes changed after the person saw it is refused.
import {
  type DocumentRenderer,
  type EditOperation,
  type Envelope,
  type FileKind,
  PLAN_LIMITS,
  type Plan,
  type PlanBinding,
  type PlanContents,
  type PlanOutput,
  type Proof,
  type Provenance,
  type RenderedBlock,
  type StoredRenderOptions,
} from "@portifact/contracts";
import { canonicalJson, sha256Hex, utf8Length } from "./digest.ts";
import { textEditOf } from "./edit.ts";
import {
  contextOf,
  envelopeBytes,
  envelopeOperation,
  locationOf,
  renderEnvelope,
} from "./envelope.ts";
import { planHtml } from "./html-planner.ts";
import { planMarkdown } from "./markdown-planner.ts";
import type { PlannedFile, PlannedListed, PlannedPatch } from "./planned.ts";
import { buildPreview } from "./preview.ts";
import { planText } from "./text-planner.ts";
import { newWork, type Work } from "./work.ts";

/** The stored rendering of a document version and the options it was made with. */
export interface StoredRendering {
  html: string;
  /** The stored block map's text, for Markdown; null for text documents. */
  blockMap: string | null;
  options: StoredRenderOptions;
}

export interface PlanInput {
  binding: PlanBinding;
  provenance: Provenance;
  kind: FileKind;
  /** The stored file, decoded. */
  source: string;
  operations: readonly EditOperation[];
  /** Required for documents: the stored rendering the plan must reproduce. */
  stored?: StoredRendering;
  /** The URL the page is served at on the artifact origin, for link destinations. */
  pageUrl: string;
  /** The installed renderer; a document plan accepts only its label as the binding's renderer. */
  renderer: DocumentRenderer;
  work?: Work;
}

/** A plan with what the server keeps for itself: the bytes and the proofs, never exported. */
export interface BuiltPlan extends Plan {
  /** The new file, when anything applies; checked against `output` at confirmation. */
  newSource?: string;
  /** Proof data per envelope, applied then listed (null when an operation was never located). */
  proofs: (Proof | null)[];
  work: Work;
}

/** Thrown when an envelope or the plan would be over its size limit, before anything is hashed. */
export class PlanTooLargeError extends Error {
  constructor(what: "envelope" | "plan") {
    super(`The ${what} is over its limit`);
    this.name = "PlanTooLargeError";
  }
}

const textBytes = (text: string) => new TextEncoder().encode(text);

async function hashOfText(text: string): Promise<string> {
  return sha256Hex(text);
}

/** The output a new file commits to: its hash and size and, for a document, its stored files. */
async function outputOf(
  kind: FileKind,
  source: string,
  options: StoredRenderOptions | null,
  renderer: DocumentRenderer,
  rendered?: readonly { kind: string; text: string }[],
): Promise<PlanOutput> {
  const sha256 = await hashOfText(source);
  const size = textBytes(source).length;
  if (kind === "html" || options === null) {
    return { sha256, size, renderedSha256: null, blockMapSha256: null, options: null };
  }
  const files =
    rendered ?? renderer.stored(kind, source, { title: options.title, sourceSha256: sha256 });
  const page = files.find((file) => file.kind === "rendered");
  const blockMap = files.find((file) => file.kind === "block_map");
  return {
    sha256,
    size,
    renderedSha256: page ? await hashOfText(page.text) : null,
    blockMapSha256: blockMap ? await hashOfText(blockMap.text) : null,
    options: { title: options.title },
  };
}

/** The stored block map's blocks, or null when it cannot be read. */
function blocksOf(blockMap: string | null): RenderedBlock[] | null {
  try {
    const parsed = JSON.parse(blockMap ?? "") as { blocks?: unknown };
    return Array.isArray(parsed.blocks) ? (parsed.blocks as RenderedBlock[]) : null;
  } catch {
    return null;
  }
}

/**
 * Whether the installed renderer reproduces the stored rendering (a verified baseline, not a
 * label): the binding names this build's renderer, and rendering the stored file with the stored
 * options gives the stored page and block map byte for byte.
 */
function baselineHolds(input: PlanInput, work: Work): boolean {
  const { stored, kind } = input;
  if (input.binding.renderer !== input.renderer.label || !stored || kind === "html") return false;
  const again = input.renderer.stored(kind, input.source, {
    title: stored.options.title,
    sourceSha256: input.binding.fileSha256,
  });
  work.renders++;
  const blockMap = again.find((file) => file.kind === "block_map")?.text ?? null;
  return again[0]?.text === stored.html && blockMap === stored.blockMap;
}

async function planFile(input: PlanInput, work: Work): Promise<PlannedFile> {
  const edits = input.operations.map(textEditOf);
  if (input.kind === "html")
    return planHtml({ html: input.source, edits, pageUrl: input.pageUrl, work });
  const stored = input.stored;
  const blocks = input.kind === "markdown" ? blocksOf(stored?.blockMap ?? null) : [];
  if (!stored || blocks === null || !baselineHolds(input, work)) {
    return {
      applied: [],
      listed: edits.map((edit, operation) => ({
        operation,
        reason: edit === null ? "not_text" : "renderer_changed",
      })),
      work,
    };
  }
  if (input.kind === "markdown") {
    return planMarkdown({
      source: input.source,
      edits,
      page: { html: stored.html, blocks },
      title: stored.options.title,
      pageUrl: input.pageUrl,
      renderer: input.renderer,
      work,
    });
  }
  return planText({
    source: input.source,
    edits,
    title: stored.options.title,
    renderer: input.renderer,
    work,
  });
}

/** The hash of a plan's contents: the canonical JSON of everything but the digest. */
export async function planDigest(contents: PlanContents): Promise<string> {
  const { format, binding, kind, applied, listed, output, lines } = contents;
  return sha256Hex(canonicalJson({ format, binding, kind, applied, listed, output, lines }));
}

export async function buildPlan(input: PlanInput): Promise<BuiltPlan> {
  const work = input.work ?? newWork();
  const { source, binding } = input;
  const planned = await planFile(input, work);

  const envelope = (status: Envelope["status"], item: PlannedPatch | PlannedListed): Envelope => {
    const operation = input.operations[item.operation] as EditOperation;
    let location: Envelope["location"] = { unresolved: true };
    let context: Envelope["context"] = null;
    if (item.proof) {
      location = locationOf(source, item.proof.start, item.proof.end);
      context = contextOf(source, item.proof.start, item.proof.end);
    } else {
      // A listed text operation the planner did not locate: its before, when it occurs once.
      const before = textEditOf(operation)?.before ?? "";
      const first = before ? source.indexOf(before) : -1;
      if (first >= 0 && source.indexOf(before, first + 1) < 0) {
        location = locationOf(source, first, first + before.length);
        context = contextOf(source, first, first + before.length);
      }
    }
    return {
      format: 1,
      status,
      reason: "reason" in item ? item.reason : null,
      operation: envelopeOperation(operation),
      binding,
      provenance: input.provenance,
      location,
      context,
      destinations: item.destinations ?? [],
    };
  };
  const applied = planned.applied.map((item) => envelope("applied", item));
  const listed = planned.listed.map((item) => envelope("listed", item));
  for (const each of [...applied, ...listed]) {
    if (envelopeBytes(each) > PLAN_LIMITS.envelopeBytes) throw new PlanTooLargeError("envelope");
  }
  const options = input.kind === "html" ? null : (input.stored?.options ?? null);
  const output =
    planned.source === undefined
      ? null
      : await outputOf(input.kind, planned.source, options, input.renderer, planned.rendered);
  const lines = [...applied, ...listed].flatMap(renderEnvelope);
  const contents: PlanContents = {
    format: 1,
    binding,
    kind: input.kind,
    applied,
    listed,
    output,
    lines,
  };
  if (utf8Length(JSON.stringify(contents)) > PLAN_LIMITS.planBytes) {
    throw new PlanTooLargeError("plan");
  }
  return {
    ...contents,
    digest: await planDigest(contents),
    proofs: [
      ...planned.applied.map((item) => item.proof),
      ...planned.listed.map((item) => item.proof ?? null),
    ],
    work,
    ...(planned.source === undefined ? {} : { newSource: planned.source }),
  };
}

export type Confirmation = "confirmed" | "plan_changed";

/**
 * The confirmation check at acceptance: the digest the person confirmed must be the digest of
 * this plan's contents, recomputed here; the binding must still be the artifact's current state;
 * and the bytes to be written must derive the output the plan committed to, rendering and block
 * map included.
 */
export async function confirmPlan(input: {
  plan: PlanContents & { digest: string };
  confirmedDigest: string;
  current: PlanBinding;
  newSource: string | undefined;
  renderer: DocumentRenderer;
}): Promise<Confirmation> {
  const { plan, confirmedDigest, newSource } = input;
  if (plan.digest !== confirmedDigest || (await planDigest(plan)) !== confirmedDigest) {
    return "plan_changed";
  }
  if (canonicalJson(plan.binding) !== canonicalJson(input.current)) return "plan_changed";
  if (plan.output === null) return newSource === undefined ? "confirmed" : "plan_changed";
  if (newSource === undefined) return "plan_changed";
  const derived = await outputOf(plan.kind, newSource, plan.output.options, input.renderer);
  return canonicalJson(derived) === canonicalJson(plan.output) ? "confirmed" : "plan_changed";
}

/** Change-list capacity is all or nothing: an acceptance adds every listed item or none. */
export function admitItems(open: number, adding: number, cap: number): boolean {
  return open + adding <= cap;
}

/**
 * What the preview shows for a plan: the built preview of the new file when anything applies, or
 * an explicit unavailable state with the reasons, never the unchanged page as if it were changed.
 */
export function previewOfPlan(
  plan: BuiltPlan,
  renderer: DocumentRenderer,
): { state: "ready"; document: string } | { state: "unavailable"; reasons: string[] } {
  if (plan.newSource === undefined) {
    return { state: "unavailable", reasons: plan.listed.map((item) => item.reason ?? "unknown") };
  }
  return { state: "ready", document: buildPreview(plan.kind, plan.newSource, renderer, plan.work) };
}
