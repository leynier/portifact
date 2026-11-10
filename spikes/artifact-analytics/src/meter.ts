// The per-isolate batching of views, the same shape as `TrafficMeter` in apps/content: views are
// added up in memory per artifact and UTC day and written once per window after the response,
// through `waitUntil`. Delivery never waits for or pays a D1 write per request. Production would
// flush this in the same timer as the traffic meter; the two writes go to different databases
// (traffic to the control database, views to the access database), so they are two batches.
import { utcDay, type ViewKind } from "./views.ts";

export const VIEW_FLUSH_MS = 5_000;

/** Views of one artifact on one UTC day, still to be added to its row. */
export interface ViewDelta {
  artifactId: string;
  ownerId: string;
  day: number;
  views: number;
  signedInViews: number;
  /** The owner's analytics retention when the views were served; the row's expiry follows it. */
  retentionDays: number;
}

/** One view to record, as `serve` hands it over. */
export interface ViewCharge {
  artifactId: string;
  ownerId: string;
  at: number;
  kind: ViewKind;
  retentionDays: number;
}

export type WriteViews = (deltas: ViewDelta[]) => Promise<unknown>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ViewMeter {
  readonly #pending = new Map<string, ViewDelta>();
  #scheduled = false;

  constructor(
    private readonly write: WriteViews,
    private readonly delayMs: number = VIEW_FLUSH_MS,
  ) {}

  /** Adds the view; the first one of a window schedules the write with `waitUntil`. */
  count(charge: ViewCharge, waitUntil: (promise: Promise<unknown>) => void): void {
    this.#add({
      artifactId: charge.artifactId,
      ownerId: charge.ownerId,
      day: utcDay(charge.at),
      views: 1,
      signedInViews: charge.kind === "signedIn" ? 1 : 0,
      retentionDays: charge.retentionDays,
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
      console.error("view counter write failed; kept for the next window");
    }
  }

  pending(): ViewDelta[] {
    return [...this.#pending.values()];
  }

  #add(delta: ViewDelta): void {
    const key = `${delta.artifactId}\u0000${delta.day}`;
    const current = this.#pending.get(key);
    if (!current) {
      this.#pending.set(key, { ...delta });
      return;
    }
    current.views += delta.views;
    current.signedInViews += delta.signedInViews;
    current.retentionDays = Math.max(current.retentionDays, delta.retentionDays);
  }
}
