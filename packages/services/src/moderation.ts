// Abuse reports and operator suspensions (plan section 13). Reports come from anyone through the
// public form; suspensions are applied only by the operator tool (apps/jobs/scripts/operator.ts),
// never by a web route. A suspended artifact is not servable, so delivery, read sessions,
// downloads and annotations refuse it through their existing state checks.
import type { AbuseReason, Locale } from "@portifact/contracts";
import { type Db, type GlobalDb, type RegionalDb, schema } from "@portifact/db";
import { fail, ok, purgeDate, type Result, reporterNameKept } from "@portifact/domain";
import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { domainDbsOf, releaseArtifactDomains } from "./custom-domains.ts";
import { isHeld } from "./legal-holds.ts";
import {
  type DecisionStatement,
  decisionStatements,
  newDecisionId,
  reportOutcomeJob,
} from "./moderation-notices.ts";
import { ownerEntitlements } from "./plans.ts";

type Batch = [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];

export interface AbuseReportSubmission {
  artifactId: string | null;
  reason: AbuseReason;
  details: string | undefined;
  email: string | undefined;
  /** The keyed hash of `email` (`keyedHash`), computed where the secret is. */
  emailKey?: string | undefined;
  /** The exact address reported, in full, when the reporter gave one. */
  address?: string | null | undefined;
  name?: string | undefined;
  /** The reporter's statement that the report is accurate, complete and in good faith. */
  confirmed?: boolean | undefined;
  locale?: Locale | undefined;
  now: number;
}

/**
 * Stores a report about an artifact that exists. The caller answers the same either way, so the
 * form cannot tell a private artifact from a missing one; reports about IDs that never existed
 * are dropped instead of stored.
 */
export async function submitAbuseReport(
  db: RegionalDb,
  input: AbuseReportSubmission,
): Promise<{ stored: boolean }> {
  if (!input.artifactId) return { stored: false };
  // The artifact is in its region and reports are global (decision 0005): no statement spans
  // both, so the artifact is checked first. One that goes away in between leaves a report about
  // a gone artifact, which the operator dismisses.
  const a = schema.artifacts;
  const [artifact] = await db
    .select({ id: a.id })
    .from(a)
    .where(and(eq(a.id, input.artifactId), notInArray(a.state, ["draft", "purging", "deleted"])))
    .limit(1);
  if (!artifact) return { stored: false };
  const id = `rep_${crypto.randomUUID().replaceAll("-", "")}`;
  await db.global.insert(schema.abuseReports).values({
    id,
    artifactId: input.artifactId,
    reporterEmail: input.email || null,
    reporterEmailKey: input.email ? (input.emailKey ?? null) : null,
    reporterName: reporterNameKept(input.reason, input.name),
    address: input.address ?? null,
    confirmed: input.confirmed === true,
    locale: input.locale ?? null,
    reason: input.reason,
    details: input.details || null,
    status: "open",
    resolvedAt: null,
    outcomeNotice: null,
    outcomeNotifiedAt: null,
    createdAt: input.now,
  });
  return { stored: true };
}

export type AbuseReportRow = typeof schema.abuseReports.$inferSelect;

export async function listAbuseReports(
  db: GlobalDb,
  input: { status?: AbuseReportRow["status"] | undefined; limit: number },
): Promise<AbuseReportRow[]> {
  return db
    .select()
    .from(schema.abuseReports)
    .where(input.status ? eq(schema.abuseReports.status, input.status) : undefined)
    .orderBy(asc(schema.abuseReports.createdAt), asc(schema.abuseReports.id))
    .limit(input.limit);
}

/**
 * Resolves a report. Resolving an open report that came with an email writes the job that tells
 * the reporter the outcome, in the same batch and on the report still being open, unless the
 * operator withholds it where the law requires silence; changing a resolved report's status
 * tells nobody again. `notice` says what happened to the reporter's email.
 */
