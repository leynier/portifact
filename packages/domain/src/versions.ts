// Previous versions (plan section 5, "Versiones históricas", and premium plan P3): how many an
// artifact keeps and for how long come from its owner's plan, read when a version is listed,
// rolled back to or pruned, never fixed when it was replaced. So an upgrade keeps longer the
// versions not pruned yet, and a lower plan prunes down to its own values on the next scan.
import type { PlanLimits } from "@portifact/contracts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How many previous versions an owner keeps, and for how many days after they were replaced. */
export interface VersionRetention {
  previousVersions: number;
  days: number;
}

export function versionRetention(
  limits: Pick<PlanLimits, "retainedPreviousVersions" | "previousVersionRetentionDays">,
): VersionRetention {
  return {
    previousVersions: limits.retainedPreviousVersions,
    days: limits.previousVersionRetentionDays,
  };
}

/** A version replaced at or before this moment is past the retention days at `now`. */
export function retentionCutoff(retention: VersionRetention, now: number): number {
  return now - retention.days * DAY_MS;
}

/** When a previous version replaced at `supersededAt` stops being retained by time. */
export function previousVersionExpiry(supersededAt: number, retention: VersionRetention): number {
  return supersededAt + retention.days * DAY_MS;
}

/**
 * Whether a previous version is still retained: replaced less than the retention days ago, and
 * fewer than the plan's number of previous versions were replaced after it (`newer`). The current
 * version is always retained and is not a previous version.
 */
export function previousVersionRetained(
  version: { supersededAt: number; newer: number },
  retention: VersionRetention,
  now: number,
): boolean {
  return (
    version.newer < retention.previousVersions &&
    previousVersionExpiry(version.supersededAt, retention) > now
  );
}
