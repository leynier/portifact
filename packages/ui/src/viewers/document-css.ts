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

/** Every rule the Markdown and TXT document viewers need, without the token declarations. */
export const DOCUMENT_CSS = `${BASE_CSS}${MARKDOWN_CSS}${TEXT_CSS}`.trim();
