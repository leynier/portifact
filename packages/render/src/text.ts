// Plain text to an exact, escaped, preformatted view (plan section 7: a TXT with HTML is shown
// literally). Line numbers are not part of the text, so nothing else is added.
import { assertSourceSize } from "./source.ts";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

/** Escapes text content. Quotes need no escaping outside attributes. */
export function escapeText(text: string): string {
  return text.replace(/[&<>]/g, (char) => ESCAPES[char] ?? char);
}

export interface RenderedText {
  /** HTML fragment for the document body. */
  html: string;
}

/**
 * Renders text inside `<pre>`. The HTML parser drops one newline right after `<pre>`, so one is
 * always written first and a text that starts with a blank line keeps it.
 */
export function renderText(source: string): RenderedText {
  assertSourceSize(source);
  return { html: `<pre class="pf-text">\n${escapeText(source)}</pre>` };
}
