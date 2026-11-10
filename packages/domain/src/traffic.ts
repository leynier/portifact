// Traffic quota per account (plan sections 2 and 12): requests and bytes its artifacts serve in a
// calendar month (UTC), across all of them. When either is used up, only that account's
// artifacts answer 429 until the next cycle; publishing and the other quotas are independent.
import type { PlanLimits } from "@portifact/contracts";

/** What an account's artifacts served in one cycle. */
export interface TrafficUsage {
  requests: number;
  bytes: number;
}

/** One cycle of the traffic quota: the UTC calendar month that contains `now`. */
export interface TrafficCycle {
  start: number;
  resetsAt: number;
}

export function trafficCycle(now: number): TrafficCycle {
  const date = new Date(now);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  return { start: Date.UTC(year, month, 1), resetsAt: Date.UTC(year, month + 1, 1) };
}

/** The traffic quota of the owner's plan. */
export type TrafficLimits = Pick<PlanLimits, "requestsPerMonth" | "bytesPerMonth">;

/** True once either the requests or the bytes of the cycle reach the plan's limit. */
export function trafficExhausted(usage: TrafficUsage, limits: TrafficLimits): boolean {
  return usage.requests >= limits.requestsPerMonth || usage.bytes >= limits.bytesPerMonth;
}

/**
 * Bytes a response charges to the account: the body it sends. HEAD, 304 and refusals send no
 * body, so they count as a request only.
 */
export function chargedBytes(status: number, method: string, bodyLength: number): number {
  if (method === "HEAD" || status === 304 || status >= 400) return 0;
  return Math.max(0, bodyLength);
}
