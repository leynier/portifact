import { TERMS_VERSION } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import { needsTermsAcceptance, termsRefusalMessage, usableWithoutCurrentTerms } from "./terms.ts";

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

describe("usableWithoutCurrentTerms", () => {
  it("keeps reading and downloading available", () => {
    expect(usableWithoutCurrentTerms(["artifacts:read"])).toBe(true);
    expect(usableWithoutCurrentTerms(["annotations:read"])).toBe(true);
    expect(usableWithoutCurrentTerms(["artifacts:read", "annotations:read"])).toBe(true);
    expect(usableWithoutCurrentTerms([])).toBe(true);
  });

  it("refuses anything that changes data or manages credentials", () => {
    for (const scope of [
      "artifacts:write",
      "artifacts:share",
      "artifacts:delete",
      "annotations:write",
      "annotations:moderate",
      "credentials:manage",
    ]) {
      expect(usableWithoutCurrentTerms([scope]), scope).toBe(false);
      expect(usableWithoutCurrentTerms(["artifacts:read", scope]), scope).toBe(false);
    }
  });
});

describe("termsRefusalMessage", () => {
  it("names the version and where to accept, and that nobody can accept for the holder", () => {
    const message = termsRefusalMessage("https://app.example.test", { version: "2027-01-01" });
    expect(message).toContain("version 2027-01-01");
    expect(message).toContain("open https://app.example.test in a browser");
    expect(message).toContain("Agree and continue");
    expect(message).toContain("no app or agent can accept them");
    expect(termsRefusalMessage("https://a.test")).toContain(TERMS_VERSION);
    expect(message).not.toContain("Ask the user");
  });

  it("tells an agent to hand the decision to the user", () => {
    const message = termsRefusalMessage("https://a.test", { agent: true });
    expect(message).toContain("no app or agent can accept them");
    expect(message).toMatch(/Ask the user to do it, and do not retry/);
  });
});
