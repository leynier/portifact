// The patch plan of decision 0027 ("Automatic application: the patch plan"). The server builds it
// from the stored file alone. A document over its size limit is refused before anything is
// rendered. For a document within it, the plan first verifies the baseline: the installed renderer
// must reproduce the stored rendering and block map byte for byte from the stored file with the
// stored options, or nothing applies (`renderer_changed`). The plan holds one canonical envelope
// per operation; the lines are rendered from those envelopes and the change list stores them
// unchanged. An envelope places an operation in the file only when the planner proved it from the
// selected text through its source map. The plan commits to the complete output: the new file's
// hash and size and, for a document, the new rendering's and block map's hashes and the options.
// Every size is checked before anything is hashed. The digest is the hash of the canonical JSON
// of the contents, and confirming recomputes it and re-derives the output from the bytes to be
// written, so a plan whose contents or bytes changed after the person saw it is refused.
import {
  type DocumentRenderer,
  type EditOperation,
  type Envelope,
  type EnvelopePeople,
  type FileKind,
  PLAN_LIMITS,
  type Plan,
  type PlanBinding,
  type PlanContents,
  type PlanOutput,
  type Proof,
  type RenderedBlock,
  type StoredRenderOptions,
} from "@portifact/contracts";
import { canonicalJson, sha256Hex, utf8Length } from "./digest.ts";
import { shortenDestination } from "./display.ts";
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
import {
  PENDING_SHA256,
  type PlannedFile,
  type PlannedListed,
  type PlannedPatch,
  unplaced,
} from "./planned.ts";
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
  /** The binding without its route: the plan takes the route the operations target. */
  binding: Omit<PlanBinding, "route">;
  /** Whether the suggester and the accepting person still have accounts (never their names). */
  people: EnvelopePeople;
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
  /**
   * Proof data per envelope, applied then listed: null when an operation was never mapped, or
   * when its proof would be over `PLAN_LIMITS.proofBytes` (the item is then closed by hand).
   */
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

const limitOf = (kind: FileKind) =>
  kind === "html" ? PLAN_LIMITS.htmlBytes : PLAN_LIMITS.documentBytes;

/** The output of a new file, its hashes still pending: sizes can be checked before hashing. */
function pendingOutput(
  kind: FileKind,
  source: string,
  options: StoredRenderOptions | null,
): PlanOutput {
  const size = utf8Length(source);
  if (kind === "html" || options === null) {
    return {
      sha256: PENDING_SHA256,
      size,
      renderedSha256: null,
      blockMapSha256: null,
      options: null,
    };
  }
  return {
    sha256: PENDING_SHA256,
    size,
    renderedSha256: PENDING_SHA256,
    blockMapSha256: kind === "markdown" ? PENDING_SHA256 : null,
    options: { title: options.title },
  };
}

/**
 * The output of a new file: its hash and size and, for a document, the hashes of the files the
 * commit will store for it. `rendered` are the planner's renderings, whose block map still holds
 * `PENDING_SHA256` where the file's hash goes.
 */
