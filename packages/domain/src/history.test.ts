import { describe, expect, it } from "vitest";
import {
  CLOSED_UPLOAD_RETENTION_DAYS,
  daysBefore,
  ERASED_ACCOUNT,
  EXPIRED_AUTH_GRACE_MS,
  HISTORY_RETENTION_DAYS,
  historyCutoff,
  STALE_FINDING_DAYS,
  UNUSED_APP_REGISTRATION_DAYS,
  USAGE_EVENT_RETENTION_DAYS,
} from "./history.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 12);

describe("history retention", () => {
  it("keeps lifecycle and moderation records a year after what they describe went", () => {
    expect(HISTORY_RETENTION_DAYS).toBe(365);
    expect(historyCutoff(NOW)).toBe(NOW - 365 * DAY);
  });

  it("counts other retention periods in whole days before now", () => {
    expect(daysBefore(NOW, 7)).toBe(NOW - 7 * DAY);
    expect(daysBefore(NOW, 0)).toBe(NOW);
  });

  it("keeps usage events longer than the 24-hour windows that count them", () => {
    expect(USAGE_EVENT_RETENTION_DAYS * DAY).toBeGreaterThan(DAY);
  });

  it("keeps closed uploads, stale findings and unused registrations for the documented periods", () => {
    expect(CLOSED_UPLOAD_RETENTION_DAYS).toBe(30);
    expect(STALE_FINDING_DAYS).toBe(90);
    expect(UNUSED_APP_REGISTRATION_DAYS).toBe(30);
    expect(EXPIRED_AUTH_GRACE_MS).toBe(DAY);
  });

  it("erases an account's ID with a value that names no account", () => {
    expect(ERASED_ACCOUNT).toBe("deleted");
    expect(ERASED_ACCOUNT.startsWith("u_")).toBe(false);
  });
});
