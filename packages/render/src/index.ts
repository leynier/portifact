// Markdown and plain-text rendering for artifact viewers. Pure: no I/O, deterministic output.
export {
  DOCUMENT_STYLESHEET,
  type DocumentOptions,
  type MarkdownDocumentOptions,
  REPORT_PATH,
  type RenderedDocument,
  renderMarkdownDocument,
  renderTextDocument,
} from "./document.ts";
export { RenderError, type RenderErrorReason } from "./errors.ts";
export { HIGHLIGHT_LIMITS, isHighlighted, TOKEN_CLASSES } from "./highlight.ts";
export {
  DEFAULT_LABELS,
  type Heading,
  type MarkdownOptions,
  type RenderedMarkdown,
  type RenderLabels,
  renderMarkdown,
  type SourceBlock,
} from "./markdown.ts";
export {
  DIAGRAM_LOADER,
  DIAGRAM_LOADER_HASH,
  DIAGRAM_PATH,
  documentPolicy,
  type PolicyOptions,
} from "./policy.ts";
export { assertSourceSize, decodeSource, MAX_SOURCE_BYTES, utf8ByteLength } from "./source.ts";
export { escapeText, type RenderedText, renderText } from "./text.ts";
export { classifyUrl, type UrlTarget } from "./urls.ts";
export { RENDERER_VERSION, SECURE_RENDERER_VERSION } from "./version.ts";
