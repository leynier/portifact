import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { suggestionsEnabled } from "./suggestions-switch.ts";

describe("the suggestions switch", () => {
  it("is on only for exactly true", () => {
    expect(suggestionsEnabled({ SUGGESTIONS_ENABLED: "true" })).toBe(true);
    for (const value of [undefined, "", "TRUE", "1", "yes", " true"]) {
      expect(suggestionsEnabled({ SUGGESTIONS_ENABLED: value }), String(value)).toBe(false);
    }
    expect(suggestionsEnabled({})).toBe(false);
  });

  it("is in no deployed Worker configuration", () => {
    for (const app of ["app", "content", "jobs", "web"]) {
      let config: string;
      try {
        config = readFileSync(
          new URL(`../../../apps/${app}/wrangler.jsonc`, import.meta.url),
          "utf8",
        );
      } catch {
        continue;
      }
      expect(config, app).not.toContain("SUGGESTIONS_ENABLED");
    }
  });
});
