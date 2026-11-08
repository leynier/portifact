import { describe, expect, it } from "vitest";
import {
  MAX_REFRESH_INTERVAL_MS,
  REFRESH_INTERVAL_MS,
  refreshInterval,
  refreshOptions,
} from "./refresh.ts";

describe("dashboard refresh policy", () => {
  it("refreshes every 30 seconds while nothing fails", () => {
    expect(REFRESH_INTERVAL_MS).toBe(30_000);
    expect(refreshInterval(0)).toBe(30_000);
  });

  it("waits twice as long after each consecutive failure, up to five minutes", () => {
    expect(refreshInterval(1)).toBe(60_000);
    expect(refreshInterval(2)).toBe(120_000);
    expect(refreshInterval(3)).toBe(240_000);
    expect(refreshInterval(4)).toBe(MAX_REFRESH_INTERVAL_MS);
    expect(refreshInterval(40)).toBe(300_000);
    expect(refreshInterval(-1)).toBe(30_000);
  });

  it("never refreshes in a hidden tab and treats data as fresh for one interval", () => {
    expect(refreshOptions.refetchIntervalInBackground).toBe(false);
    expect(refreshOptions.staleTime).toBe(30_000);
    expect(refreshOptions.refetchInterval({ state: { fetchFailureCount: 2 } })).toBe(120_000);
  });
});
