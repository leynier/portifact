// Markdown to safe HTML: CommonMark plus the GFM extensions (tables, strikethrough, autolinks,
// task lists and footnotes). Raw HTML is never interpreted: it is shown as literal text.
import GithubSlugger, { slug } from "github-slugger";
import MarkdownIt, {
  type Env,
  type MarkdownIt as MarkdownItInstance,
  type StateCore,
  type Token,
} from "markdown-it";
import footnotes from "markdown-it-footnote";
import { assertSourceSize } from "./source.ts";
import { classifyUrl } from "./urls.ts";

/** Strings the renderer adds for assistive technology. Callers pass translated ones. */
export interface RenderLabels {
  /** Accessible name of the footnotes section. */
  footnotes: string;
  /** Accessible name of the link from footnote `n` back to where it is referenced. */
  backToReference: (n: number) => string;
}

export const DEFAULT_LABELS: RenderLabels = {
  footnotes: "Footnotes",
  backToReference: (n) => `Back to reference ${n}`,
};

export interface MarkdownOptions {
  /**
   * Load images from other origins. Off by default (plan section 7): remote images are opt-in and
   * stay off in protected documents. When off, a remote image becomes a link to it.
   */
  remoteImages?: boolean;
  labels?: RenderLabels;
}

/**
 * A rendered block and the source it came from, so annotations can anchor to a block and a
 * source position (plan section 8). Lines are 1-based and inclusive; offsets are UTF-16 code unit
 * indexes into the original source, `end` exclusive and before the line break.
 */
export interface SourceBlock {
  id: string;
  tag: string;
  startLine: number;
  endLine: number;
  start: number;
  end: number;
}

export interface Heading {
  id: string;
  level: number;
  text: string;
}

export interface RenderedMarkdown {
  /** HTML fragment for the document body. */
  html: string;
  /** Every element carrying `data-pf-block`, in document order. */
  blocks: SourceBlock[];
  headings: Heading[];
}

interface RenderEnv {
  source: string;
  remoteImages: boolean;
  labels: RenderLabels;
  blocks: SourceBlock[];
  headings: Heading[];
}

/** Opening tokens that become anchorable blocks. Hidden paragraphs (tight lists) are skipped. */
const BLOCK_TOKENS = new Set([
  "heading_open",
  "paragraph_open",
  "blockquote_open",
  "bullet_list_open",
  "ordered_list_open",
  "list_item_open",
  "table_open",
  "tr_open",
  "fence",
  "code_block",
]);

const TASK_MARKER = /^\[([ xX])\][ \t]/;
const ALIGNMENT = /^text-align:(left|center|right)$/;
const EXTERNAL_REL = "nofollow noopener noreferrer";

/**
 * markdown-it-footnote appends each footnote with `state.tokens = state.tokens.concat(...)`, which
 * copies the whole token stream per footnote: quadratic, so 20,000 footnotes took 10 seconds.
 * While its tail rule runs, the stream is this array, whose `concat` appends in place. `filter`
 * keeps the subclass through `Symbol.species`.
 */
class AppendOnlyTokens extends Array<Token> {
  override concat(...items: (Token | ConcatArray<Token>)[]): Token[] {
    for (const item of items) {
      if (Array.isArray(item)) for (const token of item) this.push(token);
      else this.push(item as Token);
    }
    return this;
  }
}

