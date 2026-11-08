import { MULTIPART } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import { DEFAULT_MULTIPART, isPlannedPart, partRange, planParts } from "./multipart.ts";

const MiB = 1024 * 1024;

describe("planParts", () => {
  it("uploads objects up to 64 MiB in one request", () => {
    expect(planParts(0)).toBeNull();
    expect(planParts(64 * MiB)).toBeNull();
  });

  it("splits objects over 64 MiB into 16 MiB parts", () => {
    expect(planParts(64 * MiB + 1)).toEqual({ partSize: 16 * MiB, partCount: 5 });
    expect(planParts(250_000_000)).toEqual({ partSize: 16 * MiB, partCount: 15 });
  });

  it("follows an injected threshold and part size", () => {
    expect(planParts(12 * MiB, { thresholdBytes: 10 * MiB, partBytes: 5 * MiB })).toEqual({
      partSize: 5 * MiB,
      partCount: 3,
    });
    expect(planParts(10 * MiB, { thresholdBytes: 10 * MiB, partBytes: 5 * MiB })).toBeNull();
  });

  it("never plans parts below R2's minimum", () => {
    expect(planParts(100, { thresholdBytes: 10, partBytes: 1 })).toEqual({
      partSize: MULTIPART.minPartBytes,
      partCount: 1,
    });
  });

  it("grows the part size so the part count stays within R2's maximum", () => {
    const size = MULTIPART.maxParts * DEFAULT_MULTIPART.partBytes + 1;
    const plan = planParts(size);
    expect(plan?.partCount).toBeLessThanOrEqual(MULTIPART.maxParts);
    expect(plan?.partSize).toBeGreaterThan(DEFAULT_MULTIPART.partBytes);
  });
});

describe("partRange", () => {
  const plan = { partSize: 5 * MiB, partCount: 3 };

  it("gives full parts and a shorter last part", () => {
    expect(partRange(12 * MiB, plan, 1)).toEqual({ offset: 0, size: 5 * MiB });
    expect(partRange(12 * MiB, plan, 2)).toEqual({ offset: 5 * MiB, size: 5 * MiB });
    expect(partRange(12 * MiB, plan, 3)).toEqual({ offset: 10 * MiB, size: 2 * MiB });
  });

  it("knows which part numbers belong to the plan", () => {
    expect(isPlannedPart(plan, 1)).toBe(true);
    expect(isPlannedPart(plan, 3)).toBe(true);
    expect(isPlannedPart(plan, 0)).toBe(false);
    expect(isPlannedPart(plan, 4)).toBe(false);
    expect(isPlannedPart(plan, 1.5)).toBe(false);
  });
});
