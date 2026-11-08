import { TERMS_VERSION } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import { needsTermsAcceptance } from "./terms.ts";

describe("needsTermsAcceptance", () => {
  it("lets through an account that accepted the current version", () => {
    expect(needsTermsAcceptance(TERMS_VERSION)).toBe(false);
  });

  it("asks an account that never accepted", () => {
    expect(needsTermsAcceptance(null)).toBe(true);
    expect(needsTermsAcceptance(undefined)).toBe(true);
  });

  it("asks again when the terms change", () => {
    expect(needsTermsAcceptance("2026-11-08", "2027-01-01")).toBe(true);
  });
});
