import { describe, expect, it } from "vitest";
import { checkModerationNoticeCapacity, SIGN_IN_EMAILS_PER_CYCLE } from "./email.ts";
import { checkHoldPlacement, decisionSource, reporterNameKept } from "./moderation.ts";

describe("moderation rules", () => {
  it("takes the source the operator gives, or a notice when a report is named", () => {
    expect(decisionSource(undefined, "rep_1")).toBe("notice");
    expect(decisionSource(undefined, undefined)).toBe("review");
    expect(decisionSource("review", "rep_1")).toBe("review");
    expect(decisionSource("notice", undefined)).toBe("notice");
  });

  it("never keeps a reporter's name for child safety reports", () => {
    expect(reporterNameKept("child_safety", "Ada")).toBeNull();
    expect(reporterNameKept("phishing", "  Ada  ")).toBe("Ada");
    expect(reporterNameKept("phishing", "  ")).toBeNull();
    expect(reporterNameKept("phishing", undefined)).toBeNull();
  });

  it("holds only suspended artifacts, with a future release date", () => {
    expect(checkHoldPlacement("suspended", null, 10).ok).toBe(true);
    expect(checkHoldPlacement("suspended", 11, 10).ok).toBe(true);
    const active = checkHoldPlacement("active", null, 10);
    expect(active.ok).toBe(false);
    expect(!active.ok && active.code).toBe("invalid_input");
    expect(checkHoldPlacement("suspended", 10, 10).ok).toBe(false);
  });

  it("sends moderation emails until sign-in codes stop", () => {
    expect(checkModerationNoticeCapacity(SIGN_IN_EMAILS_PER_CYCLE - 1).ok).toBe(true);
    expect(checkModerationNoticeCapacity(SIGN_IN_EMAILS_PER_CYCLE).ok).toBe(false);
  });
});
