// Rendering of `markdown` and `text` artifacts (plan sections 7 and 9). A document is rendered
// once, when its version is committed, never per request: hostile input can expand about ten
// times, so the output is stored in R2 like any other object, counted in the account's storage
// and kept until a renderer security fix asks for a new rendering.
import { type Db, schema } from "@portifact/db";
import { type DocumentType, fail, ok, type Result } from "@portifact/domain";
import {
  assertSourceSize,
  decodeSource,
  RENDERER_VERSION,
  RenderError,
  renderMarkdownDocument,
  renderTextDocument,
} from "@portifact/render";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { objectKey, sha256Hex } from "./objects.ts";

/** A file the server derives from a document: its HTML page or, for Markdown, its block map. */
export interface Rendering {
  kind: "rendered" | "block_map";
  contentType: string;
  bytes: Uint8Array;
  sha256: string;
}

export interface DocumentRendering {
  rendererVersion: string;
  /** Always the page first, then the block map of a Markdown document. */
  files: Rendering[];
  /** Total size of the files, which counts toward the version and the account. */
  bytes: number;
}

export interface RenderInput {
  type: DocumentType;
  /** Artifact name, used as the page title. */
  name: string;
  /** R2 key of the document's source object. */
  sourceKey: string;
  sourceSha256: string;
}

const HTML = "text/html; charset=utf-8";
const JSON_TYPE = "application/json";

/**
 * Reads a document's source from R2 and renders it. Fails with `invalid_input` when the source
 * is not a valid document (binary, invalid UTF-8 or over the size limit).
 */
export async function renderDocument(
  bucket: R2Bucket,
  input: RenderInput,
): Promise<Result<DocumentRendering>> {
  const object = await bucket.get(input.sourceKey);
  if (!object) return fail("upload_incomplete", "The document's source is missing.");
  let source: string;
  try {
    source = decodeSource(new Uint8Array(await object.arrayBuffer()));
  } catch (error) {
    if (error instanceof RenderError) return fail(error.code, error.message);
    throw error;
  }
  const encoder = new TextEncoder();
  const outputs: { kind: Rendering["kind"]; contentType: string; text: string }[] = [];
  if (input.type === "markdown") {
    // Published pages draw their Mermaid blocks in the browser; the preview below does not.
    const document = renderMarkdownDocument(source, {
      title: input.name,
      reportLink: true,
      liveDiagrams: true,
    });
    outputs.push({ kind: "rendered", contentType: HTML, text: document.html });
    outputs.push({
      kind: "block_map",
      contentType: JSON_TYPE,
      text: JSON.stringify({
        rendererVersion: document.rendererVersion,
        sourceSha256: input.sourceSha256,
        blocks: document.blocks,
        headings: document.headings,
      }),
    });
  } else {
    const document = renderTextDocument(source, { title: input.name, reportLink: true });
    outputs.push({ kind: "rendered", contentType: HTML, text: document.html });
  }
  const files: Rendering[] = [];
  for (const output of outputs) {
    const bytes = encoder.encode(output.text);
    files.push({
      kind: output.kind,
      contentType: output.contentType,
      bytes,
      sha256: await sha256Hex(bytes),
    });
  }
  return ok({
    rendererVersion: RENDERER_VERSION,
    files,
    bytes: files.reduce((sum, file) => sum + file.bytes.byteLength, 0),
  });
}

/**
 * Writes renderings to R2 under their content address. Deterministic, so repeating it is safe.
 * When the owner already has a row for the bytes, they go to that row's key: a transferred
 * artifact's rows keep the key they were stored under (transfer.ts), so a key built from the
 * owner would be an object no row holds. A verified row already has the bytes.
 */
export async function storeRenderings(
  db: Db,
  bucket: R2Bucket,
  ownerId: string,
  files: readonly Rendering[],
): Promise<void> {
  const rows = new Map(
    (
      await db
        .select({
          sha256: schema.objects.sha256,
          r2Key: schema.objects.r2Key,
          state: schema.objects.state,
        })
        .from(schema.objects)
        .where(
          and(
            eq(schema.objects.ownerId, ownerId),
            inArray(
              schema.objects.sha256,
              files.map((file) => file.sha256),
            ),
          ),
        )
    ).map((row) => [row.sha256, row]),
  );
  for (const file of files) {
    const row = rows.get(file.sha256);
    if (row?.state === "verified") continue;
    await bucket.put(row?.r2Key ?? objectKey(ownerId, file.sha256), file.bytes, {
      sha256: file.sha256,
      httpMetadata: { contentType: file.contentType },
    });
  }
}

export interface RenderingRows {
  ownerId: string;
  versionId: string;
  /** The document's path: renderings are recorded at the entrypoint, under their own kind. */
  entrypoint: string;
  files: readonly Rendering[];
  /** Initial state of objects the account does not store yet. */
  state: "pending" | "verified";
  /** Every write happens only while this condition holds. */
  guard: SQL;
  now: number;
}

/**
 * Batch statements that record renderings: an object row per new object and a manifest entry
 * per rendering, replacing an earlier rendering of the same kind. Referencing the objects from
 * the version keeps the orphan sweep away from them and frees them with the version.
 */
export function renderingStatements(db: Db, rows: RenderingRows) {
  return rows.files.flatMap((file) => {
    const size = file.bytes.byteLength;
    const key = objectKey(rows.ownerId, file.sha256);
    // Columns in table order: owner_id, sha256, size, r2_key, state, created_at.
    const object = db
      .insert(schema.objects)
      .select(
        sql`select ${rows.ownerId}, ${file.sha256}, ${size}, ${key}, ${rows.state}, ${rows.now} where ${rows.guard}`,
      );
    return [
      rows.state === "verified"
        ? object.onConflictDoUpdate({
            target: [schema.objects.ownerId, schema.objects.sha256],
            set: { state: "verified" },
          })
        : object.onConflictDoNothing(),
      // Columns in table order: version_id, kind, path, owner_id, sha256, size, content_type.
      db
        .insert(schema.versionFiles)
        .select(
          sql`select ${rows.versionId}, ${file.kind}, ${rows.entrypoint}, ${rows.ownerId}, ${file.sha256}, ${size}, ${file.contentType} where ${rows.guard}`,
        )
        .onConflictDoUpdate({
          target: [
            schema.versionFiles.versionId,
            schema.versionFiles.kind,
            schema.versionFiles.path,
          ],
          set: {
            sha256: sql`excluded.sha256`,
            size: sql`excluded.size`,
            contentType: sql`excluded.content_type`,
          },
        }),
    ];
  });
}

export interface PreviewInput {
  type: DocumentType;
  name: string;
  source: string;
}

/**
 * Renders a source the way a commit would, without storing anything, for the dashboard's editor.
 * Applies the same checks as the commit: at most the document limit in UTF-8 and no NUL
 * characters (binary data).
 */
export function previewDocument(
  input: PreviewInput,
): Result<{ html: string; rendererVersion: string }> {
  try {
    assertSourceSize(input.source);
    if (input.source.includes("\u0000")) {
      throw new RenderError("binary", "Documents must be text, not binary");
    }
    const document =
      input.type === "markdown"
        ? renderMarkdownDocument(input.source, { title: input.name })
        : renderTextDocument(input.source, { title: input.name });
    return ok({ html: document.html, rendererVersion: document.rendererVersion });
  } catch (error) {
    if (error instanceof RenderError) return fail(error.code, error.message);
    throw error;
  }
}
