// Comment notices (premium plan section 5, P5; rules in packages/domain/src/comment-notices.ts).
// A comment, reply or resolution on an artifact whose owner's plan includes `commentNotices`
// leaves pending rows in `comment_notices`, one per recipient and thread, in its own batch
// (./comment-activity.ts). The scheduled run picks recipients whose oldest pending activity has
// settled and, in one batch per run, writes one `comment_notice` outbox job per recipient
// carrying their rows (IDs and counts only) and deletes those rows, conditioned on that job's
// unique claim, so overlapping runs never schedule the same activity twice. The queue consumer
// sends the digest.
//
// Sending is at most once, like expiry notices: the job claims its outbox row by deleting it
// before sending, so a duplicate delivery finds nothing to do. A send that fails puts the row back
// for the next run. When it sends, the job checks again everything that may have changed: the
// account, its opt-out, its mutes, the owner's plan, the suppression list, the cycle's capacity
// and, through `noticeView`, which threads the recipient may still read, by the same rules as
// every read path. The email holds counts per artifact and the artifact's name, never comment
// text or who wrote it.
import {
  COMMENT_NOTICE_THREADS_MAX,
  type CommentNoticeMute,
  CommentNoticePayload,
  type UnsubscribeResult,
} from "@portifact/contracts";
import type { LocaleCode } from "@portifact/contracts/locales";
import { bothSides, type Db, type GlobalDb, type RegionalDb, schema } from "@portifact/db";
import {
  type ArtifactActivity,
  COMMENT_NOTICE,
  COMMENT_NOTICE_FEATURE,
  checkCommentNoticeCapacity,
  commentNoticeSettledBefore,
  fail,
  groupActivity,
  hasFeature,
  logEvent,
  ok,
  type Result,
  unsubscribeUsable,
} from "@portifact/domain";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { loadSettings, noticeOptOutMarker } from "./account-settings.ts";
import { annotationReader, type NoticeView, noticeView } from "./annotations.ts";
import {
  emailsSentInCycle,
  isEmailSuppressed,
  RecipientSuppressedError,
  recordEmailsSent,
  suppressEmail,
} from "./email.ts";
import type { JobOutcome } from "./outbox.ts";

const cn = schema.commentNotices;
const o = schema.outbox;
/** D1 binds at most 100 parameters per statement. */
const IN_CHUNK = 80;

/** One artifact as the digest shows it. */
export interface NoticeArtifact extends ArtifactActivity {
  name: string;
}

/**
 * Builds and sends the digest (the jobs Worker renders it with packages/emails and signs the
 * unsubscribe link for `userId` at `issuedAt`). It throws `RecipientSuppressedError` when the
 * provider refuses the address, and an error without the address or the message otherwise.
 */
export interface CommentNotifier {
  send(notice: {
    to: string;
    userId: string;
    issuedAt: number;
    /** The most active first, at most `COMMENT_NOTICE.artifactsListed`. */
    artifacts: NoticeArtifact[];
    /** Further artifacts with activity that the email only counts. */
    more: number;
    /** The recipient's language (account settings); null means English. */
    locale: LocaleCode | null;
  }): Promise<void>;
}

/** No `comment_notice` job is waiting for the recipient. */
function noPendingJob(recipient: SQL | string): SQL {
  return sql`not exists (select 1 from ${o} where ${o.topic} = 'comment_notice' and ${o.subject} = ${recipient})`;
}

/** The job this scheduling wrote for the recipient, by its unique claim. */
function scheduled(recipient: string, claim: string): SQL {
  return sql`exists (select 1 from ${o} where ${o.topic} = 'comment_notice' and ${o.subject} = ${recipient} and json_extract(${o.payload}, '$.claim') = ${claim})`;
}

/** The recipient's oldest rows a job takes, the same set in every statement of the batch. */
function picked(recipient: string): SQL {
  return sql`select "thread_id" from "comment_notices" where "recipient_id" = ${recipient} order by "first_at", "thread_id" limit ${COMMENT_NOTICE_THREADS_MAX}`;
}

export interface CommentNoticeScheduleResult {
  recipients: number;
  /** Recipients who turned the notices off: their pending rows were deleted. */
  optedOut: number;
}

/**
 * Schedules this run's comment notices: one job per recipient whose oldest pending activity has
 * settled and who has no job waiting, for up to `recipientsPerRun` recipients. Rows of recipients
 * who turned the notices off are deleted instead.
 */
