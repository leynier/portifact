import { SHARE_LINKS, SHARE_OPEN_LIMITS } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import { isLoggedLinkOpening } from "./access-log.ts";
import { entitlements } from "./plans.ts";
import {
  checkShareExpiry,
  passwordGate,
  SHARE_MESSAGES,
  shareLinkOpens,
  shareLinkStatus,
  shareSessionExpiry,
  shareUsedDay,
} from "./share-links.ts";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const DAY = 86_400_000;
const pro = entitlements({ plan: "pro", seats: 1, validUntil: null, overrides: null }, NOW);
const free = entitlements(null, NOW);

describe("shareLinkStatus", () => {
  it("is active without a revocation or an expiry in the past", () => {
    expect(shareLinkStatus({ expiresAt: null, revokedAt: null }, NOW)).toBe("active");
    expect(shareLinkStatus({ expiresAt: NOW + 1, revokedAt: null }, NOW)).toBe("active");
  });

  it("expires exactly at its expiry", () => {
    expect(shareLinkStatus({ expiresAt: NOW, revokedAt: null }, NOW)).toBe("expired");
    expect(shareLinkStatus({ expiresAt: NOW - 1, revokedAt: null }, NOW)).toBe("expired");
  });

  it("is revoked once revoked, whatever its expiry", () => {
    expect(shareLinkStatus({ expiresAt: NOW - 1, revokedAt: NOW - 2 }, NOW)).toBe("revoked");
    expect(shareLinkStatus({ expiresAt: null, revokedAt: 0 }, NOW)).toBe("revoked");
  });
});

describe("checkShareExpiry", () => {
  it("accepts no expiry and any time in the next 365 days", () => {
    expect(checkShareExpiry(null, NOW)).toEqual({ ok: true, value: null });
    expect(checkShareExpiry(NOW + 1, NOW)).toEqual({ ok: true, value: NOW + 1 });
    const last = NOW + SHARE_LINKS.maxExpiryDays * DAY;
    expect(checkShareExpiry(last, NOW)).toEqual({ ok: true, value: last });
  });

  it("refuses the past, now and anything after the maximum", () => {
    expect(checkShareExpiry(NOW, NOW)).toEqual({
      ok: false,
      code: "invalid_input",
      message: "expiresAt: Choose a time in the future.",
    });
    expect(checkShareExpiry(NOW - DAY, NOW).ok).toBe(false);
    expect(checkShareExpiry(NOW + SHARE_LINKS.maxExpiryDays * DAY + 1, NOW)).toEqual({
      ok: false,
      code: "invalid_input",
      message: "expiresAt: A link can last at most 365 days.",
    });
  });
});

describe("shareLinkOpens", () => {
  const live = { expiresAt: null, revokedAt: null };

  it("opens an active link of a servable artifact whose owner's plan has share links", () => {
    expect(shareLinkOpens({ link: live, servable: true, owner: pro }, NOW)).toBe(true);
  });

  it("does not open when any condition fails", () => {
    expect(shareLinkOpens({ link: live, servable: false, owner: pro }, NOW)).toBe(false);
    expect(shareLinkOpens({ link: live, servable: true, owner: free }, NOW)).toBe(false);
    expect(
      shareLinkOpens(
        { link: { expiresAt: NOW, revokedAt: null }, servable: true, owner: pro },
        NOW,
      ),
    ).toBe(false);
    expect(
      shareLinkOpens(
        { link: { expiresAt: null, revokedAt: NOW }, servable: true, owner: pro },
        NOW,
      ),
    ).toBe(false);
  });

  it("follows the plan: an expired grant pauses the link, a new one resumes it", () => {
    const lapsed = entitlements({ plan: "pro", seats: 1, validUntil: NOW, overrides: null }, NOW);
    expect(shareLinkOpens({ link: live, servable: true, owner: lapsed }, NOW)).toBe(false);
    const off = entitlements(
      { plan: "pro", seats: 1, validUntil: null, overrides: { features: { shareLinks: false } } },
      NOW,
    );
    expect(shareLinkOpens({ link: live, servable: true, owner: off }, NOW)).toBe(false);
  });
});

describe("shareSessionExpiry", () => {
  it("lasts 12 hours, or until the link expires when that is sooner", () => {
    const longest = NOW + SHARE_LINKS.sessionTtlSeconds * 1000;
    expect(shareSessionExpiry(null, NOW)).toBe(longest);
    expect(shareSessionExpiry(longest + 1, NOW)).toBe(longest);
    expect(shareSessionExpiry(NOW + 1000, NOW)).toBe(NOW + 1000);
  });
});

describe("shareUsedDay", () => {
  it("keeps only the UTC day", () => {
    expect(shareUsedDay(NOW)).toBe(Date.parse("2026-11-10T00:00:00Z"));
    expect(shareUsedDay(Date.parse("2026-11-10T23:59:59.999Z"))).toBe(
      Date.parse("2026-11-10T00:00:00Z"),
    );
  });
});

describe("passwordGate", () => {
  const { tokenHumanCheckAfter, ipHumanCheckAfter, tokenIpLockAfter, tokenCeiling } =
    SHARE_OPEN_LIMITS;

  it("uses the documented numbers", () => {
    expect([tokenHumanCheckAfter, ipHumanCheckAfter, tokenIpLockAfter, tokenCeiling]).toEqual([
      3, 5, 10, 100,
    ]);
  });

  // Counts include the attempt being decided.
  it.each([
    [{ token: 1, ip: 1, tokenIp: 1 }, "allowed"],
    [{ token: 3, ip: 5, tokenIp: 3 }, "allowed"],
    [{ token: 4, ip: 1, tokenIp: 1 }, "human_check"],
    [{ token: 1, ip: 6, tokenIp: 1 }, "human_check"],
    // Many IPs past the token's threshold: a solved human check still lets each one try.
    [{ token: 100, ip: 1, tokenIp: 1 }, "human_check"],
    // An office or carrier NAT past the IP's threshold is asked to solve the check, never refused.
    [{ token: 1, ip: 1000, tokenIp: 1 }, "human_check"],
    [{ token: 10, ip: 10, tokenIp: 10 }, "human_check"],
    // Only one token from one IP is locked...
    [{ token: 11, ip: 11, tokenIp: 11 }, "locked"],
    [{ token: 1, ip: 1, tokenIp: 11 }, "locked"],
    // ...or a token past the ceiling, which takes that many solved checks to reach.
    [{ token: 101, ip: 1, tokenIp: 1 }, "locked"],
  ] as const)("decides %o as %s", (attempts, gate) => {
    expect(passwordGate(attempts)).toBe(gate);
  });
});

describe("isLoggedLinkOpening", () => {
  it("records page loads of authenticated and restricted artifacts only", () => {
    expect(isLoggedLinkOpening({ navigation: true, accessMode: "restricted" })).toBe(true);
    expect(isLoggedLinkOpening({ navigation: true, accessMode: "authenticated" })).toBe(true);
    expect(isLoggedLinkOpening({ navigation: true, accessMode: "public" })).toBe(false);
    expect(isLoggedLinkOpening({ navigation: false, accessMode: "restricted" })).toBe(false);
  });
});

describe("SHARE_MESSAGES", () => {
  it("never tells a dead link from a wrong password", () => {
    expect(SHARE_MESSAGES.refused).toBe(
      "The password is wrong, or the link expired or was revoked.",
    );
    expect(SHARE_MESSAGES.unavailable).not.toContain("password");
  });
});