export async function resolveAbuseReport(
  db: GlobalDb,
  input: {
    reportId: string;
    status: "actioned" | "dismissed";
    now: number;
    withhold?: boolean | undefined;
  },
): Promise<Result<{ reportId: string; notice: "pending" | "withheld" | "none" | "unchanged" }>> {
  const r = schema.abuseReports;
  const open = sql`exists (select 1 from ${r} where ${r.id} = ${input.reportId} and ${r.status} = 'open')`;
  const withEmail = sql`exists (select 1 from ${r} where ${r.id} = ${input.reportId} and ${r.status} = 'open' and ${r.reporterEmail} is not null)`;
  const [, resolved] = (await db.batch([
    reportOutcomeJob(db, input.reportId, input.withhold ? sql`0` : withEmail, input.now),
    db
      .update(r)
      .set({
        status: input.status,
        resolvedAt: input.now,
        outcomeNotice: sql`case when ${r.reporterEmail} is null then null else ${input.withhold ? "withheld" : "pending"} end`,
      })
      .where(and(eq(r.id, input.reportId), open))
      .returning({ email: r.reporterEmail }),
  ])) as unknown as [unknown, { email: string | null }[]];
  const [first] = resolved;
  if (first) {
    const notice = first.email === null ? "none" : input.withhold ? "withheld" : "pending";
    return ok({ reportId: input.reportId, notice });
  }
  const updated = await db
    .update(r)
    .set({ status: input.status, resolvedAt: input.now })
    .where(eq(r.id, input.reportId))
    .returning({ id: r.id });
  if (updated.length === 0) return fail("not_found", "No report with that ID.");
  return ok({ reportId: input.reportId, notice: "unchanged" });
}

export interface SuspendInput {
  reason: AbuseReason;
  reportId?: string | undefined;
  note?: string | undefined;
  /**
   * The statement of reasons: recorded with the suspension and emailed to the people affected
   * unless withheld. Left out only where nothing is decided anew (a restore suspending again).
   */
  statement?: DecisionStatement | undefined;
  now: number;
}

export interface SuspensionOutcome {
  suspensionId: string;
  /** False when the target was already suspended; nothing changed. */
  changed: boolean;
}

function newSuspensionId(): string {
  return `sus_${crypto.randomUUID().replaceAll("-", "")}`;
}

function uniqueFailed(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (/UNIQUE constraint failed: suspensions/.test(e.message)) return true;
  }
  return false;
}

function checkFailed(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (/CHECK constraint failed: account_usage/.test(e.message)) return true;
  }
  return false;
}

async function openSuspension(db: Db, kind: "artifact" | "account", targetId: string) {
  const [row] = await db
    .select()
    .from(schema.suspensions)
    .where(
      and(
        eq(schema.suspensions.kind, kind),
        eq(schema.suspensions.targetId, targetId),
        isNull(schema.suspensions.liftedAt),
      ),
    )
    .limit(1);
  return row;
}

/** The open suspension of an account, if the operator suspended it. */
export async function accountSuspension(db: Db, userId: string) {
  return openSuspension(db, "account", userId);
}

/**
 * Suspends one artifact at once: it stops being served everywhere and its owner sees the
 * reason. Allowed from `active` and `archived`; the state it had is restored when reinstated.
 * The suspension row is inserted first, under the state the request read, and the unique open
 * suspension per artifact makes it the claim: a concurrent suspension fails instead of applying
 * twice, and the artifact changes only if this row exists.
 */
