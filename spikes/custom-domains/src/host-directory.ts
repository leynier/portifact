// Custom hostname to artifact, for the content Worker. The global `custom_domains` table answers
// which artifact and region a hostname belongs to; the isolate caches that answer as a hint only.
// The authority is the artifact row in its region (`artifacts.custom_host`), which delivery reads
// anyway, so a stale hint costs one extra read and is never served: removal and moves take effect
// at the next request with no invalidation message. Unlike the artifact directory of decision
// 0005, a hostname's answer can change, which is exactly why the hint is checked on every use.
import { isRegion, type Region } from "./regions.ts";

export const HOST_CACHE_ENTRIES = 10_000;

export interface HostHint {
  artifactId: string;
  region: Region;
}

export class HostDirectory {
  readonly #global: D1Database;
  readonly #cache = new Map<string, HostHint>();
  readonly #max: number;

  constructor(global: D1Database, maxEntries = HOST_CACHE_ENTRIES) {
    this.#global = global;
    this.#max = maxEntries;
  }

  /** The cached hint, or a fresh one from the global table. Misses are never cached. */
  async hint(hostname: string): Promise<HostHint | null> {
    const cached = this.#cache.get(hostname);
    if (cached) {
      this.#cache.delete(hostname);
      this.#cache.set(hostname, cached);
      return cached;
    }
    return this.refresh(hostname);
  }

  /** Drops what the isolate knew and reads the global table again. */
  async refresh(hostname: string): Promise<HostHint | null> {
    this.#cache.delete(hostname);
    const row = await this.#global
      .prepare(
        "select artifact_id, region from custom_domains where hostname = ? and state = 'active'",
      )
      .bind(hostname)
      .first<{ artifact_id: string; region: string }>();
    if (!row) return null;
    if (!isRegion(row.region)) throw new Error(`Unknown region ${row.region}`);
    const hint = { artifactId: row.artifact_id, region: row.region };
    this.#cache.set(hostname, hint);
    if (this.#cache.size > this.#max) {
      const oldest = this.#cache.keys().next().value as string;
      this.#cache.delete(oldest);
    }
    return hint;
  }

  get size(): number {
    return this.#cache.size;
  }
}
