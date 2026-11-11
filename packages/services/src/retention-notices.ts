// The admins' notice of a workspace's maximum life of artifacts (decision 0023). Saving a new or
// shorter maximum life writes one `retention_notice` job in the save's global batch; the queue
// consumer emails every admin of the workspace once, during the notice period. Like the other
// notices it claims its row by deleting it before sending, so nobody gets it twice, and puts it
// back when the send fails before anyone got it. It is a service email about the workspace's own
// rule, so there is no opt-out; suppressed addresses and the cycle's email capacity are
// respected, and every email sent is counted. It says counts, days and a date, never a name, so
// it is the same in every region (decision 0005).
import { RetentionNoticePayload } from "@portifact/contracts";
import type { LocaleCode } from "@portifact/contracts/locales";
import { type RegionalDb, schema } from "@portifact/db";
import { checkNoticeCapacity, logEvent, policyOf } from "@portifact/domain";
import { eq } from "drizzle-orm";
import { loadSettings } from "./account-settings.ts";
import { ownerRecipients } from "./actors.ts";
import {
  emailsSentInCycle,
  isEmailSuppressed,
  RecipientSuppressedError,
  recordEmailsSent,
  suppressEmail,
} from "./email.ts";
import type { JobOutcome } from "./outbox.ts";

/** Sends the email; renders it with packages/emails in the jobs Worker. */
export interface RetentionNotifier {
  send(notice: {
    to: string;
    workspaceSlug: string;
    days: number;
    from: number;
    atStart: number;
    soon: number;
    locale: LocaleCode | null;
  }): Promise<void>;
}

type Skip = "changed" | "no_admin" | "suppressed" | "capacity";

function skipped(reason: Skip): JobOutcome {
  // Only the reason: never an address or the workspace.
  logEvent("log", "retention_notice_skipped", { reason });
  return "stale";
}

/**
 * Runs a `retention_notice` job: claims it, checks the workspace still has the maximum life the
 * save set (a later change makes this notice moot; a new or shorter one writes its own) and
 * emails each admin.
 */
export async function sendRetentionNotice(
  db: RegionalDb,
  row: typeof schema.outbox.$inferSelect,
  now: number,
  notifier: RetentionNotifier,
): Promise<JobOutcome> {
  const claimed = await db
    .delete(schema.outbox)
    .where(eq(schema.outbox.id, row.id))
    .returning({ id: schema.outbox.id });
  if (claimed.length === 0) return "done";
  const workspaceId = row.subject ?? "";
  const parsed = RetentionNoticePayload.safeParse(
    typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
  );
  if (!parsed.success) return skipped("changed");
  const notice = parsed.data;
  const w = schema.workspaces;
  const [workspace] = await db.global
    .select({ slug: w.slug, policy: w.policy })
    .from(w)
    .where(eq(w.id, workspaceId))
    .limit(1);
  const policy = workspace ? policyOf(workspace.policy) : null;
  if (
    !workspace ||
    policy?.artifactMaxDays !== notice.days ||
    policy.artifactMaxDaysFrom !== notice.from
  ) {
    return skipped("changed");
  }
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
        days: notice.days,
        from: notice.from,
        atStart: notice.atStart,
        soon: notice.soon,
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
        topic: "retention_notice",
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
