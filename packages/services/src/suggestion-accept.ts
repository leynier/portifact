// Accepting a suggestion and publishing a draft (decision 0027, "Producing the new version", "The
// acceptance claim"). Two steps:
//
// 1. The person confirms a plan by its digest (`acceptSuggestion`, `publishDraft`, session-only
//    routes in the adapters). After authorization the request is counted (the person's and the
//    artifact's planning windows, shared with dry runs, and the owner's acceptance window) before
//    any file is read, so a refused or wrong confirmation costs the same budget as a plan. Then the
//    server rebuilds the plan from the stored files, compares the digest, applies budget
//    protection (a version-producing acceptance as a publish, `checkPublishCapacity`; one that
//    only lists items as annotation work, `checkAnnotationCapacity`) and the change list's room,
//    and in one batch starts an acceptance attempt, marks the suggestion `applying` (or the draft
//    as publishing) and writes the `suggestion_accept` or `draft_publish` job, all on the attempt
//    row the batch inserted first under the state the person saw, their role included.
// 2. The job (`runAcceptance`) authorizes the person again as an annotation write on the owner
//    side at the job's own time (effective state and expiry, annotation mode, hold), rebuilds and
//    confirms the plan, and completes the attempt with one claim (`acceptance_claims`): the claim
//    is the first statement of the completing batch, inserted only when the change list has room
//    for every listed item, the artifact is as authorized (owner, active, unexpired, mode, base
//    version), the person still acts for the owner and the suggestion or draft is as confirmed;
//    every later statement is conditioned on the claim with this run's token. When something
//    applies, the batch is the publish's own commit (`publishFromPlan` through `preparePublish`
//    and `commitPublish`, never a second path), after checking that the bytes and renderings it
//    stores are exactly the plan's output; when nothing does, it lists the items and completes
//    the suggestion or draft without a version.
//
// The person's role is a global row and the attempt regional (decision 0005). With one database
// both batches name the membership through `bothSides`, as `stillAdmin` does; with a separate
// regional database the role is read again right before each batch and the batch fails closed
// on a refusal, so a removal landing between that read and the batch is the one window.
//
// Every failure point ends in a state the job or the scan (`expireAcceptAttempts`) recovers: see
// the recovery table in the record and in docs/operations.md, "Edit suggestions".
import {
  AcceptancePayload,
  type AcceptanceStarted,
  CHANGE_LIST_LIMITS,
  type Envelope,
  isWorkspaceId,
  type Proof,
  SUGGESTION_LIMITS,
  utf8Length,
} from "@portifact/contracts";
import {
  bothSides,
  type Db,
  hitRateLimits,
  type RateLimitHit,
  type RegionalDb,
  schema,
} from "@portifact/db";
import {
  actsForOwner,
  checkAnnotationCapacity,
  checkPublishCapacity,
  fail,
  ok,
  type Result,
} from "@portifact/domain";
import {
  admitItems,
  attemptOverdue,
  checkDecide,
  confirmPlan,
} from "@portifact/domain/suggestions";
import { DOCUMENT_RENDERER } from "@portifact/render";
import { and, eq, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { actorOn } from "./actors.ts";
import {
  type AnnotationActor,
  type AuthorizedAnnotations,
  annotationParts,
} from "./annotations.ts";
import { auditEvent } from "./audit.ts";
import { platformProtection } from "./budget.ts";
import type { JobOutcome } from "./outbox.ts";
import {
  closeUploadSession,
  commitPublish,
  type ManifestEntry,
  preparePublish,
} from "./publish.ts";
import {
  admitPlanning,
  draftPlanOf,
  newFileBytes,
  ownDraft,
  type SubjectPlan,
  suggestionPlanOf,
} from "./suggestion-plans.ts";
import { CHANGE_LIST_CAP, openItemsSql } from "./suggestion-versions.ts";

const th = schema.annotationThreads;
const at = schema.acceptanceAttempts;
const cl = schema.acceptanceClaims;
const dr = schema.editDrafts;
const ci = schema.changeItems;
const t = schema.artifacts;

type AttemptRow = typeof at.$inferSelect;
type ArtifactRow = typeof t.$inferSelect;
type OutboxRow = typeof schema.outbox.$inferSelect;
export type AttemptEndReason = NonNullable<AttemptRow["reason"]>;

const planChanged = () => ({
  ...fail<never>("version_conflict", "The plan changed since you reviewed it. Review it again."),
  detail: "plan_changed" as const,
});

/** A new attempt ID; its hex part also keys the version and upload the job prepares. */
const newAttemptId = () => `att_${crypto.randomUUID().replaceAll("-", "")}`;
const serverIdsOf = (attemptId: string) => {
  const key = attemptId.slice("att_".length);
  return { versionId: `ver_${key}`, sessionId: `upl_${key}` };
};

// The accepting person's role, inside the batches

/**
 * The handle a batch runs on and the condition that the person still acts for the owner: in a
 * personal space only its own account does (the artifact's owner predicate already says so); in
 * a workspace an admin or editor, named inside the batch when the region's database is the global
 * one. With a separate regional database the condition is empty and `stillActs` is read right
 * before the batch instead.
 */
function acceptorScope(db: RegionalDb, ownerId: string, userId: string): { w: Db; holds: SQL } {
  const both = bothSides(db);
  if (!isWorkspaceId(ownerId)) return { w: both ?? db, holds: sql`${ownerId} = ${userId}` };
  if (!both) return { w: db, holds: sql`1` };
  const m = schema.workspaceMembers;
  return {
    w: both,
    holds: sql`exists (select 1 from ${m} as "acceptor" where "acceptor"."workspace_id" = ${ownerId} and "acceptor"."user_id" = ${userId} and "acceptor"."role" in ('admin', 'editor'))`,
  };
}

/** Whether the person acts for the owner now, read from the global database. */
async function stillActs(db: RegionalDb, ownerId: string, userId: string): Promise<boolean> {
  const actor = await actorOn(db.global, userId, ownerId);
  return actor.ok && actsForOwner(actor.value, ownerId);
}

/** The artifact as the person was authorized on it, at the base version, inside a batch. */
function artifactAt(loaded: AuthorizedAnnotations, baseVersionId: string, now: number): SQL {
  return sql`${annotationParts.artifactGuard(loaded, "moderate", now)} and exists (select 1 from ${t} where ${t.id} = ${loaded.artifact.id} and ${t.currentVersionId} = ${baseVersionId})`;
}

// Admission at the route

/**
 * Counts one acceptance for the person, the artifact and the owner, after authorization and
 * before any file is read: in the planning windows dry runs use, and in the owner's acceptance
 * window. A wrong digest, an exhausted budget and a retry all count.
 */
async function countAcceptance(
  db: RegionalDb,
  input: { userId: string; artifactId: string; ownerId: string; now: number },
): Promise<Result<true>> {
  const planning = await admitPlanning(db, input.userId, input.artifactId, input.now);
  if (!planning.ok) return planning;
  const [hit] = (await hitRateLimits(
    db.global.$client,
    [`suggestion_accept:owner:${input.ownerId}`],
    SUGGESTION_LIMITS.acceptsOwnerWindowMs,
    input.now,
  )) as [RateLimitHit];
  if (hit.count > SUGGESTION_LIMITS.acceptsPerOwner) {
    return fail("rate_limited", "Too many acceptances today. Try again tomorrow.");
  }
  return ok(true);
}

/** Budget protection for an acceptance: a publish when it makes a version, annotation work else. */
async function capacityFor(db: RegionalDb, built: SubjectPlan, now: number): Promise<Result<true>> {
  const actions = (await platformProtection(db.global, now)).actions;
  return built.plan.output === null
    ? checkAnnotationCapacity(actions)
    : checkPublishCapacity(actions, false);
}

/** The confirmed digest is this plan's, its bytes included (a stored byte order mark too). */
async function confirmed(built: SubjectPlan, digest: string): Promise<boolean> {
  const { plan, page } = built;
  return (
    (await confirmPlan({
      plan,
      confirmedDigest: digest,
      current: plan.binding,
      newSource: plan.newSource,
      renderer: DOCUMENT_RENDERER,
      bom: page.bom,
    })) === "confirmed"
  );
}

/**
 * What both routes check once the request is counted and the plan rebuilt: the digest, budget
 * protection and the change list's room.
 */
async function admitPlan(
  db: RegionalDb,
  built: SubjectPlan,
  input: { digest: string; artifactId: string; now: number },
): Promise<Result<true>> {
  if (!(await confirmed(built, input.digest))) return planChanged();
  const capacity = await capacityFor(db, built, input.now);
  if (!capacity.ok) return capacity;
  if (
    !admitItems(await openItems(db, input.artifactId), built.plan.listed.length, CHANGE_LIST_CAP)
  ) {
    return fail("quota_exceeded", "The change list is full. Close some of its items first.");
  }
  return ok(true);
}

/** The attempt row's insert, under `guard`. Columns in schema order. */
function attemptInsert(
  w: Db,
  attempt: {
    id: string;
    artifactId: string;
    ownerId: string;
    origin: "suggestion" | "draft";
    threadId: string | null;
    userId: string;
    digest: string;
    baseVersionId: string;
    now: number;
  },
  guard: SQL,
) {
  // id, artifact, owner, origin, thread, user, digest, base version, version, state, reason,
  // deliveries, created, updated.
  return w
    .insert(at)
    .select(
      sql`select ${attempt.id}, ${attempt.artifactId}, ${attempt.ownerId}, ${attempt.origin}, ${attempt.threadId}, ${attempt.userId}, ${attempt.digest}, ${attempt.baseVersionId}, null, 'running', null, 0, ${attempt.now}, ${attempt.now} where ${guard}`,
    )
    .returning({ id: at.id });
}

const attemptExists = (attemptId: string) =>
  sql`exists (select 1 from ${at} where ${at.id} = ${attemptId})`;

/** The attempt's job, written on the attempt row. Columns in schema order. */
function acceptanceJob(
  w: Db,
  topic: "suggestion_accept" | "draft_publish",
  input: { attemptId: string; artifactId: string; contentDomain: string; now: number },
) {
  const payload = JSON.stringify({
    attemptId: input.attemptId,
    contentDomain: input.contentDomain,
  });
  return w
    .insert(schema.outbox)
    .select(
      sql`select null, ${topic}, ${payload}, ${input.now}, null, 0, ${input.now}, ${input.artifactId}, null where ${attemptExists(input.attemptId)}`,
    );
}

/**
 * Starts accepting a pending suggestion whose plan the person confirmed by `digest`: the owner
 * side only, as a person (session-only routes). Answers with the attempt the job runs.
 */
export async function acceptSuggestion(
  db: RegionalDb,
  bucket: R2Bucket,
  input: AnnotationActor & { threadId: string; digest: string; contentDomain: string },
): Promise<Result<AcceptanceStarted>> {
  const loaded = await annotationParts.authorize(db, input, "moderate");
  if (!loaded.ok) return loaded;
  const { artifact } = loaded.value;
  const thread = await annotationParts.findThread(db, loaded.value, input.threadId);
  if (!thread || thread.kind !== "suggestion") return fail("not_found", "Suggestion not found.");
  const decision = checkDecide(loaded.value.role, thread.suggestionState);
  if (!decision.ok) return decision;
  if (thread.versionId !== artifact.currentVersionId) {
    return fail("version_conflict", "This suggestion was made on an earlier version.");
  }
  const counted = await countAcceptance(db, { ...input, ownerId: artifact.ownerId });
  if (!counted.ok) return counted;
  const built = await suggestionPlanOf(db, bucket, {
    artifact,
    thread,
    acceptor: true,
    contentDomain: input.contentDomain,
  });
  if (!built.ok) return built;
  const admitted = await admitPlan(db, built.value, { ...input, artifactId: artifact.id });
  if (!admitted.ok) return admitted;
  const { w, holds } = acceptorScope(db, artifact.ownerId, input.userId);
  if (!bothSides(db) && !(await stillActs(db, artifact.ownerId, input.userId))) {
    return fail("not_found", "Artifact not found.");
  }
  const attemptId = newAttemptId();
  const guard = sql`${artifactAt(loaded.value, thread.versionId, input.now)} and ${holds} and exists (select 1 from ${th} where ${th.id} = ${thread.id} and ${th.suggestionState} = 'pending' and ${th.suggestionRevision} = ${thread.suggestionRevision})`;
  const [inserted] = await w.batch([
    attemptInsert(
      w,
      {
        id: attemptId,
        artifactId: artifact.id,
        ownerId: artifact.ownerId,
        origin: "suggestion",
        threadId: thread.id,
        userId: input.userId,
        digest: input.digest,
        baseVersionId: thread.versionId,
        now: input.now,
      },
      guard,
    ),
    w
      .update(th)
      .set({ suggestionState: "applying", attemptId, attemptReason: null, updatedAt: input.now })
      .where(
        and(eq(th.id, thread.id), eq(th.suggestionState, "pending"), attemptExists(attemptId)),
      ),
    acceptanceJob(w, "suggestion_accept", {
      attemptId,
      artifactId: artifact.id,
      contentDomain: input.contentDomain,
      now: input.now,
    }),
  ]);
  if (inserted.length === 0) {
    return fail("version_conflict", "The suggestion changed meanwhile. Reload and try again.");
  }
  return ok({ attemptId, state: "applying" });
}

/**
 * Starts publishing one's own draft whose plan the person confirmed by `digest`: one version for
 * what applies, change-list items for the rest, the draft deleted on the switch.
 */
export async function publishDraft(
  db: RegionalDb,
  bucket: R2Bucket,
  input: AnnotationActor & { digest: string; contentDomain: string },
): Promise<Result<AcceptanceStarted>> {
  const found = await ownDraft(db, input, "moderate");
  if (!found.ok) return found;
  const { loaded, draft } = found.value;
  const { artifact } = loaded;
  if (draft.attemptId !== null) {
    return fail("version_conflict", "This draft is being published. Try again in a moment.");
  }
  if (draft.baseVersionId !== artifact.currentVersionId) {
    return fail("version_conflict", "A newer version was published since this draft began.");
  }
  const counted = await countAcceptance(db, {
    ...input,
    artifactId: artifact.id,
    ownerId: artifact.ownerId,
  });
  if (!counted.ok) return counted;
  const built = await draftPlanOf(db, bucket, {
    artifact,
    draft,
    contentDomain: input.contentDomain,
  });
  if (!built.ok) return built;
  const admitted = await admitPlan(db, built.value, { ...input, artifactId: artifact.id });
  if (!admitted.ok) return admitted;
  const { w, holds } = acceptorScope(db, artifact.ownerId, input.userId);
  if (!bothSides(db) && !(await stillActs(db, artifact.ownerId, input.userId))) {
    return fail("not_found", "Draft not found.");
  }
  const attemptId = newAttemptId();
  const ownDraftAt = and(
    eq(dr.artifactId, artifact.id),
    eq(dr.userId, input.userId),
    eq(dr.revision, draft.revision),
    sql`${dr.attemptId} is null`,
  );
  const guard = sql`${artifactAt(loaded, draft.baseVersionId, input.now)} and ${holds} and exists (select 1 from ${dr} where ${ownDraftAt})`;
  const [inserted] = await w.batch([
    attemptInsert(
      w,
      {
        id: attemptId,
        artifactId: artifact.id,
        ownerId: artifact.ownerId,
        origin: "draft",
        threadId: null,
        userId: input.userId,
        digest: input.digest,
        baseVersionId: draft.baseVersionId,
        now: input.now,
      },
      guard,
    ),
    w
      .update(dr)
      .set({ attemptId, attemptReason: null })
      .where(and(ownDraftAt, attemptExists(attemptId))),
    acceptanceJob(w, "draft_publish", {
      attemptId,
      artifactId: artifact.id,
      contentDomain: input.contentDomain,
      now: input.now,
    }),
  ]);
  if (inserted.length === 0) {
    return fail("version_conflict", "The draft changed meanwhile. Reload and try again.");
  }
  return ok({ attemptId, state: "applying" });
}

// Ending an attempt

/**
 * Ends a running attempt that did not complete: the suggestion goes back to `pending` (or the
 * draft is free again) with the reason, its pending upload is released at once (so it holds no
 * open upload slot until it expires), and a suggestion that lost its version to a publish is
 * offered to the carry job. Conditioned on the attempt still running, so it happens once; an
 * attempt an erasure ended already leaves the suggestion withdrawn.
 */
export async function endAttempt(
  db: RegionalDb,
  attempt: Pick<AttemptRow, "id" | "artifactId" | "ownerId" | "origin">,
  reason: AttemptEndReason,
  now: number,
): Promise<void> {
  const running = sql`exists (select 1 from ${at} where ${at.id} = ${attempt.id} and ${at.state} = 'running')`;
  const carry = JSON.stringify({ versionId: "" });
  await db.batch([
    db
      .update(th)
      .set({ suggestionState: "pending", attemptId: null, attemptReason: reason, updatedAt: now })
      .where(and(eq(th.attemptId, attempt.id), eq(th.suggestionState, "applying"), running)),
    db
      .update(dr)
      .set({ attemptId: null, attemptReason: reason })
      .where(and(eq(dr.attemptId, attempt.id), running)),
    // A suggestion left on an earlier version is carried to the current one, or outdated.
    db
      .insert(schema.outbox)
      .select(
        sql`select null, 'suggestion_carry', json_set(${carry}, '$.versionId', ${t.currentVersionId}), ${now}, null, 0, ${now}, ${t.id}, null from ${t} where ${t.id} = ${attempt.artifactId} and ${t.currentVersionId} is not null and ${running} and ${attempt.origin === "suggestion" && reason === "version_conflict" ? sql`1` : sql`0`}`,
      ),
    db
      .update(at)
      .set({ state: "ended", reason, updatedAt: now })
      .where(and(eq(at.id, attempt.id), eq(at.state, "running"))),
  ]);
  await releaseUpload(db, attempt, now);
}

/**
 * Closes the upload keyed by the attempt, when there is one: an upload prepared before a crash
 * that kept `version_id` from being recorded is released too.
 */
async function releaseUpload(
  db: RegionalDb,
  attempt: Pick<AttemptRow, "id" | "ownerId">,
  now: number,
): Promise<void> {
  const { sessionId } = serverIdsOf(attempt.id);
  await closeUploadSession(db, { ownerId: attempt.ownerId, sessionId, now }, "failed");
}

// The claim and the completion

interface Completion {
  attempt: AttemptRow;
  loaded: AuthorizedAnnotations;
  built: SubjectPlan;
  token: string;
  now: number;
  /** The handle the completing batch runs on, and the person's role condition. */
  w: Db;
  holds: SQL;
}

/**
 * The claim: inserted only with room for every listed item, the attempt running, the subject as
 * confirmed, the person still acting for the owner and the artifact as authorized at the job's
 * time (owner, active, unexpired, annotation mode) on the base version.
 */
function claimStatement(c: Completion) {
  const { attempt, w } = c;
  const listed = c.built.plan.listed.length;
  const subject =
    attempt.origin === "suggestion"
      ? sql`exists (select 1 from ${th} where ${th.id} = ${attempt.threadId} and ${th.suggestionState} = 'applying' and ${th.attemptId} = ${attempt.id})`
      : sql`exists (select 1 from ${dr} where ${dr.artifactId} = ${attempt.artifactId} and ${dr.userId} = ${attempt.userId} and ${dr.attemptId} = ${attempt.id})`;
  // Columns in schema order: attempt, run token, artifact, created.
  return w
    .insert(cl)
    .select(
      sql`select ${attempt.id}, ${c.token}, ${attempt.artifactId}, ${c.now} where ${openItemsSql(attempt.artifactId)} + ${listed} <= ${CHANGE_LIST_LIMITS.openPerArtifact} and exists (select 1 from ${at} where ${at.id} = ${attempt.id} and ${at.state} = 'running') and ${subject} and ${c.holds} and ${artifactAt(c.loaded, attempt.baseVersionId, c.now)}`,
    )
    .onConflictDoNothing()
    .returning({ id: cl.attemptId });
}

async function openItems(db: RegionalDb, artifactId: string): Promise<number> {
  const [row] = await db.all<{ open: number }>(sql`select ${openItemsSql(artifactId)} as open`);
  return Number((row as { open: number }).open);
}

/** True only for the run whose token the claim holds: another run's claim grants nothing. */
const heldBy = (attemptId: string, token: string) =>
  sql`exists (select 1 from ${cl} where ${cl.attemptId} = ${attemptId} and ${cl.runToken} = ${token})`;

/** One change-list item per listed operation, with the people beside the envelope. */
function itemStatements(c: Completion, condition: SQL, submittedBy: SQL): BatchItem<"sqlite">[] {
  const { attempt, built, w } = c;
  const { plan } = built;
  const applied = plan.applied.length;
  return plan.listed.map((envelope: Envelope, index) => {
    const proof: Proof | null = plan.proofs[applied + index] ?? null;
    const envelopeText = JSON.stringify(envelope);
    const proofText = proof === null ? null : JSON.stringify(proof);
    const bytes = utf8Length(envelopeText) + (proofText === null ? 0 : utf8Length(proofText));
    const id = `chg_${crypto.randomUUID().replaceAll("-", "")}`;
    // Columns in schema order: id, artifact, owner, origin, thread, attempt, version, path,
    // route, envelope, proof, bytes, reason, state, created by, submitted by, created, closed
    // at, closed by, closed version, revision.
    return w
      .insert(ci)
      .select(
        sql`select ${id}, ${attempt.artifactId}, ${attempt.ownerId}, ${attempt.origin}, ${attempt.origin === "suggestion" ? attempt.threadId : null}, ${attempt.id}, ${plan.binding.versionId}, ${plan.binding.path}, ${plan.binding.route}, ${envelopeText}, ${proofText}, ${bytes}, ${envelope.reason as string}, 'open', ${attempt.userId}, ${submittedBy}, ${c.now}, null, null, null, 1 where ${condition}`,
      );
  });
}

/** Completes the suggestion or draft and the attempt, and records the acceptance. */
function completionStatements(
  c: Completion,
  condition: SQL,
  version: { id: string; number: SQL } | null,
): BatchItem<"sqlite">[] {
  const { attempt, built, now, w } = c;
  // The suggester, beside each item's envelope (account erasure clears it).
  const submittedBy =
    attempt.origin === "suggestion"
      ? sql`(select ${th.authorId} from ${th} where ${th.id} = ${attempt.threadId})`
      : sql`${attempt.userId}`;
  return [
    ...itemStatements(c, condition, submittedBy),
    attempt.origin === "suggestion"
      ? w
          .update(th)
          .set({
            suggestionState: "accepted",
            attemptId: null,
            attemptReason: null,
            decidedBy: attempt.userId,
            decidedAt: now,
            resultVersionId: version?.id ?? null,
            state: "resolved",
            resolvedAt: now,
            resolvedBy: attempt.userId,
            suggestionRevision: sql`${th.suggestionRevision} + 1`,
            updatedAt: now,
          })
          .where(
            and(eq(th.id, attempt.threadId as string), eq(th.attemptId, attempt.id), condition),
          )
      : w
          .delete(dr)
          .where(
            and(
              eq(dr.artifactId, attempt.artifactId),
              eq(dr.userId, attempt.userId as string),
              eq(dr.attemptId, attempt.id),
              condition,
            ),
          ),
    auditEvent(
      w,
      {
        ownerId: attempt.ownerId,
        kind: "suggestion.accepted",
        actor: { type: "user", id: attempt.userId as string },
        targetId: attempt.artifactId,
        artifactId: attempt.artifactId,
        detail: {
          origin: attempt.origin,
          applied: built.plan.applied.length,
          listed: built.plan.listed.length,
          version: version ? 1 : null,
        },
        ...(version ? { computed: { version: version.number } } : {}),
        now,
      },
      condition,
    ),
    w
      .update(at)
      .set({ state: "done", versionId: version?.id ?? null, updatedAt: now })
      .where(and(eq(at.id, attempt.id), eq(at.state, "running"), condition)),
  ];
}

/**
 * Why a claim was not taken: a duplicate run holds it, the list is full, the person no longer
 * acts for the owner, the artifact is no longer as authorized, or the version moved.
 */
async function lostClaim(db: RegionalDb, c: Completion): Promise<"duplicate" | AttemptEndReason> {
  const [held] = await db
    .select({ token: cl.runToken })
    .from(cl)
    .where(eq(cl.attemptId, c.attempt.id))
    .limit(1);
  if (held) return "duplicate";
  if (
    !admitItems(
      await openItems(db, c.attempt.artifactId),
      c.built.plan.listed.length,
      CHANGE_LIST_CAP,
    )
  ) {
    return "quota_exceeded";
  }
  const again = await authorizedAt(db, c.attempt, c.now);
  if (!again) return "revoked";
  return "version_conflict";
}

/** Whether a failed batch broke the owner's annotation quota or the open-item backstop. */
function annotationQuotaFailure(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (/annotation_usage|change_items_open_limit/.test(e.message)) return true;
  }
  return false;
}

