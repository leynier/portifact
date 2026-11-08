import { LIMITS } from "@portifact/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  nextMonthStart,
  publicAccessFrom,
  type UsageSnapshot,
  usageBlocks,
  windowReleaseAt,
  windowTotal,
} from "./usage.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-20T12:00:00Z");

const quiet: UsageSnapshot = {
  now: NOW,
  accountCreatedAt: NOW - 30 * DAY,
  activeArtifacts: 3,
  storedBytes: 1_000,
  reservedBytes: 0,
  openUploads: 0,
  firstUploadExpiry: null,
  newObjectsThisMonth: 10,
  publishes: [{ at: NOW - 1_000, amount: 1 }],
  newFiles: [{ at: NOW - 1_000, amount: 3 }],
  newBytes: [{ at: NOW - 1_000, amount: 1_000 }],
};

describe("windowReleaseAt", () => {
  it("is null while the window has room", () => {
    expect(windowReleaseAt([{ at: 1, amount: 4 }], 5)).toBeNull();
    expect(windowReleaseAt([], 1)).toBeNull();
  });

  it("frees room when enough of the oldest events leave the window", () => {
    const events = [
      { at: 100, amount: 2 },
      { at: 200, amount: 2 },
      { at: 300, amount: 2 },
    ];
    // Total 6, limit 5: dropping the first event leaves 4 < 5.
    expect(windowReleaseAt(events, 5, 1_000)).toBe(1_100);
    // Limit 3: the first two events must leave.
    expect(windowReleaseAt(events, 3, 1_000)).toBe(1_200);
    // Limit 1: every event must leave.
    expect(windowReleaseAt(events, 1, 1_000)).toBe(1_300);
  });

  it("returns a time when the remaining total is below the limit, for any window", () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat(50), { minLength: 1, maxLength: 30 }),
        fc.integer({ min: 1, max: 400 }),
        (amounts, limit) => {
          const events = amounts.map((amount, index) => ({ at: index * 10, amount }));
          const release = windowReleaseAt(events, limit, 1_000);
          if (windowTotal(events) < limit) return release === null;
          if (release === null) return false;
          const left = events.filter((event) => event.at + 1_000 > release);
          const dropped = events.filter((event) => event.at + 1_000 <= release);
          const leftBefore = [...left, dropped.at(-1) as (typeof events)[number]];
          return windowTotal(left) < limit && windowTotal(leftBefore) >= limit;
        },
      ),
    );
  });
});

describe("usageBlocks", () => {
  it("reports nothing for an account within its limits", () => {
    expect(usageBlocks(quiet)).toEqual([]);
  });

  it("stops new artifacts, not updates, at the active limit", () => {
    expect(usageBlocks({ ...quiet, activeArtifacts: LIMITS.activeArtifacts })).toEqual([
      expect.objectContaining({ reason: "active_artifacts", stops: "new_artifacts", until: null }),
    ]);
    expect(usageBlocks({ ...quiet, activeArtifacts: LIMITS.activeArtifacts - 1 })).toEqual([]);
  });

  it("counts reserved bytes toward storage", () => {
    const full = { ...quiet, storedBytes: LIMITS.accountBytes - 10, reservedBytes: 10 };
    expect(usageBlocks(full).map((block) => block.reason)).toEqual(["storage"]);
    expect(usageBlocks({ ...full, reservedBytes: 9 })).toEqual([]);
  });

  it("lifts the 24-hour blocks when the oldest events leave the window", () => {
    const publishes = Array.from({ length: LIMITS.publishesPer24h }, (_, i) => ({
      at: NOW - DAY + 60_000 * (i + 1),
      amount: 1,
    }));
    const [block] = usageBlocks({ ...quiet, publishes });
    expect(block).toEqual({
      reason: "publishes_per_24h",
      stops: "publishing",
      message: expect.stringContaining("100"),
      until: NOW + 60_000,
    });

    const files = [{ at: NOW - 1_000, amount: LIMITS.newFilesPer24h }];
    const bytes = [{ at: NOW - 2_000, amount: LIMITS.newBytesPer24h }];
    expect(usageBlocks({ ...quiet, newFiles: files, newBytes: bytes })).toEqual([
      expect.objectContaining({ reason: "new_files_per_24h", until: NOW - 1_000 + DAY }),
      expect.objectContaining({ reason: "new_bytes_per_24h", until: NOW - 2_000 + DAY }),
    ]);
  });

  it("lifts the upload block when the oldest upload expires", () => {
    const expiry = NOW + 3_600_000;
    expect(
      usageBlocks({ ...quiet, openUploads: LIMITS.concurrentUploads, firstUploadExpiry: expiry }),
    ).toEqual([expect.objectContaining({ reason: "open_uploads", until: expiry })]);
  });

  it("lifts the monthly block at the start of the next month", () => {
    expect(usageBlocks({ ...quiet, newObjectsThisMonth: LIMITS.newObjectsPerMonth })).toEqual([
      expect.objectContaining({
        reason: "new_objects_per_month",
        until: Date.parse("2026-12-01T00:00:00Z"),
      }),
    ]);
  });

  it("stops public access during the account's first seven days", () => {
    const createdAt = NOW - DAY;
    expect(usageBlocks({ ...quiet, accountCreatedAt: createdAt })).toEqual([
      {
        reason: "account_too_new_for_public",
        stops: "public_access",
        message: expect.stringContaining("7 days"),
        until: createdAt + 7 * DAY,
      },
    ]);
    expect(usageBlocks({ ...quiet, accountCreatedAt: NOW - 7 * DAY })).toEqual([]);
  });
});

describe("dates", () => {
  it("finds the next month across a year boundary", () => {
    expect(nextMonthStart(Date.parse("2026-12-31T23:59:59Z"))).toBe(
      Date.parse("2027-01-01T00:00:00Z"),
    );
  });

  it("allows public access seven days after sign-up", () => {
    expect(publicAccessFrom(0)).toBe(7 * DAY);
  });
});
