// Pages for the suggestion tests, read with happy-dom (a parser the planners never use) and
// located through `packages/anchors` over the page's body, as the bridge does in a browser. The
// independent checker uses only this module: nothing here imports planner code.
import { AnchorDocument, type AnchorElement } from "@portifact/anchors";
import type { FileKind } from "@portifact/contracts";
import { DOCUMENT_RENDERER, renderStoredDocument, type SourceBlock } from "@portifact/render";
import { type Document, Window } from "happy-dom";

export interface TextEdit {
  start: number;
  end: number;
  before: string;
  after: string;
}

export interface StoredPage {
  html: string;
  blockMap: string | null;
  options: { title: string };
  blocks: SourceBlock[];
}

/** The installed renderer, as the services will pass it. */
export const RENDERER = DOCUMENT_RENDERER;

export const PAGE_URL = "https://k7d2qm4xab.portifact.dev/index.html";
export const DOC_URL = "https://k7d2qm4xab.portifact.dev/";
export const TITLE = "Document";
export const PEOPLE = { submittedBy: "Reviewer", acceptedBy: "Owner" };

// One window for every parse: a window holds timers and listeners until it is closed.
const window = new Window({ url: DOC_URL });
const parser = new window.DOMParser();

/** Parses a whole HTML document with happy-dom. Scripts never run. */
export function parseDocument(html: string): Document {
  return parser.parseFromString(html, "text/html");
}

/** The normalized text the bridge would compute for a page's body. */
export function bodyText(html: string): string {
  const body = parseDocument(html).body;
  return new AnchorDocument(body as unknown as AnchorElement).text.value;
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A document's stored files as the commit writes them. */
export async function storedOf(
  kind: "markdown" | "text",
  source: string,
  title = TITLE,
): Promise<StoredPage> {
  const files = renderStoredDocument(kind, source, { title, sourceSha256: await sha256(source) });
  const blockMap = files.find((file) => file.kind === "block_map")?.text ?? null;
  return {
    html: (files[0] as { text: string }).text,
    blockMap,
    options: { title },
    blocks: blockMap ? (JSON.parse(blockMap) as { blocks: SourceBlock[] }).blocks : [],
  };
}

/** The page a stored file is served as. */
export async function pageOf(kind: FileKind, source: string): Promise<string> {
  return kind === "html" ? source : (await storedOf(kind, source)).html;
}

/** The page text of a stored file, as the bridge would compute it. */
export async function pageTextOf(kind: FileKind, source: string): Promise<string> {
  return bodyText(await pageOf(kind, source));
}

/** An edit at the `occurrence`-th place `before` appears in a page text. */
export function editAt(text: string, before: string, after: string, occurrence = 0): TextEdit {
  let index = -1;
  for (let i = 0; i <= occurrence; i++) index = text.indexOf(before, index + 1);
  if (index < 0) throw new Error(`"${before}" is not on the page`);
  const start = Array.from(text.slice(0, index)).length;
  return { start, end: start + Array.from(before).length, before, after };
}
