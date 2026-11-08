import { describe, expect, it } from "vitest";
import { RENDERER_VERSION, SECURE_RENDERER_VERSION } from "./version.ts";

describe("renderer versions", () => {
  it("are positive integers", () => {
    expect(RENDERER_VERSION).toMatch(/^[1-9][0-9]*$/);
    expect(SECURE_RENDERER_VERSION).toMatch(/^[1-9][0-9]*$/);
  });

  it("never require a version newer than the renderer", () => {
    expect(Number(SECURE_RENDERER_VERSION)).toBeLessThanOrEqual(Number(RENDERER_VERSION));
  });
});
