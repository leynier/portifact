import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ADMISSION_LIMITS } from "./budget.ts";
import {
  checkEmailCapacity,
  EMAIL_RESERVE,
  emailDay,
  emailHint,
  normalizeEmail,
  SIGN_IN_EMAILS_PER_CYCLE,
  SUPPRESSION_TTL_MS,
  suppressionExpiry,
  suppressionForEvent,
} from "./email.ts";

const DAY = 86_400_000;
const event = (type: string, bounce?: string) => ({
  type,
  payload: { eventId: "e1", recipient: "a@example.test", bounce: bounce ? { type: bounce } : {} },
});

describe("checkEmailCapacity", () => {
  it("keeps a reserve below the admission limit, so codes alone never stop publishing", () => {
    expect(SIGN_IN_EMAILS_PER_CYCLE).toBe(ADMISSION_LIMITS.emails - EMAIL_RESERVE);
    expect(EMAIL_RESERVE).toBeGreaterThan(0);
  });

  it("admits sends up to the cycle's cap and refuses from it", () => {
    expect(checkEmailCapacity(0)).toEqual({ ok: true, value: true });
    expect(checkEmailCapacity(SIGN_IN_EMAILS_PER_CYCLE - 1).ok).toBe(true);
    const full = checkEmailCapacity(SIGN_IN_EMAILS_PER_CYCLE);
    expect(full).toMatchObject({ ok: false, code: "capacity_unavailable" });
    expect(full.ok ? "" : full.message).toContain("Google or GitHub");
    expect(checkEmailCapacity(SIGN_IN_EMAILS_PER_CYCLE + 5).ok).toBe(false);
  });
});

describe("suppressionForEvent", () => {
  it("suppresses every complaint and only hard bounces", () => {
    expect(suppressionForEvent(event("cf.email.sending.message.complained"))).toBe("complaint");
    expect(suppressionForEvent(event("cf.email.sending.message.bounced", "hard"))).toBe(
      "hard_bounce",
    );
    expect(suppressionForEvent(event("message.bounced", "hard"))).toBe("hard_bounce");
  });

  it("ignores soft bounces, deferrals, deliveries and unknown events", () => {
    for (const e of [
      event("cf.email.sending.message.bounced", "soft"),
      event("cf.email.sending.message.bounced"),
      event("cf.email.sending.message.deferred", "soft"),
      event("cf.email.sending.message.delivered"),
      event("cf.email.sending.message.failed", "hard"),
      event("something.else"),
    ]) {
      expect(suppressionForEvent(e), e.type).toBeNull();
    }
  });
});

describe("suppression retention", () => {
  it("keeps complaints longest and provider refusals shortest", () => {
    expect(SUPPRESSION_TTL_MS.complaint).toBe(180 * DAY);
    expect(SUPPRESSION_TTL_MS.hard_bounce).toBe(30 * DAY);
    expect(SUPPRESSION_TTL_MS.provider).toBe(7 * DAY);
    expect(suppressionExpiry("hard_bounce", 1_000)).toBe(1_000 + 30 * DAY);
  });
});

describe("addresses", () => {
  it("normalizes case and surrounding spaces", () => {
    expect(normalizeEmail("  Ana@Example.COM ")).toBe("ana@example.com");
  });

  it("masks all but the first character and the domain", () => {
    expect(emailHint("Ana.Lopez@Example.com")).toBe("a***@example.com");
    expect(emailHint("x@y.z")).toBe("x***@y.z");
    expect(emailHint("@nouser.test")).toBe("***");
    expect(emailHint("no-at-sign")).toBe("***");
  });

  it("never shows more of the local part than its first character", () => {
    fc.assert(
      fc.property(fc.emailAddress(), (email) => {
        const hint = emailHint(email);
        const local = normalizeEmail(email).slice(0, normalizeEmail(email).lastIndexOf("@"));
        return local.length <= 1 || !hint.includes(local);
      }),
    );
  });
});

describe("emailDay", () => {
  it("is the start of the UTC day", () => {
    expect(emailDay(Date.parse("2026-11-20T23:59:59.999Z"))).toBe(Date.parse("2026-11-20"));
    expect(emailDay(Date.parse("2026-11-21T00:00:00Z"))).toBe(Date.parse("2026-11-21"));
  });
});