async function outputOf(
  kind: FileKind,
  source: string,
  options: StoredRenderOptions | null,
  renderer: DocumentRenderer,
  rendered?: readonly { kind: string; text: string }[],
): Promise<PlanOutput> {
  const output = pendingOutput(kind, source, options);
  const sha256 = await sha256Hex(source);
  if (output.options === null || kind === "html") return { ...output, sha256 };
  const pending = `"sourceSha256":"${PENDING_SHA256}"`;
  const files =
    rendered?.map((file) =>
      file.kind === "block_map"
        ? { ...file, text: file.text.replace(pending, `"sourceSha256":"${sha256}"`) }
        : file,
    ) ?? renderer.stored(kind, source, { title: output.options.title, sourceSha256: sha256 });
  const page = files.find((file) => file.kind === "rendered") as { text: string };
  const blockMap = files.find((file) => file.kind === "block_map");
  return {
    ...output,
    sha256,
    renderedSha256: await sha256Hex(page.text),
    blockMapSha256: blockMap ? await sha256Hex(blockMap.text) : null,
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
 * label): the binding names this renderer, and rendering the stored file with the stored options
 * gives the stored page and block map byte for byte.
 */
function baselineHolds(input: PlanInput, stored: StoredRendering, work: Work): boolean {
  if (input.binding.renderer !== input.renderer.label) return false;
  const again = input.renderer.stored(input.kind as "markdown" | "text", input.source, {
    title: stored.options.title,
    sourceSha256: input.binding.fileSha256,
  });
  work.renders++;
  const blockMap = again.find((file) => file.kind === "block_map")?.text ?? null;
  return (again[0] as { text: string }).text === stored.html && blockMap === stored.blockMap;
}

function planFile(input: PlanInput, work: Work): PlannedFile {
  const edits = input.operations.map(textEditOf);
  const all = (reason: PlannedListed["reason"]): PlannedFile => ({
    applied: [],
    listed: edits.map((edit, operation) =>
      unplaced(operation, edit === null ? "not_text" : reason),
    ),
    work,
  });
  if (utf8Length(input.source) > limitOf(input.kind)) return all("too_large");
  if (input.kind === "html") {
    return planHtml({ html: input.source, edits, pageUrl: input.pageUrl, work });
  }
  const stored = input.stored;
  const blocks = input.kind === "markdown" ? blocksOf(stored?.blockMap ?? null) : [];
  if (!stored || blocks === null || !baselineHolds(input, stored, work)) {
    return all("renderer_changed");
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

const contentsBytes = (contents: PlanContents) => utf8Length(JSON.stringify(contents));

/** An envelope within its limit: its destinations shortened (marked) when they alone exceed it. */
function bounded(envelope: Envelope): Envelope {
  if (envelopeBytes(envelope) <= PLAN_LIMITS.envelopeBytes) return envelope;
  const shortened = {
    ...envelope,
    destinations: envelope.destinations.map((link) =>
      shortenDestination(link, PLAN_LIMITS.destinationUnits),
    ),
  };
  if (envelopeBytes(shortened) > PLAN_LIMITS.envelopeBytes) throw new PlanTooLargeError("envelope");
  return shortened;
}

/** A proof that fits its column, or null: an item whose proof would not fit is closed by hand. */
const storable = (proof: Proof | undefined): Proof | null =>
  proof && utf8Length(JSON.stringify(proof)) <= PLAN_LIMITS.proofBytes ? proof : null;

export async function buildPlan(input: PlanInput): Promise<BuiltPlan> {
  const work = input.work ?? newWork();
  const { source } = input;
  const binding: PlanBinding = {
    ...input.binding,
    route: input.operations[0]?.target.route ?? null,
  };
  const planned = planFile(input, work);

  const envelope = (status: Envelope["status"], item: PlannedPatch | PlannedListed): Envelope => {
    const operation = input.operations[item.operation] as EditOperation;
    // Only a proof places an operation in the file: it was mapped from the selected text.
    const proof = item.proof;
    return bounded({
      format: 1,
      status,
      reason: "reason" in item ? item.reason : null,
      operation: envelopeOperation(operation),
      binding,
      people: input.people,
      location: proof ? locationOf(source, proof.start, proof.end) : { unresolved: true },
      context: proof ? contextOf(source, proof.start, proof.end) : null,
      destinations: item.destinations,
      destinationsKnown: "destinationsKnown" in item ? item.destinationsKnown : true,
    });
  };
  const applied = planned.applied.map((item) => envelope("applied", item));
  const listed = planned.listed.map((item) => envelope("listed", item));
  const options = input.kind === "html" ? null : (input.stored?.options ?? null);
  const pending: PlanContents = {
    format: 1,
    binding,
    kind: input.kind,
    applied,
    listed,
    output:
      planned.source === undefined ? null : pendingOutput(input.kind, planned.source, options),
    lines: [...applied, ...listed].flatMap(renderEnvelope),
  };
  // Every hash is 64 characters, so the pending output has the size the real one will have.
  if (contentsBytes(pending) > PLAN_LIMITS.planBytes) throw new PlanTooLargeError("plan");
  const output =
    planned.source === undefined
      ? null
      : await outputOf(input.kind, planned.source, options, input.renderer, planned.rendered);
  const contents: PlanContents = { ...pending, output };
  return {
    ...contents,
    digest: await planDigest(contents),
    proofs: [
      ...planned.applied.map((item) => storable(item.proof)),
      ...planned.listed.map((item) => storable(item.proof)),
    ],
    work,
    ...(planned.source === undefined ? {} : { newSource: planned.source }),
  };
}

export type Confirmation = "confirmed" | "plan_changed";

/**
 * The confirmation check at acceptance: the plan and the bytes to be written are within their
 * limits (checked before any hashing); the digest the person confirmed is the digest of this
 * plan's contents, recomputed here; the binding is still the artifact's current state; and the
 * bytes derive the output the plan committed to, rendering and block map included.
 */
export async function confirmPlan(input: {
  plan: PlanContents & { digest: string };
  confirmedDigest: string;
  current: PlanBinding;
  newSource: string | undefined;
  renderer: DocumentRenderer;
}): Promise<Confirmation> {
  const { plan, confirmedDigest, newSource } = input;
  const { format, binding, kind, applied, listed, output, lines } = plan;
  const contents: PlanContents = { format, binding, kind, applied, listed, output, lines };
  if (contentsBytes(contents) > PLAN_LIMITS.planBytes) return "plan_changed";
  if (newSource !== undefined && utf8Length(newSource) > limitOf(kind)) return "plan_changed";
  if (plan.digest !== confirmedDigest) return "plan_changed";
  if (canonicalJson(binding) !== canonicalJson(input.current)) return "plan_changed";
  if ((output === null) !== (newSource === undefined)) return "plan_changed";
  if ((await planDigest(contents)) !== confirmedDigest) return "plan_changed";
  if (output === null || newSource === undefined) return "confirmed";
  const derived = await outputOf(kind, newSource, output.options, input.renderer);
  return canonicalJson(derived) === canonicalJson(output) ? "confirmed" : "plan_changed";
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
