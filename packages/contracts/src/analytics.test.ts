import { describe, expect, it } from "vitest";
import {
  ANALYTICS,
  ArtifactStatsQuery,
  ArtifactStatsView,
  GetArtifactStatsInput,
  StatsDate,
} from "./analytics.ts";

describe("StatsDate", () => {
  it("takes real calendar days only", () => {
    for (const day of ["2026-11-08", "2024-02-29", "2026-12-31"]) {
      expect(StatsDate.safeParse(day).success, day).toBe(true);
    }
    for (const day of ["2026-02-29", "2026-13-01", "2026-11-8", "yesterday", "2026-11-08T00:00Z"]) {
      expect(StatsDate.safeParse(day).success, day).toBe(false);
    }
  });
});

describe("analytics shapes", () => {
  it("caps a range at a year and a leap day and defaults to 30 days", () => {
    expect(ANALYTICS).toEqual({ defaultDays: 30, maxRangeDays: 366 });
  });

  it("parses the query and the tool input with optional days", () => {
    expect(ArtifactStatsQuery.parse({})).toEqual({});
    expect(ArtifactStatsQuery.safeParse({ from: "nope" }).success).toBe(false);
    expect(GetArtifactStatsInput.parse({ artifactId: "abcdefghij", to: "2026-11-08" })).toEqual({
      artifactId: "abcdefghij",
      to: "2026-11-08",
    });
  });

  it("allows null visitors and refuses negative counts", () => {
    const body = {
      artifactId: "abcdefghij",
      from: "2026-11-08",
      to: "2026-11-08",
      days: [{ date: "2026-11-08", views: 1, signedInViews: 0, visitors: null }],
      totals: { views: 1, signedInViews: 0, visitors: null },
      retentionDays: 30,
    };
    expect(ArtifactStatsView.parse(body)).toEqual(body);
    expect(
      ArtifactStatsView.safeParse({ ...body, totals: { ...body.totals, views: -1 } }).success,
    ).toBe(false);
    expect(ArtifactStatsView.safeParse({ ...body, retentionDays: 0 }).success).toBe(false);
  });
});
