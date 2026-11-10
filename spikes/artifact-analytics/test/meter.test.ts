import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { type ViewCharge, type ViewDelta, ViewMeter } from "../src/meter.ts";
import { recordViews } from "../src/record.ts";
import { DAY_MS } from "../src/views.ts";
import { collector, NOW, randomId, TODAY, viewRows } from "./harness.ts";

const charge = (artifactId: string, overrides: Partial<ViewCharge> = {}): ViewCharge => ({
  artifactId,
  ownerId: "owner",
  at: NOW,
  kind: "anonymous",
  retentionDays: 365,
  ...overrides,
});

describe("ViewMeter", () => {
  it("adds views per artifact and day in memory and schedules one write per window", async () => {
    const writes: ViewDelta[][] = [];
    const meter = new ViewMeter(async (deltas) => {
      writes.push(deltas);
    }, 0);
    const { waitUntil, settle, scheduled } = collector();
    for (let i = 0; i < 10; i += 1) meter.count(charge("a"), waitUntil);
    meter.count(charge("a", { kind: "signedIn" }), waitUntil);
    meter.count(charge("a", { at: NOW + DAY_MS }), waitUntil);
    meter.count(charge("b"), waitUntil);
    expect(scheduled()).toBe(1);
    await settle();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual([
      {
        artifactId: "a",
        ownerId: "owner",
        day: TODAY,
        views: 11,
        signedInViews: 1,
        retentionDays: 365,
      },
      {
        artifactId: "a",
        ownerId: "owner",
        day: TODAY + DAY_MS,
        views: 1,
        signedInViews: 0,
        retentionDays: 365,
      },
      {
        artifactId: "b",
        ownerId: "owner",
        day: TODAY,
        views: 1,
        signedInViews: 0,
        retentionDays: 365,
      },
    ]);
    // The next window schedules again.
    meter.count(charge("a"), waitUntil);
    expect(scheduled()).toBe(2);
    await settle();
    expect(writes).toHaveLength(2);
  });

  it("keeps a failed batch for the next window, merged with what came meanwhile", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    const writes: ViewDelta[][] = [];
    const meter = new ViewMeter(async (deltas) => {
      if (fail) throw new Error("D1 unavailable");
      writes.push(deltas);
    }, 0);
    const { waitUntil } = collector();
    meter.count(charge("a"), waitUntil);
    meter.count(charge("a"), waitUntil);
    await meter.flush();
    expect(meter.pending()).toMatchObject([{ artifactId: "a", views: 2 }]);
    meter.count(charge("a", { kind: "signedIn", retentionDays: 730 }), waitUntil);
    fail = false;
    await meter.flush();
    expect(writes).toEqual([
      [
        {
          artifactId: "a",
          ownerId: "owner",
          day: TODAY,
          views: 3,
          signedInViews: 1,
          retentionDays: 730,
        },
      ],
    ]);
    expect(meter.pending()).toEqual([]);
    expect(error).toHaveBeenCalledOnce();
    // The log names no artifact, owner or amount.
    expect(String(error.mock.calls[0]?.[0])).not.toMatch(/owner|\ba\b|\d/);
    error.mockRestore();
  });

  it("does nothing when there is nothing pending", async () => {
    const write = vi.fn(async () => {});
    await new ViewMeter(write, 0).flush();
    expect(write).not.toHaveBeenCalled();
  });

  it("small counts are exact: 12 views from four isolates flushing at once read back as 12", async () => {
    const id = randomId();
    const isolates = Array.from(
      { length: 4 },
      () => new ViewMeter((d) => recordViews(env.ACCESS, d), 0),
    );
    const { waitUntil, settle } = collector();
    for (let i = 0; i < 12; i += 1) {
      const isolate = isolates[i % 4] as ViewMeter;
      isolate.count(charge(id, { kind: i % 3 === 0 ? "signedIn" : "anonymous" }), waitUntil);
    }
    await settle();
    expect(await viewRows(id)).toMatchObject([{ day: TODAY, views: 12, signed_in_views: 4 }]);
  });

  it("thousands of views from many isolates in concurrent windows add up exactly", async () => {
    const id = randomId();
    const isolates = Array.from(
      { length: 8 },
      () => new ViewMeter((d) => recordViews(env.ACCESS, d), 0),
    );
    for (let round = 0; round < 5; round += 1) {
      const { waitUntil, settle } = collector();
      for (let i = 0; i < 400; i += 1) {
        (isolates[i % 8] as ViewMeter).count(charge(id), waitUntil);
      }
      await settle();
    }
    expect(await viewRows(id)).toMatchObject([{ views: 2_000, signed_in_views: 0 }]);
  });
});
