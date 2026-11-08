import { LIMITS } from "@portifact/contracts";
import { fail, ok, type Result } from "./result.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Publishing, updating or renewing sets the expiry to now plus 30 days. */
export function nextExpiry(now: Date): Date {
  return new Date(now.getTime() + LIMITS.activeDays * DAY_MS);
}

/**
 * Archived artifacts are purged six calendar months after archiving, in UTC. When the target
 * month is shorter (for example archiving on August 31), the date clamps to its last day.
 */
export function purgeDate(archivedAt: Date): Date {
  const year = archivedAt.getUTCFullYear();
  const month = archivedAt.getUTCMonth() + LIMITS.archiveMonths;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(archivedAt.getUTCDate(), lastDay);
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      archivedAt.getUTCHours(),
      archivedAt.getUTCMinutes(),
      archivedAt.getUTCSeconds(),
      archivedAt.getUTCMilliseconds(),
    ),
  );
}

export interface LifecycleRecord {
  state: "draft" | "active" | "archived" | "suspended" | "purging" | "deleted";
  expiresAt: Date | null;
  archivedAt: Date | null;
}

/**
 * The state that applies at `now`. An active artifact past its expiry is archived even if the
 * maintenance job has not run yet, so delivery never depends on cron timing.
 */
export function effectiveState(record: LifecycleRecord, now: Date): LifecycleRecord["state"] {
  if (record.state === "active" && record.expiresAt && now >= record.expiresAt) return "archived";
  return record.state;
}

/** When the archive started for an artifact that is archived at `now`. */
export function effectiveArchivedAt(record: LifecycleRecord, now: Date): Date | null {
  if (record.state === "archived") return record.archivedAt;
  if (effectiveState(record, now) === "archived") return record.expiresAt;
  return null;
}

/** Only the owner may restore, only before the purge date, and only with a free active slot. */
export function checkRestore(
  record: LifecycleRecord,
  now: Date,
  activeArtifacts: number,
): Result<{ expiresAt: Date }> {
  const archivedAt = effectiveArchivedAt(record, now);
  if (!archivedAt) return fail("invalid_input", "Only archived artifacts can be restored.");
  if (now >= purgeDate(archivedAt)) {
    return fail("not_found", "The archive has expired and the artifact was deleted.");
  }
  if (activeArtifacts >= LIMITS.activeArtifacts) {
    return fail("quota_exceeded", `You already have ${LIMITS.activeArtifacts} active artifacts.`);
  }
  return ok({ expiresAt: nextExpiry(now) });
}