/**
 * Completes an attempt whose plan applies nothing: items and completion, no version. The owner's
 * annotation quota (the items' bytes) refusing the batch ends the attempt as `quota_exceeded`, as
 * a publish's own quota does.
 */
async function completeWithoutVersion(db: RegionalDb, c: Completion): Promise<JobOutcome> {
  const held = heldBy(c.attempt.id, c.token);
  let claimRows: unknown[];
  try {
    [claimRows] = await c.w.batch([claimStatement(c), ...completionStatements(c, held, null)]);
  } catch (error) {
    if (!annotationQuotaFailure(error)) throw error;
    await endAttempt(db, c.attempt, "quota_exceeded", c.now);
    return "done";
  }
  if (claimRows.length === 1) return "done";
  const lost = await lostClaim(db, c);
  if (lost !== "duplicate") await endAttempt(db, c.attempt, lost, c.now);
  return "done";
}

/** The version's manifest with the planned file replaced, and its declared source origin. */
async function manifestOf(
  db: RegionalDb,
  versionId: string,
  path: string,
  sha256: string,
  size: number,
) {
  const vf = schema.versionFiles;
  const files = await db
    .select({
      path: vf.path,
      kind: vf.kind,
      sha256: vf.sha256,
      size: vf.size,
      contentType: vf.contentType,
    })
    .from(vf)
    .where(and(eq(vf.versionId, versionId), sql`${vf.kind} in ('published', 'source')`));
  const manifest: ManifestEntry[] = files.map((file) => {
    const entry = { ...file, kind: file.kind as "published" | "source" };
    return file.kind === "published" && file.path === path ? { ...entry, sha256, size } : entry;
  });
  const [origin] = await db
    .select()
    .from(schema.sourceOrigins)
    .where(eq(schema.sourceOrigins.versionId, versionId))
    .limit(1);
  const [version] = await db
    .select({ entrypoint: schema.versions.entrypoint })
    .from(schema.versions)
    .where(eq(schema.versions.id, versionId))
    .limit(1);
  return { manifest, origin, entrypoint: (version as { entrypoint: string }).entrypoint };
}

