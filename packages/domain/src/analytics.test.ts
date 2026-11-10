import { describe, expect, it } from "vitest";
import { accessLogCutoff } from "./access-log.ts";
import {
  DAY_MS,
  FREE_RETENTION_DAYS,
  formatDay,
  pageView,
  parseDay,
  retentionExpiry,
  type ServedPage,
  statsRange,
  utcDay,
  viewsExpireAt,
} from "./analytics.ts";
import { entitlements } from "./plans.ts";

const OWNER = "u_owner";
const VISITOR = "u_visitor";

const page = (overrides: Partial<ServedPage> = {}): ServedPage => ({
  method: "GET",
  fetchMode: "navigate",
  fetchDest: "document",
  fetchSite: "none",
  status: 200,
  isPage: true,
  viewerRedirect: false,
  visitorId: null,
  ownerId: OWNER,
  analytics: true,
  ...overrides,
});

describe("pageView", () => {
  it.each<[string, Partial<ServedPage>, ReturnType<typeof pageView>]>([
    // Bar off: the top-level document is the view.
    ["a top-level page, bar off", {}, "anonymous"],
    ["a top-level page with a session", { visitorId: VISITOR }, "signedIn"],
    ["a further page of a site, same origin", { fetchSite: "same-origin" }, "anonymous"],
    ["a revalidated reload", { status: 304 }, "anonymous"],
    ["a range of a page", { status: 206 }, "anonymous"],
    // Bar on: the redirect is not the view, the viewer's frame load is.
    ["the redirect to the viewer", { status: 303, viewerRedirect: true }, null],
    ["a redirect even if it said 200", { viewerRedirect: true }, null],
    ["the viewer's frame", { fetchDest: "iframe", fetchSite: "cross-site" }, "anonymous"],
    [
      "the viewer's frame in review mode",
      { fetchDest: "iframe", fetchSite: "cross-site", visitorId: VISITOR },
      "signedIn",
    ],
    ["a legacy frame element", { fetchDest: "frame", fetchSite: "cross-site" }, "anonymous"],
    ["another site's embed of the artifact", { fetchDest: "iframe" }, "anonymous"],
    ["a sibling artifact's frame", { fetchDest: "iframe", fetchSite: "same-site" }, null],
    ["an embed element", { fetchDest: "embed", fetchSite: "cross-site" }, null],
    ["an object element", { fetchDest: "object", fetchSite: "cross-site" }, null],
    // Never views.
    ["a subresource", { fetchMode: "no-cors", fetchDest: "image" }, null],
    ["a fetch", { fetchMode: "cors", fetchDest: "empty" }, null],
    ["a file that is not a page", { isPage: false }, null],
    ["HEAD", { method: "HEAD" }, null],
    ["no fetch metadata", { fetchMode: null, fetchDest: null, fetchSite: null }, null],
    ["only a mode", { fetchDest: null, fetchSite: null }, null],
    ["a document that is not a navigation", { fetchMode: "no-cors" }, null],
    ["a navigation with no destination", { fetchDest: null, fetchSite: "cross-site" }, null],
    ["a 404", { status: 404 }, null],
    ["a 429", { status: 429 }, null],
    ["a 503", { status: 503 }, null],
    ["the owner's own visit", { visitorId: OWNER }, null],
    [
      "the owner's own visit in the viewer",
      { visitorId: OWNER, fetchDest: "iframe", fetchSite: "cross-site" },
      null,
    ],
    ["an owner without analytics", { analytics: false }, null],
    [
      "a signed-in visitor of an owner without analytics",
      { analytics: false, visitorId: VISITOR },
      null,
    ],
  ])("%s", (_name, overrides, expected) => {
    expect(pageView(page(overrides))).toBe(expected);
  });
});

describe("days", () => {
  it("rounds to the UTC day and formats it", () => {
    const at = Date.UTC(2026, 10, 8, 23, 59, 59, 999);
    expect(utcDay(at)).toBe(Date.UTC(2026, 10, 8));
    expect(utcDay(Date.UTC(2026, 10, 9))).toBe(Date.UTC(2026, 10, 9));
    expect(formatDay(utcDay(at))).toBe("2026-11-08");
    expect(parseDay("2026-11-08")).toBe(Date.UTC(2026, 10, 8));
    expect(DAY_MS).toBe(86_400_000);
  });
});

