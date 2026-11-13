// Suggestion threads and stored plans for the preview tests (decision 0027). The suggestion
// services come in their own pull request, so these write the rows directly: a thread of kind
// `suggestion` holding an edit, and the plan `buildPlan` makes for it from the stored files, in
// `suggestion_plans` for the person who will ask for the preview.
import { env } from "cloudflare:test";
import { ANCHOR_SCHEMA_VERSION, type EditOperation, type FileKind } from "@portifact/contracts";
import { schema } from "@portifact/db";
import {
  type BuiltPlan,
  buildPlan,
  newWork,
  planPageUrl,
  renderedPage,
  type StoredRendering,
} from "@portifact/domain/suggestions";
import { DOCUMENT_RENDERER } from "@portifact/render";
import { and, eq } from "drizzle-orm";
import { commitPublish, preparePublish } from "../src/publish.ts";
import { db, NOW, sha256 } from "./fixtures.ts";

export const CONTENT_DOMAIN = "portifact.dev";
export const TITLE = "Plan";
const TYPES = { html: "site", markdown: "markdown", text: "text" } as const;
const CONTENT_TYPES = { html: "text/html", markdown: "text/markdown", text: "text/plain" } as const;
export const PATHS = { html: "index.html", markdown: "index.md", text: "notes.txt" } as const;

/** Publishes one file as an artifact of its kind, through the real publish flow. */
export async function publishFile(
  ownerId: string,
  kind: FileKind,
  body: string,
  base?: { artifactId: string; versionId: string },
  options: { userId?: string; now?: number } = {},
) {
  const sha = await sha256(body);
  const prepared = await preparePublish(db(), {
    userId: options.userId ?? ownerId,
    type: TYPES[kind],
    name: TITLE,
    entrypoint: PATHS[kind],
    baseVersionId: base?.versionId ?? null,
    ...(base ? { artifactId: base.artifactId } : {}),
    files: [
      {
        path: PATHS[kind],
        kind: "published",
        sha256: sha,
        size: new TextEncoder().encode(body).length,
        contentType: CONTENT_TYPES[kind],
      },
    ],
    now: options.now ?? NOW,
  });
  if (!prepared.ok) throw new Error(prepared.message);
  await env.ARTIFACTS.put(`objects/${ownerId}/${sha}`, body);
  const committed = await commitPublish(db(), env.ARTIFACTS, {
    userId: options.userId ?? ownerId,
    sessionId: prepared.value.sessionId,
    now: options.now ?? NOW,
  });
  if (!committed.ok) throw new Error(committed.message);
  return { artifactId: committed.value.artifactId, versionId: committed.value.versionId };
}

async function storedEntry(versionId: string, kind: "rendered" | "block_map", path: string) {
  const [row] = await db()
    .select({ sha256: schema.versionFiles.sha256, ownerId: schema.versionFiles.ownerId })
    .from(schema.versionFiles)
    .where(
      and(
        eq(schema.versionFiles.versionId, versionId),
        eq(schema.versionFiles.kind, kind),
        eq(schema.versionFiles.path, path),
      ),
    );
  if (!row) return null;
  const object = await env.ARTIFACTS.get(`objects/${row.ownerId}/${row.sha256}`);
  return object ? object.text() : null;
}

/** A text operation replacing the first `before` on the page as the bridge would place it. */
export function textOperation(
  kind: FileKind,
  source: string,
  artifactId: string,
  before: string,
  after: string,
): EditOperation {
  const page = renderedPage(kind, source, {
    title: TITLE,
    pageUrl: planPageUrl(kind, artifactId, CONTENT_DOMAIN, PATHS[kind]),
    renderer: DOCUMENT_RENDERER,
    work: newWork(),
  });
  const text = page.points.join("");
  const index = text.indexOf(before);
  if (index < 0) throw new Error(`"${before}" is not on the page`);
  const start = Array.from(text.slice(0, index)).length;
  return {
    kind: "text",
    target: {
      schema: ANCHOR_SCHEMA_VERSION,
      path: PATHS[kind],
      anchor: {
        kind: "text",
        quote: { exact: before, prefix: "", suffix: "" },
        position: { start, end: start + Array.from(before).length },
      },
    },
    after,
  };
}

export interface SuggestionInput {
  kind: FileKind;
  source: string;
  artifactId: string;
  versionId: string;
  ownerId: string;
  authorId: string;
  /** Who holds the plan (`suggestion_plans.user_id`). */
  viewerId: string;
  operations: EditOperation[];
  threadId?: string;
  now?: number;
}

/** Inserts a pending suggestion thread with its edit, and the viewer's stored plan for it. */
export async function suggestionWithPlan(input: SuggestionInput): Promise<{
  threadId: string;
  plan: BuiltPlan;
}> {
  const threadId = input.threadId ?? `th_${crypto.randomUUID()}`;
  const now = input.now ?? NOW;
  const edit = JSON.stringify({ operations: input.operations });
  const target = JSON.stringify(input.operations[0]?.target);
  await db()
    .insert(schema.annotationThreads)
    .values({
      id: threadId,
      artifactId: input.artifactId,
      versionId: input.versionId,
      ownerId: input.ownerId,
      authorId: input.authorId,
      target,
      targetBytes: new TextEncoder().encode(target).length,
      path: PATHS[input.kind],
      updatedAt: now,
      kind: "suggestion",
      suggestionState: "pending",
      suggestionRevision: 1,
      edit,
      editBytes: new TextEncoder().encode(edit).length,
    });
  const plan = await planFor({ ...input, threadId, revision: 1 });
  await storePlan(input.viewerId, input.artifactId, threadId, plan, now);
  return { threadId, plan };
}

/** The plan of a suggestion from the version's stored files, as the services will build it. */
export async function planFor(
  input: SuggestionInput & { threadId: string; revision: number },
): Promise<BuiltPlan> {
  const path = PATHS[input.kind];
  let stored: StoredRendering | undefined;
  if (input.kind !== "html") {
    stored = {
      html: (await storedEntry(input.versionId, "rendered", path)) ?? "",
      blockMap:
        input.kind === "markdown" ? await storedEntry(input.versionId, "block_map", path) : null,
      options: { title: TITLE },
    };
  }
  return buildPlan({
    binding: {
      artifactId: input.artifactId,
      versionId: input.versionId,
      path,
      fileSha256: await sha256(input.source),
      renderer: DOCUMENT_RENDERER.label,
      subject: input.threadId,
      revision: input.revision,
    },
    people: { submitter: true, acceptor: true },
    kind: input.kind,
    source: input.source,
    operations: input.operations,
    ...(stored ? { stored } : {}),
    pageUrl: planPageUrl(input.kind, input.artifactId, CONTENT_DOMAIN, path),
    renderer: DOCUMENT_RENDERER,
  });
}

/** Stores a plan in the person's cache, as the suggestion services will (10 minutes). */
export async function storePlan(
  userId: string,
  artifactId: string,
  threadId: string | null,
  plan: BuiltPlan,
  now = NOW,
) {
  const { newSource: _n, proofs: _p, work: _w, ...exported } = plan;
  await db()
    .insert(schema.suggestionPlans)
    .values({
      userId,
      digest: plan.digest,
      artifactId,
      threadId,
      plan: JSON.stringify(exported),
      createdAt: now,
      expiresAt: now + 10 * 60_000,
    });
}
