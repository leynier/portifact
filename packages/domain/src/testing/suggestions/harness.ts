// Test helpers for the suggestion planners (decision 0027). Pages are read here with happy-dom, a
// parser the planners never use, and positions are computed through `packages/anchors` over the
// page's body, as the bridge computes them in a browser.
import {
  ANCHOR_SCHEMA_VERSION,
  type EditOperation,
  type FileKind,
  type PlanBinding,
} from "@portifact/contracts";
import type { TextEdit } from "../../suggestions/edit.ts";
import { planHtml } from "../../suggestions/html-planner.ts";
import { planMarkdown } from "../../suggestions/markdown-planner.ts";
import { type BuiltPlan, buildPlan, type StoredRendering } from "../../suggestions/plan.ts";
import type { PlannedFile } from "../../suggestions/planned.ts";
import { planText } from "../../suggestions/text-planner.ts";
import { newWork, type Work } from "../../suggestions/work.ts";

import {
  DOC_URL,
  editAt,
  PAGE_URL,
  PEOPLE,
  pageTextOf,
  RENDERER,
  sha256,
  storedOf,
  TITLE,
} from "./pages.ts";

export * from "./pages.ts";

export async function edit(
  kind: FileKind,
  source: string,
  before: string,
  after: string,
  occurrence = 0,
): Promise<TextEdit> {
  return editAt(await pageTextOf(kind, source), before, after, occurrence);
}

/** Runs one planner directly (documents with their stored page, already verified). */
export async function planOne(
  kind: FileKind,
  source: string,
  edits: readonly (TextEdit | null)[],
  work: Work = newWork(),
): Promise<PlannedFile> {
  if (kind === "html") return planHtml({ html: source, edits, pageUrl: PAGE_URL, work });
  if (kind === "text") return planText({ source, edits, title: TITLE, renderer: RENDERER, work });
  const stored = await storedOf("markdown", source);
  return planMarkdown({
    source,
    edits,
    page: { html: stored.html, blocks: stored.blocks },
    title: TITLE,
    pageUrl: DOC_URL,
    renderer: RENDERER,
    work,
  });
}

export type Resolution =
  | {
      status: "certain";
      source: string;
      range: { start: number; end: number };
      replacement: string;
      destinations: PlannedFile["applied"][number]["destinations"];
    }
  | { status: "uncertain"; reason: string };

/** One operation as a plan of its own. */
export async function resolve(kind: FileKind, source: string, edit: TextEdit): Promise<Resolution> {
  const planned = await planOne(kind, source, [edit]);
  const applied = planned.applied[0];
  if (!applied || planned.source === undefined) {
    return { status: "uncertain", reason: planned.listed[0]?.reason ?? "none" };
  }
  return {
    status: "certain",
    source: planned.source,
    range: { start: applied.start, end: applied.end },
    replacement: applied.replacement,
    destinations: applied.destinations,
  };
}

/** A text operation for an edit, as the viewer would submit it. */
export function textOperation(edit: TextEdit, path = "index.md"): EditOperation {
  return {
    kind: "text",
    target: {
      schema: ANCHOR_SCHEMA_VERSION,
      path,
      anchor: {
        kind: "text",
        quote: { exact: edit.before, prefix: "", suffix: "" },
        position: { start: edit.start, end: edit.end },
      },
    },
    after: edit.after,
  };
}

export const elementOperation = (
  action: "remove" | "duplicate",
  path = "index.md",
): EditOperation => ({
  kind: "structure",
  action,
  target: {
    schema: ANCHOR_SCHEMA_VERSION,
    path,
    anchor: { kind: "element", selectors: ["#x"], tagName: "p", fingerprint: "Hello" },
  },
});

export async function bindingFor(
  kind: FileKind,
  source: string,
  overrides: Partial<PlanBinding> = {},
): Promise<PlanBinding> {
  return {
    artifactId: "k7d2qm4xab",
    versionId: "ver_1",
    path: kind === "html" ? "index.html" : kind === "text" ? "notes.txt" : "index.md",
    fileSha256: await sha256(source),
    renderer: RENDERER.label,
    subject: "th_1",
    revision: 1,
    ...overrides,
  };
}

/** A full plan through `buildPlan`, with the stored rendering a commit would have written. */
export async function plan(
  kind: FileKind,
  source: string,
  operations: readonly (TextEdit | EditOperation)[],
  options: { stored?: StoredRendering | null; binding?: Partial<PlanBinding>; work?: Work } = {},
): Promise<BuiltPlan> {
  let stored: StoredRendering | undefined;
  if (options.stored === undefined) {
    stored = kind === "html" ? undefined : await storedOf(kind, source);
  } else {
    stored = options.stored ?? undefined;
  }
  const path = kind === "html" ? "index.html" : "index.md";
  return buildPlan({
    binding: await bindingFor(kind, source, options.binding),
    provenance: PEOPLE,
    kind,
    source,
    operations: operations.map((each) => ("kind" in each ? each : textOperation(each, path))),
    ...(stored ? { stored } : {}),
    pageUrl: kind === "html" ? PAGE_URL : DOC_URL,
    renderer: RENDERER,
    ...(options.work ? { work: options.work } : {}),
  });
}
