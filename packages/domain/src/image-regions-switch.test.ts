import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { imageRegionsEnabled } from "./image-regions-switch.ts";

describe("the image regions switch", () => {
  it("is on only for exactly true", () => {
    expect(imageRegionsEnabled({ IMAGE_REGIONS_ENABLED: "true" })).toBe(true);
    for (const value of [undefined, "", "TRUE", "1", "yes", " true"]) {
      expect(imageRegionsEnabled({ IMAGE_REGIONS_ENABLED: value }), String(value)).toBe(false);
    }
    expect(imageRegionsEnabled({})).toBe(false);
  });

  it("is in no deployed Worker configuration", () => {
    for (const app of ["app", "content", "jobs", "web", "data"]) {
      let config: string;
      try {
        config = readFileSync(
          new URL(`../../../apps/${app}/wrangler.jsonc`, import.meta.url),
          "utf8",
        );
      } catch {
        continue;
      }
      expect(config, app).not.toContain("IMAGE_REGIONS_ENABLED");
    }
  });
});
