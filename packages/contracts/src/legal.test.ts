import { describe, expect, it } from "vitest";
import { TERMS_VERSION, TermsAcceptanceInput } from "./index.ts";

describe("terms acceptance input", () => {
  const valid = { version: TERMS_VERSION, acceptTerms: true, confirmAdult: true };

  it("accepts the current version with both confirmations", () => {
    expect(TermsAcceptanceInput.parse(valid)).toEqual(valid);
  });

  it("refuses an older version, a missing confirmation or extra fields", () => {
    for (const bad of [
      { ...valid, version: "2000-01-01" },
      { ...valid, acceptTerms: false },
      { ...valid, confirmAdult: false },
      { version: TERMS_VERSION, acceptTerms: true },
      { ...valid, userId: "someone-else" },
    ]) {
      expect(TermsAcceptanceInput.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("names the version as an ISO date", () => {
    expect(TERMS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
