// Rules of service tokens and publish keys (premium plan T4 and T5, decision 0011). Pure: the
// services read and write the rows, these functions decide.
import { SERVICE_TOKENS, type ServiceTokenRestriction } from "@portifact/contracts";
import type { TokenReach } from "./actor.ts";
import { fail, ok, type Result } from "./result.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** When a token created at `now` for `days` days expires. */
export function serviceTokenExpiry(now: number, days: number): number {
  return now + days * DAY_MS;
}

/** Whether a token is past its expiry at `now`. */
export function serviceTokenExpired(expiresAt: number, now: number): boolean {
  return expiresAt <= now;
}

/** The start of the period `now` falls in; `last_used_at` is written once per period. */
export function lastUsedPeriodStart(now: number): number {
  return now - (now % SERVICE_TOKENS.lastUsedPeriodMs);
}

/**
 * Whether a request at `now` should record the token's use: only when the stored time is from an
 * earlier period, so requests within the period add no write.
 */
export function lastUsedDue(lastUsedAt: number | null, now: number): boolean {
  return lastUsedAt === null || lastUsedAt < lastUsedPeriodStart(now);
}

/** What a restriction is checked against: who created the artifact and its publish key. */
export interface ReachSubject {
  createdBy: string | null;
  externalKey: string | null;
}

/** Whether a token with this restriction reaches the artifact. */
export function restrictionAllows(
  tokenId: string,
  restriction: ServiceTokenRestriction,
  subject: ReachSubject,
): boolean {
  switch (restriction.kind) {
    case "none":
      return true;
    case "own":
      return subject.createdBy === tokenId;
    case "key":
      return subject.externalKey !== null && subject.externalKey.startsWith(restriction.prefix);
  }
}

/**
 * Whether a token restricted to a key prefix may publish with `key`. A token restricted that way
 * publishes only with a key under its prefix; other tokens and people with any key or none.
 */
export function checkPublishKeyReach(
  reach: TokenReach | undefined,
  key: string | undefined,
): Result<void> {
  if (!reach || reach.restriction.kind !== "key") return ok(undefined);
  const { prefix } = reach.restriction;
  if (key === undefined) {
    return fail(
      "forbidden",
      `This service token publishes only with a key starting with "${prefix}".`,
    );
  }
  if (!key.startsWith(prefix)) {
    return fail("forbidden", `This service token publishes only keys starting with "${prefix}".`);
  }
  return ok(undefined);
}

/** The restriction as stored: its kind, and the prefix only when restricted by key. */
export function restrictionColumns(restriction: ServiceTokenRestriction): {
  restriction: "none" | "own" | "key";
  keyPrefix: string | null;
} {
  return {
    restriction: restriction.kind,
    keyPrefix: restriction.kind === "key" ? restriction.prefix : null,
  };
}

/** The restriction a stored row holds; a `key` row without a prefix reaches nothing. */
export function restrictionOf(
  kind: "none" | "own" | "key",
  keyPrefix: string | null,
): ServiceTokenRestriction {
  if (kind === "key") return { kind, prefix: keyPrefix ?? "\u0000" };
  return { kind };
}
