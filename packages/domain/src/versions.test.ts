import { LIMITS, PLANS } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  previousVersionExpiry,
  previousVersionRetained,
  retentionCutoff,
  versionRetention,
} from "./versions.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-10T12:00:00Z");

describe("versionRetention", () => {
  it("is two previous versions for seven days on free, exactly the limits before plans", () => {
    expect(versionRetention(PLANS.free.limits)).toEqual({
      previousVersions: LIMITS.retainedPreviousVersions,
      days: LIMITS.previousVersionRetentionDays,
    });
    expect(versionRetention(PLANS.free.limits)).toEqual({ previousVersions: 2, days: 7 });
  });

  it("follows the plan's values on paid plans", () => {
    expect(versionRetention(PLANS.pro.limits)).toEqual({ previousVersions: 50, days: 90 });
    expect(versionRetention(PLANS.team.limits)).toEqual({ previousVersions: 100, days: 365 });
  });
});

describe("retentionCutoff and previousVersionExpiry", () => {
  it("count the retention days from the moment a version was replaced", () => {
    const free = { previousVersions: 2, days: 7 };
    expect(retentionCutoff(free, NOW)).toBe(NOW - 7 * DAY);
    expect(previousVersionExpiry(NOW, free)).toBe(NOW + 7 * DAY);
    expect(previousVersionExpiry(NOW, { previousVersions: 50, days: 90 })).toBe(NOW + 90 * DAY);
  });
});

describe("previousVersionRetained", () => {
  const free = { previousVersions: 2, days: 7 };
  const cases: [string, { supersededAt: number; newer: number }, boolean][] = [
    ["just replaced, the newest previous version", { supersededAt: NOW, newer: 0 }, true],
    ["the second previous version", { supersededAt: NOW - DAY, newer: 1 }, true],
    ["the third previous version, inside the days", { supersededAt: NOW - DAY, newer: 2 }, false],
    ["one millisecond before the days end", { supersededAt: NOW - 7 * DAY + 1, newer: 0 }, true],
    ["exactly when the days end", { supersededAt: NOW - 7 * DAY, newer: 0 }, false],
    ["past the days", { supersededAt: NOW - 8 * DAY, newer: 0 }, false],
  ];
  it.each(cases)("%s", (_label, version, retained) => {
    expect(previousVersionRetained(version, free, NOW)).toBe(retained);
  });

  it("keeps on Pro what free has already dropped", () => {
    const pro = { previousVersions: 50, days: 90 };
    const old = { supersededAt: NOW - 30 * DAY, newer: 10 };
    expect(previousVersionRetained(old, free, NOW)).toBe(false);
    expect(previousVersionRetained(old, pro, NOW)).toBe(true);
    expect(previousVersionRetained({ supersededAt: NOW, newer: 49 }, pro, NOW)).toBe(true);
    expect(previousVersionRetained({ supersededAt: NOW, newer: 50 }, pro, NOW)).toBe(false);
  });

  it("keeps none when a plan keeps no previous version", () => {
    expect(
      previousVersionRetained(
        { supersededAt: NOW, newer: 0 },
        { previousVersions: 0, days: 7 },
        NOW,
      ),
    ).toBe(false);
  });
});