export async function suspendArtifact(
  db: RegionalDb,
  input: SuspendInput & { artifactId: string; parentId?: string | undefined },
): Promise<Result<SuspensionOutcome>> {
  const [artifact] = await db
    .select()
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, input.artifactId))
    .limit(1);
  if (!artifact) return fail("not_found", "Artifact not found.");
  if (artifact.state === "suspended") return alreadySuspended(db, artifact.id, input.now);
  if (artifact.state !== "active" && artifact.state !== "archived") {
    return fail("invalid_input", `A ${artifact.state} artifact cannot be suspended.`);
  }
  const id = newSuspensionId();
  const a = schema.artifacts;
  const s = schema.suspensions;
  const readState = sql`exists (select 1 from ${a} where ${a.id} = ${artifact.id} and ${a.state} = ${artifact.state} and ${a.lifecycleGeneration} = ${artifact.lifecycleGeneration})`;
  const claimed = sql`exists (select 1 from ${s} where ${s.id} = ${id})`;
  const decision = input.statement
    ? decisionStatements(
        db,
        newDecisionId(),
        {
          targetKind: "artifact",
          targetId: artifact.id,
          ownerId: artifact.ownerId,
          action: "suspend",
          reason: input.reason,
          suspensionId: id,
          reportId: input.reportId ?? null,
          now: input.now,
        },
        input.statement,
        claimed,
      )
    : [];
  try {
    const [inserted] = (await db.batch([
      db
        .insert(s)
        .select(
          sql`select ${id}, 'artifact', ${artifact.id}, ${input.reason}, ${artifact.state}, ${input.reportId ?? null}, ${input.parentId ?? null}, ${input.note ?? null}, ${input.now}, null, null where ${readState}`,
        )
        .returning({ id: s.id }),
      db.insert(schema.lifecycleEvents).select(
        // id, artifact, actor, channel, event, details, at
        sql`select null, ${artifact.id}, null, 'system', 'suspended', ${JSON.stringify({ reason: input.reason, suspensionId: id })}, ${input.now} where ${claimed}`,
      ),
      ...decision,
      db
        .update(a)
        .set({
          state: "suspended",
          suspensionReason: input.reason,
          lifecycleGeneration: artifact.lifecycleGeneration + 1,
          // Its custom domain stops in the same batch; the domain is detached below.
          customHost: null,
          updatedAt: input.now,
        })
        .where(and(eq(a.id, artifact.id), claimed)),
    ])) as unknown as [{ id: string }[]];
    if (inserted.length === 0) return alreadySuspended(db, artifact.id, input.now);
  } catch (error) {
    if (uniqueFailed(error)) return alreadySuspended(db, artifact.id, input.now);
    throw error;
  }
  // The hostname and its certificate are withdrawn from Cloudflare; reinstating does not bring
  // them back.
  await releaseArtifactDomains(domainDbsOf(db), artifact.id, "suspended", input.now);
  return ok({ suspensionId: id, changed: true });
}

/** After a lost claim: fine if another suspension won, a conflict if anything else changed. */
async function alreadySuspended(
  db: RegionalDb,
  artifactId: string,
  now: number,
): Promise<Result<SuspensionOutcome>> {
  const open = await openSuspension(db, "artifact", artifactId);
  if (!open) return fail("version_conflict", "The artifact changed meanwhile. Try again.");
  // A retry finishes what a suspension that stopped after its batch left undone.
  await releaseArtifactDomains(domainDbsOf(db), artifactId, "suspended", now);
  return ok({ suspensionId: open.id, changed: false });
}

/**
 * Lifts an artifact's suspension and puts it back in the state it had. An artifact that was
 * active needs a free active slot again; without one it goes to the archive, where its owner
 * can restore it later. An artifact suspended with its account is reinstated with the account.
 */
