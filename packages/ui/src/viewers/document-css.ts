// Styles for the Markdown and TXT document viewers served on artifact origins (docs/design.md,
// "Artifact-origin viewers"). They load without Tailwind, so they use the CSS custom properties
// from tokens.css directly. Only tokens appear here: no raw colors, sizes or spacing.

/** Base page and shared rules for every document viewer. */
const BASE_CSS = `
*,
*::before,
*::after {
  box-sizing: border-box;
}

html {
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}

body {
  margin: 0;
  background: var(--pf-color-canvas);
  color: var(--pf-color-text);
  font-family: var(--pf-font-sans);
  font-size: var(--pf-text-base);
  line-height: var(--pf-leading-normal);
}

::selection {
  background: var(--pf-color-selection);
  color: var(--pf-color-text);
}

.pf-document {
  max-width: var(--pf-measure);
  margin: 0 auto;
  padding: var(--pf-space-8) var(--pf-space-4) var(--pf-space-12);
  overflow-wrap: anywhere;
}

a {
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 0.15em;
}

a:hover {
  text-decoration-thickness: var(--pf-border-width-strong);
}

:focus-visible {
  outline: var(--pf-border-width-strong) solid var(--pf-color-focus);
  outline-offset: var(--pf-border-width-strong);
  border-radius: var(--pf-radius-xs);
}

`;

/** Prose rules for rendered Markdown. */
const MARKDOWN_CSS = `
.pf-markdown > :first-child {
  margin-top: 0;
}

.pf-markdown :is(p, ul, ol, blockquote, pre, hr, .pf-table) {
  margin: 0 0 var(--pf-space-4);
}

.pf-markdown :is(h1, h2, h3, h4, h5, h6) {
  margin: var(--pf-space-8) 0 var(--pf-space-3);
  font-weight: var(--pf-weight-bold);
  line-height: var(--pf-leading-tight);
}

.pf-markdown h1 {
  font-size: var(--pf-text-3xl);
}

.pf-markdown h2 {
  font-size: var(--pf-text-2xl);
  padding-bottom: var(--pf-space-2);
  border-bottom: var(--pf-border-width) solid var(--pf-color-border);
}

.pf-markdown h3 {
  font-size: var(--pf-text-xl);
}

.pf-markdown h4 {
  font-size: var(--pf-text-lg);
}

.pf-markdown :is(h5, h6) {
  font-size: var(--pf-text-base);
}

.pf-markdown h6 {
  color: var(--pf-color-text-muted);
}

.pf-markdown :is(ul, ol) {
  padding-left: var(--pf-space-6);
}

.pf-markdown li + li,
.pf-markdown li > :is(ul, ol) {
  margin-top: var(--pf-space-1);
}

.pf-markdown li > :is(ul, ol) {
  margin-bottom: 0;
}

.pf-markdown .contains-task-list {
  list-style: none;
  padding-left: var(--pf-space-2);
}

.pf-markdown .task-list-item-checkbox {
  margin: 0 var(--pf-space-2) 0 0;
  accent-color: var(--pf-color-text);
}

.pf-markdown blockquote {
  padding: 0 var(--pf-space-4);
  border-left: var(--pf-border-width-strong) solid var(--pf-color-border-strong);
  color: var(--pf-color-text-muted);
}

.pf-markdown hr {
  height: 0;
  border: 0;
  border-top: var(--pf-border-width) solid var(--pf-color-border);
  margin: var(--pf-space-8) 0;
}

.pf-markdown :is(code, pre) {
  font-family: var(--pf-font-mono);
  font-size: var(--pf-text-sm);
}

.pf-markdown :not(pre) > code {
  padding: 0 var(--pf-space-1);
  border-radius: var(--pf-radius-xs);
  background: var(--pf-color-surface);
  border: var(--pf-border-width) solid var(--pf-color-border);
}

.pf-markdown pre {
  padding: var(--pf-space-4);
  border-radius: var(--pf-radius-sm);
  background: var(--pf-color-surface);
  border: var(--pf-border-width) solid var(--pf-color-border);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.pf-markdown img {
  max-width: 100%;
  height: auto;
}

.pf-markdown .pf-table {
  overflow-x: auto;
}

.pf-markdown table {
  border-collapse: collapse;
}

.pf-markdown :is(th, td) {
  padding: var(--pf-space-2) var(--pf-space-3);
  border: var(--pf-border-width) solid var(--pf-color-border);
  vertical-align: top;
}

.pf-markdown th {
  font-weight: var(--pf-weight-semibold);
  background: var(--pf-color-surface);
}

.pf-markdown .pf-align-left {
  text-align: left;
}

.pf-markdown .pf-align-center {
  text-align: center;
}

.pf-markdown .pf-align-right {
  text-align: right;
}

.pf-markdown .footnotes {
  margin-top: var(--pf-space-12);
  padding-top: var(--pf-space-4);
  border-top: var(--pf-border-width) solid var(--pf-color-border);
  font-size: var(--pf-text-sm);
  color: var(--pf-color-text-muted);
}

.pf-markdown .footnote-ref a {
  text-decoration: none;
}
`;

