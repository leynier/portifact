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
  "comment_notice",
  "owner_retention",
  "webhook_delivery",
  "delete_custom_hostname",
  "workspace_deletion",
  "access_history_move",
  "domain_notice",
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
 * Threads one comment notice covers at most: a safety cap on the payload (a queue message), not a
 * plan limit. Activity past it stays pending and goes in the recipient's next notice.
 */
export const COMMENT_NOTICE_THREADS_MAX = 200;

/**
 * Payload of a `comment_notice` job (its subject is the recipient's user ID): the threads with new
 * activity and what happened in each. IDs and counts only, never comment text or authors. The job
 * counts only the threads the recipient may still see when it sends.
 */
export const CommentNoticePayload = z.strictObject({
  /** Unique per scheduling; the scan's batch consumes the pending rows only for its own job. */
  claim: z.string().min(1).max(100),
  threads: z
    .array(
      z.strictObject({
        artifactId: z.string().min(1).max(200),
        threadId: z.string().min(1).max(200),
        /** 1 when the thread is new. */
        created: z.number().int().min(0).max(1),
        replies: z.number().int().min(0).max(200),
        /** 1 when the thread was resolved. */
        resolved: z.number().int().min(0).max(1),
      }),
    )
    .min(1)
    .max(COMMENT_NOTICE_THREADS_MAX),
});
export type CommentNoticePayload = z.infer<typeof CommentNoticePayload>;

/**
 * Payload of a `domain_notice` job (its subject is the owner): the custom domains a plan that
 * ended will stop covering, and when (decision 0006, section 7). Hostnames only.
 */
export const DomainNoticePayload = z.strictObject({
  hostnames: z.array(z.string().min(1).max(253)).min(1).max(100),
  detachAt: z.number().int().nonnegative(),
});
export type DomainNoticePayload = z.infer<typeof DomainNoticePayload>;

/**
 * One purged or deleted artifact or account, a revoked share link, a removed webhook or a removed
 * or lapsed workspace email domain (by row ID), that a restored backup must not bring back.
 */
export const TombstoneMarker = z.strictObject({
  kind: z.enum(["artifact", "account", "share_link", "workspace", "webhook", "workspace_domain"]),
  id: z.string().min(1).max(200),
  deletedAt: z.number().int().nonnegative(),
});
export type TombstoneMarker = z.infer<typeof TombstoneMarker>;
