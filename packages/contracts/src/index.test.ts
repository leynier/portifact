import { describe, expect, it } from "vitest";
import {
  ApiError,
  ArtifactId,
  Email,
  ErrorCode,
  LIMITS,
  OAuthScope,
  OTP_LIMITS,
  TokenPrincipal,
} from "./index.ts";

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

  it("lists the seven OAuth scopes from the plan and nothing else", () => {
    expect(OAuthScope.options).toEqual([
      "artifacts:read",
      "artifacts:write",
      "artifacts:share",
      "artifacts:delete",
      "annotations:read",
      "annotations:write",
      "annotations:moderate",
    ]);
    expect(OAuthScope.safeParse("admin").success).toBe(false);
  });

  it("requires a user and a client in a token principal", () => {
    const principal = { userId: "u1", clientId: "portifact-cli", scopes: ["artifacts:read"] };
    expect(TokenPrincipal.parse(principal)).toEqual(principal);
    expect(TokenPrincipal.safeParse({ ...principal, userId: "" }).success).toBe(false);
    expect(TokenPrincipal.safeParse({ ...principal, clientId: "" }).success).toBe(false);
  });

  it("keeps sign-in codes short-lived with a cooldown below the hourly limit", () => {
    expect(OTP_LIMITS.codeTtlSeconds).toBe(300);
    expect(OTP_LIMITS.allowedAttempts).toBe(3);
    expect(OTP_LIMITS.perEmailCooldown.max).toBeLessThan(OTP_LIMITS.perEmail.max);
    expect(OTP_LIMITS.perEmail.max).toBeLessThan(OTP_LIMITS.perIp.max);
    // The plan's admission limit is 20,000 emails a month.
    expect(OTP_LIMITS.global.max * 31).toBeLessThanOrEqual(20_000);
    expect(ErrorCode.options).toContain("rate_limited");
  });
});
