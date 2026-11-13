// What a commit stores for a `markdown` or `text` document: its page and, for Markdown, its block
// map, rendered with the options every stored rendering uses. One function serves the commit
// (`renderDocument` in the services) and the suggestion planners (decision 0027, "Binding and
// confirmation"), which must reproduce a stored rendering byte for byte from its source before
// they trust it, and derive the new version's rendering exactly as the commit will write it.
import type { DocumentRenderer } from "@portifact/contracts";
import { renderMarkdownDocument, renderTextDocument } from "./document.ts";
import { renderMarkdown } from "./markdown.ts";
import { renderText } from "./text.ts";
import { RENDERER_VERSION } from "./version.ts";

/** The flags of every stored rendering: published pages link the report page and draw diagrams. */
export const STORED_RENDERING = { reportLink: true, liveDiagrams: true } as const;

export const RENDERED_CONTENT_TYPE = "text/html; charset=utf-8";
export const BLOCK_MAP_CONTENT_TYPE = "application/json";

export interface StoredDocumentOptions {
  /** The artifact's name, the page title. */
  title: string;
  /** SHA-256 of the source, recorded in the block map. */
  sourceSha256: string;
}

export interface StoredDocumentFile {
  kind: "rendered" | "block_map";
  contentType: string;
  text: string;
}

/** The files a commit stores for a document: always the page first, then a Markdown block map. */
export function renderStoredDocument(
  type: "markdown" | "text",
  source: string,
  options: StoredDocumentOptions,
): StoredDocumentFile[] {
  if (type === "text") {
    const document = renderTextDocument(source, {
      title: options.title,
      reportLink: STORED_RENDERING.reportLink,
    });
    return [{ kind: "rendered", contentType: RENDERED_CONTENT_TYPE, text: document.html }];
  }
  const document = renderMarkdownDocument(source, { title: options.title, ...STORED_RENDERING });
  return [
    { kind: "rendered", contentType: RENDERED_CONTENT_TYPE, text: document.html },
    {
      kind: "block_map",
      contentType: BLOCK_MAP_CONTENT_TYPE,
      text: JSON.stringify({
        rendererVersion: RENDERER_VERSION,
        sourceSha256: options.sourceSha256,
        blocks: document.blocks,
        headings: document.headings,
      }),
    },
  ];
}

/** The renderer as the suggestion planners take it (decision 0027). */
export const DOCUMENT_RENDERER: DocumentRenderer = {
  label: `portifact-render@${RENDERER_VERSION}`,
  stored: renderStoredDocument,
  body: (kind, source) =>
    kind === "markdown" ? renderMarkdown(source).html : renderText(source).html,
};
