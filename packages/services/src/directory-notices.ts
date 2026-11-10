// The notice a person gets when a workspace's directory adds their existing account as a member
// (decision 0017): they joined without an accept step, so they are told who added them, where
// the workspace is and how to leave. One `directory_notice` outbox job is written in the
// provisioning's own batch, on its own condition; the jobs Worker sends it.
//
// Like expiry notices, the job claims its row by deleting it before sending and puts it back on a
// failed send. It respects suppressions and the notice capacity (which stops notices well before
// sign-in codes), counts every email sent, and reaches one person at most once per workspace a
// day (`rate_limits`, counted at send time, given back on a failed send). Never for a pending
// membership: a person without an account gets nothing unless the workspace turned invitation
// emails on.
import type { LocaleCode } from "@portifact/contracts/locales";
import {
  type GlobalDb,
  hitRateLimit,
  type RegionalDb,
  releaseRateLimit,
  schema,
} from "@portifact/db";
import { checkNoticeCapacity } from "@portifact/domain";
import { and, eq, type SQL, sql } from "drizzle-orm";
import { loadSettings } from "./account-settings.ts";
import {
  emailsSentInCycle,
  isEmailSuppressed,
  RecipientSuppressedError,
  recordEmailsSent,
  suppressEmail,
} from "./email.ts";
import type { JobOutcome } from "./outbox.ts";

/** At most one notice per person and workspace in this window. */
export const DIRECTORY_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Sends the email; renders it with packages/emails in the jobs Worker. */
export interface DirectoryNotifier {
  send(notice: {
    to: string;
    workspaceName: string;
    workspaceSlug: string;
    locale: LocaleCode | null;
  }): Promise<void>;
}

/**
 * The job for `account`'s notice, inserted only when `condition` holds (the condition the
 * membership insert of the same batch uses).
 */
export function directoryNoticeJob(
  global: GlobalDb,
  workspaceId: string,
  account: string,
  condition: SQL,
  now: number,
) {
  const payload = JSON.stringify({ workspaceId });
  // Columns in schema order: id, topic, payload, available, dispatched, attempts, created,
  // subject, generation.
  return global
    .insert(schema.outbox)
    .select(
      sql`select null, 'directory_notice', ${payload}, ${now}, null, 0, ${now}, ${account}, null where ${condition}`,
    );
}

type Skip = "not_member" | "suppressed" | "capacity" | "recent";

function skipped(reason: Skip): JobOutcome {
  // Only the reason: never the address or the workspace.
  console.log(JSON.stringify({ event: "directory_notice_skipped", reason }));
  return "stale";
}

function workspaceOf(payload: unknown): string | null {
  const value = typeof payload === "string" ? JSON.parse(payload) : payload;
  const id = (value as { workspaceId?: unknown } | null)?.workspaceId;
  return typeof id === "string" ? id : null;
}

/**
 * Runs a `directory_notice` job: claims it, checks the person is still a member (a removal since
 * makes it moot), then sends one email in their language.
 */
export async function sendDirectoryNotice(
  db: RegionalDb,
  row: typeof schema.outbox.$inferSelect,
  now: number,
  notifier: DirectoryNotifier,
): Promise<JobOutcome> {
  const global = db.global;
  const claimed = await global
    .delete(schema.outbox)
    .where(eq(schema.outbox.id, row.id))
    .returning({ id: schema.outbox.id });
  if (claimed.length === 0) return "done";
  const userId = row.subject ?? "";
  const workspaceId = workspaceOf(row.payload);
  if (workspaceId === null) return skipped("not_member");
  const [found] = await global
    .select({
      email: schema.users.email,
      name: schema.workspaces.name,
      slug: schema.workspaces.slug,
    })
    .from(schema.workspaceMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceMembers.workspaceId))
    .where(
      and(
        eq(schema.workspaceMembers.workspaceId, workspaceId),
        eq(schema.workspaceMembers.userId, userId),
      ),
    )
    .limit(1);
  if (!found) return skipped("not_member");
  if (await isEmailSuppressed(global, found.email, now)) return skipped("suppressed");
  if (!checkNoticeCapacity(await emailsSentInCycle(global, now)).ok) return skipped("capacity");
  const key = `directory-notice:${workspaceId}:${userId}`;
  const hit = await hitRateLimit(global.$client, key, DIRECTORY_NOTICE_WINDOW_MS, now);
  if (hit.count > 1) return skipped("recent");
  try {
    await notifier.send({
      to: found.email,
      workspaceName: found.name,
      workspaceSlug: found.slug,
      locale: (await loadSettings(global, userId)).locale,
    });
  } catch (error) {
    await releaseRateLimit(global.$client, key, DIRECTORY_NOTICE_WINDOW_MS, hit.resetAt);
    if (error instanceof RecipientSuppressedError) {
      await suppressEmail(global, { email: found.email, reason: "provider", now });
      return skipped("suppressed");
    }
    await global.insert(schema.outbox).values({
      topic: "directory_notice",
      payload: { workspaceId },
      availableAt: now,
      createdAt: row.createdAt,
      subject: userId,
      attempts: row.attempts,
    });
    throw error;
  }
  await recordEmailsSent(global, now);
  return "done";
}
