// The patch plan of decision 0027 (rules 3, 9 and 10). The server builds it from the stored file
// alone and binds it to the artifact, the version, the file's path and SHA-256, the renderer
// version and the suggestion's revision. The person confirms the plan by its digest after seeing
// what it shows: the exact before and after with control and invisible characters made visible,
// the source line around each change and the destination of every link around it. Any change of
// what the plan is bound to, or of the plan itself, makes the confirmation fail. Operations it
// does not apply leave as frozen change-list envelopes holding only what the plan showed.
import { createHash } from "node:crypto";
import { renderMarkdownDocument, renderTextDocument } from "@portifact/render";
import type { TextEdit, UncertainReason } from "./edit.ts";
import { planHtml } from "./html-resolver.ts";
import { planMarkdown } from "./markdown-resolver.ts";
import { planText } from "./text-resolver.ts";

export interface Binding {
  artifactId: string;
  versionId: string;
  path: string;
  /** SHA-256 of the stored file the plan was built from. */
  fileSha256: string;
  /** Renderer version of the stored rendering; documents are rebuilt with exactly this one. */
  renderer: string;
  suggestionId: string;
  suggestionRevision: number;
}

export interface Provenance {
  submittedBy: string;
  acceptedBy: string;
}

export interface Envelope {
  /** The operation exactly as accepted: before and after, both shown in the confirmation. */
  operation: { kind: "text"; before: string; after: string };
  binding: Binding;
  provenance: Provenance;
  /** Where the server found it in the stored file, or `unresolved` when it could not. */
  location: { line: number; context: string } | { unresolved: true };
  reason: UncertainReason;
}

export interface AppliedLine {
  operation: number;
  before: string;
  after: string;
  line: number;
  context: string;
  destinations: string[];
}

export interface Plan {
  binding: Binding;
  kind: "markdown" | "text" | "html";
  applied: AppliedLine[];
  listed: Envelope[];
  /** SHA-256 of the new file, when anything applied. */
  newSha256?: string;
  /** What the person sees, line by line. */
  lines: string[];
  digest: string;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Bidirectional controls, zero-width and other invisible characters, made visible as `⟦U+XXXX⟧`
 * so a confirmation cannot hide a reordered or invisible change (finding 10).
 */
const INVISIBLE = /[­؜᠎​-‏‪-‮⁠-⁤⁦-⁯﻿￹-￻]/gu;

export function visible(text: string): string {
  return text.replace(
    INVISIBLE,
    (char) => `⟦U+${(char.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, "0")}⟧`,
  );
}

/** The 1-based line of an offset and that line's text, from the stored file (never the reviewer). */
function lineAt(source: string, offset: number): { line: number; context: string } {
  const start = source.lastIndexOf("\n", offset - 1) + 1;
  const end = source.indexOf("\n", offset);
  const line = source.slice(0, offset).split("\n").length;
  return { line, context: source.slice(start, end < 0 ? source.length : end) };
}

/** Where `before` sits in the stored file when it occurs there exactly once, else unresolved. */
function locate(source: string, before: string): Envelope["location"] {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + 1) >= 0) return { unresolved: true };
  return lineAt(source, first);
}

export function buildPlan(input: {
  binding: Omit<Binding, "fileSha256">;
  provenance: Provenance;
  kind: Plan["kind"];
  source: string;
  edits: readonly TextEdit[];
}): Plan & { newSource?: string } {
  const binding: Binding = { ...input.binding, fileSha256: sha256(input.source) };
  const applied: AppliedLine[] = [];
  const listed: Envelope[] = [];
  let newSource: string | undefined;
  const envelope = (edit: TextEdit, reason: UncertainReason): Envelope => ({
    operation: { kind: "text", before: edit.before, after: edit.after },
    binding,
    provenance: input.provenance,
    location: locate(input.source, edit.before),
    reason,
  });

  if (input.kind === "markdown") {
    const planned = planMarkdown(input.source, input.edits);
    for (const item of planned.listed) {
      listed.push(envelope(input.edits[item.operation] as TextEdit, item.reason));
    }
    for (const item of planned.applied) {
      const edit = input.edits[item.patch.operation] as TextEdit;
      applied.push({
        operation: item.patch.operation,
        before: edit.before,
        after: edit.after,
        ...lineAt(input.source, item.patch.start),
        destinations: item.destinations,
      });
    }
    newSource = planned.source;
  } else {
    const planned =
      input.kind === "text"
        ? planText(input.source, input.edits)
        : planHtml(input.source, input.edits);
    for (const item of planned.listed) {
      listed.push(envelope(input.edits[item.operation] as TextEdit, item.reason));
    }
    for (const item of planned.applied) {
      const edit = input.edits[item.operation] as TextEdit;
      applied.push({
        operation: item.operation,
        before: edit.before,
        after: edit.after,
        ...lineAt(input.source, item.start),
        destinations: item.destinations,
      });
    }
    newSource = planned.source;
  }

  const lines = [
    ...applied.flatMap((item) => [
      `line ${item.line}: ${visible(item.context)}`,
      `- ${visible(item.before)}`,
      `+ ${visible(item.after)}`,
      ...item.destinations.map((href) => `link to ${visible(href)}`),
    ]),
    ...listed.map(
      (item) =>
        `for the change list (${item.reason}): - ${visible(item.operation.before)} + ${visible(item.operation.after)}`,
    ),
  ];
  const body = {
    binding,
    kind: input.kind,
    applied,
    listed,
    ...(newSource === undefined ? {} : { newSha256: sha256(newSource) }),
    lines,
  };
  return {
    ...body,
    digest: sha256(JSON.stringify(body)),
    ...(newSource === undefined ? {} : { newSource }),
  };
}

/**
 * The confirmation check at acceptance: the digest the person confirmed must be this plan's, and
 * the plan's binding must still be the artifact's current state (rule 3).
 */
export function confirmPlan(plan: Plan, confirmedDigest: string, now: Binding): boolean {
  return plan.digest === confirmedDigest && JSON.stringify(plan.binding) === JSON.stringify(now);
}

/**
 * Change-list capacity is all or nothing (rule 9): an acceptance adds every listed item or none,
 * so a full list refuses the acceptance instead of dropping part of it.
 */
export function admitItems(open: number, adding: number, cap: number): boolean {
  return open + adding <= cap;
}

/** The inert content security policy every HTML preview starts with (rule 1). */
export const PREVIEW_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'";

/**
 * An inert preview built from the stored files, shown in a frame with an empty `sandbox` and
 * `srcdoc` in the viewer: the renderer's own output for documents (without the diagram loader),
 * and for an inert HTML page its patched file with this policy first in its head, so it runs
 * nothing, loads nothing, submits nothing and navigates nowhere. Never a change to the running
 * artifact.
 */
export function inertPreview(kind: Plan["kind"], source: string): string {
  if (kind === "markdown") return renderMarkdownDocument(source, { title: "Preview" }).html;
  if (kind === "text") return renderTextDocument(source, { title: "Preview" }).html;
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_POLICY}">`;
  return /<head[^>]*>/i.test(source)
    ? source.replace(/<head[^>]*>/i, (head) => `${head}${meta}`)
    : `<!doctype html><head>${meta}</head>${source}`;
}
