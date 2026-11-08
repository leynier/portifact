import { describe, expect, it } from "vitest";
import { checkFile } from "../design-check.ts";
import { TOKENS_CSS } from "../tokens/tokens-css.ts";
import { DOCUMENT_CSS } from "./document-css.ts";

const declared = new Set([...TOKENS_CSS.matchAll(/(--pf-[\w-]+)\s*:/g)].map((m) => m[1]));

describe("document viewer stylesheet", () => {
  it("only references tokens that tokens.css declares", () => {
    const used = [...DOCUMENT_CSS.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(20);
    expect(used.filter((name) => !declared.has(name))).toEqual([]);
  });

  it("declares no raw colors, so both themes come from the tokens", () => {
    expect(checkFile("document.css", DOCUMENT_CSS)).toEqual([]);
    expect(DOCUMENT_CSS).not.toMatch(
      /:[^;]*\b(?:black|white|red|blue|green|gray|grey|transparent)\b/i,
    );
  });

  it("styles both viewers and keeps text wrapping instead of scrolling the page", () => {
    expect(DOCUMENT_CSS).toContain(".pf-markdown");
    expect(DOCUMENT_CSS).toMatch(/\.pf-text \{[^}]*white-space: pre-wrap/);
    expect(DOCUMENT_CSS).toMatch(/\.pf-markdown pre \{[^}]*white-space: pre-wrap/);
  });

  it("draws a visible focus indicator with the focus token", () => {
    expect(DOCUMENT_CSS).toMatch(/:focus-visible \{[^}]*var\(--pf-color-focus\)/);
  });
});
