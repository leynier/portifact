// Edit suggestions in the services' tests (decision 0027): documents and pages published through
// the real publish path, text operations placed where the anchors of a browser would place them
// (the page's own text index, `renderedPage`), and the jobs run as the jobs Worker runs them.
import { env } from "cloudflare:test";
import {
  ANCHOR_SCHEMA_VERSION,
  type ArtifactType,
  type EditOperation,
  type OutboxTopic,
} from "@portifact/contracts";
import { type RegionalDb, schema } from "@portifact/db";
import { newWork, renderedPage } from "@portifact/domain/suggestions";
import { DOCUMENT_RENDERER } from "@portifact/render";
import { and, eq } from "drizzle-orm";
import type { HumanCheck } from "../src/annotations.ts";
import { runJob } from "../src/outbox.ts";
import { db, NOW } from "./fixtures.ts";
import { type Published, publishVersion } from "./version-support.ts";

export const DOMAIN = "portifact.dev";
export const NAME = "Versions";
export const DOC = "First paragraph.\n\nSecond paragraph here.\n\nA [linked](https://x.test) word.\n";
export const PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page</title></head><body><h1 id="t">Title</h1><p>Second paragraph here.</p><p>A <a href="/x">linked</a> word.</p></body></html>';

export const humanCheck: HumanCheck = { token: undefined, verify: async () => "ok" };

export interface Doc extends Published {
  type: ArtifactType;
  path: string;
}

/** Publishes a Markdown document (or a site page) as a new artifact of `userId` or `ownerId`. */
export async function publishDoc(
  userId: string,
  options: { body?: string; type?: "markdown" | "site"; ownerId?: string; now?: number } = {},
): Promise<Doc> {
  const type = options.type ?? "markdown";
  const path = type === "markdown" ? "index.md" : "index.html";
  const body = options.body ?? (type === "markdown" ? DOC : PAGE);
  const published = await publishVersion(
    userId,
    { [path]: { body, contentType: type === "markdown" ? "text/markdown" : "text/html" } },
    {
      type,
      entrypoint: path,
      now: options.now ?? NOW,
      ...(options.ownerId ? { ownerId: options.ownerId } : {}),
    },
  );
  // Comments (and so suggestions) are open on it.
  await db()
    .update(schema.artifacts)
    .set({ annotations: "open" })
    .where(eq(schema.artifacts.id, published.artifactId));
  return { ...published, type, path };
}

/** Publishes the next version of `doc` with `body`. */
export async function republish(userId: string, doc: Doc, body: string, now = NOW + 1_000) {
  const next = await publishVersion(
    userId,
    {
      [doc.path]: {
        body,
        contentType: doc.type === "markdown" ? "text/markdown" : "text/html",
      },
    },
    { type: doc.type, entrypoint: doc.path, base: doc, now },
  );
  return { ...doc, ...next };
}

/** A text operation on `before` (its `occurrence`th place on the page) to `after`. */
export function textOp(
  doc: Pick<Doc, "type" | "path">,
  body: string,
  before: string,
  after: string,
  occurrence = 0,
): EditOperation {
  const kind = doc.type === "markdown" ? "markdown" : "html";
  const page = renderedPage(kind, body, {
    title: NAME,
    pageUrl: `https://k7d2qm4xab.${DOMAIN}/`,
    renderer: DOCUMENT_RENDERER,
    work: newWork(),
  });
  const text = page.points.join("");
  let at = -1;
  for (let i = 0; i <= occurrence; i++) at = text.indexOf(before, at + 1);
  if (at < 0) throw new Error(`"${before}" is not on the page`);
  const start = Array.from(text.slice(0, at)).length;
  return {
    kind: "text",
    target: {
      schema: ANCHOR_SCHEMA_VERSION,
      path: doc.path,
      anchor: {
        kind: "text",
        quote: { exact: before, prefix: "", suffix: "" },
        position: { start, end: start + Array.from(before).length },
      },
    },
    after,
  };
}

/** The outbox rows of `topic` for an artifact, oldest first. */
export async function jobsOf(topic: OutboxTopic, artifactId: string, handle: RegionalDb = db()) {
  return handle
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.topic, topic), eq(schema.outbox.subject, artifactId)))
    .orderBy(schema.outbox.id);
}

export const JOB_DEPS = { suggestions: { enabled: true, contentDomain: DOMAIN } };

/** Runs every waiting job of `topic` for the artifact, as the jobs Worker would. */
export async function runJobs(
  topic: OutboxTopic,
  artifactId: string,
  now = NOW + 2_000,
  handle: RegionalDb = db(),
  bucket: R2Bucket = env.ARTIFACTS,
) {
  const outcomes = [];
  for (const row of await jobsOf(topic, artifactId)) {
    outcomes.push(await runJob(handle, bucket, { id: row.id, topic }, now, JOB_DEPS));
  }
  return outcomes;
}

export async function thread(id: string) {
  const [row] = await db()
    .select()
    .from(schema.annotationThreads)
    .where(eq(schema.annotationThreads.id, id));
  return row;
}

export async function artifactOf(id: string) {
  const [row] = await db().select().from(schema.artifacts).where(eq(schema.artifacts.id, id));
  return row;
}

/** The text of the current version's file at `path`. */
export async function currentText(artifactId: string, path: string): Promise<string> {
  const artifact = await artifactOf(artifactId);
  const [file] = await db()
    .select({ r2Key: schema.objects.r2Key })
    .from(schema.versionFiles)
    .innerJoin(
      schema.objects,
      and(
        eq(schema.objects.ownerId, schema.versionFiles.ownerId),
        eq(schema.objects.sha256, schema.versionFiles.sha256),
      ),
    )
    .where(
      and(
        eq(schema.versionFiles.versionId, artifact?.currentVersionId ?? ""),
        eq(schema.versionFiles.kind, "published"),
        eq(schema.versionFiles.path, path),
      ),
    );
  const object = await env.ARTIFACTS.get(file?.r2Key ?? "");
  return object ? object.text() : "";
}

export async function auditKinds(artifactId: string): Promise<string[]> {
  const rows = await db()
    .select({ kind: schema.auditEvents.kind, detail: schema.auditEvents.detail })
    .from(schema.auditEvents)
    .where(eq(schema.auditEvents.artifactId, artifactId))
    .orderBy(schema.auditEvents.at);
  return rows.map((row) => row.kind);
}

export async function items(artifactId: string) {
  return db()
    .select()
    .from(schema.changeItems)
    .where(eq(schema.changeItems.artifactId, artifactId))
    .orderBy(schema.changeItems.id);
}

export async function attempts(artifactId: string) {
  return db()
    .select()
    .from(schema.acceptanceAttempts)
    .where(eq(schema.acceptanceAttempts.artifactId, artifactId));
}
