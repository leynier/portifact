// Review emails (approval reviews, decision 0013, "Emails"). The write that asks for a review,
// adds reviewers or makes a version's status final writes one `review_notice` event job in its
// own batch (./review-activity.ts), only when the artifact owner's plan includes both `reviews`
// and `commentNotices`. The jobs Worker runs it in two steps:
//
// 1. The event job (subject: the request) turns into one `send` job per recipient account in one
//    batch that also deletes it: for a request, the reviewers added at that time who have an
//    account with that verified address (an address that never signed in gets nothing); for a
//    final status, the owner side (the user of a personal space, or a workspace's admins and
//    editors, the requester among them while they still are), never the person whose verdict
//    made it final.
// 2. A send job (subject: the recipient) claims its row by deleting it before sending, like
//    `comment_notice` and `expiry_notice`, checks again everything that may have changed (the
//    account, its opt-out, the request and the version, the owner's plan, that a reviewer is still
//    listed and can still open the artifact or that the recipient is still on the owner side and
//    has not muted it, the suppression list and the cycle's capacity), claims the one email per
//    person, artifact, version and kind in `review_notices`, and sends. A failed send puts both
//    back.
//
// Emails never hold the note, other reviewers' names or anything the reviewers wrote, and logs
// never hold an address: only a reason and a count.
import { ReviewNoticePayload } from "@portifact/contracts";
import type { LocaleCode } from "@portifact/contracts/locales";
import { type RegionalDb, schema } from "@portifact/db";
import { checkReviewNoticeCapacity, effectiveState, reviewNoticesOn } from "@portifact/domain";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { loadSettings } from "./account-settings.ts";
import { ownerSide } from "./actors.ts";
import { participation } from "./annotations.ts";
import {
  emailsSentInCycle,
  isEmailSuppressed,
  RecipientSuppressedError,
  recordEmailsSent,
  suppressEmail,
} from "./email.ts";
import type { JobOutcome } from "./outbox.ts";
import { ownerEntitlements } from "./plans.ts";

const o = schema.outbox;
const rq = schema.reviewRequests;
const rr = schema.reviewReviewers;
const a = schema.artifacts;
const sent = schema.reviewNotices;

type OutboxRow = typeof schema.outbox.$inferSelect;
type FinalStatus = "approved" | "changes_requested";

/**
 * Builds and sends one review email (the jobs Worker renders it with packages/emails and signs
 * the unsubscribe link for `userId` at `issuedAt`, the same link as comment notices). It throws
 * `RecipientSuppressedError` when the provider refuses the address, and an error without the
 * address or the message otherwise.
 */
export interface ReviewNotifier {
  send(notice: {
    to: string;
    userId: string;
    issuedAt: number;
    /** `requested`: the recipient was asked to review; `completed`: the version reached `status`. */
    kind: "requested" | "completed";
    status: FinalStatus | null;
    artifactId: string;
    name: string;
    version: number | null;
    /** The recipient's language (account settings); null means English. */
    locale: LocaleCode | null;
  }): Promise<void>;
}

type Skip =
  | "stale"
  | "plan"
  | "no_account"
  | "opted_out"
  | "not_reviewer"
  | "not_owner_side"
  | "muted"
  | "suppressed"
  | "capacity"
  | "duplicate";

function skipped(reason: Skip, recipients = 1): JobOutcome {
  // Only the reason and a count: never an address, a name or anything about the review.
  console.log(JSON.stringify({ event: "review_notice_skipped", reason, recipients }));
  return "stale";
}

/** Runs a `review_notice` job: an event fans out into send jobs, a send job sends one email. */
export async function runReviewNotice(
  db: RegionalDb,
  row: OutboxRow,
  now: number,
  notifier: ReviewNotifier,
): Promise<JobOutcome> {
  const payload = ReviewNoticePayload.safeParse(row.payload);
  if (!payload.success) return skipped("stale");
  if (payload.data.stage === "event") return fanOut(db, row, payload.data, now);
  return send(db, row, payload.data, now, notifier);
}

type EventPayload = Extract<ReviewNoticePayload, { stage: "event" }>;
type SendPayload = Extract<ReviewNoticePayload, { stage: "send" }>;

/** The open request at the version the event was about, with its artifact. */
async function openAt(db: RegionalDb, requestId: string, versionId: string) {
  const [found] = await db
    .select({ request: rq, artifact: a })
    .from(rq)
    .innerJoin(a, eq(a.id, rq.artifactId))
    .where(and(eq(rq.id, requestId), isNull(rq.cancelledAt), eq(rq.versionId, versionId)))
    .limit(1);
  return found;
}

/** Accounts holding these addresses verified, by ID. */
async function accountsFor(db: RegionalDb, emails: readonly string[]): Promise<string[]> {
  if (emails.length === 0) return [];
  const u = schema.users;
  const rows = await db.global
    .select({ id: u.id })
    .from(u)
    .where(and(inArray(u.email, [...emails]), eq(u.emailVerified, true)));
  return rows.map((user) => user.id);
}

