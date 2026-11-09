import { LIMITS } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  checkNoticeCapacity,
  NOTICE_EMAIL_RESERVE,
  NOTICE_EMAILS_PER_CYCLE,
  SIGN_IN_EMAILS_PER_CYCLE,
} from "./email.ts";
import {
  EXPIRY_NOTICE,
  groupNotices,
  noticeDue,
  noticeWindowEnd,
  ownerInCooldown,
  stillExpiring,
} from "./expiry-notices.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 8, 12);

describe("EXPIRY_NOTICE", () => {
  it("notifies three days ahead, at most daily, so every artifact gets two days of warning", () => {
    expect(EXPIRY_NOTICE.windowMs).toBe(3 * DAY);
    expect(EXPIRY_NOTICE.ownerCooldownMs).toBe(DAY);
    expect(EXPIRY_NOTICE.windowMs - EXPIRY_NOTICE.ownerCooldownMs).toBeGreaterThanOrEqual(2 * DAY);
    expect(noticeWindowEnd(NOW)).toBe(NOW + 3 * DAY);
  });
});

describe("noticeDue", () => {
  const due = { state: "active", expiresAt: NOW + 2 * DAY, expiryNoticeFor: null };

  it("is due for an active artifact expiring inside the window, at its exact end", () => {
    expect(noticeDue(due, NOW)).toBe(true);
    expect(noticeDue({ ...due, expiresAt: NOW + 3 * DAY }, NOW)).toBe(true);
    expect(noticeDue({ ...due, expiresAt: NOW + 1 }, NOW)).toBe(true);
  });

  it("is not due outside the window, once expired or without an expiry", () => {
    expect(noticeDue({ ...due, expiresAt: NOW + 3 * DAY + 1 }, NOW)).toBe(false);
    expect(noticeDue({ ...due, expiresAt: NOW }, NOW)).toBe(false);
    expect(noticeDue({ ...due, expiresAt: null }, NOW)).toBe(false);
  });

  it("is not due for artifacts that are not active", () => {
    for (const state of ["draft", "archived", "suspended", "purging", "deleted"]) {
      expect(noticeDue({ ...due, state }, NOW)).toBe(false);
    }
  });

  it("is due once per expiry: notified for this expiry no, for an earlier one yes", () => {
    expect(noticeDue({ ...due, expiryNoticeFor: due.expiresAt }, NOW)).toBe(false);
    expect(noticeDue({ ...due, expiryNoticeFor: due.expiresAt - 30 * DAY }, NOW)).toBe(true);
  });
});

describe("ownerInCooldown", () => {
  it("holds a second notice for a day after the last one, to the millisecond", () => {
    expect(ownerInCooldown(null, NOW)).toBe(false);
    expect(ownerInCooldown(NOW - HOUR, NOW)).toBe(true);
    expect(ownerInCooldown(NOW - DAY + 1, NOW)).toBe(true);
    expect(ownerInCooldown(NOW - DAY, NOW)).toBe(false);
  });
});

describe("groupNotices", () => {
  it("groups per owner with the soonest expiry first and a stable order on ties", () => {
    const groups = groupNotices([
      { ownerId: "a", id: "a3", expiresAt: NOW + 2 * DAY },
      { ownerId: "b", id: "b1", expiresAt: NOW + DAY },
      { ownerId: "a", id: "a2", expiresAt: NOW + DAY },
      { ownerId: "a", id: "a1", expiresAt: NOW + DAY },
    ]);
    expect([...groups.keys()]).toEqual(["a", "b"]);
    expect(groups.get("a")).toEqual([
      { id: "a1", expiresAt: NOW + DAY },
      { id: "a2", expiresAt: NOW + DAY },
      { id: "a3", expiresAt: NOW + 2 * DAY },
    ]);
    expect(groups.get("b")).toEqual([{ id: "b1", expiresAt: NOW + DAY }]);
    expect(groupNotices([]).size).toBe(0);
  });

  it("lists at most the active artifact limit in one notice", () => {
    const many = Array.from({ length: LIMITS.activeArtifacts + 3 }, (_, i) => ({
      ownerId: "a",
      id: `id${String(i).padStart(3, "0")}`,
      expiresAt: NOW + DAY + i,
    }));
    const group = groupNotices(many).get("a") ?? [];
    expect(group).toHaveLength(LIMITS.activeArtifacts);
    expect(group[0]?.id).toBe("id000");
  });
});

describe("stillExpiring", () => {
  const entry = { id: "k7d2qm4xab", expiresAt: NOW + DAY };
  const current = { ownerId: "u1", state: "active", expiresAt: NOW + DAY };

  it("keeps an artifact that is unchanged since the notice was scheduled", () => {
    expect(stillExpiring(entry, current, "u1", NOW)).toBe(true);
  });

  it("drops one renewed, published again, archived, gone, moved or already expired", () => {
    expect(stillExpiring(entry, { ...current, expiresAt: NOW + 30 * DAY }, "u1", NOW)).toBe(false);
    expect(stillExpiring(entry, { ...current, state: "archived" }, "u1", NOW)).toBe(false);
    expect(stillExpiring(entry, undefined, "u1", NOW)).toBe(false);
    expect(stillExpiring(entry, current, "u2", NOW)).toBe(false);
    expect(stillExpiring(entry, current, "u1", NOW + DAY)).toBe(false);
  });
});

describe("checkNoticeCapacity", () => {
  it("stops notices with a reserve left for sign-in codes", () => {
    expect(NOTICE_EMAILS_PER_CYCLE).toBe(SIGN_IN_EMAILS_PER_CYCLE - NOTICE_EMAIL_RESERVE);
    expect(NOTICE_EMAIL_RESERVE).toBeGreaterThan(0);
    expect(checkNoticeCapacity(NOTICE_EMAILS_PER_CYCLE - 1)).toEqual({ ok: true, value: true });
    expect(checkNoticeCapacity(NOTICE_EMAILS_PER_CYCLE)).toMatchObject({
      ok: false,
      code: "capacity_unavailable",
    });
  });
});