function createParser(): MarkdownItInstance {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });
  // Fuzzy matching finds `www.` links; bare domains are unwrapped again in `unwrapBareDomains`.
  md.linkify.set({ fuzzyLink: true, fuzzyEmail: true });
  md.validateLink = (url) => classifyUrl(url) !== undefined;
  md.use(footnotes);
  md.core.ruler.before("footnote_tail", "pf_append_only_tokens", (state) => {
    state.tokens = AppendOnlyTokens.from(state.tokens);
  });
  md.core.ruler.push("portifact", annotate);

  const rules = md.renderer.rules;
  rules.table_open = (tokens, idx, options, _env, self) =>
    `<div class="pf-table" tabindex="0">\n${self.renderToken(tokens, idx, options)}`;
  rules.table_close = (tokens, idx, options, _env, self) =>
    `${self.renderToken(tokens, idx, options)}</div>\n`;
  rules.task_checkbox = (tokens, idx) =>
    `<input type="checkbox" class="task-list-item-checkbox" disabled${tokens[idx]?.meta?.checked === true ? " checked" : ""}> `;
  rules.footnote_anchor_name = (tokens, idx) => String(Number(tokens[idx]?.meta?.id) + 1);
  rules.footnote_ref = (tokens, idx, options, env, self) => {
    const id = self.rules.footnote_anchor_name?.(tokens, idx, options, env, self) ?? "";
    const subId = Number(tokens[idx]?.meta?.subId);
    const refId = subId > 0 ? `${id}:${subId}` : id;
    return `<sup class="footnote-ref"><a href="#fn:${id}" id="fnref:${refId}">${id}</a></sup>`;
  };
  rules.footnote_block_open = (_tokens, _idx, _options, env) =>
    `<section class="footnotes" aria-label="${md.utils.escapeHtml(renderEnv(env).labels.footnotes)}">\n<ol>\n`;
  rules.footnote_block_close = () => "</ol>\n</section>\n";
  rules.footnote_open = (tokens, idx, options, env, self) =>
    `<li id="fn:${self.rules.footnote_anchor_name?.(tokens, idx, options, env, self) ?? ""}">`;
  rules.footnote_close = () => "</li>\n";
  rules.footnote_anchor = (tokens, idx, options, env, self) => {
    const id = self.rules.footnote_anchor_name?.(tokens, idx, options, env, self) ?? "";
    const subId = Number(tokens[idx]?.meta?.subId);
    const refId = subId > 0 ? `${id}:${subId}` : id;
    const label = md.utils.escapeHtml(renderEnv(env).labels.backToReference(Number(id)));
    return ` <a href="#fnref:${refId}" class="footnote-backref" aria-label="${label}">↩︎</a>`;
  };
  return md;
}

function renderEnv(env: Env | undefined): RenderEnv {
  return env as unknown as RenderEnv;
}

/** Core rule that adds block ids, heading ids, task lists, link and image policy. */
function annotate(state: StateCore): void {
  const env = renderEnv(state.env);
  const lines = lineStarts(env.source);
  const slugger = new GithubSlugger();
  const tokens = state.tokens;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as Token;
    if (BLOCK_TOKENS.has(token.type) && token.map && !token.hidden) {
      const id = `b${env.blocks.length + 1}`;
      token.attrSet("data-pf-block", id);
      env.blocks.push(sourceBlock(id, token, env.source, lines));
    }
    if (token.type === "heading_open") {
      const text = inlineText(tokens[index + 1]);
      // A heading with no sluggable characters still gets an id, from a neutral word.
      const id = slugger.slug(slug(text) ? text : "section");
      token.attrSet("id", id);
      env.headings.push({ id, level: Number(token.tag.slice(1)), text });
    }
    if (token.type === "list_item_open") markTask(state, index);
    if (token.type === "th_open" || token.type === "td_open") alignWithClass(token);
    if (token.type === "inline" && token.children) {
      token.children = unwrapBareDomains(token.children).flatMap((child) =>
        applyUrlPolicy(state, child, env),
      );
    }
  }
}

function sourceBlock(id: string, token: Token, source: string, lines: number[]): SourceBlock {
  const [first, last] = token.map as [number, number];
  // markdown-it may map a block one line past the end of a source without a final newline.
  const lastLine = Math.max(first, Math.min(last, lines.length) - 1);
  return {
    id,
    tag: token.tag,
    startLine: first + 1,
    endLine: lastLine + 1,
    start: lines[first] ?? source.length,
    end: lineEnd(source, lines, lastLine),
  };
}

/** Offsets where each line starts. Breaks match markdown-it: CRLF, CR or LF. */
function lineStarts(source: string): number[] {
  const starts = [0];
  for (const match of source.matchAll(/\r\n?|\n/g)) starts.push(match.index + match[0].length);
  return starts;
}

function lineEnd(source: string, lines: number[], line: number): number {
  const next = lines[line + 1];
  if (next === undefined) return source.length;
  return source[next - 2] === "\r" && source[next - 1] === "\n" ? next - 2 : next - 1;
}

