// Statements of reasons and report outcomes (docs/operations.md, "Reports"). Every operator
// decision about an artifact, an account or a brand writes a `moderation_decisions` row in the
// batch of the change it explains, on that change's own condition, with a `moderation_notice` job
// unless the operator withheld the email where the law requires silence. The job emails the people
// affected (the account of a personal space, or a workspace's admins), records each send in
// `moderation_notice_sends` (the operator's proof), and marks the decision `sent` or
// `no_recipient`. Resolving a report that came with an email writes a `report_outcome` job the same
// way. Both are service notices: no opt-out, refused for suppressed addresses, counted with the
// email budget, and on the sign-in codes' rung (`checkModerationNoticeCapacity`), waiting for the
// next cycle rather than being dropped.
import type {
  AbuseReason,
  DecisionSource,
  StatementText,
  SuspensionStatement,
} from "@portifact/contracts";
import type { LocaleCode } from "@portifact/contracts/locales";
import { type Db, type GlobalDb, type RegionalDb, schema } from "@portifact/db";
import { checkModerationNoticeCapacity, logEvent } from "@portifact/domain";
import { and, desc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
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

/** What the operator says about a decision: the facts, the ground, the source, and silence. */
export interface DecisionStatement extends Partial<StatementText> {
  facts: string;
  source: DecisionSource;
  /** True where the law requires silence: the decision is recorded and nobody is emailed. */
  withhold: boolean;
}

export type DecisionTarget = "artifact" | "account" | "brand";

export interface DecisionRecord {
  targetKind: DecisionTarget;
  targetId: string;
  ownerId: string;
  action: "suspend" | "reinstate";
  reason: AbuseReason | null;
  suspensionId: string | null;
  reportId: string | null;
  now: number;
}

export function newDecisionId(): string {
  return `dec_${crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * The decision row and, unless withheld, its job, both inserted only while `condition` holds:
 * put them in the change's batch before its guarded write, on the old state it read.
 */
export function decisionStatements(
  db: Db,
  id: string,
  record: DecisionRecord,
  statement: DecisionStatement,
  condition: SQL,
): BatchItem<"sqlite">[] {
  const notice = statement.withhold ? "withheld" : "pending";
  // Columns in schema order: id, target kind, target, owner, action, reason, suspension, report,
  // source, facts, ground, notice, recipients, notified, created.
  const decision = db
    .insert(schema.moderationDecisions)
    .select(
      sql`select ${id}, ${record.targetKind}, ${record.targetId}, ${record.ownerId}, ${record.action}, ${record.reason}, ${record.suspensionId}, ${record.reportId}, ${statement.source}, ${statement.facts}, ${statement.ground ?? null}, ${notice}, 0, null, ${record.now} where ${condition}`,
    );
  if (statement.withhold) return [decision];
  const payload = JSON.stringify({ decisionId: id });
  // Columns in schema order: id, topic, payload, available, dispatched, attempts, created,
  // subject, generation.
  const job = db
    .insert(schema.outbox)
    .select(
      sql`select null, 'moderation_notice', ${payload}, ${record.now}, null, 0, ${record.now}, ${id}, null where ${condition}`,
    );
  return [decision, job];
}

/** One email of a statement of reasons; the jobs Worker renders it with packages/emails. */
export interface ModerationNotice {
  to: string;
  locale: LocaleCode | null;
  action: "suspend" | "reinstate";
  target: DecisionTarget;
  artifactId: string | null;
  /** The artifact's name; the notifier drops it outside the default region (decision 0005). */
  artifactName: string | null;
  /** The workspace's slug, for the dashboard link; null for a personal space. */
  workspaceSlug: string | null;
  reason: AbuseReason | null;
  source: DecisionSource;
  facts: string;
  ground: string | null;
  decidedAt: number;
}

export interface ModerationNotifier {
  send(notice: ModerationNotice): Promise<void>;
}

type Skip = "suppressed" | "capacity" | "no_email";

// Only the reason: never the address, the decision's text or the artifact.
function skippedNotice(reason: Skip): void {
  logEvent("log", "moderation_notice_skipped", { reason });
}

function skippedOutcome(reason: Skip): void {
  logEvent("log", "report_outcome_skipped", { reason });
}

/**
 * Runs a `moderation_notice` job: emails every person affected who was not emailed yet and marks
 * the decision. A failed send throws, so the job runs again and skips those already sent; a full
 * cycle leaves it `pending` for later.
 */
export async function sendModerationNotice(
  db: RegionalDb,
  row: typeof schema.outbox.$inferSelect,
  now: number,
  notifier: ModerationNotifier,
): Promise<JobOutcome> {
  const global = db.global;
  const d = schema.moderationDecisions;
  const [decision] = await db
    .select()
    .from(d)
    .where(eq(d.id, row.subject ?? ""))
    .limit(1);
  if (!decision || decision.notice !== "pending") return "stale";
  const s = schema.moderationNoticeSends;
  const already = new Set(
    (await db.select({ userId: s.userId }).from(s).where(eq(s.decisionId, decision.id))).map(
      (sent) => sent.userId,
    ),
  );
  const recipients =
    decision.targetKind === "account"
      ? [decision.ownerId]
      : await ownerRecipients(global, decision.ownerId);
  const artifact =
    decision.targetKind === "artifact"
      ? (
          await db
            .select({ name: schema.artifacts.name })
            .from(schema.artifacts)
            .where(eq(schema.artifacts.id, decision.targetId))
            .limit(1)
        )[0]
      : undefined;
  const slug = await workspaceSlug(global, decision.ownerId);
  for (const userId of recipients) {
    if (already.has(userId)) continue;
    const [user] = await global
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    if (!user) continue;
    if (await isEmailSuppressed(global, user.email, now)) {
      skippedNotice("suppressed");
      continue;
    }
    if (!checkModerationNoticeCapacity(await emailsSentInCycle(global, now)).ok) {
      skippedNotice("capacity");
      return "pending";
    }
    try {
      await notifier.send({
        to: user.email,
        locale: (await loadSettings(global, userId)).locale,
        action: decision.action,
        target: decision.targetKind,
        artifactId: decision.targetKind === "artifact" ? decision.targetId : null,
        artifactName: artifact?.name ?? null,
        workspaceSlug: slug,
        reason: decision.reason,
        source: decision.source,
        facts: decision.facts,
        ground: decision.ground,
        decidedAt: decision.createdAt,
      });
    } catch (error) {
      if (error instanceof RecipientSuppressedError) {
        await suppressEmail(global, { email: user.email, reason: "provider", now });
        skippedNotice("suppressed");
        continue;
      }
      throw error;
    }
    await db
      .insert(s)
      .values({ decisionId: decision.id, userId, sentAt: now })
      .onConflictDoNothing();
    await recordEmailsSent(global, now);
    already.add(userId);
  }
  const [count] = await db
    .select({ count: sql<number>`count(*)` })
    .from(s)
    .where(eq(s.decisionId, decision.id));
  const sent = Number(count?.count ?? 0);
  await db
    .update(d)
    .set({ notice: sent > 0 ? "sent" : "no_recipient", recipients: sent, notifiedAt: now })
    .where(and(eq(d.id, decision.id), eq(d.notice, "pending")));
  return "done";
}

async function workspaceSlug(global: GlobalDb, ownerId: string): Promise<string | null> {
  const [row] = await global
    .select({ slug: schema.workspaces.slug })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, ownerId))
    .limit(1);
  return row?.slug ?? null;
}

/**
 * The statement of reasons the managers of a suspended artifact see next to the category: the
 * latest decision behind its open suspension (or its account's), unless it was withheld.
 */
export async function suspensionStatement(
  db: Db,
  artifactId: string,
): Promise<SuspensionStatement | null> {
  const s = schema.suspensions;
  const [open] = await db
    .select({ id: s.id, parentId: s.parentId })
    .from(s)
    .where(and(eq(s.kind, "artifact"), eq(s.targetId, artifactId), isNull(s.liftedAt)))
    .limit(1);
  if (!open) return null;
  const d = schema.moderationDecisions;
  const ids = open.parentId ? [open.id, open.parentId] : [open.id];
  const [decision] = await db
    .select()
    .from(d)
    .where(and(inArray(d.suspensionId, ids), eq(d.action, "suspend")))
    .orderBy(desc(d.createdAt))
    .limit(1);
  if (!decision || decision.notice === "withheld" || decision.ground === null) return null;
  return {
    facts: decision.facts,
    ground: decision.ground,
    source: decision.source,
    decidedAt: new Date(decision.createdAt).toISOString(),
  };
}

/** The decisions about one target, newest first, for the operator tool. */
export async function listDecisions(db: Db, targetKind: DecisionTarget, targetId: string) {
  const d = schema.moderationDecisions;
  const decisions = await db
    .select()
    .from(d)
    .where(and(eq(d.targetKind, targetKind), eq(d.targetId, targetId)))
    .orderBy(desc(d.createdAt));
  const s = schema.moderationNoticeSends;
  const sends =
    decisions.length === 0
      ? []
      : await db
          .select()
          .from(s)
          .where(
            inArray(
              s.decisionId,
              decisions.map((decision) => decision.id),
            ),
          );
  return decisions.map((decision) => ({
    ...decision,
    sends: sends.filter((send) => send.decisionId === decision.id),
  }));
}

/** One email telling a reporter the outcome. */
export interface ReportOutcomeNotice {
  to: string;
  locale: LocaleCode | null;
  outcome: "actioned" | "dismissed";
  reported: string;
  reportedAt: number;
}

export interface ReportOutcomeNotifier {
  send(notice: ReportOutcomeNotice): Promise<void>;
}

/** The job for a report's outcome, inserted only while `condition` holds (global outbox). */
export function reportOutcomeJob(global: GlobalDb, reportId: string, condition: SQL, now: number) {
  const payload = JSON.stringify({ reportId });
  return global
    .insert(schema.outbox)
    .select(
      sql`select null, 'report_outcome', ${payload}, ${now}, null, 0, ${now}, ${reportId}, null where ${condition}`,
    );
}

/**
 * Runs a `report_outcome` job: emails the reporter the decision once and records it. A report
 * whose email was erased since (its account was deleted) is marked `undeliverable`.
 */
export async function sendReportOutcome(
  db: RegionalDb,
  row: typeof schema.outbox.$inferSelect,
  now: number,
  notifier: ReportOutcomeNotifier,
): Promise<JobOutcome> {
  const global = db.global;
  const r = schema.abuseReports;
  const [report] = await global
    .select()
    .from(r)
    .where(eq(r.id, row.subject ?? ""))
    .limit(1);
  if (!report || report.outcomeNotice !== "pending") return "stale";
  if (report.status === "open") return "stale";
  const undeliverable = async (reason: Skip) => {
    skippedOutcome(reason);
    await global
      .update(r)
      .set({ outcomeNotice: "undeliverable" })
      .where(and(eq(r.id, report.id), eq(r.outcomeNotice, "pending")));
    return "done" as const;
  };
  if (!report.reporterEmail) return undeliverable("no_email");
  if (await isEmailSuppressed(global, report.reporterEmail, now))
    return undeliverable("suppressed");
  if (!checkModerationNoticeCapacity(await emailsSentInCycle(global, now)).ok) {
    skippedOutcome("capacity");
    return "pending";
  }
  try {
    await notifier.send({
      to: report.reporterEmail,
      locale: (report.locale as LocaleCode | null) ?? null,
      outcome: report.status,
      reported: report.address ?? report.artifactId,
      reportedAt: report.createdAt,
    });
  } catch (error) {
    if (error instanceof RecipientSuppressedError) {
      await suppressEmail(global, { email: report.reporterEmail, reason: "provider", now });
      return undeliverable("suppressed");
    }
    throw error;
  }
  await global
    .update(r)
    .set({ outcomeNotice: "sent", outcomeNotifiedAt: now })
    .where(and(eq(r.id, report.id), eq(r.outcomeNotice, "pending")));
  await recordEmailsSent(global, now);
  return "done";
}
