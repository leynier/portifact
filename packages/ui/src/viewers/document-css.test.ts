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

  it("styles the viewer chrome with tokens only", () => {
    expect(DOCUMENT_CSS).toMatch(/\.pf-chrome \{[^}]*var\(--pf-color-text-muted\)/);
  });

  it("styles highlighted code with weight, italics and the muted grey only", () => {
    const rules = [...DOCUMENT_CSS.matchAll(/([^{}]*pf-tok-[^{}]*)\{([^}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(4);
    for (const [, , body] of rules) {
      for (const [, property] of (body ?? "").matchAll(/([\w-]+):/g)) {
        expect(["font-weight", "font-style", "color", "text-decoration"]).toContain(property);
      }
      expect(body).not.toMatch(/color: (?!var\(--pf-color-text(?:-muted)?\))/);
    }
    for (const kind of ["keyword", "type", "string", "comment", "meta", "subst", "deletion"]) {
      expect(DOCUMENT_CSS).toContain(`.pf-tok-${kind}`);
    }
  });

  it("folds a drawn diagram's source without removing it", () => {
    expect(DOCUMENT_CSS).toMatch(/\.pf-mermaid\.pf-diagram-folded \{\s*display: none;/);
    expect(DOCUMENT_CSS).toMatch(/\.pf-diagram img \{[^}]*max-width: 100%/);
  });

  it("draws a visible focus indicator with the focus token", () => {
    expect(DOCUMENT_CSS).toMatch(/:focus-visible \{[^}]*var\(--pf-color-focus\)/);
  });
});
