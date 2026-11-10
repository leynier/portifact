// Traffic metering on the content Worker (plan sections 11 and 12). Each isolate adds up what it
// serves per account in memory and writes it to D1 once per window, after the response, through
// `waitUntil`: delivery never waits for or pays a D1 write per request. The counters therefore lag
// by up to one window per isolate, which is the accepted overshoot of the quota.

import type { Region } from "@portifact/db";
import type { TrafficDelta } from "@portifact/services";

/** How long an isolate gathers traffic before writing it; well under the 30 s of waitUntil. */
export const TRAFFIC_FLUSH_MS = 5_000;

/** One served request to charge to an account in a cycle. */
export interface TrafficCharge {
  ownerId: string;
  cycleStart: number;
  bytes: number;
}

/**
 * Charges one served request; delivery calls it once per authorized request it answers, with the
 * artifact's region (decision 0005), the default one when absent.
 */
export type CountTraffic = (charge: TrafficCharge, region?: Region) => void;

export type WriteTraffic = (deltas: TrafficDelta[]) => Promise<void>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class TrafficMeter {
  readonly #pending = new Map<string, TrafficDelta>();
  #scheduled = false;

  constructor(
    private readonly write: WriteTraffic,
    private readonly delayMs: number = TRAFFIC_FLUSH_MS,
  ) {}

  /**
   * Adds the charge to the pending batch. The first charge of a window schedules the write with
   * `waitUntil`, which keeps the isolate alive until it is done.
   */
  count(charge: TrafficCharge, waitUntil: (promise: Promise<unknown>) => void): void {
    this.#add({ ...charge, requests: 1 });
    if (this.#scheduled) return;
    this.#scheduled = true;
    waitUntil(sleep(this.delayMs).then(() => this.flush()));
  }

  /** Writes what is pending. A failed write keeps the deltas for the next window. */
  async flush(): Promise<void> {
    this.#scheduled = false;
    const deltas = [...this.#pending.values()];
    this.#pending.clear();
    if (deltas.length === 0) return;
    try {
      await this.write(deltas);
    } catch {
      for (const delta of deltas) this.#add(delta);
      // No identifiers or amounts: the log is technical and sampled.
      console.error("traffic metering write failed; kept for the next window");
    }
  }

  /** Pending deltas, for tests. */
  pending(): TrafficDelta[] {
    return [...this.#pending.values()];
  }

  #add(delta: TrafficDelta): void {
    const key = `${delta.ownerId}\u0000${delta.cycleStart}`;
    const current = this.#pending.get(key);
    if (current) {
      current.requests += delta.requests;
      current.bytes += delta.bytes;
    } else {
      this.#pending.set(key, { ...delta });
    }
  }
}
