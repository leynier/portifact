// Regenerates src/tokens/tokens-css.ts from tokens.css, so Workers can inline the tokens without
// a CSS loader. `src/tokens/tokens-css.test.ts` fails when the two drift.
const dir = new URL("../src/tokens/", import.meta.url);
const css = await Bun.file(new URL("tokens.css", dir)).text();
const source = `// Generated from tokens.css by \`bun run --cwd packages/ui sync-tokens\`. Do not edit by hand.

/** The contents of tokens.css, for documents that inline the design tokens. */
export const TOKENS_CSS = ${JSON.stringify(css)};
`;
await Bun.write(new URL("tokens-css.ts", dir), source);