export async function scheduleCommentNotices(
  db: RegionalDb,
  now: number,
): Promise<CommentNoticeScheduleResult> {
  const settled = commentNoticeSettledBefore(now);
  const due = (
    await db
      .select({ recipientId: cn.recipientId })
      .from(cn)
      .where(noPendingJob(sql`${cn.recipientId}`))
      .groupBy(cn.recipientId)
      .having(sql`min(${cn.firstAt}) <= ${settled}`)
      .limit(COMMENT_NOTICE.recipientsPerRun)
  ).map((row) => row.recipientId);
  if (due.length === 0) return { recipients: 0, optedOut: 0 };

  const s = schema.accountSettings;
  const optedOut = new Set(
    (
      await db.global
        .select({ userId: s.userId })
        .from(s)
        .where(and(inArray(s.userId, due), eq(s.commentNotices, false)))
    ).map((row) => row.userId),
  );

  const statements = due.flatMap((recipient) => {
    if (optedOut.has(recipient)) return [db.delete(cn).where(eq(cn.recipientId, recipient))];
    const claim = crypto.randomUUID();
    const ready = sql`(select min("first_at") from "comment_notices" where "recipient_id" = ${recipient}) <= ${settled} and ${noPendingJob(recipient)}`;
    const mine = scheduled(recipient, claim);
    return [
      // Columns in schema order: id, topic, payload, available, dispatched, attempts, created,
      // subject, generation. Written first; the rows go only if this job exists.
      db
        .insert(o)
        .select(
          sql`select null, 'comment_notice', json_object('claim', ${claim}, 'threads', json("list")), ${now}, null, 0, ${now}, ${recipient}, null from (select json_group_array(json_object('artifactId', "artifact_id", 'threadId', "thread_id", 'created', "created", 'replies', "replies", 'resolved', "resolved")) as "list", count(*) as "n" from (select * from "comment_notices" where "recipient_id" = ${recipient} order by "first_at", "thread_id" limit ${COMMENT_NOTICE_THREADS_MAX})) where "n" > 0 and ${ready}`,
        ),
      db
        .delete(cn)
        .where(
          and(eq(cn.recipientId, recipient), sql`${cn.threadId} in (${picked(recipient)})`, mine),
        ),
      // What is left (past the payload's cap) waits a whole window again, so the recipient never
      // gets two digests closer together than that.
      db
        .update(cn)
        .set({ firstAt: now })
        .where(and(eq(cn.recipientId, recipient), mine)),
    ];
  });
  const [first, ...rest] = statements;
  if (first) await db.batch([first, ...rest]);
  return { recipients: due.length - optedOut.size, optedOut: optedOut.size };
}

type Skip = "no_account" | "opted_out" | "nothing_visible" | "suppressed" | "capacity";

function skipped(reason: Skip, threads: number): JobOutcome {
  // Only the reason and a count: never the address, names or anything about the comments.
  logEvent("log", "comment_notice_skipped", { reason, threads });
  return "stale";
}

/** The artifacts the recipient muted among `artifactIds`. */
async function mutedArtifacts(db: RegionalDb, userId: string, artifactIds: string[]) {
  const m = schema.commentNoticeMutes;
  const muted = new Set<string>();
  for (let i = 0; i < artifactIds.length; i += IN_CHUNK) {
    const rows = await db
      .select({ artifactId: m.artifactId })
      .from(m)
      .where(and(eq(m.userId, userId), inArray(m.artifactId, artifactIds.slice(i, i + IN_CHUNK))));
    for (const row of rows) muted.add(row.artifactId);
  }
  return muted;
}

/**
 * Runs a `comment_notice` job: claims it, checks again what may have changed since it was
 * scheduled, and sends one digest of the activity the recipient may still see.
 */
