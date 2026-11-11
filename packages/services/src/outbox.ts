// Transactional outbox (plan section 10). A state change that needs follow-up work writes an
// `outbox` row in the same D1 batch, so the job exists exactly when the change does. The
// scheduled run relays pending rows to the `portifact-jobs` queue and the consumer runs them.
// Queues deliver at least once, so every job is idempotent: the row is the job's source of
// truth, a job whose row is gone is already done, and a purge carries the lifecycle generation
// it was claimed with, so it never acts on an artifact that changed since. The scheduled scans
// stay as a safety net for anything the queue loses.

import {
  DeleteObjectsPayload,
  EraseAccessEventsPayload,
  type JobMessage,
} from "@portifact/contracts";
import { type AccessDb, type Db, type Region, type RegionalDb, schema } from "@portifact/db";
import { and, asc, eq, inArray, isNull, lte, or, type SQL, sql } from "drizzle-orm";
import { eraseAccessEvents } from "./access-log.ts";
import { advanceAccountDeletion } from "./account-data.ts";
import { applyOwnerRetention, moveAccessHistory } from "./analytics.ts";
import { type AuditStreamDeps, deliverAuditStream } from "./audit-streams.ts";
import type { DomainDeps } from "./cloudflare-hostnames.ts";
import { type CommentNotifier, sendCommentNotice } from "./comment-notices.ts";
import { runSearchIndex } from "./content-search.ts";
import { domainDbsOf, runDeleteHostname } from "./custom-domains.ts";
import { type DirectoryNotifier, sendDirectoryNotice } from "./directory-notices.ts";
import { type DomainNotifier, sendDomainNotice } from "./domain-notices.ts";
import { type ExpiryNotifier, sendExpiryNotice } from "./expiry-notices.ts";
import { deleteArtifactData } from "./maintenance.ts";
import { abortSessionMultipart } from "./multipart.ts";
import { type GraceNotifier, sendGraceNotice } from "./plan-grace-notices.ts";
import { applyOwnerPlanRegion } from "./plans.ts";
import { type ReviewNotifier, runReviewNotice } from "./review-notices.ts";
import { runThreadIssue, type ThreadIssueDeps } from "./thread-issues.ts";
import { deliverWebhook, type WebhookDeps } from "./webhooks.ts";
import { runWorkspacePolicyJob } from "./workspace-policies.ts";
import { advanceWorkspaceDeletion, type DeletionRegions, singleRegion } from "./workspaces.ts";

/** A relayed job that is not done after this long is sent again. */
export const OUTBOX_REDELIVER_MS = 60 * 60_000;
/**
 * Jobs the request itself goes on to do right away become relayable only after this delay, so
 * the queue gets them only when that inline work did not finish.
 */
export const OUTBOX_INLINE_GRACE_MS = 5 * 60_000;

const IN_CHUNK = 80;

/**
 * Inserts a `purge_artifact` job for every artifact `where` matches, carrying the generation the
 * claim that follows in the same batch gives it. Put it before that claim and give both the same
 * condition on the old state, so the job exists exactly when the claim happens.
 */
export function purgeJobs(db: Db, where: SQL, now: number, availableAt = now) {
  const a = schema.artifacts;
  return db
    .insert(schema.outbox)
    .select(
      sql`select null, 'purge_artifact', '{}', ${availableAt}, null, 0, ${now}, ${a.id}, ${a.lifecycleGeneration} + 1 from ${a} where ${where}`,
    );
}

/** Inserts an `account_deletion` job for `userId` when `condition` holds. */
export function accountDeletionJob(db: Db, userId: string, condition: SQL, now: number) {
  return db
    .insert(schema.outbox)
    .select(
      sql`select null, 'account_deletion', '{}', ${now}, null, 0, ${now}, ${userId}, null where ${condition}`,
    );
}

/** Deletes the finished jobs of one topic and subject, for example once an artifact is purged. */
export function closeJobs(
  db: Db,
  topic: (typeof schema.OUTBOX_TOPICS)[number],
  subject: string,
  condition: SQL,
) {
  return db
    .delete(schema.outbox)
    .where(and(eq(schema.outbox.topic, topic), eq(schema.outbox.subject, subject), condition));
}

export interface RelayResult {
  relayed: number;
}

/**
 * Sends pending jobs to the queue: rows never sent, and rows sent more than
 * `OUTBOX_REDELIVER_MS` ago that are still there (the message was lost, or its retries ran out).
 * A row is marked sent only after the queue accepted it, so a failed send is retried next run.
 */
