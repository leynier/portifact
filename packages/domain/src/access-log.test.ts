import { describe, expect, it } from "vitest";
import {
  ACCESS_RETENTION_MS,
  ACCESS_WINDOW_MS,
  accessLogCutoff,
  accessWindow,
  isLoggedOpening,
} from "./access-log.ts";

const T = Date.UTC(2026, 10, 8, 12, 0, 0);

describe("access log windows", () => {
  it("uses 30-minute windows and 30 days of retention", () => {
    expect(ACCESS_WINDOW_MS).toBe(30 * 60_000);
    expect(ACCESS_RETENTION_MS).toBe(30 * 24 * 60 * 60_000);
  });

  it("puts every instant of a window in the same window and the next one in another", () => {
    expect(accessWindow(T)).toBe(T);
    expect(accessWindow(T + 1)).toBe(T);
    expect(accessWindow(T + ACCESS_WINDOW_MS - 1)).toBe(T);
    expect(accessWindow(T + ACCESS_WINDOW_MS)).toBe(T + ACCESS_WINDOW_MS);
    expect(accessWindow(T - 1)).toBe(T - ACCESS_WINDOW_MS);
  });

  it("keeps openings for exactly the retention period", () => {
    expect(accessLogCutoff(T)).toBe(T - ACCESS_RETENTION_MS);
  });
});

describe("logged openings", () => {
  const base = { navigation: true, visitorId: "reader", ownerId: "owner" };

  it("records a page load by a signed-in visitor", () => {
    expect(isLoggedOpening(base)).toBe(true);
  });

  it("never records subresources, anonymous visits or the owner's own visits", () => {
    expect(isLoggedOpening({ ...base, navigation: false })).toBe(false);
    expect(isLoggedOpening({ ...base, visitorId: null })).toBe(false);
    expect(isLoggedOpening({ ...base, visitorId: "owner" })).toBe(false);
  });
});