async function fanOut(
  db: RegionalDb,
  row: OutboxRow,
  event: EventPayload,
  now: number,
): Promise<JobOutcome> {
  const requestId = row.subject ?? "";
  const found = await openAt(db, requestId, event.versionId);
  if (!found) return skipped("stale");
  const { request, artifact } = found;
  const owner = await ownerEntitlements(db.global, artifact.ownerId, now);
  if (!reviewNoticesOn(owner)) return skipped("plan");
  let recipients: string[];
  let status: FinalStatus | null = null;
  if (event.kind === "requested") {
    const asked = await db
      .select({ email: rr.email })
      .from(rr)
      .where(
        and(eq(rr.requestId, request.id), eq(rr.addedAt, event.addedAt), isNull(rr.droppedAt)),
      );
    recipients = await accountsFor(
      db,
      asked.map((reviewer) => reviewer.email),
    );
    if (recipients.length < asked.length) {
      skipped("no_account", asked.length - recipients.length);
    }
  } else {
    // A later change of the status made this one stale; the newer one has its own job.
    if (request.announced !== event.status) return skipped("stale");
    status = event.status;
    recipients = (await ownerSide(db.global, artifact.ownerId)).filter(
      (id) => id !== event.actorId,
    );
  }
  const unique = [...new Set(recipients)];
  // The send jobs exist only if this run still holds the event, which goes in the same batch.
  const mine = sql`exists (select 1 from ${o} where ${o.id} = ${row.id})`;
  const statements: BatchItem<"sqlite">[] = unique.map((userId) =>
    // Columns in schema order: id, topic, payload, available, dispatched, attempts, created,
    // subject, generation.
    db
      .insert(o)
      .select(
        sql`select null, 'review_notice', json_object('stage', 'send', 'kind', ${event.kind}, 'requestId', ${request.id}, 'artifactId', ${artifact.id}, 'versionId', ${event.versionId}, 'status', ${status}), ${now}, null, 0, ${now}, ${userId}, null where ${mine}`,
      ),
  );
  statements.push(db.delete(o).where(eq(o.id, row.id)));
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  return "done";
}

async function send(
  db: RegionalDb,
  row: OutboxRow,
  job: SendPayload,
  now: number,
  notifier: ReviewNotifier,
): Promise<JobOutcome> {
  const claimed = await db.delete(o).where(eq(o.id, row.id)).returning({ id: o.id });
  // Another delivery of the same message claimed it first.
  if (claimed.length === 0) return "done";
  const userId = row.subject ?? "";

  const [user] = await db.global
    .select({ email: schema.users.email, verified: schema.users.emailVerified })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!user) return skipped("no_account");
  const settings = await loadSettings(db.global, userId);
  if (!settings.commentNotices) return skipped("opted_out");

  const found = await openAt(db, job.requestId, job.versionId);
  if (!found || found.artifact.id !== job.artifactId) return skipped("stale");
  const { request, artifact } = found;
  const state = effectiveState(
    {
      state: artifact.state,
      expiresAt: artifact.expiresAt === null ? null : new Date(artifact.expiresAt),
      archivedAt: artifact.archivedAt === null ? null : new Date(artifact.archivedAt),
    },
    new Date(now),
  );
  if (state !== "active" || artifact.currentVersionId !== job.versionId) return skipped("stale");
  const owner = await ownerEntitlements(db.global, artifact.ownerId, now);
  if (!reviewNoticesOn(owner)) return skipped("plan");

  if (job.kind === "requested") {
    // Still listed, still counting, and still able to open the artifact and take part.
    const email = user.verified ? user.email.toLowerCase() : null;
    if (email === null) return skipped("not_reviewer");
    const [reviewer] = await db
      .select({ email: rr.email })
      .from(rr)
      .where(and(eq(rr.requestId, request.id), eq(rr.email, email), isNull(rr.droppedAt)))
      .limit(1);
    if (!reviewer) return skipped("not_reviewer");
    const found = await participation(db, artifact, [email], owner);
    if (!found.get(email)?.takesPart) return skipped("not_reviewer");
  } else {
    if (request.announced !== job.status) return skipped("stale");
    if (!(await ownerSide(db.global, artifact.ownerId)).includes(userId)) {
      return skipped("not_owner_side");
    }
    const m = schema.commentNoticeMutes;
    const [muted] = await db
      .select({ userId: m.userId })
      .from(m)
      .where(and(eq(m.artifactId, artifact.id), eq(m.userId, userId)))
      .limit(1);
    if (muted) return skipped("muted");
  }

  if (await isEmailSuppressed(db, user.email, now)) return skipped("suppressed");
  if (!checkReviewNoticeCapacity(await emailsSentInCycle(db, now)).ok) return skipped("capacity");

  // One email of each kind per person, artifact and version, whatever the jobs say.
  const once = await db
    .insert(sent)
    .values({
      artifactId: artifact.id,
      versionId: job.versionId,
      recipientId: userId,
      kind: job.kind,
      sentAt: now,
    })
    .onConflictDoNothing()
    .returning({ artifactId: sent.artifactId });
  if (once.length === 0) return skipped("duplicate");
  const unclaim = () =>
    db
      .delete(sent)
      .where(
        and(
          eq(sent.artifactId, artifact.id),
          eq(sent.versionId, job.versionId),
          eq(sent.recipientId, userId),
          eq(sent.kind, job.kind),
        ),
      );

  const [version] = await db
    .select({ number: schema.versions.number })
    .from(schema.versions)
    .where(eq(schema.versions.id, job.versionId))
    .limit(1);
  try {
    await notifier.send({
      to: user.email,
      userId,
      issuedAt: now,
      kind: job.kind,
      status: job.status,
      artifactId: artifact.id,
      name: artifact.name,
      version: version?.number ?? null,
      locale: settings.locale,
    });
  } catch (error) {
    if (error instanceof RecipientSuppressedError) {
      await suppressEmail(db, { email: user.email, reason: "provider", now });
      await unclaim();
      return skipped("suppressed");
    }
    // Back in the outbox for the next run, as it was, and the email unclaimed.
    await db.batch([
      unclaim(),
      db.insert(o).values({
        topic: "review_notice",
        payload: job,
        availableAt: now,
        createdAt: row.createdAt,
        subject: userId,
        attempts: row.attempts,
      }),
    ]);
    throw error;
  }
  await recordEmailsSent(db, now);
  return "done";
}