export async function reinstateArtifact(
  db: RegionalDb,
  input: {
    artifactId: string;
    now: number;
    viaAccount?: boolean;
    /** What the people affected are told; none when it comes back with its account. */
    statement?: DecisionStatement | undefined;
  },
): Promise<Result<{ state: "active" | "archived"; changed: boolean }>> {
  const [artifact] = await db
    .select()
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, input.artifactId))
    .limit(1);
  if (!artifact) return fail("not_found", "Artifact not found.");
  const open = await openSuspension(db, "artifact", artifact.id);
  if (artifact.state !== "suspended" || !open) {
    if (artifact.state === "active" || artifact.state === "archived") {
      return ok({ state: artifact.state, changed: false });
    }
    return fail("invalid_input", `A ${artifact.state} artifact cannot be reinstated.`);
  }
  // A held artifact stays suspended until its hold is released (docs/operations.md).
  if (await isHeld(db, artifact.id)) {
    return fail("invalid_input", "This artifact has a legal hold; release it first.");
  }
  if (open.parentId && !input.viaAccount) {
    const [parent] = await db
      .select({ liftedAt: schema.suspensions.liftedAt })
      .from(schema.suspensions)
      .where(eq(schema.suspensions.id, open.parentId))
      .limit(1);
    if (parent && parent.liftedAt === null) {
      return fail(
        "invalid_input",
        "This artifact is suspended with its account; reinstate the account.",
      );
    }
  }

  // An artifact that goes back to the archive is kept for its owner's plan's months from now.
  const archiveMonths = (await ownerEntitlements(db.global, artifact.ownerId, input.now)).limits
    .archiveMonths;
  const back = async (state: "active" | "archived") => {
    const a = schema.artifacts;
    const s = schema.suspensions;
    // Every write is conditioned on the state this request read, and the guarded update of the
    // artifact runs last, so of two concurrent reinstatements exactly one applies.
    const readState = sql`exists (select 1 from ${a} where ${a.id} = ${artifact.id} and ${a.state} = 'suspended' and ${a.lifecycleGeneration} = ${artifact.lifecycleGeneration})`;
    const archive =
      state === "archived" && open.previousState === "active"
        ? {
            archivedAt: input.now,
            purgeAt: purgeDate(new Date(input.now), archiveMonths).getTime(),
          }
        : {};
    const decision = input.statement
      ? decisionStatements(
          db,
          newDecisionId(),
          {
            targetKind: "artifact",
            targetId: artifact.id,
            ownerId: artifact.ownerId,
            action: "reinstate",
            reason: null,
            suspensionId: open.id,
            reportId: null,
            now: input.now,
          },
          input.statement,
          readState,
        )
      : [];
    const statements = [
      ...decision,
      db
        .update(s)
        .set({ liftedAt: input.now })
        .where(and(eq(s.id, open.id), isNull(s.liftedAt), readState)),
      db
        .insert(schema.lifecycleEvents)
        .select(
          sql`select null, ${artifact.id}, null, 'system', 'reinstated', ${JSON.stringify({ state, suspensionId: open.id })}, ${input.now} where ${readState}`,
        ),
      db
        .update(a)
        .set({
          state,
          ...archive,
          // Only an active artifact stays pinned; one that goes to the archive loses its pin.
          ...(state === "archived" ? { pinned: false } : {}),
          suspensionReason: null,
          lifecycleGeneration: artifact.lifecycleGeneration + 1,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(a.id, artifact.id),
            eq(a.state, "suspended"),
            eq(a.lifecycleGeneration, artifact.lifecycleGeneration),
          ),
        )
        .returning({ id: a.id }),
    ] as unknown as Batch;
    const results = (await db.batch(statements)) as unknown[];
    return (results.at(-1) as unknown[]).length === 1;
  };

  const target = open.previousState === "archived" ? "archived" : "active";
  try {
    if (!(await back(target)))
      return fail("version_conflict", "The artifact changed meanwhile. Try again.");
    return ok({ state: target, changed: true });
  } catch (error) {
    // The account has no free active slot: the artifact goes to the archive instead.
    if (target === "active" && checkFailed(error)) {
      if (!(await back("archived")))
        return fail("version_conflict", "The artifact changed meanwhile. Try again.");
      return ok({ state: "archived", changed: true });
    }
    throw error;
  }
}

/**
 * Suspends an account: it can no longer publish, and every active or archived artifact it owns
 * is suspended with it in the same transaction. Artifacts suspended on their own keep their own
 * suspension. The account can still sign in, see why, export its data and delete itself.
 */
