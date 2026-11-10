import { LIMITS, type PlanLimits } from "@portifact/contracts";
import { type Entitlements, hasFeature } from "./plans.ts";
import { fail, ok, type Result } from "./result.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Publishing, updating or renewing sets the expiry to now plus 30 days. */
export function nextExpiry(now: Date): Date {
  return new Date(now.getTime() + LIMITS.activeDays * DAY_MS);
}

/**
 * Archived artifacts are purged `months` calendar months after archiving, in UTC: the owner's
 * plan's `archiveMonths` when it was archived (6 on free, 12 on paid plans). When the target
 * month is shorter (for example archiving on August 31), the date clamps to its last day.
 */
export function purgeDate(archivedAt: Date, months: number): Date {
  const year = archivedAt.getUTCFullYear();
  const month = archivedAt.getUTCMonth() + months;
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
  /** The purge date set when it was archived; absent where a caller does not need it. */
  purgeAt?: Date | null;
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

/**
 * When an artifact archived at `now` is purged: the date set when it was archived, or, for an
 * active artifact past its expiry that maintenance has not archived yet, its expiry plus the
 * owner's archive months. A date already set never moves, so a later plan change neither
 * shortens nor extends it.
 */
export function effectivePurgeAt(
  record: LifecycleRecord,
  now: Date,
  archiveMonths: number,
): Date | null {
  const archivedAt = effectiveArchivedAt(record, now);
  if (!archivedAt) return null;
  if (record.state === "archived" && record.purgeAt) return record.purgeAt;
  return purgeDate(archivedAt, archiveMonths);
}

/**
 * Only the owner may restore, only before the purge date, and only with a free active slot of
 * the owner's plan.
 */
export function checkRestore(
  record: LifecycleRecord,
  now: Date,
  activeArtifacts: number,
  limits: Pick<PlanLimits, "activeArtifacts" | "archiveMonths">,
): Result<{ expiresAt: Date }> {
  const purgeAt = effectivePurgeAt(record, now, limits.archiveMonths);
  if (!purgeAt) return fail("invalid_input", "Only archived artifacts can be restored.");
  if (now >= purgeAt) {
    return fail("not_found", "The archive has expired and the artifact was deleted.");
  }
  if (activeArtifacts >= limits.activeArtifacts) {
    return fail("quota_exceeded", `You already have ${limits.activeArtifacts} active artifacts.`);
  }
  return ok({ expiresAt: nextExpiry(now) });
}

/** An artifact's lifecycle with its pin (premium plan P2). */
export interface PinRecord extends LifecycleRecord {
  pinned: boolean;
}

/**
 * Pinning keeps an active artifact published with no expiry until it is unpinned. Only an
 * artifact that is active at `now` can be pinned; pinning a pinned one changes nothing. The plan
 * check (`requireFeature(owner, "pin")`) comes first, in the service.
 */
export function checkPin(record: PinRecord, now: Date): Result<{ changed: boolean }> {
  if (effectiveState(record, now) !== "active") {
    return fail("artifact_archived", "Only active artifacts can be pinned; restore it first.");
  }
  return ok({ changed: !record.pinned });
}

/**
 * Unpinning gives a pinned artifact a fresh 30-day expiry from `now`, like a renewal. It needs no
 * plan, so an owner can always undo a pin. Unpinning an artifact that is not pinned changes
 * nothing and keeps its expiry.
 */
export function checkUnpin(
  record: PinRecord,
  now: Date,
): Result<{ changed: boolean; expiresAt: Date | null }> {
  if (record.state !== "active") {
    return fail("invalid_input", "Only active artifacts can be unpinned.");
  }
  if (!record.pinned) return ok({ changed: false, expiresAt: record.expiresAt });
  return ok({ changed: true, expiresAt: nextExpiry(now) });
}

/**
 * Whether an owner's pins lapse: its plan (expired, removed or lowered) no longer includes `pin`.
 * The maintenance scan then unpins its artifacts with a fresh 30-day expiry; nothing is archived
 * or deleted on the spot.
 */
export function pinsLapse(owner: Entitlements): boolean {
  return !hasFeature(owner, "pin");
}
