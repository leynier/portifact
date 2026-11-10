// The global artifact directory: which region holds an artifact. The content Worker only gets the
// ID from the hostname, so it asks here before the regional lookup. A row's region never changes
// and an ID is never reused, so a positive answer can be cached for the isolate's life with no
// invalidation. Misses are not cached: an ID claimed a moment later must be found.
import { isRegion, type Region } from "./regions.ts";

export const DIRECTORY_CACHE_ENTRIES = 10_000;

export class Directory {
  readonly #global: D1Database;
  readonly #cache = new Map<string, Region>();
  readonly #max: number;

  constructor(global: D1Database, maxEntries = DIRECTORY_CACHE_ENTRIES) {
    this.#global = global;
    this.#max = maxEntries;
  }

  async regionOf(id: string): Promise<Region | null> {
    const cached = this.#cache.get(id);
    if (cached) {
      // Refresh the entry's place, so the map's order is least recently used first.
      this.#cache.delete(id);
      this.#cache.set(id, cached);
      return cached;
    }
    const row = await this.#global
      .prepare("select region from artifact_directory where id = ?")
      .bind(id)
      .first<{ region: string }>();
    if (!row) return null;
    if (!isRegion(row.region)) throw new Error(`Unknown region ${row.region}`);
    this.#cache.set(id, row.region);
    if (this.#cache.size > this.#max) {
      const oldest = this.#cache.keys().next().value as string;
      this.#cache.delete(oldest);
    }
    return row.region;
  }

  get size(): number {
    return this.#cache.size;
  }
}
