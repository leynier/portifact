import { ACCOUNT_DELETION_CODE, OTP_LIMITS, TERMS_VERSION } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  deletionCodeExpiresAt,
  deletionCodeFrom,
  deletionCodeRedeemable,
  mayLeaveWithCode,
} from "./account-deletion-code.ts";

describe("account deletion codes", () => {
  it("are offered only to accounts without the current terms", () => {
    expect(mayLeaveWithCode(null)).toBe(true);
    expect(mayLeaveWithCode(undefined)).toBe(true);
    expect(mayLeaveWithCode("2000-01-01")).toBe(true);
    expect(mayLeaveWithCode(TERMS_VERSION)).toBe(false);
  });

  it("have the sign-in code's lifetime and attempts", () => {
    expect(ACCOUNT_DELETION_CODE.codeTtlSeconds).toBe(OTP_LIMITS.codeTtlSeconds);
    expect(ACCOUNT_DELETION_CODE.allowedAttempts).toBe(OTP_LIMITS.allowedAttempts);
    expect(deletionCodeExpiresAt(1_000)).toBe(1_000 + 300_000);
  });

  it("are six digits, padded, and skip draws that would bias them", () => {
    expect(deletionCodeFrom(() => 42)).toBe("000042");
    expect(deletionCodeFrom(() => 4_293_999_999)).toBe("999999");
    const draws = [4_294_000_000, 0xffffffff, 1_234_567];
    expect(deletionCodeFrom(() => draws.shift() ?? 0)).toBe("234567");
    expect(draws).toEqual([]);
  });

  it("can be tried until they expire or run out of attempts", () => {
    expect(deletionCodeRedeemable({ expiresAt: 2, attempts: 0 }, 1)).toBe(true);
    expect(deletionCodeRedeemable({ expiresAt: 2, attempts: 2 }, 1)).toBe(true);
    expect(deletionCodeRedeemable({ expiresAt: 2, attempts: 3 }, 1)).toBe(false);
    expect(deletionCodeRedeemable({ expiresAt: 1, attempts: 0 }, 1)).toBe(false);
  });
});
