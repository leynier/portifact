// The patch plan of decision 0027 (rules 3, 9 and 10, and rules 4, 6 and 7 of the second round).
// The server builds it from the stored file alone. For a document it first verifies the baseline:
// the installed renderer, with the stored rendering options, must reproduce the stored rendering
// and block map byte for byte, or nothing applies (`renderer_changed`). The plan holds one
// canonical envelope per operation (`envelope.ts`); the lines the person sees are rendered from
// those envelopes and the change list exports them unchanged. It commits to the complete output:
// the new file's hash and, for a document, the new rendering's and block map's hashes and the
// options. Its digest is the hash of all of that, and confirming recomputes it from the plan's
// contents and re-derives the output from the new file, so a plan whose contents or bytes changed
// after the person saw it is refused, not re-read.
import { createHash } from "node:crypto";
import { RENDERER_VERSION, renderMarkdownDocument, renderTextDocument } from "@portifact/render";
import type { TextEdit, UncertainReason } from "./edit.ts";
import {
  type Binding,
  contextOf,
  ENVELOPE_LIMITS,
  type Envelope,
  envelopeBytes,
  locationOf,
  type Provenance,
  renderEnvelope,
} from "./envelope.ts";
import { planHtml } from "./html-resolver.ts";
import { planMarkdown } from "./markdown-resolver.ts";
import type { PlannedFile, PlannedListed, PlannedPatch, Proof } from "./planned.ts";
import { buildPreview } from "./preview.ts";
import { planText } from "./text-resolver.ts";

export type { Binding, Envelope, Provenance } from "./envelope.ts";

/** The renderer label of this build, the only one a plan accepts. */
export const RENDERER = `portifact-render@${RENDERER_VERSION}`;

export interface RenderOptions {
  title: string;
  reportLink: boolean;
  liveDiagrams: boolean;
}

/** The stored rendering of a document version: what the commit wrote and with which options. */
export interface StoredRendering {
  html: string;
  blockMap: string | null;
  options: RenderOptions;
}

export interface Output {
  sha256: string;
  renderedSha256: string | null;
  blockMapSha256: string | null;
  options: RenderOptions | null;
}

export interface Plan {
  format: 1;
  binding: Binding;
  kind: "markdown" | "text" | "html";
  applied: Envelope[];
  listed: Envelope[];
  /** What the new version holds, when anything applies. */
  output: Output | null;
  lines: string[];
  digest: string;
}

