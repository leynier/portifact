// Shapes that cross the jobs Worker's boundaries: messages on the `portifact-jobs` queue, the
// payloads of outbox rows, and the tombstone markers the operator exports before restoring a
// backup and applies after it (docs/operations.md).
import { z } from "zod";
import { Region } from "./workspaces.ts";

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
  "search_index",
  "review_notice",
  "workspace_policy",
  "directory_notice",
  "thread_issue",
  "plan_region",
  "audit_stream",
  "retention_notice",
  "plan_grace_notice",
  "comment_retention_notice",
  "comment_tombstones",
  "moderation_notice",
  "report_outcome",
  "legal_hold_release",
]);
export type OutboxTopic = z.infer<typeof OutboxTopic>;

/**
 * A queue message only points at its outbox row; the row is the job's source of truth. Every
 * control database has its own outbox (decision 0005), so `region` names the database the row is
 * in; a message without it is the default region's, which is also the global database's, so the
 * messages queued before a second region existed keep working.
 */
export const JobMessage = z.strictObject({
  id: z.number().int().positive(),
  topic: OutboxTopic,
  region: Region.optional(),
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

const reviewNoticeId = z.string().min(1).max(200);

/**
 * Payload of a `review_notice` job (approval reviews, decision 0013, "Emails"). The write's batch
 * adds one `event` job (its subject is the request): who was asked (the reviewers added at
 * `addedAt`) or which final status the version reached. The job fans it out into one `send` job
 * per recipient account (its subject is the account), which sends one email. IDs, a time and a
 * status only: never an address, a name or a note.
 */
export const ReviewNoticePayload = z.union([
  z.strictObject({
    stage: z.literal("event"),
    kind: z.literal("requested"),
    versionId: reviewNoticeId,
    /** The reviewers asked are those added at this time. */
    addedAt: z.number().int().nonnegative(),
  }),
  z.strictObject({
    stage: z.literal("event"),
    kind: z.literal("completed"),
    versionId: reviewNoticeId,
    status: z.enum(["approved", "changes_requested"]),
    /** Whose verdict made it final, when one did: they are not told about their own act. */
    actorId: reviewNoticeId.nullable(),
  }),
  z.strictObject({
    stage: z.literal("send"),
    kind: z.enum(["requested", "completed"]),
    requestId: reviewNoticeId,
    artifactId: reviewNoticeId,
    versionId: reviewNoticeId,
    status: z.enum(["approved", "changes_requested"]).nullable(),
  }),
]);
export type ReviewNoticePayload = z.infer<typeof ReviewNoticePayload>;

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
 * or lapsed workspace email domain (by row ID), a deleted workspace group or a removed group
 * membership (by row ID, decision 0014) or a removed single sign-on provider (by row ID,
 * decision 0016), a removed issue integration connection (decision 0018) or a removed audit
 * stream (decision 0019), that a restored backup must not bring back.
 */
export const TombstoneMarker = z.strictObject({
  kind: z.enum([
    "artifact",
    "account",
    "share_link",
    "workspace",
    "webhook",
    "service_token",
    "workspace_domain",
    "workspace_group",
    "workspace_group_member",
    "workspace_sso",
    "scim_token",
    "scim_user",
    "workspace_invitation",
    "workspace_member",
    "integration_connection",
    "audit_stream",
    "comment_thread",
    "github_trust_rule",
    "comment_message",
    "workspace_member_left",
    "notice_opt_out",
    "comment_notice_mute",
    "session",
    "oauth_token",
    "oauth_grant",
  ]),
  id: z.string().min(1).max(200),
  deletedAt: z.number().int().nonnegative(),
});
export type TombstoneMarker = z.infer<typeof TombstoneMarker>;

/**
 * A legal hold, as `export-tombstones` writes it next to the markers (one JSON line each) and
 * `apply-tombstones` puts back before anything else, so a restore never loses a hold, never
 * brings back one that was released, and never lets a re-applied deletion take a held artifact.
 */
export const LegalHoldLine = z.strictObject({
  legalHold: z.strictObject({
    id: z.string().regex(/^hold_[0-9a-f]{32}$/),
    artifactId: z.string().min(1).max(200),
    ownerId: z.string().min(1).max(200),
    ownerEmail: z.string().max(254).nullable(),
    reason: z.string().min(1).max(40),
    ground: z.string().min(1).max(500),
    createdAt: z.number().int().nonnegative(),
    releaseAt: z.number().int().nonnegative().nullable(),
    releasedAt: z.number().int().nonnegative().nullable(),
  }),
});
export type LegalHoldLine = z.infer<typeof LegalHoldLine>;