function inlineText(token: Token | undefined): string {
  let text = "";
  for (const child of token?.children ?? []) {
    if (child.type === "text" || child.type === "code_inline") text += child.content;
    else if (child.type === "image") text += inlineText(child);
  }
  return text;
}

/** GFM task list item: `- [ ] todo` or `- [x] done`. */
function markTask(state: StateCore, index: number): void {
  const tokens = state.tokens;
  const inline = tokens[index + 2];
  const first = inline?.children?.[0];
  if (tokens[index + 1]?.type !== "paragraph_open" || inline?.type !== "inline") return;
  if (first?.type !== "text") return;
  const marker = TASK_MARKER.exec(first.content);
  if (!marker) return;
  first.content = first.content.slice(marker[0].length);
  const checkbox = new state.Token("task_checkbox", "input", 0);
  checkbox.meta = { checked: marker[1] !== " " };
  inline.children?.unshift(checkbox);
  (tokens[index] as Token).attrJoin("class", "task-list-item");
  const list = findParentList(tokens, index);
  list?.attrSet("class", "contains-task-list");
}

function findParentList(tokens: Token[], index: number): Token | undefined {
  const level = (tokens[index] as Token).level - 1;
  for (let at = index - 1; at >= 0; at -= 1) {
    const token = tokens[at] as Token;
    if (token.level === level && token.nesting === 1) return token;
  }
  return undefined;
}

/** markdown-it aligns cells with `style`; viewers style through classes only. */
function alignWithClass(token: Token): void {
  const declaration = token.attrGet("style");
  if (declaration === null) return;
  token.attrs = (token.attrs ?? []).filter(([name]) => name !== "style");
  const align = ALIGNMENT.exec(String(declaration))?.[1];
  if (align) token.attrSet("class", `pf-align-${align}`);
}

/**
 * GFM autolinks `www.` hosts, scheme URLs and email addresses, but not bare domains such as
 * `example.com`, which linkify's fuzzy mode would also link.
 */
function unwrapBareDomains(children: Token[]): Token[] {
  const kept: Token[] = [];
  for (let index = 0; index < children.length; index += 1) {
    const token = children[index] as Token;
    const text = children[index + 1];
    const bare =
      token.type === "link_open" &&
      token.markup === "linkify" &&
      !String(token.attrGet("href")).startsWith("mailto:") &&
      !/^(?:www\.|[a-z][a-z0-9+.-]*:)/i.test(text?.content ?? "");
    if (!bare) {
      kept.push(token);
      continue;
    }
    // linkify emits exactly link_open, text, link_close.
    if (text) kept.push(text);
    index += 2;
  }
  return kept;
}

/** Marks external links and turns remote images into links when remote images are off. */
function applyUrlPolicy(state: StateCore, token: Token, env: RenderEnv): Token[] {
  if (token.type === "link_open") {
    if (classifyUrl(String(token.attrGet("href") ?? "")) === "remote")
      token.attrSet("rel", EXTERNAL_REL);
    return [token];
  }
  if (token.type !== "image" || env.remoteImages) return [token];
  const src = String(token.attrGet("src") ?? "");
  if (classifyUrl(src) !== "remote") return [token];
  const open = new state.Token("link_open", "a", 1);
  open.attrs = [
    ["href", src],
    ["rel", EXTERNAL_REL],
  ];
  const text = new state.Token("text", "", 0);
  text.content = inlineText(token) || src;
  return [open, text, new state.Token("link_close", "a", -1)];
}

const parser = createParser();

/** Renders Markdown to a sanitized HTML fragment with stable block and heading ids. */
export function renderMarkdown(source: string, options: MarkdownOptions = {}): RenderedMarkdown {
  assertSourceSize(source);
  const env: RenderEnv = {
    source,
    remoteImages: options.remoteImages ?? false,
    labels: options.labels ?? DEFAULT_LABELS,
    blocks: [],
    headings: [],
  };
  const html = parser.render(source, env as unknown as Env);
  return { html, blocks: env.blocks, headings: env.headings };
}
