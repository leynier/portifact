import { TRAFFIC_LIMITS } from "@portifact/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  chargedBytes,
  trafficExhausted as exhaustedWith,
  type TrafficUsage,
  trafficCycle,
} from "./traffic.ts";

const trafficExhausted = (usage: TrafficUsage) => exhaustedWith(usage, TRAFFIC_LIMITS);

describe("trafficCycle", () => {
  it("is the UTC calendar month around the instant", () => {
    expect(trafficCycle(Date.parse("2026-11-20T12:00:00Z"))).toEqual({
      start: Date.parse("2026-11-01T00:00:00Z"),
      resetsAt: Date.parse("2026-12-01T00:00:00Z"),
    });
  });

  it("rolls over at midnight UTC on the first day, across a year boundary", () => {
    const last = Date.parse("2026-12-31T23:59:59.999Z");
    expect(trafficCycle(last).start).toBe(Date.parse("2026-12-01T00:00:00Z"));
    expect(trafficCycle(last + 1)).toEqual({
      start: Date.parse("2027-01-01T00:00:00Z"),
      resetsAt: Date.parse("2027-02-01T00:00:00Z"),
    });
  });

  it("always contains the instant and starts where the previous one resets", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4_102_444_800_000 }), (now) => {
        const cycle = trafficCycle(now);
        return (
          cycle.start <= now &&
          now < cycle.resetsAt &&
          trafficCycle(cycle.start - 1).resetsAt === cycle.start
        );
      }),
    );
  });
});

describe("trafficExhausted", () => {
  const { requestsPerMonth, bytesPerMonth } = TRAFFIC_LIMITS;

  it("holds from the limit of either requests or bytes", () => {
    expect(trafficExhausted({ requests: requestsPerMonth, bytes: 0 })).toBe(true);
    expect(trafficExhausted({ requests: 0, bytes: bytesPerMonth })).toBe(true);
    expect(trafficExhausted({ requests: requestsPerMonth + 5, bytes: bytesPerMonth + 5 })).toBe(
      true,
    );
  });

  it("does not hold below both limits", () => {
    expect(trafficExhausted({ requests: 0, bytes: 0 })).toBe(false);
    expect(trafficExhausted({ requests: requestsPerMonth - 1, bytes: bytesPerMonth - 1 })).toBe(
      false,
    );
  });

  it("uses the plan's values", () => {
    expect(TRAFFIC_LIMITS).toEqual({ requestsPerMonth: 1_000_000, bytesPerMonth: 25_000_000_000 });
  });
});

describe("chargedBytes", () => {
  it("charges the body of a successful GET", () => {
    expect(chargedBytes(200, "GET", 1_234)).toBe(1_234);
    expect(chargedBytes(206, "GET", 10)).toBe(10);
  });

  it("charges nothing for HEAD, 304 and refusals", () => {
    expect(chargedBytes(200, "HEAD", 1_234)).toBe(0);
    expect(chargedBytes(304, "GET", 1_234)).toBe(0);
    expect(chargedBytes(404, "GET", 300)).toBe(0);
    expect(chargedBytes(503, "GET", 300)).toBe(0);
  });

  it("never charges a negative amount", () => {
    expect(chargedBytes(200, "GET", -1)).toBe(0);
  });
});
