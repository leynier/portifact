import { describe, expect, it } from "vitest";
import { ApiError, ArtifactId, Email, ErrorCode, LIMITS } from "./index.ts";

describe("contracts", () => {
  it("accepts only 10-character lowercase base32 artifact ids", () => {
    expect(ArtifactId.safeParse("k7d2qm4xab").success).toBe(true);
    for (const bad of ["k7d2qm4xa", "k7d2qm4xab1", "K7D2QM4XAB", "k7d2qm4x0b", "k7d2qm4x-b"]) {
      expect(ArtifactId.safeParse(bad).success).toBe(false);
    }
  });

  it("lowercases emails so access lists compare reliably", () => {
    expect(Email.parse("Ana@Example.COM")).toBe("ana@example.com");
    expect(Email.safeParse("not-an-email").success).toBe(false);
  });

  it("describes errors with a known code", () => {
    const valid = { error: { code: "quota_exceeded", message: "Too many artifacts." } };
    expect(ApiError.parse(valid)).toEqual(valid);
    expect(ApiError.safeParse({ error: { code: "teapot", message: "x" } }).success).toBe(false);
    expect(ErrorCode.options).toContain("version_conflict");
  });

  it("keeps the product limits from the plan in decimal units", () => {
    expect(LIMITS.artifactBytes).toBe(250_000_000);
    expect(LIMITS.accountBytes).toBe(2_500_000_000);
    expect(LIMITS.activeArtifacts).toBe(50);
    expect(LIMITS.publishesPer24h).toBe(100);
  });
});