export async function suspendAccount(
  db: RegionalDb,
  input: SuspendInput & { userId: string },
): Promise<Result<SuspensionOutcome & { artifacts: number }>> {
  const [user] = await db.global
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, input.userId))
    .limit(1);
  if (!user) return fail("not_found", "Account not found.");
  const id = newSuspensionId();
  const a = schema.artifacts;
  const s = schema.suspensions;
  const claimed = sql`exists (select 1 from ${s} where ${s.id} = ${id})`;
  const childOf = sql`exists (select 1 from ${s} where ${s.kind} = 'artifact' and ${s.targetId} = ${a.id} and ${s.parentId} = ${id} and ${s.liftedAt} is null)`;
  const decision = input.statement
    ? decisionStatements(
        db,
        newDecisionId(),
        {
          targetKind: "account",
          targetId: input.userId,
          ownerId: input.userId,
          action: "suspend",
          reason: input.reason,
          suspensionId: id,
          reportId: input.reportId ?? null,
          now: input.now,
        },
        input.statement,
        claimed,
      )
    : [];
  try {
    const results = (await db.batch([
      db.insert(s).values({
        id,
        kind: "account",
        targetId: input.userId,
        reason: input.reason,
        reportId: input.reportId ?? null,
        note: input.note ?? null,
        createdAt: input.now,
      }),
      db
        .insert(s)
        .select(
          sql`select 'sus_' || lower(hex(randomblob(16))), 'artifact', ${a.id}, ${input.reason}, ${a.state}, ${input.reportId ?? null}, ${id}, null, ${input.now}, null, null from ${a} where ${a.ownerId} = ${input.userId} and ${a.state} in ('active', 'archived') and ${claimed}`,
        ),
      db
        .insert(schema.lifecycleEvents)
        .select(
          sql`select null, ${a.id}, null, 'system', 'suspended', ${JSON.stringify({ reason: input.reason, accountSuspensionId: id })}, ${input.now} from ${a} where ${a.ownerId} = ${input.userId} and ${a.state} in ('active', 'archived') and ${childOf}`,
        ),
      db
        .update(a)
        .set({
          state: "suspended",
          suspensionReason: input.reason,
          lifecycleGeneration: sql`${a.lifecycleGeneration} + 1`,
          updatedAt: input.now,
        })
        .where(and(eq(a.ownerId, input.userId), inArray(a.state, ["active", "archived"]), childOf))
        .returning({ id: a.id }),
      ...decision,
    ])) as unknown[];
    return ok({
      suspensionId: id,
      changed: true,
      artifacts: (results[3] as unknown[]).length,
    });
  } catch (error) {
    if (uniqueFailed(error)) {
      const open = await openSuspension(db, "account", input.userId);
      return ok({ suspensionId: open?.id ?? "", changed: false, artifacts: 0 });
    }
    throw error;
  }
}

/**
 * Lifts an account suspension: reinstates the artifacts suspended with it, then lifts the
 * account itself last, so a run that stops halfway can simply be repeated.
 */
export async function reinstateAccount(
  db: RegionalDb,
  input: { userId: string; now: number; statement?: DecisionStatement | undefined },
): Promise<Result<{ artifacts: number; changed: boolean; held: number }>> {
  const open = await openSuspension(db, "account", input.userId);
  if (!open) return ok({ artifacts: 0, changed: false, held: 0 });
  const children = await db
    .select({ artifactId: schema.suspensions.targetId })
    .from(schema.suspensions)
    .where(
      and(
        eq(schema.suspensions.kind, "artifact"),
        eq(schema.suspensions.parentId, open.id),
        isNull(schema.suspensions.liftedAt),
      ),
    );
  let artifacts = 0;
  let held = 0;
  for (const child of children) {
    // A held artifact keeps its own suspension; `reinstate-artifact` lifts it after the release.
    if (await isHeld(db, child.artifactId)) {
      held += 1;
      continue;
    }
    const result = await reinstateArtifact(db, {
      artifactId: child.artifactId,
      now: input.now,
      viaAccount: true,
    });
    if (!result.ok && result.code !== "not_found") return result;
    if (result.ok && result.value.changed) artifacts += 1;
  }
  const s = schema.suspensions;
  const stillOpen = sql`exists (select 1 from ${s} where ${s.id} = ${open.id} and ${s.liftedAt} is null)`;
  const decision = input.statement
    ? decisionStatements(
        db,
        newDecisionId(),
        {
          targetKind: "account",
          targetId: input.userId,
          ownerId: input.userId,
          action: "reinstate",
          reason: null,
          suspensionId: open.id,
          reportId: null,
          now: input.now,
        },
        input.statement,
        stillOpen,
      )
    : [];
  await db.batch([
    ...decision,
    db
      .update(s)
      .set({ liftedAt: input.now })
      .where(and(eq(s.id, open.id), isNull(s.liftedAt))),
  ] as unknown as Batch);
  return ok({ artifacts, changed: true, held });
}