/** Why a commit that did not switch ends the attempt, besides a lost claim. */
const COMMIT_REASONS: Partial<Record<string, AttemptEndReason>> = {
  upload_incomplete: "failed",
  quota_exceeded: "quota_exceeded",
  forbidden: "revoked",
};

const PREPARE_REASONS: Partial<Record<string, AttemptEndReason>> = {
  quota_exceeded: "quota_exceeded",
  capacity_unavailable: "capacity_unavailable",
  version_conflict: "version_conflict",
  artifact_archived: "revoked",
  forbidden: "revoked",
  not_found: "revoked",
};

/**
 * Publishes the plan's new file as a new version through the publish path (decision 0027,
 * "Producing the new version"): the bytes are checked against the plan's output (size and
 * SHA-256), `preparePublish` opens a server upload for the base version's files with the planned
 * one replaced, as the accepting person (keyed by the attempt, so a retry finds it), the bytes go
 * to R2 under their content address, and `commitPublish` commits with the claim first, the
 * completion on its switch, and its rendering and block map held to the plan's hashes. Every
 * quota, rendering, audit, webhook, search, approval and expiry rule of a publish applies.
 */
export async function publishFromPlan(
  db: RegionalDb,
  bucket: R2Bucket,
  c: Completion & { artifact: ArtifactRow },
): Promise<JobOutcome> {
  const { attempt, built, now, artifact } = c;
  const userId = attempt.userId as string;
  const { plan, page } = built;
  const output = plan.output as NonNullable<typeof plan.output>;
  const bytes = newFileBytes(page, plan.newSource as string);
  const fileSha = await sha256Of(bytes);
  // The bytes stored are exactly the plan's output, or nothing is published.
  if (fileSha !== output.sha256 || bytes.byteLength !== output.size) {
    await endAttempt(db, attempt, "plan_changed", now);
    return "done";
  }
  const ids = serverIdsOf(attempt.id);
  const [existing] = await db
    .select({ state: schema.uploadSessions.state })
    .from(schema.uploadSessions)
    .where(eq(schema.uploadSessions.id, ids.sessionId))
    .limit(1);
  // A closed upload (expired or failed; a committed one completed the attempt in its batch).
  if (existing && existing.state !== "uploading" && existing.state !== "ready") {
    await endAttempt(db, attempt, "failed", now);
    return "done";
  }
  if (!existing) {
    const { manifest, origin, entrypoint } = await manifestOf(
      db,
      attempt.baseVersionId,
      plan.binding.path,
      fileSha,
      bytes.byteLength,
    );
    const prepared = await preparePublish(db, {
      userId,
      artifactId: artifact.id,
      type: artifact.type,
      name: artifact.name,
      entrypoint,
      baseVersionId: attempt.baseVersionId,
      files: manifest,
      ...(origin
        ? {
            sourceOrigin: {
              commit: origin.commit,
              branch: origin.branch,
              remote: origin.remote,
              dirty: origin.dirty,
            },
          }
        : {}),
      serverIds: ids,
      now,
    });
    if (!prepared.ok) {
      // Another delivery of this job prepared the same version meanwhile: it completes it.
      if (await sessionExists(db, ids.sessionId)) return "pending";
      await endAttempt(db, attempt, PREPARE_REASONS[prepared.code] ?? "failed", now);
      return "done";
    }
    await db
      .update(at)
      .set({ versionId: ids.versionId, updatedAt: now })
      .where(and(eq(at.id, attempt.id), sql`${at.versionId} is null`));
  }
  // The new file under its content address, when the owner does not store it verified already.
  const [object] = await db
    .select({ r2Key: schema.objects.r2Key, state: schema.objects.state })
    .from(schema.objects)
    .where(and(eq(schema.objects.ownerId, attempt.ownerId), eq(schema.objects.sha256, fileSha)))
    .limit(1);
  if (object?.state === "pending") {
    await bucket.put(object.r2Key, bytes, { sha256: fileSha });
  }
  // With one database the claim names the membership; with a separate regional one the commit
  // reads the role again after its rendering and right before its batch (`stillActs`).
  const held = heldBy(attempt.id, c.token);
  const versionNumber = sql`(select ${schema.versions.number} from ${schema.versions} where ${schema.versions.id} = ${ids.versionId})`;
  const committed = await commitPublish(
    db,
    bucket,
    { userId, sessionId: ids.sessionId, now },
    {
      handle: c.w,
      claim: claimStatement(c),
      held,
      completion: (switched) =>
        completionStatements(c, sql`${switched} and ${held}`, {
          id: ids.versionId,
          number: versionNumber,
        }),
      via: attempt.origin,
      ...(bothSides(db) ? {} : { stillActs: () => stillActs(db, attempt.ownerId, userId) }),
      renderedSha256: output.renderedSha256,
      blockMapSha256: output.blockMapSha256,
    },
  );
  if (committed.ok) return "done";
  const reason =
    "detail" in committed && committed.detail === "plan_changed"
      ? "plan_changed"
      : COMMIT_REASONS[committed.code];
  if (reason) {
    await endAttempt(db, attempt, reason, now);
    return "done";
  }
  const lost = await lostClaim(db, c);
  if (lost !== "duplicate") await endAttempt(db, attempt, lost, now);
  return "done";
}

