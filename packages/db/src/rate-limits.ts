// Fixed-window rate limit counters in D1 (table `rate_limits`). Each hit is one upsert
// statement, so concurrent requests are serialized by the database and cannot both take the
// last slot.

export interface RateLimitHit {
  /** Requests counted in the current window, including this one. */
  count: number;
  /** When the current window ends, in milliseconds since the epoch. */
  resetAt: number;
}

/**
 * Counts one request for `key` in a window of `windowMs` and returns the new count. A window
 * that ended at or before `now` starts again at `now`. The caller compares the count to its
 * limit.
 */
export async function hitRateLimit(
  d1: D1Database,
  key: string,
  windowMs: number,
  now: number,
): Promise<RateLimitHit> {
  // An upsert with RETURNING always yields the row it wrote.
  const row = (await d1
    .prepare(
      `insert into rate_limits (key, window_start, count) values (?1, ?2, 1)
       on conflict (key) do update set
         count = case when window_start <= ?2 - ?3 then 1 else count + 1 end,
         window_start = case when window_start <= ?2 - ?3 then ?2 else window_start end
       returning window_start, count`,
    )
    .bind(key, now, windowMs)
    .first<{ window_start: number; count: number }>()) as { window_start: number; count: number };
  return { count: row.count, resetAt: row.window_start + windowMs };
}

/**
 * The count of `key` in its current window without counting a request: zero when there is no
 * counter or its window ended. For limits that count only some outcomes (failed passwords), so
 * the check before the attempt and the hit after a failure are separate.
 */
export async function peekRateLimit(
  d1: D1Database,
  key: string,
  windowMs: number,
  now: number,
): Promise<RateLimitHit> {
  const row = await d1
    .prepare("select window_start, count from rate_limits where key = ?1")
    .bind(key)
    .first<{ window_start: number; count: number }>();
  if (!row || row.window_start <= now - windowMs) return { count: 0, resetAt: now + windowMs };
  return { count: row.count, resetAt: row.window_start + windowMs };
}

/** Deletes counters whose window started before `before`. Safe to run at any time. */
export async function pruneRateLimits(d1: D1Database, before: number): Promise<number> {
  const result = await d1
    .prepare("delete from rate_limits where window_start < ?1")
    .bind(before)
    .run();
  return result.meta.changes;
}
