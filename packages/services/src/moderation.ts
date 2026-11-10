// Abuse reports and operator suspensions (plan section 13). Reports come from anyone through the
// public form; suspensions are applied only by the operator tool (apps/jobs/scripts/operator.ts),
// never by a web route. A suspended artifact is not servable, so delivery, read sessions,
// downloads and annotations refuse it through their existing state checks.
import type { AbuseReason } from "@portifact/contracts";
import { type Db, schema } from "@portifact/db";
import { fail, ok, purgeDate, type Result } from "@portifact/domain";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { ownerEntitlements } from "./plans.ts";

type Batch = [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];

export interface AbuseReportSubmission {
  artifactId: string | null;
  reason: AbuseReason;
  details: string | undefined;
  email: string | undefined;
  now: number;
}

/**
 * Stores a report about an artifact that exists. The caller answers the same either way, so the
 * form cannot tell a private artifact from a missing one; reports about IDs that never existed
 * are dropped instead of stored.
 */
export async function submitAbuseReport(
  db: Db,
  input: AbuseReportSubmission,
): Promise<{ stored: boolean }> {
  if (!input.artifactId) return { stored: false };
  const id = `rep_${crypto.randomUUID().replaceAll("-", "")}`;
  const a = schema.artifacts;
  const inserted = await db
    .insert(schema.abuseReports)
    .select(
      sql`select ${id}, ${input.artifactId}, ${input.email || null}, ${input.reason}, ${input.details || null}, 'open', null, ${input.now} where exists (select 1 from ${a} where ${a.id} = ${input.artifactId} and ${a.state} not in ('draft', 'purging', 'deleted'))`,
    )
    .returning({ id: schema.abuseReports.id });
  return { stored: inserted.length === 1 };
}

export type AbuseReportRow = typeof schema.abuseReports.$inferSelect;

export async function listAbuseReports(
  db: Db,
  input: { status?: AbuseReportRow["status"] | undefined; limit: number },
): Promise<AbuseReportRow[]> {
  return db
    .select()
    .from(schema.abuseReports)
    .where(input.status ? eq(schema.abuseReports.status, input.status) : undefined)
    .orderBy(asc(schema.abuseReports.createdAt), asc(schema.abuseReports.id))
    .limit(input.limit);
}

export async function resolveAbuseReport(
  db: Db,
  input: { reportId: string; status: "actioned" | "dismissed"; now: number },
): Promise<Result<{ reportId: string }>> {
  const updated = await db
    .update(schema.abuseReports)
    .set({ status: input.status, resolvedAt: input.now })
    .where(eq(schema.abuseReports.id, input.reportId))
    .returning({ id: schema.abuseReports.id });
  if (updated.length === 0) return fail("not_found", "No report with that ID.");
  return ok({ reportId: input.reportId });
}

export interface SuspendInput {
  reason: AbuseReason;
  reportId?: string | undefined;
  note?: string | undefined;
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
  db: Db,
  input: SuspendInput & { artifactId: string; parentId?: string | undefined },
): Promise<Result<SuspensionOutcome>> {
  const [artifact] = await db
    .select()
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, input.artifactId))
    .limit(1);
  if (!artifact) return fail("not_found", "Artifact not found.");
  if (artifact.state === "suspended") return alreadySuspended(db, artifact.id);
  if (artifact.state !== "active" && artifact.state !== "archived") {
    return fail("invalid_input", `A ${artifact.state} artifact cannot be suspended.`);
  }
  const id = newSuspensionId();
  const a = schema.artifacts;
  const s = schema.suspensions;
  const readState = sql`exists (select 1 from ${a} where ${a.id} = ${artifact.id} and ${a.state} = ${artifact.state} and ${a.lifecycleGeneration} = ${artifact.lifecycleGeneration})`;
  const claimed = sql`exists (select 1 from ${s} where ${s.id} = ${id})`;
  try {
    const [inserted] = (await db.batch([
      db
        .insert(s)
        .select(
          sql`select ${id}, 'artifact', ${artifact.id}, ${input.reason}, ${artifact.state}, ${input.reportId ?? null}, ${input.parentId ?? null}, ${input.note ?? null}, ${input.now}, null where ${readState}`,
        )
        .returning({ id: s.id }),
      db.insert(schema.lifecycleEvents).select(
        // id, artifact, actor, channel, event, details, at
        sql`select null, ${artifact.id}, null, 'system', 'suspended', ${JSON.stringify({ reason: input.reason, suspensionId: id })}, ${input.now} where ${claimed}`,
      ),
      db
        .update(a)
        .set({
          state: "suspended",
          suspensionReason: input.reason,
          lifecycleGeneration: artifact.lifecycleGeneration + 1,
          updatedAt: input.now,
        })
        .where(and(eq(a.id, artifact.id), claimed)),
    ])) as unknown as [{ id: string }[]];
    if (inserted.length === 0) return alreadySuspended(db, artifact.id);
  } catch (error) {
    if (uniqueFailed(error)) return alreadySuspended(db, artifact.id);
    throw error;
  }
  return ok({ suspensionId: id, changed: true });
}

/** After a lost claim: fine if another suspension won, a conflict if anything else changed. */
async function alreadySuspended(db: Db, artifactId: string): Promise<Result<SuspensionOutcome>> {
  const open = await openSuspension(db, "artifact", artifactId);
  if (!open) return fail("version_conflict", "The artifact changed meanwhile. Try again.");
  return ok({ suspensionId: open.id, changed: false });
}

/**
 * Lifts an artifact's suspension and puts it back in the state it had. An artifact that was
 * active needs a free active slot again; without one it goes to the archive, where its owner
 * can restore it later. An artifact suspended with its account is reinstated with the account.
 */
export async function reinstateArtifact(
  db: Db,
  input: { artifactId: string; now: number; viaAccount?: boolean },
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
  const archiveMonths = (await ownerEntitlements(db, artifact.ownerId, input.now)).limits
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
    const statements: Batch = [
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
    ];
    const results = (await db.batch(statements)) as unknown[];
    return (results[2] as unknown[]).length === 1;
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
  db: Db,
  input: SuspendInput & { userId: string },
): Promise<Result<SuspensionOutcome & { artifacts: number }>> {
  const [user] = await db
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
          sql`select 'sus_' || lower(hex(randomblob(16))), 'artifact', ${a.id}, ${input.reason}, ${a.state}, ${input.reportId ?? null}, ${id}, null, ${input.now}, null from ${a} where ${a.ownerId} = ${input.userId} and ${a.state} in ('active', 'archived') and ${claimed}`,
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
  db: Db,
  input: { userId: string; now: number },
): Promise<Result<{ artifacts: number; changed: boolean }>> {
  const open = await openSuspension(db, "account", input.userId);
  if (!open) return ok({ artifacts: 0, changed: false });
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
  for (const child of children) {
    const result = await reinstateArtifact(db, {
      artifactId: child.artifactId,
      now: input.now,
      viaAccount: true,
    });
    if (!result.ok && result.code !== "not_found") return result;
    if (result.ok && result.value.changed) artifacts += 1;
  }
  await db
    .update(schema.suspensions)
    .set({ liftedAt: input.now })
    .where(and(eq(schema.suspensions.id, open.id), isNull(schema.suspensions.liftedAt)));
  return ok({ artifacts, changed: true });
}
