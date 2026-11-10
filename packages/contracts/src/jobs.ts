// Shapes that cross the jobs Worker's boundaries: messages on the `portifact-jobs` queue, the
// payloads of outbox rows, and the tombstone markers the operator exports before restoring a
// backup and applies after it (docs/operations.md).
import { z } from "zod";

export const OutboxTopic = z.enum([
  "purge_artifact",
  "account_deletion",
  "delete_objects",
  "abort_multipart",
  "erase_access_events",
  "expiry_notice",
]);
export type OutboxTopic = z.infer<typeof OutboxTopic>;

/** A queue message only points at its outbox row; the row is the job's source of truth. */
export const JobMessage = z.strictObject({
  id: z.number().int().positive(),
  topic: OutboxTopic,
});
export type JobMessage = z.infer<typeof JobMessage>;

/** Payload of a `delete_objects` job: the R2 keys whose rows its batch deleted. */
export const DeleteObjectsPayload = z.object({
  keys: z.array(z.string().min(1).max(200)).max(100),
});

/**
 * Payload of an `erase_access_events` job: whether its subject is a purged artifact (its whole
 * access log goes) or a deleted account (its openings of other people's artifacts go).
 */
export const EraseAccessEventsPayload = z.strictObject({
  kind: z.enum(["artifact", "user"]),
});
export type EraseAccessEventsPayload = z.infer<typeof EraseAccessEventsPayload>;

/**
 * Artifacts one expiry notice lists at most: a safety cap on the payload (a queue message) and the
 * email, not a plan limit. An owner with more expiring at once gets the rest, soonest first, in
 * the next notices (one a day while they stay inside the notice window).
 */
export const EXPIRY_NOTICE_ARTIFACTS_MAX = 1_000;

/**
 * Payload of an `expiry_notice` job (its subject is the owner): the artifacts it tells the owner
 * about, each with the expiry it was scheduled for. The job skips an artifact whose expiry changed
 * since (renewed or published again) or that is no longer active.
 */
export const ExpiryNoticePayload = z.strictObject({
  artifacts: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(200),
        expiresAt: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .max(EXPIRY_NOTICE_ARTIFACTS_MAX),
});
export type ExpiryNoticePayload = z.infer<typeof ExpiryNoticePayload>;

/**
 * One purged or deleted artifact or account, or a revoked share link, that a restored backup must
 * not bring back.
 */
export const TombstoneMarker = z.strictObject({
  kind: z.enum(["artifact", "account", "share_link"]),
  id: z.string().min(1).max(200),
  deletedAt: z.number().int().nonnegative(),
});
export type TombstoneMarker = z.infer<typeof TombstoneMarker>;