async function sessionExists(db: RegionalDb, sessionId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.uploadSessions.id })
    .from(schema.uploadSessions)
    .where(eq(schema.uploadSessions.id, sessionId))
    .limit(1);
  return row !== undefined;
}

async function sha256Of(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The job

/**
 * Runs a `suggestion_accept` or `draft_publish` job: re-authorizes the person, rebuilds and
 * confirms the plan, and completes it with a version or without one. Every outcome either
 * completes the attempt or ends it with a reason; a thrown error leaves the job for the queue to
 * retry, and the scan ends an attempt still running after its deliveries or its time.
 */
export async function runAcceptance(
  db: RegionalDb,
  bucket: R2Bucket,
  row: OutboxRow,
  now: number,
): Promise<JobOutcome> {
  const payload = AcceptancePayload.safeParse(row.payload);
  if (!payload.success) return "stale";
  const { attemptId, contentDomain } = payload.data;
  // Counted first, so a job that keeps failing ends through the scan.
  const [attempt] = await db
    .update(at)
    .set({ deliveries: sql`${at.deliveries} + 1`, updatedAt: now })
    .where(and(eq(at.id, attemptId), eq(at.state, "running")))
    .returning();
  if (!attempt) {
    // Ended elsewhere (an account erasure, the scan): its upload, if any, goes now.
    const [ended] = await db.select().from(at).where(eq(at.id, attemptId)).limit(1);
    if (ended?.state === "ended") await releaseUpload(db, ended, now);
    return "done";
  }
  // Three deliveries already ran, or it started too long ago: it ends (the scan does the same).
  if (attemptOverdue({ deliveries: attempt.deliveries - 1, createdAt: attempt.createdAt }, now)) {
    await endAttempt(db, attempt, "failed", now);
    return "done";
  }
  const checked = await recheck(db, bucket, attempt, contentDomain, now);
  if (!checked.ok) {
    await endAttempt(db, attempt, checked.reason, now);
    return "done";
  }
  const scope = acceptorScope(db, attempt.ownerId, attempt.userId as string);
  const completion: Completion = {
    attempt,
    loaded: checked.loaded,
    built: checked.built,
    token: crypto.randomUUID(),
    now,
    ...scope,
  };
  if (checked.built.plan.output === null) {
    if (!bothSides(db) && !(await stillActs(db, attempt.ownerId, attempt.userId as string))) {
      await endAttempt(db, attempt, "revoked", now);
      return "done";
    }
    return completeWithoutVersion(db, completion);
  }
  return publishFromPlan(db, bucket, { ...completion, artifact: checked.loaded.artifact });
}

type Recheck =
  | { ok: true; loaded: AuthorizedAnnotations; built: SubjectPlan }
  | { ok: false; reason: AttemptEndReason };

/**
 * The person's authorization at the job's time: an annotation write on the owner side (effective
 * state and expiry, annotation mode, hold), on the attempt's owner.
 */
async function authorizedAt(
  db: RegionalDb,
  attempt: AttemptRow,
  now: number,
): Promise<AuthorizedAnnotations | null> {
  if (attempt.userId === null) return null;
  const loaded = await annotationParts.authorize(
    db,
    { userId: attempt.userId, artifactId: attempt.artifactId, now },
    "moderate",
  );
  if (!loaded.ok || loaded.value.role !== "owner") return null;
  return loaded.value.artifact.ownerId === attempt.ownerId ? loaded.value : null;
}

/** Everything the route checked, again, from the current state at the job's time. */
async function recheck(
  db: RegionalDb,
  bucket: R2Bucket,
  attempt: AttemptRow,
  contentDomain: string,
  now: number,
): Promise<Recheck> {
  const revoked = { ok: false, reason: "revoked" } as const;
  const loaded = await authorizedAt(db, attempt, now);
  if (!loaded) return revoked;
  const { artifact } = loaded;
  if (artifact.currentVersionId !== attempt.baseVersionId) {
    return { ok: false, reason: "version_conflict" };
  }
  let built: Result<SubjectPlan>;
  if (attempt.origin === "suggestion") {
    const [thread] = attempt.threadId
      ? await db.select().from(th).where(eq(th.id, attempt.threadId)).limit(1)
      : [];
    if (!thread || thread.suggestionState !== "applying" || thread.attemptId !== attempt.id) {
      return revoked;
    }
    built = await suggestionPlanOf(db, bucket, { artifact, thread, acceptor: true, contentDomain });
  } else {
    const [draft] = await db
      .select()
      .from(dr)
      .where(and(eq(dr.artifactId, artifact.id), eq(dr.userId, attempt.userId as string)))
      .limit(1);
    if (!draft || draft.attemptId !== attempt.id) return revoked;
    built = await draftPlanOf(db, bucket, { artifact, draft, contentDomain });
  }
  if (!built.ok || !(await confirmed(built.value, attempt.digest))) {
    return { ok: false, reason: "plan_changed" };
  }
  // A version is admitted again by `preparePublish`; listing items is annotation work.
  if (built.value.plan.output === null) {
    const capacity = await capacityFor(db, built.value, now);
    if (!capacity.ok) return { ok: false, reason: "capacity_unavailable" };
  }
  return { ok: true, loaded, built: built.value };
}
