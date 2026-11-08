// The per-visitor counter behind the budget traffic limits (src/budget.ts). One Durable Object
// per limited key (kind and visitor IP) counts requests in a fixed window. A Durable Object runs
// one request at a time worldwide, so the count is exact: unlike Workers Rate Limiting, whose
// counts are per location and eventually consistent, parallel requests cannot all see a count
// below the limit. It is only reached while protection limits traffic.
import { DurableObject } from "cloudflare:workers";

export interface TrafficHit {
  /** True when this request is within the limit. */
  allowed: boolean;
  /** When the current window ends, in milliseconds since the epoch. */
  resetAt: number;
}

export class TrafficLimiter extends DurableObject {
  // In memory only: an object Cloudflare evicts after a quiet spell starts a new window, which
  // only forgives a visitor who already stopped. Storage writes would cost more per request.
  #windowStart = 0;
  #count = 0;

  /** Counts one request at `now` against `limit` requests per `periodMs`. */
  hit(limit: number, periodMs: number, now: number): TrafficHit {
    if (now >= this.#windowStart + periodMs || now < this.#windowStart) {
      this.#windowStart = now;
      this.#count = 0;
    }
    this.#count += 1;
    return { allowed: this.#count <= limit, resetAt: this.#windowStart + periodMs };
  }
}
