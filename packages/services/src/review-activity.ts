// The write side of review events (decisions 0009 and 0013): the statements a review request, a
// change that adds reviewers, or a batch that makes a version's status final adds to its own
// batch, on its own condition, so the webhook event and the email job exist exactly when the write
// does and cost no extra round trip. They are built from the owner's entitlements the write
// already loaded: `review.requested` and `review.completed` webhook events only with `webhooks`,
// the `review_notice` job only with both `reviews` and `commentNotices` (`reviewNoticesOn`).
// Nothing here reads.
import { type Db, schema } from "@portifact/db";
import { type Entitlements, reviewNoticesOn } from "@portifact/domain";
import { type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { markWebhookEvent } from "./webhook-activity.ts";

const rq = schema.reviewRequests;
const rr = schema.reviewReviewers;
const rv = schema.reviewVerdicts;
const o = schema.outbox;

/** What the review statements need from the write: all of it already loaded. */
export interface ReviewEventContext {
  entitlements: Entitlements;
  artifact: { id: string; ownerId: string };
}

/** The counting reviewers' verdicts of one kind on the version under review, live in the batch. */
function liveVerdicts(requestId: string, verdict: "approve" | "changes"): SQL {
  return sql`(select count(*) from ${rv} join ${rr} on ${rr.requestId} = ${rv.requestId} and ${rr.email} = ${rv.email} join ${rq} on ${rq.id} = ${rv.requestId} where ${rv.requestId} = ${requestId} and ${rr.droppedAt} is null and ${rv.versionId} = ${rq.versionId} and ${rv.verdict} = ${verdict})`;
}

/** The counting reviewers of a request, live in the batch. */
function liveReviewers(requestId: string): SQL {
  return sql`(select count(*) from ${rr} where ${rr.requestId} = ${requestId} and ${rr.droppedAt} is null)`;
}

/**
 * The status of a request on its live rows (`liveApprovalStatus` in ./approval-reviews.ts holds
 * the same answer; both follow `approvalSummary`).
 */
export function liveStatus(requestId: string): SQL<string> {
  const reviewers = liveReviewers(requestId);
  const required = liveRequired(requestId);
  return sql<string>`(case when ${liveVerdicts(requestId, "changes")} > 0 then 'changes_requested' when ${reviewers} > 0 and ${liveVerdicts(requestId, "approve")} >= ${required} then 'approved' else 'pending' end)`;
}

function liveRequired(requestId: string): SQL {
  const reviewers = liveReviewers(requestId);
  return sql`max(1, min(coalesce((select ${rq.required} from ${rq} where ${rq.id} = ${requestId}), ${reviewers}), ${reviewers}))`;
}

/**
 * The review's status and counts as one JSON value (an `ApprovalSummary`), computed in the batch:
 * what a review webhook event carries. Counts only: no address, name or note.
 */
export function liveSummary(requestId: string): SQL {
  return sql`json_object('status', ${liveStatus(requestId)}, 'reviewers', ${liveReviewers(requestId)}, 'required', ${liveRequired(requestId)}, 'approvals', ${liveVerdicts(requestId, "approve")}, 'changesRequested', ${liveVerdicts(requestId, "changes")})`;
}

/** The number of the version under review, read in the batch. */
function liveVersionNumber(requestId: string): SQL {
  const v = schema.versions;
  return sql`(select ${v.number} from ${v} where ${v.id} = (select ${rq.versionId} from ${rq} where ${rq.id} = ${requestId}))`;
}

/** The version under review, read in the batch. */
function liveVersionId(requestId: string): SQL {
  return sql`(select ${rq.versionId} from ${rq} where ${rq.id} = ${requestId})`;
}

/**
 * True exactly when `announce` (./approval-reviews.ts) is about to record a final status: the
 * request is open, its live status is final and not the one announced. The statements built on it
 * run just before `announce` in the same batch, so they see the same rows.
 */
export function aboutToAnnounce(requestId: string, condition: SQL): SQL {
  const live = liveStatus(requestId);
  return sql`exists (select 1 from ${rq} where ${rq.id} = ${requestId} and ${rq.cancelledAt} is null and ${live} in ('approved', 'changes_requested') and ${rq.announced} is not ${live}) and ${condition}`;
}

/** A `review_notice` event job for the request, written when `condition` holds. */
function noticeJob(db: Db, requestId: string, payload: SQL, condition: SQL, now: number) {
  // Columns in schema order: id, topic, payload, available, dispatched, attempts, created,
  // subject, generation.
  return db
    .insert(o)
    .select(
      sql`select null, 'review_notice', ${payload}, ${now}, null, 0, ${now}, ${requestId}, null where ${condition}`,
    );
}

/**
 * A new request, or reviewers added to an open one: the `review.requested` webhook event (only
 * for a new request) and the email job for the reviewers added at `addedAt`. `condition` is the
 * write's own: the request it created, or the change it applied.
 */
export function reviewRequestedStatements(
  db: Db,
  context: ReviewEventContext,
  input: {
    requestId: string;
    addedAt: number;
    /** Who asked: the owner side, named in a webhook event only if they did everything counted. */
    actorId: string;
    /** A new request is a webhook event; added reviewers are only told by email. */
    webhook: boolean;
    condition: SQL;
    now: number;
  },
): BatchItem<"sqlite">[] {
  const statements: BatchItem<"sqlite">[] = [];
  if (input.webhook) {
    statements.push(
      ...markWebhookEvent(db, {
        entitlements: context.entitlements,
        ownerId: context.artifact.ownerId,
        artifactId: context.artifact.id,
        type: "review.requested",
        actorId: input.actorId,
        version: liveVersionNumber(input.requestId),
        review: liveSummary(input.requestId),
        now: input.now,
        condition: input.condition,
      }),
    );
  }
  if (reviewNoticesOn(context.entitlements)) {
    statements.push(
      noticeJob(
        db,
        input.requestId,
        sql`json_object('stage', 'event', 'kind', 'requested', 'versionId', ${liveVersionId(input.requestId)}, 'addedAt', ${input.addedAt})`,
        input.condition,
        input.now,
      ),
    );
  }
  return statements;
}

/**
 * The version under review reached a final status: the `review.completed` webhook event and the
 * email job for the owner side, on `aboutToAnnounce`. Placed right before `announce` in the batch.
 */
export function reviewCompletedStatements(
  db: Db,
  context: ReviewEventContext,
  input: {
    requestId: string;
    /** Whose verdict made it final, when one did. */
    actorId: string | null;
    condition: SQL;
    now: number;
  },
): BatchItem<"sqlite">[] {
  const when = aboutToAnnounce(input.requestId, input.condition);
  const statements: BatchItem<"sqlite">[] = [
    ...markWebhookEvent(db, {
      entitlements: context.entitlements,
      ownerId: context.artifact.ownerId,
      artifactId: context.artifact.id,
      type: "review.completed",
      // Never a reviewer's name: the event says what was decided, not who decided it.
      actorId: null,
      version: liveVersionNumber(input.requestId),
      review: liveSummary(input.requestId),
      now: input.now,
      condition: when,
    }),
  ];
  if (reviewNoticesOn(context.entitlements)) {
    statements.push(
      noticeJob(
        db,
        input.requestId,
        sql`json_object('stage', 'event', 'kind', 'completed', 'versionId', ${liveVersionId(input.requestId)}, 'status', ${liveStatus(input.requestId)}, 'actorId', ${input.actorId})`,
        when,
        input.now,
      ),
    );
  }
  return statements;
}
