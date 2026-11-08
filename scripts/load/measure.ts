// Pure helpers of the load test: latency summaries, status tallies and the deterministic byte
// stream that stands in for large files without ever holding them in memory.

export interface LatencySummary {
  count: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

/** Nearest-rank percentile of sorted values; `fraction` is between 0 and 1. */
export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] as number;
}

export function summarize(latenciesMs: readonly number[]): LatencySummary {
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    count: sorted.length,
    minMs: round(sorted[0] ?? 0),
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    p99Ms: round(percentile(sorted, 0.99)),
    maxMs: round(sorted.at(-1) ?? 0),
  };
}

/** Counts occurrences, for example of HTTP statuses or error codes. */
export function tally(values: readonly (string | number)[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[String(value)] = (counts[String(value)] ?? 0) + 1;
  return counts;
}

/**
 * Splits `total` bytes into `parts` sizes that differ by at most one byte and add up exactly,
 * so a maximum-size publish lands precisely on the limit.
 */
export function splitBytes(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const extra = total - base * parts;
  return Array.from({ length: parts }, (_, index) => base + (index < extra ? 1 : 0));
}

/**
 * Deterministic pseudo-random bytes (xorshift32 seeded per file), generated chunk by chunk.
 * Running it twice with the same seed yields the same bytes, so the load test hashes a file in
 * one pass and uploads it in another without storing it. Distinct seeds give distinct content,
 * so account deduplication never skips an upload.
 */
export function* patternChunks(
  seed: number,
  size: number,
  chunkSize = 1 << 20,
): Generator<Uint8Array> {
  // Whole words per chunk, so the bytes do not depend on the chunk size.
  const step = Math.max(4, chunkSize - (chunkSize % 4));
  let state = seed >>> 0 || 0x9e3779b9;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  let left = size;
  while (left > 0) {
    const length = Math.min(step, left);
    const chunk = new Uint8Array(length);
    const view = new DataView(chunk.buffer);
    let i = 0;
    for (; i + 4 <= length; i += 4) view.setUint32(i, next(), true);
    if (i < length) {
      const last = next();
      for (let k = 0; i < length; i++, k++) chunk[i] = (last >>> (8 * k)) & 0xff;
    }
    left -= length;
    yield chunk;
  }
}

/** The bytes `[start, end)` of a chunked stream, without holding more than one chunk. */
export function* sliceChunks(
  chunks: Iterable<Uint8Array>,
  start: number,
  end: number,
): Generator<Uint8Array> {
  let offset = 0;
  for (const chunk of chunks) {
    const from = Math.max(start - offset, 0);
    const to = Math.min(end - offset, chunk.byteLength);
    if (to > from) yield chunk.subarray(from, to);
    offset += chunk.byteLength;
    if (offset >= end) return;
  }
}
