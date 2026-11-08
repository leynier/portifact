import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOKENS_CSS } from "./tokens-css.ts";

describe("inlined tokens", () => {
  it("match tokens.css exactly (run `bun run --cwd packages/ui sync-tokens` after editing it)", () => {
    const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
    expect(TOKENS_CSS).toBe(css);
  });
});