/**
 * Highlighted code (`pf-tok-*` spans written by packages/render). Monochrome: keywords bold,
 * types italic, strings and metadata muted, comments muted italic. No hue, in either theme.
 */
const CODE_CSS = `
.pf-markdown :is(.pf-tok-keyword, .pf-tok-strong, .pf-tok-addition) {
  font-weight: var(--pf-weight-bold);
}

.pf-markdown :is(.pf-tok-type, .pf-tok-emphasis) {
  font-style: italic;
}

.pf-markdown :is(.pf-tok-string, .pf-tok-meta) {
  color: var(--pf-color-text-muted);
}

.pf-markdown .pf-tok-comment {
  color: var(--pf-color-text-muted);
  font-style: italic;
}

.pf-markdown .pf-tok-subst {
  color: var(--pf-color-text);
  font-style: normal;
}

.pf-markdown .pf-tok-deletion {
  text-decoration: line-through;
}
`;

/**
 * Mermaid diagrams drawn by the diagram script: the drawing in a frame, then a control that
 * shows the source block, which stays in the page (folded) so annotations keep their text.
 */
const DIAGRAM_CSS = `
.pf-markdown .pf-diagram {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--pf-space-3);
  margin: 0 0 var(--pf-space-4);
  padding: var(--pf-space-4);
  border-radius: var(--pf-radius-sm);
  border: var(--pf-border-width) solid var(--pf-color-border);
  background: var(--pf-color-canvas);
  overflow-x: auto;
}

.pf-markdown .pf-diagram img {
  align-self: center;
  max-width: 100%;
  height: auto;
}

.pf-markdown .pf-diagram-toggle {
  padding: 0;
  border: 0;
  background: none;
  color: var(--pf-color-text-muted);
  font: inherit;
  font-size: var(--pf-text-sm);
  text-decoration: underline;
  text-underline-offset: 0.15em;
  cursor: pointer;
}

.pf-markdown .pf-diagram-toggle[aria-expanded="true"] {
  color: var(--pf-color-text);
}

.pf-markdown .pf-mermaid.pf-diagram-folded {
  display: none;
}
`;

/** Plain text: exact characters, wrapped lines, monospace. */
const TEXT_CSS = `
.pf-text {
  margin: 0;
  font-family: var(--pf-font-mono);
  font-size: var(--pf-text-sm);
  line-height: var(--pf-leading-normal);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 4;
}
`;

/** Viewer chrome Portifact draws around a document: the report link under it. */
const CHROME_CSS = `
.pf-chrome {
  max-width: var(--pf-measure);
  margin: 0 auto;
  padding: var(--pf-space-4) var(--pf-space-4) var(--pf-space-8);
  border-top: var(--pf-border-width) solid var(--pf-color-border);
  font-size: var(--pf-text-sm);
  color: var(--pf-color-text-muted);
}
`;

/** Every rule the Markdown and TXT document viewers need, without the token declarations. */
export const DOCUMENT_CSS =
  `${BASE_CSS}${MARKDOWN_CSS}${CODE_CSS}${DIAGRAM_CSS}${TEXT_CSS}${CHROME_CSS}`.trim();