export async function relayOutbox(
  db: Db,
  queue: Queue<JobMessage>,
  now: number,
  pages = 5,
  /** The region whose database `db` is; its messages name it unless it is the default one. */
  region: Region = "default",
): Promise<RelayResult> {
  const o = schema.outbox;
  let relayed = 0;
  for (let page = 0; page < pages; page += 1) {
    const due = await db
      .select({ id: o.id, topic: o.topic })
      .from(o)
      .where(
        and(
          lte(o.availableAt, now),
          or(isNull(o.dispatchedAt), lte(o.dispatchedAt, now - OUTBOX_REDELIVER_MS)),
        ),
      )
      .orderBy(asc(o.id))
      .limit(IN_CHUNK);
    if (due.length === 0) break;
    await queue.sendBatch(
      due.map((row) => ({
        body: region === "default" ? { id: row.id, topic: row.topic } : { ...row, region },
      })),
    );
    await db
      .update(o)
      .set({ dispatchedAt: now, attempts: sql`${o.attempts} + 1` })
      .where(
        inArray(
          o.id,
          due.map((row) => row.id),
        ),
      );
    relayed += due.length;
    if (due.length < IN_CHUNK) break;
  }
  return { relayed };
}

/**
 * - `done`: the job did its work, or found it already done.
 * - `stale`: what the job was about changed meanwhile, so it did nothing.
 * - `pending`: it advanced but is not finished; deliver it again later.
 * - `kept`: the job moved its own row to a later time (the relay sends it again then), or another
 *   run holds it; the row stays and the message is done.
 */
export type JobOutcome = "done" | "stale" | "pending" | "kept";

/** What some jobs need besides D1 and R2; the jobs Worker always passes both. */
export interface JobDeps {
  /** The access log database, for `erase_access_events` and `owner_retention` jobs. */
  access?: AccessDb | undefined;
  /** Sends `expiry_notice` emails. */
  notifier?: ExpiryNotifier | undefined;
  /** Sends `comment_notice` emails. */
  commentNotifier?: CommentNotifier | undefined;
  /** Delivers `webhook_delivery` jobs. */
  webhooks?: WebhookDeps | undefined;
  /** Delivers `audit_stream` jobs (decision 0019): the webhook keys, network and switches. */
  auditStreams?: AuditStreamDeps | undefined;
  /** Cloudflare's custom hostnames, for `delete_custom_hostname` jobs; null while switched off. */
  domains?: DomainDeps | null | undefined;
  /** Sends `domain_notice` emails. */
  domainNotifier?: DomainNotifier | undefined;
  /** Sends `review_notice` emails. */
  reviewNotifier?: ReviewNotifier | undefined;
  /** Sends `directory_notice` emails (decision 0017). */
  directoryNotifier?: DirectoryNotifier | undefined;
  /** Creates issues from threads for `thread_issue` jobs (decision 0018). */
  issues?: ThreadIssueDeps | undefined;
  /** Sends `plan_grace_notice` emails (decision 0022, third delivery). */
  graceNotifier?: GraceNotifier | undefined;
  /** Every region, for the deletions that reach all of them; only the job's own without it. */
  regions?: DeletionRegions | undefined;
}

/** Runs one queued job. Safe to run again or concurrently with the same message. */
export async function runJob(
  db: RegionalDb,
  bucket: R2Bucket,
  message: JobMessage,
  now: number,
  deps: JobDeps = {},
): Promise<JobOutcome> {
  const [row] = await db.select().from(schema.outbox).where(eq(schema.outbox.id, message.id));
  // Done by an earlier delivery, by the request itself or by a scheduled scan.
  if (!row) return "done";
  const outcome = await runRow(db, bucket, row, now, deps);
  if (outcome !== "pending" && outcome !== "kept") {
    await db.delete(schema.outbox).where(eq(schema.outbox.id, row.id));
  }
  return outcome;
}

