// Accepting a suggestion and publishing a draft (decision 0027, "Producing the new version", "The
// acceptance claim"). Two steps:
//
// 1. The person confirms a plan by its digest (`acceptSuggestion`, `publishDraft`, session-only
//    routes in the adapters). The server rebuilds the plan from the stored files, compares the
//    digest, checks budget protection and the change list's room, and in one batch starts an
//    acceptance attempt, marks the suggestion `applying` (or the draft as publishing) and writes
//    the `suggestion_accept` or `draft_publish` job, all on the attempt row the batch inserted
//    first under the state the person saw.
// 2. The job (`runAcceptance`) checks everything again (the attempt still current, the person
//    still acting for the owner, the artifact servable, not held, at the base version, the same
//    digest) and completes the attempt with one claim (`acceptance_claims`): the claim is the
//    first statement of the completing batch, inserted only when the change list has room for
//    every listed item and the suggestion or draft and the base version are as confirmed, and
//    every later statement is conditioned on the claim with this run's token. When something
//    applies, the batch is the publish's own commit (`publishFromPlan` through `preparePublish`
//    and `commitPublish`, never a second path); when nothing does, it lists the items and
//    completes the suggestion or draft without a version.
//
// Every failure point ends in a state the job or the scan (`expireAcceptAttempts`) recovers: see
// the recovery table in the record and in docs/operations.md, "Edit suggestions".
import {
  type AcceptanceStarted,
  AcceptancePayload,
  CHANGE_LIST_LIMITS,
  type Envelope,
  type Proof,
  SUGGESTION_LIMITS,
  utf8Length,
} from "@portifact/contracts";
import { hitRateLimits, type RegionalDb, schema } from "@portifact/db";
import {
  actsForOwner,
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
import { type AnnotationActor, annotationParts } from "./annotations.ts";
import { auditEvent } from "./audit.ts";
import { platformProtection } from "./budget.ts";
import { isHeld } from "./legal-holds.ts";
import type { JobOutcome } from "./outbox.ts";
import {
  closeUploadSession,
  commitPublish,
  type ManifestEntry,
  preparePublish,
} from "./publish.ts";
import {
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

/**
 * What both routes check before starting an attempt: the confirmed digest is the digest of the
 * plan the server builds now from the stored files, budget protection allows a publish when one
 * would happen, the change list has room for every listed item, and the owner's daily count of
 * acceptances is not spent.
 */
async function admitAcceptance(
  db: RegionalDb,
  built: SubjectPlan,
  input: { digest: string; ownerId: string; artifactId: string; now: number },
): Promise<Result<true>> {
  const { plan } = built;
  const confirmed = await confirmPlan({
    plan,
    confirmedDigest: input.digest,
    current: plan.binding,
    newSource: plan.newSource,
    renderer: DOCUMENT_RENDERER,
  });
  if (confirmed !== "confirmed") return planChanged();
  if (plan.output !== null) {
    const capacity = checkPublishCapacity((await platformProtection(db.global, input.now)).actions, false);
    if (!capacity.ok) return capacity;
  }
  const [row] = await db.all<{ open: number }>(sql`select ${openItemsSql(input.artifactId)} as open`);
  if (!admitItems(Number(row?.open ?? 0), plan.listed.length, CHANGE_LIST_CAP)) {
    return fail("quota_exceeded", "The change list is full. Close some of its items first.");
  }
  const [hit] = await hitRateLimits(
    db.global.$client,
    [`suggestion_accept:owner:${input.ownerId}`],
    SUGGESTION_LIMITS.acceptsOwnerWindowMs,
    input.now,
  );
  if ((hit?.count ?? 0) > SUGGESTION_LIMITS.acceptsPerOwner) {
    return fail("rate_limited", "Too many acceptances today. Try again tomorrow.");
  }
  return ok(true);
}

/** The attempt row's insert, under `guard`. Columns in schema order. */
function attemptInsert(
  db: RegionalDb,
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
  return db
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
  db: RegionalDb,
  topic: "suggestion_accept" | "draft_publish",
  input: { attemptId: string; artifactId: string; contentDomain: string; now: number },
) {
  const payload = JSON.stringify({
    attemptId: input.attemptId,
    contentDomain: input.contentDomain,
  });
  return db
    .insert(schema.outbox)
    .select(
      sql`select null, ${topic}, ${payload}, ${input.now}, null, 0, ${input.now}, ${input.artifactId}, null where ${attemptExists(input.attemptId)}`,
    );
}

/** The artifact as the person authorized it: same owner, active, at the base version. */
const artifactAt = (artifact: ArtifactRow, baseVersionId: string) =>
  sql`exists (select 1 from ${t} where ${t.id} = ${artifact.id} and ${t.ownerId} = ${artifact.ownerId} and ${t.state} = 'active' and ${t.currentVersionId} = ${baseVersionId})`;

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
  const built = await suggestionPlanOf(db, bucket, {
    artifact,
    thread,
    acceptor: true,
    contentDomain: input.contentDomain,
  });
  if (!built.ok) return built;
  const admitted = await admitAcceptance(db, built.value, {
    digest: input.digest,
    ownerId: artifact.ownerId,
    artifactId: artifact.id,
    now: input.now,
  });
  if (!admitted.ok) return admitted;
  const attemptId = newAttemptId();
  const guard = sql`${artifactAt(artifact, thread.versionId)} and exists (select 1 from ${th} where ${th.id} = ${thread.id} and ${th.suggestionState} = 'pending' and ${th.suggestionRevision} = ${thread.suggestionRevision})`;
  const [inserted] = await db.batch([
    attemptInsert(
      db,
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
    db
      .update(th)
      .set({ suggestionState: "applying", attemptId, attemptReason: null, updatedAt: input.now })
      .where(and(eq(th.id, thread.id), eq(th.suggestionState, "pending"), attemptExists(attemptId))),
    acceptanceJob(db, "suggestion_accept", {
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
  const built = await draftPlanOf(db, bucket, {
    artifact,
    draft,
    contentDomain: input.contentDomain,
  });
  if (!built.ok) return built;
  const admitted = await admitAcceptance(db, built.value, {
    digest: input.digest,
    ownerId: artifact.ownerId,
    artifactId: artifact.id,
    now: input.now,
  });
  if (!admitted.ok) return admitted;
  const attemptId = newAttemptId();
  const ownDraftAt = and(
    eq(dr.artifactId, artifact.id),
    eq(dr.userId, input.userId),
    eq(dr.revision, draft.revision),
    sql`${dr.attemptId} is null`,
  );
  const guard = sql`${artifactAt(artifact, draft.baseVersionId)} and exists (select 1 from ${dr} where ${ownDraftAt})`;
  const [inserted] = await db.batch([
    attemptInsert(
      db,
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
    db
      .update(dr)
      .set({ attemptId, attemptReason: null })
      .where(and(ownDraftAt, attemptExists(attemptId))),
    acceptanceJob(db, "draft_publish", {
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
 * offered to the carry job. Conditioned on the attempt still running, so it happens once.
 */
export async function endAttempt(
  db: RegionalDb,
  attempt: Pick<AttemptRow, "id" | "artifactId" | "ownerId" | "origin" | "versionId">,
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
  if (attempt.versionId !== null) {
    const { sessionId } = serverIdsOf(attempt.id);
    await closeUploadSession(db, { ownerId: attempt.ownerId, sessionId, now }, "failed");
  }
}

// The claim and the completion

interface Completion {
  attempt: AttemptRow;
  built: SubjectPlan;
  token: string;
  now: number;
}

/** The claim: inserted only with room for every listed item and the subject as confirmed. */
function claimStatement(db: RegionalDb, c: Completion) {
  const { attempt } = c;
  const listed = c.built.plan.listed.length;
  const subject =
    attempt.origin === "suggestion"
      ? sql`exists (select 1 from ${th} where ${th.id} = ${attempt.threadId} and ${th.suggestionState} = 'applying' and ${th.attemptId} = ${attempt.id})`
      : sql`exists (select 1 from ${dr} where ${dr.artifactId} = ${attempt.artifactId} and ${dr.userId} = ${attempt.userId} and ${dr.attemptId} = ${attempt.id})`;
  // Columns in schema order: attempt, run token, artifact, created.
  return db
    .insert(cl)
    .select(
      sql`select ${attempt.id}, ${c.token}, ${attempt.artifactId}, ${c.now} where ${openItemsSql(attempt.artifactId)} + ${listed} <= ${CHANGE_LIST_LIMITS.openPerArtifact} and exists (select 1 from ${at} where ${at.id} = ${attempt.id} and ${at.state} = 'running') and ${subject} and exists (select 1 from ${t} where ${t.id} = ${attempt.artifactId} and ${t.ownerId} = ${attempt.ownerId} and ${t.state} = 'active' and ${t.currentVersionId} = ${attempt.baseVersionId})`,
    )
    .onConflictDoNothing()
    .returning({ id: cl.attemptId });
}

const heldBy = (attemptId: string, token: string) =>
  sql`exists (select 1 from ${cl} where ${cl.attemptId} = ${attemptId} and ${cl.runToken} = ${token})`;

/** One change-list item per listed operation, with the people beside the envelope. */
function itemStatements(
  db: RegionalDb,
  c: Completion,
  condition: SQL,
  submittedBy: SQL,
): BatchItem<"sqlite">[] {
  const { attempt, built } = c;
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
    return db
      .insert(ci)
      .select(
        sql`select ${id}, ${attempt.artifactId}, ${attempt.ownerId}, ${attempt.origin}, ${attempt.origin === "suggestion" ? attempt.threadId : null}, ${attempt.id}, ${plan.binding.versionId}, ${plan.binding.path}, ${plan.binding.route}, ${envelopeText}, ${proofText}, ${bytes}, ${envelope.reason ?? "not_text"}, 'open', ${attempt.userId}, ${submittedBy}, ${c.now}, null, null, null, 1 where ${condition}`,
      );
  });
}

/** Completes the suggestion or draft and the attempt, and records the acceptance. */
function completionStatements(
  db: RegionalDb,
  c: Completion,
  condition: SQL,
  version: { id: string; number: SQL } | null,
): BatchItem<"sqlite">[] {
  const { attempt, built, now } = c;
  // The suggester, beside each item's envelope (account erasure clears it).
  const submittedBy =
    attempt.origin === "suggestion"
      ? sql`(select ${th.authorId} from ${th} where ${th.id} = ${attempt.threadId})`
      : sql`${attempt.userId}`;
  return [
    ...itemStatements(db, c, condition, submittedBy),
    attempt.origin === "suggestion"
      ? db
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
          .where(and(eq(th.id, attempt.threadId as string), eq(th.attemptId, attempt.id), condition))
      : db
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
      db,
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
    db
      .update(at)
      .set({ state: "done", versionId: version?.id ?? null, updatedAt: now })
      .where(and(eq(at.id, attempt.id), eq(at.state, "running"), condition)),
  ];
}

/** Why a claim was not taken: a duplicate run holds it, the list is full, or the state moved. */
async function lostClaim(
  db: RegionalDb,
  c: Completion,
): Promise<"duplicate" | AttemptEndReason> {
  const [held] = await db
    .select({ token: cl.runToken })
    .from(cl)
    .where(eq(cl.attemptId, c.attempt.id))
    .limit(1);
  if (held) return "duplicate";
  const [row] = await db.all<{ open: number }>(
    sql`select ${openItemsSql(c.attempt.artifactId)} as open`,
  );
  if (!admitItems(Number(row?.open ?? 0), c.built.plan.listed.length, CHANGE_LIST_CAP)) {
    return "quota_exceeded";
  }
  return "version_conflict";
}

/** Completes an attempt whose plan applies nothing: items and completion, no version. */
async function completeWithoutVersion(db: RegionalDb, c: Completion): Promise<JobOutcome> {
  const held = heldBy(c.attempt.id, c.token);
  const [claimRows] = await db.batch([
    claimStatement(db, c),
    ...completionStatements(db, c, held, null),
  ]);
  if ((claimRows as unknown[]).length === 1) return "done";
  const lost = await lostClaim(db, c);
  if (lost !== "duplicate") await endAttempt(db, c.attempt, lost, c.now);
  return "done";
}

/** The version's manifest with the planned file replaced, and its declared source origin. */
async function manifestOf(db: RegionalDb, versionId: string, path: string, sha256: string, size: number) {
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
  return { manifest, origin, entrypoint: version?.entrypoint ?? path };
}

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
 * "Producing the new version"): `preparePublish` opens a server upload for the base version's
 * files with the planned one replaced, as the accepting person (keyed by the attempt, so a retry
 * finds it), the bytes go to R2 under their content address, and `commitPublish` commits with the
 * claim first and the completion on its switch. Every quota, rendering, audit, webhook, search,
 * approval and expiry rule of a publish applies unchanged.
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
  const ids = serverIdsOf(attempt.id);
  const [existing] = await db
    .select({ state: schema.uploadSessions.state })
    .from(schema.uploadSessions)
    .where(eq(schema.uploadSessions.id, ids.sessionId))
    .limit(1);
  if (existing && existing.state === "committed") return "done";
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
    await bucket.put(object.r2Key, bytes, {
      sha256: fileSha,
    });
  }
  const held = heldBy(attempt.id, c.token);
  const versionNumber = sql`(select ${schema.versions.number} from ${schema.versions} where ${schema.versions.id} = ${ids.versionId})`;
  const committed = await commitPublish(
    db,
    bucket,
    { userId, sessionId: ids.sessionId, now },
    {
      claim: claimStatement(db, c),
      held,
      completion: (switched) =>
        completionStatements(db, c, sql`${switched} and ${held}`, {
          id: ids.versionId,
          number: versionNumber,
        }),
      via: attempt.origin,
      renderedSha256: output.renderedSha256,
    },
  );
  if (committed.ok) return "done";
  if (committed.code === "upload_incomplete") {
    await endAttempt(db, attempt, "failed", now);
    return "done";
  }
  if (committed.code === "quota_exceeded") {
    await endAttempt(db, attempt, "quota_exceeded", now);
    return "done";
  }
  if ("detail" in committed && committed.detail === "plan_changed") {
    await endAttempt(db, attempt, "plan_changed", now);
    return "done";
  }
  const lost = await lostClaim(db, c);
  if (lost !== "duplicate") await endAttempt(db, attempt, lost, now);
  return "done";
}

async function sha256Of(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The job

/**
 * Runs a `suggestion_accept` or `draft_publish` job: re-checks the attempt, rebuilds and confirms
 * the plan, and completes it with a version or without one. Every outcome either completes the
 * attempt or ends it with a reason; a thrown error leaves the job for the queue to retry, and the
 * scan ends an attempt still running after its deliveries or its time.
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
  if (!attempt) return "done";
  // Three deliveries already ran, or it started too long ago: it ends (the scan does the same).
  if (attemptOverdue({ deliveries: attempt.deliveries - 1, createdAt: attempt.createdAt }, now)) {
    await endAttempt(db, attempt, "failed", now);
    return "done";
  }
  const checked = await recheck(db, bucket, attempt, contentDomain);
  if (!checked.ok) {
    await endAttempt(db, attempt, checked.reason, now);
    return "done";
  }
  const completion: Completion = {
    attempt,
    built: checked.built,
    token: crypto.randomUUID(),
    now,
  };
  if (checked.built.plan.output === null) return completeWithoutVersion(db, completion);
  return publishFromPlan(db, bucket, { ...completion, artifact: checked.artifact });
}

type Recheck =
  | { ok: true; artifact: ArtifactRow; built: SubjectPlan }
  | { ok: false; reason: AttemptEndReason };

/** Everything the route checked, again, from the current state. */
async function recheck(
  db: RegionalDb,
  bucket: R2Bucket,
  attempt: AttemptRow,
  contentDomain: string,
): Promise<Recheck> {
  const revoked = { ok: false, reason: "revoked" } as const;
  const [artifact] = await db.select().from(t).where(eq(t.id, attempt.artifactId)).limit(1);
  if (!artifact || artifact.ownerId !== attempt.ownerId || artifact.state !== "active") {
    return revoked;
  }
  if (attempt.userId === null) return revoked;
  if (await isHeld(db, artifact.id)) return revoked;
  // The person still acts for the owner (a removal or a lower role meanwhile ends the attempt).
  const actor = await actorOn(db.global, attempt.userId, artifact.ownerId);
  if (!actor.ok || !actsForOwner(actor.value, artifact.ownerId)) return revoked;
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
      .where(and(eq(dr.artifactId, artifact.id), eq(dr.userId, attempt.userId)))
      .limit(1);
    if (!draft || draft.attemptId !== attempt.id) return revoked;
    built = await draftPlanOf(db, bucket, { artifact, draft, contentDomain });
  }
  if (!built.ok) return { ok: false, reason: "plan_changed" };
  const confirmed = await confirmPlan({
    plan: built.value.plan,
    confirmedDigest: attempt.digest,
    current: built.value.plan.binding,
    newSource: built.value.plan.newSource,
    renderer: DOCUMENT_RENDERER,
  });
  if (confirmed !== "confirmed") return { ok: false, reason: "plan_changed" };
  return { ok: true, artifact, built: built.value };
}
