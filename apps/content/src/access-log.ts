// Access log recording on the content Worker (plan sections 11 and 14). Each isolate gathers the
// openings it serves in memory and writes them once per window, after the response, through
// `waitUntil`, like the traffic meter: delivery never waits for or pays a D1 write per request.
// Rows are keyed by artifact, visitor and 30-minute window, so an isolate also remembers what it
// already wrote in the current window and skips it. An evicted isolate loses what it had not
// written yet; the log says it is not a complete audit.

import type { Region } from "@portifact/db";
import { accessWindow, logEvent } from "@portifact/domain";
import type { Opening } from "@portifact/services";

export type { Opening };

/** How long an isolate gathers openings before writing them; well under the 30 s of waitUntil. */
export const ACCESS_FLUSH_MS = 5_000;

/** Records one opening; delivery calls it for every page load by a signed-in visitor. */
/** Logs an opening; `region` is the artifact's (decision 0005), the default one when absent. */
export type LogOpening = (opening: Opening, region?: Region) => void;

export type WriteOpenings = (openings: Opening[]) => Promise<unknown>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const keyOf = (opening: Opening) =>
  `${opening.artifactId}\u0000${accessWindow(opening.at)}\u0000${opening.userId}`;

export class OpeningLog {
  readonly #pending = new Map<string, Opening>();
  /** Keys this isolate already wrote, with their window, so it skips them for the window. */
  readonly #written = new Map<string, number>();
  #scheduled = false;

  constructor(
    private readonly write: WriteOpenings,
    private readonly delayMs: number = ACCESS_FLUSH_MS,
  ) {}

  /**
   * Adds the opening to the pending batch unless this isolate already wrote or holds one for the
   * same window. The first opening of a batch schedules the write with `waitUntil`.
   */
  record(opening: Opening, waitUntil: (promise: Promise<unknown>) => void): void {
    const key = keyOf(opening);
    if (this.#written.has(key) || this.#pending.has(key)) return;
    this.#pending.set(key, opening);
    if (this.#scheduled) return;
    this.#scheduled = true;
    waitUntil(sleep(this.delayMs).then(() => this.flush()));
  }

  /** Writes what is pending. A failed write keeps the openings for the next batch. */
  async flush(): Promise<void> {
    this.#scheduled = false;
    const batch = [...this.#pending.entries()];
    this.#pending.clear();
    if (batch.length === 0) return;
    try {
      await this.write(batch.map(([, opening]) => opening));
    } catch {
      for (const [key, opening] of batch) this.#pending.set(key, opening);
      // No identifiers: the log is technical and sampled, and these name visitors.
      logEvent("error", "access_log_write_failed");
      return;
    }
    const latest = Math.max(...batch.map(([, opening]) => accessWindow(opening.at)));
    for (const [key, window] of this.#written) {
      if (window < latest) this.#written.delete(key);
    }
    for (const [key, opening] of batch) {
      const window = accessWindow(opening.at);
      if (window >= latest) this.#written.set(key, window);
    }
  }

  /** Pending openings, for tests. */
  pending(): Opening[] {
    return [...this.#pending.values()];
  }
}
