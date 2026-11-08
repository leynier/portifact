// Wraps a rendered fragment in a complete HTML document styled only with design-system tokens.
import { DOCUMENT_CSS } from "@portifact/ui/document-css";
import { TOKENS_CSS } from "@portifact/ui/tokens-css";
import { type MarkdownOptions, type RenderedMarkdown, renderMarkdown } from "./markdown.ts";
import { documentPolicy } from "./policy.ts";
import { type RenderedText, renderText } from "./text.ts";
import { RENDERER_VERSION } from "./version.ts";

export interface DocumentOptions {
  /** Document title, usually the artifact name. */
  title: string;
  /** BCP 47 language of the content. Defaults to `en`. */
  lang?: string;
}

const LANG = /^[a-z]{2,3}(?:-[a-z0-9]{1,8})*$/i;
const ATTRIBUTE_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeAttribute(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ATTRIBUTE_ESCAPES[char] ?? char);
}

interface Shell extends DocumentOptions {
  kind: "markdown" | "text";
  body: string;
  remoteImages: boolean;
}

function shell({ title, lang = "en", kind, body, remoteImages }: Shell): string {
  if (!LANG.test(lang)) throw new RangeError(`Invalid language tag: ${lang}`);
  return [
    "<!doctype html>",
    `<html lang="${lang}">`,
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${documentPolicy(remoteImages)}">`,
    '<meta name="referrer" content="no-referrer">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    `<meta name="generator" content="portifact-render ${RENDERER_VERSION}">`,
    `<title>${escapeAttribute(title)}</title>`,
    `<style>\n${TOKENS_CSS}\n${DOCUMENT_CSS}\n</style>`,
    "</head>",
    "<body>",
    `<main class="${kind === "markdown" ? "pf-document pf-markdown" : "pf-document"}">`,
    body,
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

export interface RenderedDocument {
  /** Complete HTML document, ready to serve as `text/html; charset=utf-8`. */
  html: string;
  rendererVersion: string;
}

/** Renders Markdown into a complete document. Also returns the block map and headings. */
export function renderMarkdownDocument(
  source: string,
  options: DocumentOptions & MarkdownOptions,
): RenderedDocument & Omit<RenderedMarkdown, "html"> {
  const { html, blocks, headings } = renderMarkdown(source, options);
  const remoteImages = options.remoteImages ?? false;
  return {
    html: shell({ ...options, kind: "markdown", body: html, remoteImages }),
    blocks,
    headings,
    rendererVersion: RENDERER_VERSION,
  };
}

/** Renders plain text into a complete document. */
export function renderTextDocument(source: string, options: DocumentOptions): RenderedDocument {
  const { html }: RenderedText = renderText(source);
  return {
    html: shell({ ...options, kind: "text", body: html, remoteImages: false }),
    rendererVersion: RENDERER_VERSION,
  };
}
