import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Returns the body of the first block that opens with `prelude`, matching nested braces. */
function block(source: string, prelude: string): string {
  const start = source.indexOf(prelude);
  if (start < 0) throw new Error(`${prelude} not found`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
  }
  throw new Error(`${prelude} is not closed`);
}

/** Top-level rules of a block as selector lists and declarations, skipping nested at-rules. */
function rules(body: string): { selectors: string[]; declarations: string }[] {
  const found: { selectors: string[]; declarations: string }[] = [];
  for (const match of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const prelude = (match[1] ?? "").trim();
    if (prelude.startsWith("@")) continue;
    found.push({
      selectors: prelude.split(",").map((selector) => selector.replace(/\s+/g, " ").trim()),
      declarations: match[2] ?? "",
    });
  }
  return found;
}

describe("theme base layer", () => {
  const base = rules(block(css, "@layer base"));
  const pointer = base.find((rule) => /cursor:\s*pointer/.test(rule.declarations));

  it("shows the pointer cursor on every clickable control", () => {
    expect(pointer).toBeDefined();
    const selectors = pointer?.selectors ?? [];
    for (const control of ["button", '[role="button"]', '[role="tab"]', "summary", "label[for]"]) {
      expect(selectors.some((selector) => selector.startsWith(control))).toBe(true);
    }
  });

  it("keeps disabled buttons, button roles and tabs on the default cursor", () => {
    const selectors = pointer?.selectors ?? [];
    expect(selectors).toContain("button:not(:disabled)");
    expect(selectors).toContain('[role="button"]:not([aria-disabled="true"])');
    expect(selectors).toContain('[role="tab"]:not([aria-disabled="true"])');
  });
});

describe("theme utilities", () => {
  it("sizes the typing caret in em and leaves its color to token utilities", () => {
    const caret = block(css, "@utility typing-caret");
    expect(caret).toMatch(/width:\s*[\d.]+em/);
    expect(caret).toMatch(/height:\s*[\d.]+em/);
    expect(caret).not.toMatch(/color|background/);
  });
});
