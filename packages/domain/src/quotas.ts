import { LIMITS, type PlanLimits } from "@portifact/contracts";
import { formatSize } from "./plans.ts";
import { fail, ok, type Result } from "./result.ts";

/** Current consumption of an account, including capacity reserved by uploads in progress. */
export interface AccountUsage {
  activeArtifacts: number;
  /** Unique retained object bytes plus bytes reserved by open uploads. */
  storedBytes: number;
  publishesLast24h: number;
  openUploads: number;
  newFilesLast24h: number;
  newBytesLast24h: number;
  newObjectsThisMonth: number;
}

export interface PublishRequest {
  /** True when this publish creates a new artifact and takes an active slot. */
  createsArtifact: boolean;
  /** Uncompressed size of all published files of the version. */
  versionBytes: number;
  /** Files of the version (published and private sources). */
  files: number;
  /** Bytes and files not already stored by the account (after deduplication). */
  newBytes: number;
  newFiles: number;
}

/** The plan limits checkPublish applies; the other limits are safety caps in LIMITS. */
export type PublishLimits = Pick<PlanLimits, "activeArtifacts" | "artifactBytes" | "accountBytes">;

/** What a successful check reserves; the caller stores it in the same transaction. */
export interface Reservation {
  activeSlots: number;
  bytes: number;
  files: number;
}

/**
 * Checks whether a publish fits the account's quotas. Reservations count as used, so two
 * concurrent uploads cannot both take the last slot or the last bytes. `limits` are the owner's
 * plan limits (`entitlements`).
 */
export function checkPublish(
  usage: AccountUsage,
  request: PublishRequest,
  limits: PublishLimits,
): Result<Reservation> {
  if (request.versionBytes > limits.artifactBytes) {
    return fail(
      "quota_exceeded",
      `An artifact version can be at most ${formatSize(limits.artifactBytes)}.`,
    );
  }
  if (request.files > LIMITS.filesPerVersion) {
    return fail("quota_exceeded", `A version can hold at most ${LIMITS.filesPerVersion} files.`);
  }
  if (request.createsArtifact && usage.activeArtifacts >= limits.activeArtifacts) {
    return fail("quota_exceeded", `You already have ${limits.activeArtifacts} active artifacts.`);
  }
  if (usage.storedBytes + request.newBytes > limits.accountBytes) {
    return fail(
      "quota_exceeded",
      `This would exceed your ${formatSize(limits.accountBytes)} of storage.`,
    );
  }
  if (usage.publishesLast24h >= LIMITS.publishesPer24h) {
    return fail("quota_exceeded", `You can publish ${LIMITS.publishesPer24h} times per 24 hours.`);
  }
  if (usage.openUploads >= LIMITS.concurrentUploads) {
    return fail("quota_exceeded", "Finish or cancel your other uploads first.");
  }
  if (
    usage.newFilesLast24h + request.newFiles > LIMITS.newFilesPer24h ||
    usage.newBytesLast24h + request.newBytes > LIMITS.newBytesPer24h
  ) {
    return fail("quota_exceeded", "You uploaded too many new files in the last 24 hours.");
  }
  if (usage.newObjectsThisMonth + request.newFiles > LIMITS.newObjectsPerMonth) {
    return fail("quota_exceeded", "You reached the monthly limit of new files.");
  }
  return ok({
    activeSlots: request.createsArtifact ? 1 : 0,
    bytes: request.newBytes,
    files: request.newFiles,
  });
}
