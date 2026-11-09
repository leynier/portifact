// What blocks an account right now (plan sections 6 "Uso" and 12): the same limits checkPublish
// and checkAccessChange apply, read from the account's counters, with when each block lifts.
import { LIMITS } from "@portifact/contracts";
import { type TrafficUsage, trafficCycle, trafficExhausted } from "./traffic.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
export const USAGE_WINDOW_MS = DAY_MS;

/** One entry of a rolling window: when it happened and how much it counted. */
export interface WindowEvent {
  at: number;
  amount: number;
}

export interface UsageSnapshot {
  now: number;
  accountCreatedAt: number;
  activeArtifacts: number;
  storedBytes: number;
  reservedBytes: number;
  openUploads: number;
  /** Expiry of the oldest open upload; it frees its slot then at the latest. */
  firstUploadExpiry: number | null;
  newObjectsThisMonth: number;
  /** Events of the last 24 hours, oldest first. */
  publishes: readonly WindowEvent[];
  newFiles: readonly WindowEvent[];
  newBytes: readonly WindowEvent[];
  /** What the account's artifacts served in the current traffic cycle. */
  traffic: TrafficUsage;
}

export type BlockReason =
  | "active_artifacts"
  | "storage"
  | "publishes_per_24h"
  | "open_uploads"
  | "new_files_per_24h"
  | "new_bytes_per_24h"
  | "new_objects_per_month"
  | "account_too_new_for_public"
  | "traffic"
  /** The platform's budget protection (budget.ts), not the account's own use. */
  | "capacity";

export interface Block {
  reason: BlockReason;
  stops: "new_artifacts" | "publishing" | "public_access" | "serving";
  message: string;
  /** When it lifts by itself; null when the account must free capacity. */
  until: number | null;
}

export function windowTotal(events: readonly WindowEvent[]): number {
  return events.reduce((sum, event) => sum + event.amount, 0);
}

/**
 * When a rolling window full at `limit` frees room again: the moment enough of its oldest events
 * leave it for the total to drop below the limit. Null when the window is not full.
 */
export function windowReleaseAt(
  events: readonly WindowEvent[],
  limit: number,
  windowMs: number = USAGE_WINDOW_MS,
): number | null {
  let total = windowTotal(events);
  if (total < limit) return null;
  for (const event of events) {
    total -= event.amount;
    if (total < limit) return event.at + windowMs;
  }
  // Unreachable with a positive limit: the total reaches zero after the last event.
  return null;
}

/** Start of the next calendar month in UTC, when the monthly object count resets. */
export function nextMonthStart(now: number): number {
  return trafficCycle(now).resetsAt;
}

/** From when an account may make artifacts public (the same rule as checkAccessChange). */
export function publicAccessFrom(accountCreatedAt: number): number {
  return accountCreatedAt + LIMITS.publicAccessMinAccountAgeMinutes * 60_000;
}

/** Every limit that stops the account now, in the order checkPublish applies them. */
export function usageBlocks(usage: UsageSnapshot): Block[] {
  const blocks: Block[] = [];
  if (usage.activeArtifacts >= LIMITS.activeArtifacts) {
    blocks.push({
      reason: "active_artifacts",
      stops: "new_artifacts",
      message: `You have ${LIMITS.activeArtifacts} active artifacts. Archive or delete one to create another; updates still work.`,
      until: null,
    });
  }
  if (usage.storedBytes + usage.reservedBytes >= LIMITS.accountBytes) {
    blocks.push({
      reason: "storage",
      stops: "publishing",
      message:
        "Your 2.5 GB of storage is full. Delete artifacts or wait for previous versions to expire to upload new files.",
      until: null,
    });
  }
  const publishes = windowReleaseAt(usage.publishes, LIMITS.publishesPer24h);
  if (publishes !== null) {
    blocks.push({
      reason: "publishes_per_24h",
      stops: "publishing",
      message: `You published ${LIMITS.publishesPer24h} times in the last 24 hours.`,
      until: publishes,
    });
  }
  if (usage.openUploads >= LIMITS.concurrentUploads) {
    blocks.push({
      reason: "open_uploads",
      stops: "publishing",
      message: "Finish or cancel your other uploads first.",
      until: usage.firstUploadExpiry,
    });
  }
  const files = windowReleaseAt(usage.newFiles, LIMITS.newFilesPer24h);
  if (files !== null) {
    blocks.push({
      reason: "new_files_per_24h",
      stops: "publishing",
      message: `You uploaded ${LIMITS.newFilesPer24h} new files in the last 24 hours.`,
      until: files,
    });
  }
  const bytes = windowReleaseAt(usage.newBytes, LIMITS.newBytesPer24h);
  if (bytes !== null) {
    blocks.push({
      reason: "new_bytes_per_24h",
      stops: "publishing",
      message: "You uploaded 5 GB of new files in the last 24 hours.",
      until: bytes,
    });
  }
  if (usage.newObjectsThisMonth >= LIMITS.newObjectsPerMonth) {
    blocks.push({
      reason: "new_objects_per_month",
      stops: "publishing",
      message: `You stored ${LIMITS.newObjectsPerMonth} new files this month.`,
      until: nextMonthStart(usage.now),
    });
  }
  const publicFrom = publicAccessFrom(usage.accountCreatedAt);
  if (usage.now < publicFrom) {
    blocks.push({
      reason: "account_too_new_for_public",
      stops: "public_access",
      message: `Accounts can make artifacts public ${LIMITS.publicAccessMinAccountAgeMinutes} minutes after they are created.`,
      until: publicFrom,
    });
  }
  if (trafficExhausted(usage.traffic)) {
    blocks.push({
      reason: "traffic",
      stops: "serving",
      message:
        "Your artifacts served this month's traffic (1 million requests or 25 GB). They answer 429 until the next month; publishing still works.",
      until: trafficCycle(usage.now).resetsAt,
    });
  }
  return blocks;
}