export async function sendCommentNotice(
  db: RegionalDb,
  row: typeof schema.outbox.$inferSelect,
  now: number,
  notifier: CommentNotifier,
): Promise<JobOutcome> {
  const claimed = await db.delete(o).where(eq(o.id, row.id)).returning({ id: o.id });
  // Another delivery of the same message claimed it first.
  if (claimed.length === 0) return "done";

  const userId = row.subject ?? "";
  const payload = CommentNoticePayload.safeParse(row.payload);
  if (!payload.success) return skipped("nothing_visible", 0);
  const { threads } = payload.data;

  const [user] = await db.global
    .select({ email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!user) return skipped("no_account", threads.length);
  const settings = await loadSettings(db.global, userId);
  if (!settings.commentNotices) return skipped("opted_out", threads.length);

  const artifactIds = [...new Set(threads.map((thread) => thread.artifactId))];
  const muted = await mutedArtifacts(db, userId, artifactIds);
  const views = new Map<string, NoticeView>();
  for (const artifactId of artifactIds) {
    if (muted.has(artifactId)) continue;
    const view = await noticeView(db, {
      userId,
      artifactId,
      now,
      threadIds: threads
        .filter((thread) => thread.artifactId === artifactId)
        .map((thread) => thread.threadId),
    });
    // The owner's plan may have ended since the activity: no notice without the feature.
    if (view && hasFeature(view.entitlements, COMMENT_NOTICE_FEATURE)) views.set(artifactId, view);
  }
  const activity = groupActivity(
    threads,
    (thread) => views.get(thread.artifactId)?.threadIds.has(thread.threadId) ?? false,
  );
  if (activity.length === 0) return skipped("nothing_visible", threads.length);

  if (await isEmailSuppressed(db.global, user.email, now))
    return skipped("suppressed", threads.length);
  if (!checkCommentNoticeCapacity(await emailsSentInCycle(db.global, now)).ok) {
    return skipped("capacity", threads.length);
  }
  const listed = activity.slice(0, COMMENT_NOTICE.artifactsListed);
  try {
    await notifier.send({
      to: user.email,
      userId,
      issuedAt: now,
      artifacts: listed.map((entry) => ({
        ...entry,
        name: (views.get(entry.artifactId) as NoticeView).name,
      })),
      more: activity.length - listed.length,
      locale: settings.locale,
    });
  } catch (error) {
    if (error instanceof RecipientSuppressedError) {
      await suppressEmail(db.global, { email: user.email, reason: "provider", now });
      return skipped("suppressed", threads.length);
    }
    // Back in the outbox for the next run, as it was scheduled.
    await db.insert(o).values({
      topic: "comment_notice",
      payload: payload.data,
      availableAt: now,
      createdAt: row.createdAt,
      subject: userId,
      attempts: row.attempts,
    });
    throw error;
  }
  await recordEmailsSent(db.global, now);
  return "done";
}

// The per-artifact mute

/**
 * The caller's comment notices on one artifact: whether its owner's plan has them and whether the
 * caller muted it. Anyone who may read the artifact's comments may ask; anyone else gets what a
 * missing artifact gives.
 */
export async function getCommentNoticeMute(
  db: RegionalDb,
  input: { userId: string; artifactId: string; now: number },
): Promise<Result<CommentNoticeMute>> {
  const reader = await annotationReader(db, input);
  if (!reader.ok) return reader;
  const m = schema.commentNoticeMutes;
  const [row] = await db
    .select({ userId: m.userId })
    .from(m)
    .where(and(eq(m.artifactId, input.artifactId), eq(m.userId, input.userId)))
    .limit(1);
  return ok({
    available: hasFeature(reader.value.entitlements, COMMENT_NOTICE_FEATURE),
    muted: row !== undefined,
  });
}

/**
 * Mutes or unmutes one artifact's comment notices for the caller. Muting also drops what was
 * pending for them on it. Saving the same choice twice changes nothing.
 */
export async function setCommentNoticeMute(
  db: RegionalDb,
  input: { userId: string; artifactId: string; muted: boolean; now: number },
): Promise<Result<CommentNoticeMute>> {
  const reader = await annotationReader(db, input);
  if (!reader.ok) return reader;
  const m = schema.commentNoticeMutes;
  // The mute's `comment_notice_mute` tombstone (`<artifact>:<user>`) keeps it through a backup
  // restore (docs/operations.md, "Restoring a backup"): written with a mute, deleted with an
  // unmute. With one database in the same batch; with a separate regional database the global
  // write goes first, so a failure in between leaves at worst a marker for a mute the person
  // asked for, or a mute with no marker, never a marker that re-mutes after an unmute.
  const shared = bothSides(db);
  const x: Db = shared ?? db;
  const t = schema.tombstones;
  const markerId = `${input.artifactId}:${input.userId}`;
  const marker = (on: Db) =>
    input.muted
      ? on
          .insert(t)
          .values({ kind: "comment_notice_mute", id: markerId, deletedAt: input.now })
          .onConflictDoNothing()
      : on.delete(t).where(and(eq(t.kind, "comment_notice_mute"), eq(t.id, markerId)));
  const statements: BatchItem<"sqlite">[] = input.muted
    ? [
        x
          .insert(m)
          .values({ artifactId: input.artifactId, userId: input.userId, createdAt: input.now })
          .onConflictDoNothing(),
        x
          .delete(cn)
          .where(and(eq(cn.recipientId, input.userId), eq(cn.artifactId, input.artifactId))),
      ]
    : [x.delete(m).where(and(eq(m.artifactId, input.artifactId), eq(m.userId, input.userId)))];
  if (shared) {
    await shared.batch([marker(shared), ...statements] as [
      BatchItem<"sqlite">,
      ...BatchItem<"sqlite">[],
    ]);
  } else {
    await db.global.batch([marker(db.global)]);
    await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  }
  return ok({
    available: hasFeature(reader.value.entitlements, COMMENT_NOTICE_FEATURE),
    muted: input.muted,
  });
}

/** The artifacts a user muted, for the account export. */
export async function listCommentNoticeMutes(db: RegionalDb, userId: string): Promise<string[]> {
  const m = schema.commentNoticeMutes;
  return (
    await db
      .select({ artifactId: m.artifactId })
      .from(m)
      .where(eq(m.userId, userId))
      .orderBy(m.artifactId)
  ).map((row) => row.artifactId);
}

// The unsubscribe link

const TOKEN_VERSION = "cn1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}

async function tokenKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(`portifact-unsubscribe:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/**
 * The token of a one-click unsubscribe link: the user and when it was issued, signed with the
 * secret the app and jobs Workers share. It can only turn that user's comment notices off.
 */
export async function signUnsubscribeToken(
  secret: string,
  userId: string,
  issuedAt: number,
): Promise<string> {
  const payload = `${TOKEN_VERSION}.${toBase64Url(encoder.encode(userId))}.${issuedAt}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await tokenKey(secret),
    encoder.encode(payload),
  );
  return `${payload}.${toBase64Url(signature)}`;
}

