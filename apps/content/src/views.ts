// Page view counting on the content Worker (premium plan P8, decision 0007), the same shape as
// the traffic meter: each isolate adds up the views it serves per artifact and UTC day in memory
// and writes them once per window, after the response, through `waitUntil`. Delivery never waits
// for or pays a D1 write per request. The write goes to the access database (`recordViews`), as
// one batch next to the traffic meter's batch to the control database.

import type { Region } from "@portifact/db";
import { utcDay } from "@portifact/domain";
import type { ViewDelta } from "@portifact/services";

/** How long an isolate gathers views before writing them, like the traffic meter. */
export const VIEWS_FLUSH_MS = 5_000;

/** One view `serve` hands over, after `pageView` decided it is one. */
export interface ViewCharge {
  artifactId: string;
  ownerId: string;
  at: number;
  /** The signed-in visitor of the view, or null for an anonymous one. */
  visitorId: string | null;
  /** When the day's row expires on the owner's plan (`viewsExpireAt`). */
  expiresAt: number;
}

/** Counts one view; delivery calls it only for a request `pageView` counts. */
/** Counts a view; `region` is the artifact's (decision 0005), the default one when absent. */
export type CountView = (charge: ViewCharge, region?: Region) => void;

export type WriteViews = (deltas: ViewDelta[]) => Promise<unknown>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ViewMeter {
  readonly #pending = new Map<string, ViewDelta>();
  #scheduled = false;

  constructor(
    private readonly write: WriteViews,
    private readonly delayMs: number = VIEWS_FLUSH_MS,
  ) {}

  /** Adds the view; the first one of a window schedules the write with `waitUntil`. */
  count(charge: ViewCharge, waitUntil: (promise: Promise<unknown>) => void): void {
    this.#add({
      artifactId: charge.artifactId,
      ownerId: charge.ownerId,
      day: utcDay(charge.at),
      anonymous: charge.visitorId === null ? 1 : 0,
      signedIn: charge.visitorId === null ? {} : { [charge.visitorId]: 1 },
      expiresAt: charge.expiresAt,
    });
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
      // No identifiers or counts: the log is technical and sampled.
      console.error("view counter write failed; kept for the next window");
    }
  }

  /** Pending deltas, for tests. */
  pending(): ViewDelta[] {
    return [...this.#pending.values()];
  }

  #add(delta: ViewDelta): void {
    const key = `${delta.artifactId}\u0000${delta.day}`;
    const current = this.#pending.get(key);
    if (!current) {
      this.#pending.set(key, { ...delta, signedIn: { ...delta.signedIn } });
      return;
    }
    current.anonymous += delta.anonymous;
    for (const [visitorId, views] of Object.entries(delta.signedIn)) {
      current.signedIn[visitorId] = (current.signedIn[visitorId] ?? 0) + views;
    }
    current.expiresAt = Math.max(current.expiresAt, delta.expiresAt);
  }
}
