// Rules for `markdown` and `text` artifacts (plan section 7). Portifact renders their entrypoint
// once, when a version is committed, and serves the rendering at the artifact's root.
import { type ArtifactType, LIMITS, type PlanLimits } from "@portifact/contracts";
import { formatSize } from "./plans.ts";
import { fail, ok, type Result } from "./result.ts";

export type DocumentType = Exclude<ArtifactType, "site">;

/** The MIME type the original of a document is stored and downloaded with, whatever was sent. */
export const DOCUMENT_CONTENT_TYPES: Record<DocumentType, string> = {
  markdown: "text/markdown; charset=utf-8",
  text: "text/plain; charset=utf-8",
};

export function isDocumentType(type: ArtifactType): type is DocumentType {
  return type !== "site";
}

export interface DocumentFile {
  path: string;
  kind: "published" | "source";
  size: number;
}

/**
 * Checks the manifest of a document version before anything is uploaded: the entrypoint is the
 * document and fits the document limit, and a text document has nothing else to publish
 * (Markdown may bring assets such as images; private sources are allowed for both).
 */
export function checkDocumentManifest(
  type: DocumentType,
  entrypoint: string,
  files: readonly DocumentFile[],
): Result<true> {
  const published = files.filter((file) => file.kind === "published");
  const document = published.find((file) => file.path === entrypoint);
  if (!document) return fail("invalid_input", "The entrypoint must be one of the published files.");
  if (document.size > LIMITS.documentBytes) {
    return fail(
      "invalid_input",
      `Documents are limited to ${LIMITS.documentBytes} bytes; ${entrypoint} has ${document.size}.`,
    );
  }
  if (type === "text" && published.length > 1) {
    return fail("invalid_input", "A text artifact publishes a single file.");
  }
  return ok(true);
}

/**
 * Checks a version once its rendering exists: the rendered page counts toward the version size
 * like any published file, so a document with large assets cannot exceed it through rendering.
 * `limits` are the owner's plan limits (`entitlements`).
 */
export function checkRenderedVersion(
  publishedBytes: number,
  renderedBytes: number,
  limits: Pick<PlanLimits, "artifactBytes">,
): Result<true> {
  if (publishedBytes + renderedBytes > limits.artifactBytes) {
    return fail(
      "quota_exceeded",
      `With its rendered page, this version exceeds ${formatSize(limits.artifactBytes)}.`,
    );
  }
  return ok(true);
}