/** The user and issue time of a token signed with this secret, or undefined. */
export async function openUnsubscribeToken(
  secret: string,
  token: string,
): Promise<{ userId: string; issuedAt: number } | undefined> {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) return undefined;
  const [, user, issued, signature] = parts as [string, string, string, string];
  const signatureBytes = fromBase64Url(signature);
  if (!signatureBytes) return undefined;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await tokenKey(secret),
    signatureBytes,
    encoder.encode(`${TOKEN_VERSION}.${user}.${issued}`),
  );
  // Only this secret signed it, so the user and the time are the ones `signUnsubscribeToken` wrote.
  return valid
    ? { userId: decoder.decode(fromBase64Url(user)), issuedAt: Number(issued) }
    : undefined;
}

export const UNSUBSCRIBE_INVALID_MESSAGE =
  "This unsubscribe link does not work any more. Turn comment notices off in your settings instead.";

/**
 * Turns comment notices off for the user a valid unsubscribe token names, and nothing else. A
 * tampered or expired link, or one issued before the preference last changed, is refused; an
 * account that no longer exists answers like a success, so a link tells nothing about it.
 */
export async function unsubscribeCommentNotices(
  db: GlobalDb,
  input: { token: string; secret: string; now: number },
): Promise<Result<UnsubscribeResult>> {
  const opened = await openUnsubscribeToken(input.secret, input.token);
  if (!opened) return fail("invalid_input", UNSUBSCRIBE_INVALID_MESSAGE);
  const s = schema.accountSettings;
  const [current] = await db
    .select({ on: s.commentNotices, changedAt: s.commentNoticesChangedAt })
    .from(s)
    .where(eq(s.userId, opened.userId))
    .limit(1);
  // While the notices are off a link changes nothing, so a second click still answers like the
  // first; once they are back on, only a link issued after that may turn them off again.
  const changedAt = current?.on === false ? null : (current?.changedAt ?? null);
  if (!unsubscribeUsable(opened.issuedAt, changedAt, input.now)) {
    return fail("invalid_input", UNSUBSCRIBE_INVALID_MESSAGE);
  }
  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, opened.userId))
    .limit(1);
  if (!user) return ok({ unsubscribed: true });
  // A deletion landing between the two statements makes the foreign key refuse the insert; the
  // request then fails, and the next click answers like any account that no longer exists.
  await db.batch([
    db
      .insert(s)
      .values({
        userId: opened.userId,
        commentNotices: false,
        commentNoticesChangedAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: s.userId,
        set: {
          commentNotices: false,
          // Already off: keep the time, so other links issued since keep working.
          commentNoticesChangedAt: sql`case when ${s.commentNotices} = 0 then ${s.commentNoticesChangedAt} else ${input.now} end`,
          updatedAt: input.now,
        },
      }),
    // A restore must not turn them back on (docs/operations.md, "Restoring a backup").
    noticeOptOutMarker(db, opened.userId, "comment_notices", false, input.now),
  ]);
  return ok({ unsubscribed: true });
}
