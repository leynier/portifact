import { describe, expect, it } from "vitest";
import { generateArtifactId, isArtifactId } from "./ids.ts";

describe("artifact ids", () => {
  it("generates valid, distinct ids from the platform CSPRNG", () => {
    const ids = new Set(Array.from({ length: 2_000 }, () => generateArtifactId()));
    expect(ids.size).toBe(2_000);
    for (const id of ids) expect(isArtifactId(id)).toBe(true);
  });

  it("maps bytes onto the base32 alphabet without bias", () => {
    const counts = new Map<string, number>();
    let next = 0;
    const id = () =>
      generateArtifactId((bytes) => {
        for (let i = 0; i < bytes.length; i++) bytes[i] = next++ % 256;
      });
    for (let i = 0; i < 256 * 4; i++)
      for (const char of id()) counts.set(char, (counts.get(char) ?? 0) + 1);
    expect(counts.size).toBe(32);
    expect(new Set(counts.values()).size).toBe(1);
  });

  it("validates the id format", () => {
    expect(isArtifactId("k7d2qm4xab")).toBe(true);
    expect(isArtifactId("K7D2QM4XAB")).toBe(false);
    expect(isArtifactId("k7d2qm4x1b")).toBe(false);
    expect(isArtifactId("short")).toBe(false);
  });
});