async function runRow(
  db: RegionalDb,
  bucket: R2Bucket,
  row: typeof schema.outbox.$inferSelect,
  now: number,
  {
    access,
    notifier,
    commentNotifier,
    webhooks,
    auditStreams,
    domains,
    domainNotifier,
    reviewNotifier,
    directoryNotifier,
    issues,
    graceNotifier,
    regions = singleRegion(db, bucket),
  }: JobDeps,
): Promise<JobOutcome> {
  switch (row.topic) {
    case "purge_artifact":
      return purgeClaimed(db, bucket, row.subject ?? "", row.generation ?? -1, now);
    case "account_deletion": {
      const state = await advanceAccountDeletion(regions, row.subject ?? "", now);
      return state === "absent" ? "stale" : state === "finished" ? "done" : "pending";
    }
    case "delete_objects":
      await deleteUnreferencedKeys(db, bucket, DeleteObjectsPayload.parse(row.payload).keys);
      return "done";
    case "abort_multipart":
      return abortSessionMultipart(db, bucket, row.subject ?? "");
    case "erase_access_events": {
      // Thrown, not reported done: the row stays and the job runs again where the binding is.
      if (!access) throw new Error("erase_access_events needs the access log database");
      const { kind } = EraseAccessEventsPayload.parse(row.payload);
      return eraseAccessEvents(access, kind, row.subject ?? "");
    }
    case "plan_region":
      return applyOwnerPlanRegion(regions, row.subject ?? "", now);
    case "owner_retention":
      if (!access) throw new Error("owner_retention needs the access log database");
      return applyOwnerRetention(db, access, row.subject ?? "", now);
    case "expiry_notice":
      if (!notifier) throw new Error("expiry_notice needs the notifier");
      return sendExpiryNotice(db, row, now, notifier);
    case "access_history_move":
      if (!access) throw new Error("access_history_move needs the access log database");
      return moveAccessHistory(db, access, row.subject ?? "", now);
    case "workspace_deletion": {
      const state = await advanceWorkspaceDeletion(regions, row.subject ?? "", now);
      return state === "absent" ? "stale" : state === "finished" ? "done" : "pending";
    }
    case "comment_notice":
      if (!commentNotifier) throw new Error("comment_notice needs the comment notifier");
      return sendCommentNotice(db, row, now, commentNotifier);
    case "webhook_delivery":
      // Thrown, not reported done: the row stays and the job runs again where the keys are.
      if (!webhooks || webhooks.keys.length === 0) {
        throw new Error("webhook_delivery needs the webhook keys");
      }
      return deliverWebhook(db, row, now, webhooks);
    case "delete_custom_hostname":
      // Written in the global batch that detached the domain (one database with one region).
      return runDeleteHostname(domainDbsOf(db), domains ?? null, row.subject ?? "");
    case "domain_notice":
      if (!domainNotifier) throw new Error("domain_notice needs the domain notifier");
      return sendDomainNotice(db, row, now, domainNotifier);
    case "search_index":
      return runSearchIndex(db, bucket, row, now);
    case "review_notice":
      if (!reviewNotifier) throw new Error("review_notice needs the review notifier");
      return runReviewNotice(db, row, now, reviewNotifier);
    case "directory_notice":
      if (!directoryNotifier) throw new Error("directory_notice needs the directory notifier");
      return sendDirectoryNotice(db, row, now, directoryNotifier);
    case "workspace_policy":
      // Written in the global batch that saved the policy (one database with one region).
      return runWorkspacePolicyJob(db, row, now);
    case "thread_issue":
      // Thrown, not reported done: the row stays and the job runs again where the network is.
      if (!issues) throw new Error("thread_issue needs the integration deps");
      return runThreadIssue(db, row, now, issues);
    case "audit_stream":
      // Without the deps or the key the job ends instead of being redelivered forever; the scan
      // gives the stream a job again once streams are switched on with a key (decision 0019).
      if (!auditStreams || auditStreams.keys.length === 0) return "stale";
      return deliverAuditStream(db, row, now, auditStreams);
    case "plan_grace_notice":
      // Thrown, not reported done: the row stays and the job runs again where both are bound.
      if (!graceNotifier) throw new Error("plan_grace_notice needs the grace notifier");
      if (!access) throw new Error("plan_grace_notice needs the access log database");
      return sendGraceNotice(db, access, row, now, graceNotifier);
  }
}

/** Purges an artifact only while it is still in the `purging` state the job was claimed with. */
async function purgeClaimed(
  db: RegionalDb,
  bucket: R2Bucket,
  artifactId: string,
  generation: number,
  now: number,
): Promise<JobOutcome> {
  const [artifact] = await db
    .select({ state: schema.artifacts.state, generation: schema.artifacts.lifecycleGeneration })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, artifactId));
  if (!artifact) return "done";
  if (artifact.state !== "purging" || artifact.generation !== generation) return "stale";
  await deleteArtifactData(db, bucket, artifactId, now);
  return "done";
}

/**
 * Deletes R2 objects whose rows a committed batch already deleted. Keys are content addressed,
 * so a key that has a row again (the same bytes uploaded since, or a brand's logo named again)
 * is kept.
 */
async function deleteUnreferencedKeys(db: Db, bucket: R2Bucket, keys: string[]) {
  for (let i = 0; i < keys.length; i += IN_CHUNK) {
    const chunk = keys.slice(i, i + IN_CHUNK);
    const kept = new Set(
      (
        await db
          .select({ key: schema.objects.r2Key })
          .from(schema.objects)
          .where(inArray(schema.objects.r2Key, chunk))
      ).map((row) => row.key),
    );
    // A logo key is kept while a brand names it again (the same logo uploaded since).
    const logos = chunk.filter((key) => key.startsWith("brands/"));
    if (logos.length > 0) {
      const b = schema.ownerBrands;
      const named = sql<string>`'brands/' || ${b.ownerId} || '/' || ${b.logoSha256}`;
      for (const row of await db.select({ key: named }).from(b).where(inArray(named, logos))) {
        kept.add(row.key);
      }
    }
    const gone = chunk.filter((key) => !kept.has(key));
    if (gone.length > 0) await bucket.delete(gone);
  }
}
