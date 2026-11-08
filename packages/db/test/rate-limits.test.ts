import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { hitRateLimit, pruneRateLimits } from "../src/index.ts";

const minute = 60_000;
const start = Date.UTC(2026, 10, 8, 12);

describe("rate limit counters", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM rate_limits");
  });

  it("counts hits for a key within its window and reports when the window ends", async () => {
    expect(await hitRateLimit(env.DB, "otp:ip:a", minute, start)).toEqual({
      count: 1,
      resetAt: start + minute,
    });
    expect(await hitRateLimit(env.DB, "otp:ip:a", minute, start + 59_999)).toEqual({
      count: 2,
      resetAt: start + minute,
    });
  });

  it("starts a new window once the previous one has ended", async () => {
    await hitRateLimit(env.DB, "otp:ip:b", minute, start);
    await hitRateLimit(env.DB, "otp:ip:b", minute, start + 1);
    expect(await hitRateLimit(env.DB, "otp:ip:b", minute, start + minute)).toEqual({
      count: 1,
      resetAt: start + 2 * minute,
    });
  });

  it("keeps keys independent", async () => {
    await hitRateLimit(env.DB, "otp:email:x", minute, start);
    expect((await hitRateLimit(env.DB, "otp:email:y", minute, start)).count).toBe(1);
  });

  it("counts every concurrent hit exactly once", async () => {
    const hits = await Promise.all(
      Array.from({ length: 10 }, () => hitRateLimit(env.DB, "otp:global", minute, start)),
    );
    expect(hits.map((hit) => hit.count).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it("prunes only counters whose window started before the cutoff", async () => {
    await hitRateLimit(env.DB, "old", minute, start);
    await hitRateLimit(env.DB, "new", minute, start + 10 * minute);
    expect(await pruneRateLimits(env.DB, start + minute)).toBe(1);
    const rows = await env.DB.prepare("select key from rate_limits").all<{ key: string }>();
    expect(rows.results.map((row) => row.key)).toEqual(["new"]);
  });
});
