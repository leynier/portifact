// Rate limits on the endpoints that cost money or storage: sending sign-in codes, registering
// clients, starting device authorizations and entering protected artifacts. Counters live in D1, so every
// isolate sees the same count.
import { OTP_LIMITS } from "@portifact/contracts";
import { hitRateLimit, pruneRateLimits } from "@portifact/db";

export interface Limit {
  max: number;
  windowSeconds: number;
}

export type LimitDecision = { ok: true } | { ok: false; retryAfterSeconds: number };

/** Per-IP limits on unauthenticated endpoints that create rows. */
export const ENDPOINT_LIMITS: Record<string, Limit> = {
  "/oauth2/register": { max: 20, windowSeconds: 3_600 },
  "/device/code": { max: 30, windowSeconds: 3_600 },
  // Guessing codes: each code allows three attempts; this caps fresh attempts per IP.
  "/sign-in/email-otp": { max: 30, windowSeconds: 600 },
  // Signs an acceptance cookie or writes the account's acceptance.
  "/accept-terms": { max: 30, windowSeconds: 600 },
};

/**
 * Per-account limit on entries to protected artifacts (`/read/<id>`): each one that passes the
 * access check stores a handoff code.
 */
export const READ_ENTRY_LIMIT: Limit = { max: 60, windowSeconds: 600 };

/**
 * Per-account limit on review codes (`POST /api/v1/artifacts/:id/review`): each one stores a
 * code. The viewer asks for one per page load and when a review session ends.
 */
export const REVIEW_START_LIMIT: Limit = { max: 60, windowSeconds: 600 };

/**
 * Checks the limits in order and stops at the first one exceeded, so a refused request does
 * not use up a later, wider budget.
 */
export async function checkLimits(
  d1: D1Database,
  checks: readonly { key: string; limit: Limit }[],
  now: number,
): Promise<LimitDecision> {
  for (const { key, limit } of checks) {
    const hit = await hitRateLimit(d1, key, limit.windowSeconds * 1000, now);
    if (hit.count > limit.max) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((hit.resetAt - now) / 1000)) };
    }
  }
  return { ok: true };
}

/**
 * The checks for sending a sign-in code: per IP, cooldown and hourly limit per email, global.
 * The IP comes first, so requests refused for their IP do not use up the address's or the
 * service's budget.
 */
export async function otpSendChecks(
  email: string,
  ip: string,
  secret: string,
): Promise<{ key: string; limit: Limit }[]> {
  // Keys hold a keyed hash, not the address, so the table never stores emails.
  const emailKey = await keyedHash(secret, email);
  return [
    { key: `otp:ip:${ip}`, limit: OTP_LIMITS.perIp },
    { key: `otp:cooldown:${emailKey}`, limit: OTP_LIMITS.perEmailCooldown },
    { key: `otp:email:${emailKey}`, limit: OTP_LIMITS.perEmail },
    { key: GLOBAL_OTP_KEY, limit: OTP_LIMITS.global },
  ];
}

export const GLOBAL_OTP_KEY = "otp:global";

/** Removes counters older than the longest window. */
export function pruneOldCounters(d1: D1Database, now: number): Promise<number> {
  return pruneRateLimits(d1, now - 2 * OTP_LIMITS.global.windowSeconds * 1000);
}

async function keyedHash(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
