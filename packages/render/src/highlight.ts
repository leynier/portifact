// Syntax highlighting of fenced code at render time. highlight.js tokenizes a curated set of
// languages; its HTML is then rebuilt from scratch, so the output holds only the escaped text and
// `<span class="pf-tok-*">` elements this module writes, and exactly the text of the source.
/// <reference path="./highlight-languages.d.ts" />

import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import hljs from "./hljs-core.js";
import { escapeText } from "./text.ts";

/**
 * Languages highlighted, by highlight.js name; each also answers to its usual aliases (`js`,
 * `ts`, `sh`, `py`, `html`, `yml` and so on). Any other fence language stays plain text.
 */
const LANGUAGES = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  graphql,
  ini,
  java,
  javascript,
  json,
  kotlin,
  makefile,
  markdown,
  php,
  powershell,
  python,
  ruby,
  rust,
  scss,
  shell,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};

/**
 * How much code one document may highlight, in UTF-16 code units: a fence over `fence`, and
 * every fence once `document` is spent, is shown plain. Highlighting is regex-based and runs at
 * commit, where a 5 MB source is allowed, so the work per document stays bounded.
 */
export const HIGHLIGHT_LIMITS = { fence: 100_000, document: 500_000 } as const;

/**
 * Token kinds and the highlight.js scopes they take. Styles are monochrome (weight, italics and
 * the muted grey from the tokens, `DOCUMENT_CSS`); every other scope is plain text.
 */
const KINDS: Record<string, string> = {
  keyword: "keyword",
  literal: "keyword",
  "selector-tag": "keyword",
  section: "keyword",
  name: "keyword",
  built_in: "type",
  type: "type",
  string: "string",
  regexp: "string",
  char: "string",
  symbol: "string",
  link: "string",
  comment: "comment",
  quote: "comment",
  doctag: "strong",
  meta: "meta",
  subst: "subst",
  addition: "addition",
  deletion: "deletion",
  emphasis: "emphasis",
  strong: "strong",
};

/** Every class the highlighter can write, for the sanitizer tests and the stylesheet. */
export const TOKEN_CLASSES: readonly string[] = [...new Set(Object.values(KINDS))]
  .sort()
  .map((kind) => `pf-tok-${kind}`);

const highlighter = hljs.newInstance();
for (const [name, language] of Object.entries(LANGUAGES)) {
  highlighter.registerLanguage(name, language);
}

/** Remaining highlighting allowance of one rendering. */
export interface HighlightBudget {
  remaining: number;
}

export function highlightBudget(): HighlightBudget {
  return { remaining: HIGHLIGHT_LIMITS.document };
}

/** Whether `language` (a fence's first word, any case) is one the renderer highlights. */
export function isHighlighted(language: string): boolean {
  return highlighter.getLanguage(language.toLowerCase()) !== undefined;
}

/**
 * Highlighted HTML for the inside of `<code>`, or undefined to show the code plain: an unknown
 * language, a fence over the limits, or highlight.js output this module cannot vouch for.
 */
export function highlightCode(
  code: string,
  language: string,
  budget: HighlightBudget,
): string | undefined {
  if (!isHighlighted(language) || code.length > HIGHLIGHT_LIMITS.fence) return undefined;
  if (code.length > budget.remaining) return undefined;
  budget.remaining -= code.length;
  let html: string;
  try {
    html = highlighter.highlight(code, {
      language: language.toLowerCase(),
      ignoreIllegals: true,
    }).value;
  } catch {
    return undefined;
  }
  return rebuild(html, code);
}

/** One piece of highlight.js output: an opening span, a closing span or escaped text. */
const PIECE = /<span class="([^"<>]*)">|<\/span>|([^<]+)/y;
const ENTITY = /&(amp|lt|gt|quot|#x27);/g;
const BARE_AMPERSAND = /&(?!(?:amp|lt|gt|quot|#x27);)/;
const DECODED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'" };

/**
 * Writes the highlighted code again from highlight.js output: text is decoded and escaped by
 * this module, and spans keep only a `pf-tok-*` class for a known scope (others are dropped with
 * their closing tag). Anything else, unbalanced spans, or text that differs from the source by a
 * single character, and the code is shown plain instead.
 */
export function rebuild(html: string, source: string): string | undefined {
  let out = "";
  let text = "";
  const open: boolean[] = [];
  PIECE.lastIndex = 0;
  while (PIECE.lastIndex < html.length) {
    const match = PIECE.exec(html);
    if (!match) return undefined;
    const [piece, classes, raw] = match;
    if (raw !== undefined) {
      if (BARE_AMPERSAND.test(raw)) return undefined;
      const decoded = raw.replace(ENTITY, (_, name: string) => DECODED[name] ?? "");
      text += decoded;
      out += escapeText(decoded);
    } else if (classes !== undefined) {
      const kind = tokenKind(classes);
      open.push(kind !== undefined);
      if (kind !== undefined) out += `<span class="pf-tok-${kind}">`;
    } else if (piece === "</span>") {
      if (open.length === 0) return undefined;
      if (open.pop()) out += "</span>";
    }
  }
  return open.length === 0 && text === source ? out : undefined;
}

/** The kind of a highlight.js span from its first class (`hljs-title function_` is `title`). */
function tokenKind(classes: string): string | undefined {
  const first = classes.split(" ")[0] ?? "";
  if (!first.startsWith("hljs-")) return undefined;
  const scope = first.slice("hljs-".length);
  return Object.hasOwn(KINDS, scope) ? KINDS[scope] : undefined;
}