export interface BuiltPlan extends Plan {
  /** The bytes to write; checked against `output` at confirmation. */
  newSource?: string;
  /** Proof data persisted with each item and carried suggestion (never exported). */
  proofs: (Proof | null)[];
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** A document's rendering and block map, as the commit would store them. */
function renderStored(
  kind: "markdown" | "text",
  source: string,
  options: RenderOptions,
): { html: string; blockMap: string | null } {
  if (kind === "text") return { html: renderTextDocument(source, options).html, blockMap: null };
  const document = renderMarkdownDocument(source, options);
  return {
    html: document.html,
    blockMap: JSON.stringify({ blocks: document.blocks, headings: document.headings }),
  };
}

/** The stored rendering of a document, as a commit with these options writes it (for tests). */
export function storedRenderingOf(
  kind: "markdown" | "text",
  source: string,
  options?: Partial<RenderOptions>,
): StoredRendering {
  const full: RenderOptions = {
    title: "Document",
    reportLink: true,
    liveDiagrams: true,
    ...options,
  };
  return { ...renderStored(kind, source, full), options: full };
}

function outputOf(kind: Plan["kind"], source: string, options: RenderOptions | null): Output {
  if (kind === "html" || options === null) {
    return { sha256: sha256(source), renderedSha256: null, blockMapSha256: null, options: null };
  }
  const rendered = renderStored(kind, source, options);
  return {
    sha256: sha256(source),
    renderedSha256: sha256(rendered.html),
    blockMapSha256: rendered.blockMap === null ? null : sha256(rendered.blockMap),
    options,
  };
}

/** Whether the installed renderer reproduces the stored rendering (rule 6 of the second round). */
function baselineHolds(
  kind: "markdown" | "text",
  source: string,
  renderer: string,
  stored: StoredRendering | undefined,
): boolean {
  if (renderer !== RENDERER || !stored) return false;
  const again = renderStored(kind, source, stored.options);
  return again.html === stored.html && again.blockMap === stored.blockMap;
}

const digestOf = (plan: Omit<Plan, "digest">) =>
  sha256(
    JSON.stringify({
      format: plan.format,
      binding: plan.binding,
      kind: plan.kind,
      applied: plan.applied,
      listed: plan.listed,
      output: plan.output,
      lines: plan.lines,
    }),
  );

export function buildPlan(input: {
  binding: Omit<Binding, "fileSha256">;
  provenance: Provenance;
  kind: Plan["kind"];
  source: string;
  edits: readonly TextEdit[];
  /** Required for documents: the stored rendering the plan must reproduce. */
  stored?: StoredRendering;
  pageUrl?: string;
}): BuiltPlan {
  const binding: Binding = { ...input.binding, fileSha256: sha256(input.source) };
  const { kind, source, edits } = input;
  let planned: PlannedFile;
  if (kind === "html") planned = planHtml(source, edits, input.pageUrl);
  else if (!baselineHolds(kind, source, binding.renderer, input.stored)) {
    planned = {
      applied: [],
      listed: edits.map((_, operation) => ({
        operation,
        reason: "renderer_changed" as UncertainReason,
      })),
    };
  } else if (kind === "markdown") planned = planMarkdown(source, edits, input.pageUrl);
  else planned = planText(source, edits);

  const envelope = (status: Envelope["status"], item: PlannedPatch | PlannedListed): Envelope => {
    const edit = edits[item.operation] as TextEdit;
    let location: Envelope["location"] = { unresolved: true };
    let context: Envelope["context"] = null;
    if (item.proof) {
      location = locationOf(source, item.proof.start, item.proof.end);
      context = contextOf(source, item.proof.start, item.proof.end);
    } else {
      // A listed operation the planner did not locate: the before, when it occurs once in the file.
      const first = edit.before ? source.indexOf(edit.before) : -1;
      if (first >= 0 && source.indexOf(edit.before, first + 1) < 0) {
        location = locationOf(source, first, first + edit.before.length);
        context = contextOf(source, first, first + edit.before.length);
      }
    }
    return {
      format: 1,
      status,
      reason: "reason" in item ? item.reason : null,
      operation: { kind: "text", before: edit.before, after: edit.after },
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
    if (envelopeBytes(each) > ENVELOPE_LIMITS.envelopeBytes) {
      throw new Error("An envelope is over its limit");
    }
  }
  const options = kind === "html" ? null : (input.stored?.options ?? null);
  const output = planned.source === undefined ? null : outputOf(kind, planned.source, options);
  const lines = [...applied, ...listed].flatMap(renderEnvelope);
  const body: Omit<Plan, "digest"> = { format: 1, binding, kind, applied, listed, output, lines };
  if (new TextEncoder().encode(JSON.stringify(body)).length > ENVELOPE_LIMITS.planBytes) {
    throw new Error("The plan is over its limit");
  }
  return {
    ...body,
    digest: digestOf(body),
    proofs: [
      ...planned.applied.map((item) => item.proof),
      ...planned.listed.map((item) => item.proof ?? null),
    ],
    ...(planned.source === undefined ? {} : { newSource: planned.source }),
  };
}

/**
 * The confirmation check at acceptance (finding 6 of the second review): the digest the person
 * confirmed must be the digest of this plan's contents, recomputed here, the binding must still be
 * the artifact's current state, and the bytes to be written must derive the output the plan
 * committed to, rendering and block map included.
 */
export function confirmPlan(plan: BuiltPlan, confirmedDigest: string, now: Binding): boolean {
  const { digest, newSource, proofs: _proofs, ...contents } = plan;
  if (digest !== confirmedDigest || digestOf(contents) !== confirmedDigest) return false;
  if (JSON.stringify(plan.binding) !== JSON.stringify(now)) return false;
  if (plan.output === null) return newSource === undefined;
  if (newSource === undefined) return false;
  const derived = outputOf(plan.kind, newSource, plan.output.options);
  return JSON.stringify(derived) === JSON.stringify(plan.output);
}

/**
 * Change-list capacity is all or nothing (rule 9): an acceptance adds every listed item or none.
 * The transaction that enforces it is `acceptance.ts`; this is the arithmetic.
 */
export function admitItems(open: number, adding: number, cap: number): boolean {
  return open + adding <= cap;
}

/**
 * What the preview shows for a plan (finding 16): the built preview of the new file when anything
 * applies, or an explicit unavailable state with the reasons, never the unchanged page.
 */
export function previewOf(
  plan: BuiltPlan,
): { state: "ready"; document: string } | { state: "unavailable"; reasons: UncertainReason[] } {
  if (plan.newSource === undefined) {
    return {
      state: "unavailable",
      reasons: plan.listed.map((item) => item.reason as UncertainReason),
    };
  }
  return { state: "ready", document: buildPreview(plan.kind, plan.newSource) };
}

/** A preview of a stored file of any kind (the first round's name). */
export function inertPreview(kind: Plan["kind"], source: string): string {
  return buildPreview(kind, source);
}

export { visible } from "./display.ts";
export { PREVIEW_POLICY } from "./preview.ts";
