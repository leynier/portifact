// The admins' notices of a workspace's comment retention (decision 0023, "Comment retention"):
// `set` when an admin sets or shortens it, written in the save's global batch, and `soon`
// shortly before its first deletion when that comes long after the save, written by the scan.
// Like the other notices each claims its row by deleting it before sending, puts it back when the
// send fails before anyone got it, skips suppressed addresses, stops at the notice capacity and
// counts every email. Counts, days and dates only, never a name or a word of a comment, so it is
// the same in every region (decision 0005).
import { CommentRetentionNoticePayload } from "@portifact/contracts";
import type { LocaleCode } from "@portifact/contracts/locales";
import { type RegionalDb, schema } from "@portifact/db";
import { checkNoticeCapacity, commentRetentionOf, logEvent, policyOf } from "@portifact/domain";
import { eq } from "drizzle-orm";
import { loadSettings } from "./account-settings.ts";
import { ownerRecipients } from "./actors.ts";
import { commentRetentionDueAt, commentRetentionImpact } from "./comment-retention.ts";
import {
  emailsSentInCycle,
  isEmailSuppressed,
  RecipientSuppressedError,
  recordEmailsSent,
  suppressEmail,
} from "./email.ts";
import type { JobOutcome } from "./outbox.ts";

/** Sends the email; renders it with packages/emails in the jobs Worker. */
export interface CommentRetentionNotifier {
  send(notice: {
    to: string;
    workspaceSlug: string;
    kind: "set" | "soon";
    days: number;
    from: number;
    at: number;
    threads: number;
    messages: number;
    locale: LocaleCode | null;
  }): Promise<void>;
}

type Skip = "changed" | "no_admin" | "suppressed" | "capacity";

function skipped(reason: Skip): JobOutcome {
  // Only the reason: never an address or the workspace.
  logEvent("log", "comment_retention_notice_skipped", { reason });
  return "stale";
}

/**
 * Runs a `comment_retention_notice` job: checks the workspace still has comment retention taking
 * effect on the date the notice announces (removed, or replaced by one with another date and its
 * own notice, makes it moot), claims it, and emails each admin. Everything that can fail is read
 * before the claim, so an error leaves the job for the outbox to run again instead of losing it.
 * A retention lengthened before the relay keeps the date and writes no notice of its own, so a
 * `set` notice goes out with the days in force and the counts they give; a `soon` notice always
 * recounts what is due on the date it announces, with the same definition the scan deletes with,
 * and is dropped when nothing is.
 */
export async function sendCommentRetentionNotice(
  db: RegionalDb,
  row: typeof schema.outbox.$inferSelect,
  now: number,
  notifier: CommentRetentionNotifier,
  regionDb?: (workspaceId: string) => Promise<RegionalDb | null>,
): Promise<JobOutcome> {
  const workspaceId = row.subject ?? "";
  let payload: unknown = row.payload;
  try {
    if (typeof payload === "string") payload = JSON.parse(payload);
  } catch {
    payload = null;
  }
  const parsed = CommentRetentionNoticePayload.safeParse(payload);
  const notice = parsed.success ? parsed.data : null;
  const w = schema.workspaces;
  const [workspace] = notice
    ? await db.global
        .select({ slug: w.slug, policy: w.policy })
        .from(w)
        .where(eq(w.id, workspaceId))
        .limit(1)
    : [];
  // Thrown before the claim when the policy is unreadable: the job is run again.
  const rule = workspace ? commentRetentionOf(policyOf(workspace.policy)) : null;
  let counts = notice ? { threads: notice.threads, messages: notice.messages } : null;
  if (notice && rule && rule.from === notice.from) {
    if (notice.kind === "soon") {
      counts = await commentRetentionDueAt(
        (await regionDb?.(workspaceId)) ?? db,
        workspaceId,
        rule,
        notice.at,
      );
    } else if (rule.days !== notice.days) {
      const impact = await commentRetentionImpact(
        (await regionDb?.(workspaceId)) ?? db,
        workspaceId,
        rule,
      );
      counts = { threads: impact.threadsAtStart, messages: impact.messagesAtStart };
    }
  }
  const claimed = await db
    .delete(schema.outbox)
    .where(eq(schema.outbox.id, row.id))
    .returning({ id: schema.outbox.id });
  if (claimed.length === 0) return "done";
  if (!notice || !workspace || !rule || !counts || rule.from !== notice.from) {
    return skipped("changed");
  }
  if (notice.kind === "soon" && counts.threads === 0) return skipped("changed");
  const recipients: { email: string; locale: LocaleCode | null }[] = [];
  for (const userId of await ownerRecipients(db.global, workspaceId)) {
    const [user] = await db.global
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    if (user) {
      recipients.push({
        email: user.email,
        locale: (await loadSettings(db.global, userId)).locale,
      });
    }
  }
  if (recipients.length === 0) return skipped("no_admin");
  let sent = 0;
  let skip: Skip = "suppressed";
  for (const recipient of recipients) {
    if (await isEmailSuppressed(db.global, recipient.email, now)) continue;
    if (!checkNoticeCapacity(await emailsSentInCycle(db.global, now)).ok) {
      skip = "capacity";
      break;
    }
    try {
      await notifier.send({
        to: recipient.email,
        workspaceSlug: workspace.slug,
        kind: notice.kind,
        days: rule.days,
        from: notice.from,
        at: notice.at,
        threads: counts.threads,
        messages: counts.messages,
        locale: recipient.locale,
      });
    } catch (error) {
      if (error instanceof RecipientSuppressedError) {
        await suppressEmail(db.global, { email: recipient.email, reason: "provider", now });
        continue;
      }
      // Someone got it: the rest is dropped, never sent twice to the ones who did.
      if (sent > 0) continue;
      await db.insert(schema.outbox).values({
        topic: "comment_retention_notice",
        payload: notice,
        availableAt: now,
        createdAt: row.createdAt,
        subject: workspaceId,
        attempts: row.attempts,
      });
      throw error;
    }
    await recordEmailsSent(db.global, now);
    sent += 1;
  }
  return sent > 0 ? "done" : skipped(skip);
}