describe("retention", () => {
  const NOW = Date.UTC(2026, 10, 8, 12);
  const free = entitlements(null, NOW);
  const pro = entitlements({ plan: "pro", seats: 1, validUntil: null, overrides: null }, NOW);

  it("keeps rows the plan's accessLogRetentionDays from their start", () => {
    expect(FREE_RETENTION_DAYS).toBe(30);
    expect(retentionExpiry(NOW, free)).toBe(NOW + 30 * DAY_MS);
    expect(retentionExpiry(NOW, pro)).toBe(NOW + 365 * DAY_MS);
  });

  it("never keeps past the plan's end more than the free plan would", () => {
    const ending = (validUntil: number) =>
      entitlements({ plan: "pro", seats: 1, validUntil, overrides: null }, NOW);
    expect(retentionExpiry(NOW, ending(NOW + 90 * DAY_MS))).toBe(NOW + 90 * DAY_MS);
    // Ending sooner than the free retention: the free retention still applies.
    expect(retentionExpiry(NOW, ending(NOW + DAY_MS))).toBe(NOW + 30 * DAY_MS);
    expect(retentionExpiry(NOW, ending(NOW + 400 * DAY_MS))).toBe(NOW + 365 * DAY_MS);
  });

  it("keeps a lower override as it is, even with an end", () => {
    const short = entitlements(
      {
        plan: "pro",
        seats: 1,
        validUntil: NOW + 90 * DAY_MS,
        overrides: { limits: { accessLogRetentionDays: 10 } },
      },
      NOW,
    );
    expect(retentionExpiry(NOW, short)).toBe(NOW + 10 * DAY_MS);
  });

  it("counts a day's views from the end of the day", () => {
    const day = Date.UTC(2026, 10, 8);
    expect(viewsExpireAt(NOW, pro)).toBe(day + 366 * DAY_MS);
    expect(viewsExpireAt(day, free)).toBe(day + 31 * DAY_MS);
  });

  it("cuts the access log at the owner's retention", () => {
    expect(accessLogCutoff(NOW)).toBe(NOW - 30 * DAY_MS);
    expect(accessLogCutoff(NOW, 365)).toBe(NOW - 365 * DAY_MS);
  });
});

describe("statsRange", () => {
  const NOW = Date.UTC(2026, 10, 8, 12);
  const TODAY = Date.UTC(2026, 10, 8);
  const range = (from?: string, to?: string, retentionDays = 365) =>
    statsRange({ from, to, now: NOW, retentionDays });

  it("defaults to the last 30 days, today included", () => {
    expect(range()).toEqual({ ok: true, value: { from: TODAY - 29 * DAY_MS, to: TODAY } });
    expect(range(undefined, "2026-11-01")).toEqual({
      ok: true,
      value: { from: Date.UTC(2026, 10, 1) - 29 * DAY_MS, to: Date.UTC(2026, 10, 1) },
    });
    // A default range never starts after today, even when it ends in the future.
    expect(range(undefined, "2026-12-01")).toEqual({
      ok: true,
      value: { from: TODAY - 29 * DAY_MS, to: TODAY },
    });
  });

  it("takes both days inclusively and clamps to today and the retention", () => {
    expect(range("2026-11-08", "2026-11-08")).toEqual({
      ok: true,
      value: { from: TODAY, to: TODAY },
    });
    expect(range("2026-10-01", "2026-11-20", 10)).toEqual({
      ok: true,
      value: { from: TODAY - 10 * DAY_MS, to: TODAY },
    });
  });

  it("refuses reversed, too long and empty ranges", () => {
    expect(range("2026-11-02", "2026-11-01")).toMatchObject({
      ok: false,
      code: "invalid_input",
      message: "The range ends before it starts.",
    });
    expect(range("2025-11-07", "2026-11-08")).toMatchObject({
      code: "invalid_input",
      message: "The range is longer than 366 days.",
    });
    expect(range("2025-11-08", "2026-11-08")).toMatchObject({ ok: true });
    expect(range("2026-01-01", "2026-01-31", 30)).toMatchObject({
      message: "The range has no day in the last 30 days your plan keeps.",
    });
    expect(range("2026-11-09", "2026-11-10")).toMatchObject({ code: "invalid_input" });
  });
});
