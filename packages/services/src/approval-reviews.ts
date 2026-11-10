// Approval reviews (premium plan T6, feature `reviews`; decision 0013). Not review mode: that is
// the commenting session on an artifact. Here an admin or editor of the owner (role action
// `approvals`, which a service token also holds) asks named people to review the artifact's
// current version; each reviewer answers with a verdict and an optional note.
//
// Who may be a reviewer is exactly who the access rules already let open the artifact and take
// part in its comments (`addressTakesPart` in ./annotations.ts): requesting grants nothing.
// Reviewers are kept by email address and matched to the caller by verified address, like the
// reader list. A reviewer who can no longer open the artifact is dropped from the count
// (`dropped_at`): when a verdict is refused, and by the maintenance scan every 15 minutes.
//
// Every write is one batch conditioned on what the request read: the open request (its
// revision for owner-side changes, its version for verdicts), the artifact's current version and
// its owner (a transfer in between makes it a no-op). The audit event rides in the same batch on
// the same condition. Publish and rollback move the open request to the new version in the batch
// of their switch (`moveApprovalReview`), so verdicts stay with the version they were given on.
//
// Notes are untrusted plain text: never logged, never in the audit log, webhooks or emails.
import {
  APPROVALS,
  type ApprovalHistoryEntry,
  type ApprovalReviewerView,
  type ApprovalReviewView,
  type ApprovalSummary,
  type ApprovalVerdict,
  isServiceTokenId,
  utf8Length,
} from "@portifact/contracts";
import { type Db, hitRateLimit, type RegionalDb, schema } from "@portifact/db";
import {
  APPROVAL_FEATURE,
  APPROVAL_MESSAGES,
  type ApprovalReviewerFacts,
  approvalEntryVisible,
  approvalStatusVisible,
  approvalSummary,
  approvalViewerRole,
  checkApprovalChange,
  checkRequestTarget,
  checkRequiredApprovals,
  checkReviewerList,
  checkVerdictTarget,
  type Entitlements,
  effectiveState,
  fail,
  hasFeature,
  ok,
  type Result,
} from "@portifact/domain";
import { and, desc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { authorizeOn } from "./actors.ts";
import { addressTakesPart, commentStanding } from "./annotations.ts";
import { auditEvent } from "./audit.ts";
import { ownerEntitlements, requireOwnerFeature } from "./plans.ts";

const rq = schema.reviewRequests;
const rr = schema.reviewReviewers;
const rv = schema.reviewVerdicts;
const a = schema.artifacts;

const missing = () => fail<never>("not_found", APPROVAL_MESSAGES.missingArtifact);
const noRequest = () => fail<never>("not_found", APPROVAL_MESSAGES.noRequest);
const notReviewer = () => fail<never>("forbidden", APPROVAL_MESSAGES.notReviewer);
const changed = () => fail<never>("version_conflict", APPROVAL_MESSAGES.changed);

type ArtifactRow = typeof schema.artifacts.$inferSelect;
type RequestRow = typeof schema.reviewRequests.$inferSelect;

/** `ar_` and 32 hex characters from the platform's CSPRNG. */
function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `ar_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function stateOf(artifact: ArtifactRow, now: number) {
  return effectiveState(
    {
      state: artifact.state,
      expiresAt: artifact.expiresAt === null ? null : new Date(artifact.expiresAt),
      archivedAt: artifact.archivedAt === null ? null : new Date(artifact.archivedAt),
    },
    new Date(now),
  );
}

async function loadArtifact(db: RegionalDb, artifactId: string) {
  const [artifact] = await db.select().from(a).where(eq(a.id, artifactId)).limit(1);
  if (!artifact || ["draft", "purging", "deleted"].includes(artifact.state)) return undefined;
  return artifact;
}

/** The artifact, and an actor of its owner allowed to manage its reviews. */
async function loadManaged(db: RegionalDb, userId: string, artifactId: string) {
  const artifact = await loadArtifact(db, artifactId);
  if (!artifact) return missing();
  const actor = await authorizeOn(db, userId, artifact, "approvals", missing);
  if (!actor.ok) return actor;
  return ok(artifact);
}

async function openRequest(db: RegionalDb, artifactId: string): Promise<RequestRow | undefined> {
  const [row] = await db
    .select()
    .from(rq)
    .where(and(eq(rq.artifactId, artifactId), isNull(rq.cancelledAt)))
    .limit(1);
  return row;
}

async function reviewersOf(db: RegionalDb, requestId: string) {
  // In the order they were named.
  return db
    .select()
    .from(rr)
    .where(eq(rr.requestId, requestId))
    .orderBy(rr.addedAt, sql`${rr}.rowid`);
}

/**
 * The caller's verified address: the annotation rules leave it out for the owner side, who may
 * be a reviewer too.
 */
async function verifiedEmailOf(
  db: RegionalDb,
  standing: { viewerId: string; verifiedEmail: string | null },
): Promise<string | null> {
  if (standing.verifiedEmail !== null) return standing.verifiedEmail;
  const [user] = await db.global
    .select({ email: schema.users.email, verified: schema.users.emailVerified })
    .from(schema.users)
    .where(eq(schema.users.id, standing.viewerId))
    .limit(1);
  return user?.verified ? user.email.toLowerCase() : null;
}

/** The artifact still has the owner the request was authorized on. */
function stillOwned(artifact: { id: string; ownerId: string }): SQL {
  return sql`exists (select 1 from ${a} where ${a.id} = ${artifact.id} and ${a.ownerId} = ${artifact.ownerId})`;
}

/** The artifact is active with this current version, under the owner read. */
function stillCurrent(artifact: { id: string; ownerId: string }, versionId: string): SQL {
  return sql`exists (select 1 from ${a} where ${a.id} = ${artifact.id} and ${a.ownerId} = ${artifact.ownerId} and ${a.currentVersionId} = ${versionId} and ${a.state} = 'active')`;
}

/** The open request is still the one read, at the revision read. */
function requestAt(request: { id: string; revision: number }): SQL {
  return sql`exists (select 1 from ${rq} where ${rq.id} = ${request.id} and ${rq.cancelledAt} is null and ${rq.revision} = ${request.revision})`;
}

/**
 * The status of a request on its live rows, as `approvalSummary` decides it (the tests hold the
 * two to the same answers): changes requested when a counting reviewer asks for changes on the
 * version under review, approved when the approvals of counting reviewers reach the required
 * number (the request's, or every counting reviewer, never more than them and never less than
 * one), pending otherwise.
 */
export function liveApprovalStatus(requestId: string): SQL<string> {
  const counting = sql`select 1 from ${rr} join ${rq} on ${rq.id} = ${rr.requestId} where ${rr.requestId} = ${requestId} and ${rr.droppedAt} is null`;
  const verdicts = (verdict: ApprovalVerdict) =>
    sql`(select count(*) from ${rv} join ${rr} on ${rr.requestId} = ${rv.requestId} and ${rr.email} = ${rv.email} join ${rq} on ${rq.id} = ${rv.requestId} where ${rv.requestId} = ${requestId} and ${rr.droppedAt} is null and ${rv.versionId} = ${rq.versionId} and ${rv.verdict} = ${verdict})`;
  const reviewers = sql`(select count(*) from (${counting}))`;
  const required = sql`max(1, min(coalesce((select ${rq.required} from ${rq} where ${rq.id} = ${requestId}), ${reviewers}), ${reviewers}))`;
  return sql<string>`(case when ${verdicts("changes")} > 0 then 'changes_requested' when ${reviewers} > 0 and ${verdicts("approve")} >= ${required} then 'approved' else 'pending' end)`;
}

/**
 * Records that the version under review reached a final status, once per version: the seam where
 * a notice to the requester side and a `review.completed` webhook go (decision 0013, "What is
 * left"). Runs last in a batch, on that batch's condition.
 */
function announce(db: RegionalDb, requestId: string, condition: SQL): BatchItem<"sqlite"> {
  const live = liveApprovalStatus(requestId);
  return db
    .update(rq)
    .set({ announced: sql`${live}` })
    .where(
      and(
        eq(rq.id, requestId),
        isNull(rq.cancelledAt),
        sql`${live} in ('approved', 'changes_requested')`,
        sql`${rq.announced} is not ${live}`,
        condition,
      ),
    );
}

/**
 * Counts one request (or a change that adds reviewers) for the owner and the actor, after
 * authorization: every one of them may email the reviewers it names.
 */
async function limitRequests(db: RegionalDb, ownerId: string, userId: string, now: number) {
  const rules: [string, { max: number; windowSeconds: number }][] = [
    [`approvals:owner:${ownerId}`, APPROVALS.perOwnerPerDay],
    [`approvals:actor:${userId}`, APPROVALS.perActorPerHour],
  ];
  let limited = false;
  for (const [key, rule] of rules) {
    const hits = await hitRateLimit(db.global.$client, key, rule.windowSeconds * 1000, now);
    if (hits.count > rule.max) limited = true;
  }
  return limited ? fail<never>("rate_limited", APPROVAL_MESSAGES.rateLimited) : ok(true);
}

/** Refuses the first address the access rules do not let open the artifact and comment on it. */
async function checkCanTakePart(
  db: RegionalDb,
  artifact: ArtifactRow,
  emails: readonly string[],
  owner: Entitlements,
): Promise<Result<true>> {
  for (const email of emails) {
    const { takesPart } = await addressTakesPart(db, artifact, email, owner);
    if (!takesPart) return fail("invalid_input", APPROVAL_MESSAGES.cannotOpen(email));
  }
  return ok(true);
}

export interface ApprovalRequestInput {
  userId: string;
  artifactId: string;
  reviewers: readonly string[];
  requiredApprovals?: number | null | undefined;
  showStatus?: boolean | undefined;
  now: number;
}

/**
 * Asks people to review the artifact's current version: an admin or editor of the owner (or a
 * service token that reaches it), when the owner's plan includes `reviews`. Each address must
 * already be able to open the artifact and comment on it. One open request per artifact.
 */
export async function requestApprovalReview(
  db: RegionalDb,
  input: ApprovalRequestInput,
): Promise<Result<ApprovalReviewView>> {
  const managed = await loadManaged(db, input.userId, input.artifactId);
  if (!managed.ok) return managed;
  const artifact = managed.value;
  const gate = await requireOwnerFeature(db.global, artifact, APPROVAL_FEATURE, input.now);
  if (!gate.ok) return gate;
  const owner = gate.value;
  const target = checkRequestTarget({
    state: stateOf(artifact, input.now),
    currentVersionId: artifact.currentVersionId,
  });
  if (!target.ok) return target;
  const versionId = target.value;
  const reviewers = checkReviewerList(input.reviewers);
  if (!reviewers.ok) return reviewers;
  const required = checkRequiredApprovals(input.requiredApprovals ?? null, reviewers.value.length);
  if (!required.ok) return required;
  if (await openRequest(db, artifact.id)) {
    return fail("invalid_input", APPROVAL_MESSAGES.alreadyOpen);
  }
  const eligible = await checkCanTakePart(db, artifact, reviewers.value, owner);
  if (!eligible.ok) return eligible;
  const limited = await limitRequests(db, artifact.ownerId, input.userId, input.now);
  if (!limited.ok) return limited;

  const id = newRequestId();
  const created = sql`exists (select 1 from ${rq} where ${rq.id} = ${id})`;
  const showStatus = input.showStatus ?? false;
  const results = await db.batch([
    db
      .insert(rq)
      // Columns in schema order: id, artifact, version, required, show status, requested by,
      // created, updated, revision, cancelled, reason, announced, checked.
      .select(
        sql`select ${id}, ${artifact.id}, ${versionId}, ${required.value}, ${showStatus ? 1 : 0}, ${input.userId}, ${input.now}, ${input.now}, 1, null, null, null, ${input.now} where ${stillCurrent(artifact, versionId)} and not exists (select 1 from ${rq} where ${rq.artifactId} = ${artifact.id} and ${rq.cancelledAt} is null)`,
      )
      .onConflictDoNothing()
      .returning({ id: rq.id }),
    ...reviewers.value.map((email) =>
      db
        .insert(rr)
        .select(sql`select ${id}, ${email}, ${input.now}, null where ${created}`)
        .onConflictDoNothing(),
    ),
    // After the insert, on the request it created: the ID is new to this request.
    auditEvent(
      db,
      {
        ownerId: artifact.ownerId,
        kind: "review.requested",
        actor: { type: "user", id: input.userId },
        targetId: id,
        artifactId: artifact.id,
        detail: { reviewers: reviewers.value.length, required: required.value, showStatus },
        now: input.now,
      },
      created,
    ),
  ]);
  if ((results[0] as unknown[]).length === 0) {
    if (await openRequest(db, artifact.id)) {
      return fail("invalid_input", APPROVAL_MESSAGES.alreadyOpen);
    }
    return changed();
  }
  return getApprovalReview(db, { userId: input.userId, artifactId: artifact.id, now: input.now });
}

export interface ApprovalChangeInput {
  userId: string;
  artifactId: string;
  add?: readonly string[] | undefined;
  remove?: readonly string[] | undefined;
  requiredApprovals?: number | null | undefined;
  showStatus?: boolean | undefined;
  now: number;
}

/**
 * Changes the open request: adds or removes reviewers, the required number or whether others see
 * the status. Needs the plan like a request. Removing a reviewer also removes their verdict on
 * the version under review; earlier versions keep theirs as history.
 */
export async function changeApprovalReview(
  db: RegionalDb,
  input: ApprovalChangeInput,
): Promise<Result<ApprovalReviewView>> {
  const managed = await loadManaged(db, input.userId, input.artifactId);
  if (!managed.ok) return managed;
  const artifact = managed.value;
  const gate = await requireOwnerFeature(db.global, artifact, APPROVAL_FEATURE, input.now);
  if (!gate.ok) return gate;
  const owner = gate.value;
  const request = await openRequest(db, artifact.id);
  if (!request) return noRequest();
  const current = (await reviewersOf(db, request.id)).map((row) => row.email);
  const change = checkApprovalChange({
    current,
    required: request.required,
    add: input.add,
    remove: input.remove,
    newRequired: input.requiredApprovals,
  });
  if (!change.ok) return change;
  const { added, removed, required } = change.value;
  const showStatus = input.showStatus ?? request.showStatus;
  if (
    added.length === 0 &&
    removed.length === 0 &&
    required === request.required &&
    showStatus === request.showStatus
  ) {
    // A change that changes nothing records nothing.
    return getApprovalReview(db, { userId: input.userId, artifactId: artifact.id, now: input.now });
  }
  const eligible = await checkCanTakePart(db, artifact, added, owner);
  if (!eligible.ok) return eligible;
  if (added.length > 0) {
    const limited = await limitRequests(db, artifact.ownerId, input.userId, input.now);
    if (!limited.ok) return limited;
  }

  const unchanged = sql`${requestAt(request)} and ${stillOwned(artifact)}`;
  const statements: BatchItem<"sqlite">[] = [
    // Before the change, on the request still being the one read.
    auditEvent(
      db,
      {
        ownerId: artifact.ownerId,
        kind: "review.changed",
        actor: { type: "user", id: input.userId },
        targetId: request.id,
        artifactId: artifact.id,
        detail: {
          ...(added.length > 0 ? { added: added.length } : {}),
          ...(removed.length > 0 ? { removed: removed.length } : {}),
          ...(required !== request.required ? { required } : {}),
          ...(showStatus !== request.showStatus ? { showStatus } : {}),
        },
        now: input.now,
      },
      unchanged,
    ),
  ];
  if (removed.length > 0) {
    statements.push(
      db
        .delete(rv)
        .where(
          and(
            eq(rv.requestId, request.id),
            eq(rv.versionId, request.versionId),
            inArray(rv.email, removed),
            unchanged,
          ),
        ),
      db.delete(rr).where(and(eq(rr.requestId, request.id), inArray(rr.email, removed), unchanged)),
    );
  }
  for (const email of added) {
    statements.push(
      db
        .insert(rr)
        .select(sql`select ${request.id}, ${email}, ${input.now}, null where ${unchanged}`)
        .onConflictDoNothing(),
    );
  }
  const updated = sql`exists (select 1 from ${rq} where ${rq.id} = ${request.id} and ${rq.revision} = ${request.revision + 1})`;
  statements.push(
    db
      .update(rq)
      .set({
        required,
        showStatus,
        updatedAt: input.now,
        revision: sql`${rq.revision} + 1`,
        // The status may move either way; a final status is told again once it is reached.
        announced: null,
      })
      .where(and(eq(rq.id, request.id), unchanged))
      .returning({ id: rq.id }),
    announce(db, request.id, updated),
  );
  const results = await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  if ((results.at(-2) as unknown[]).length === 0) return changed();
  return getApprovalReview(db, { userId: input.userId, artifactId: artifact.id, now: input.now });
}

/**
 * Cancels the open request. Never behind the plan, so an owner whose plan lapsed can always stop
 * one. Verdicts stay with the cancelled request as history.
 */
export async function cancelApprovalReview(
  db: RegionalDb,
  input: { userId: string; artifactId: string; now: number },
): Promise<Result<ApprovalReviewView>> {
  const managed = await loadManaged(db, input.userId, input.artifactId);
  if (!managed.ok) return managed;
  const artifact = managed.value;
  const request = await openRequest(db, artifact.id);
  if (!request) return noRequest();
  const live = and(eq(rq.id, request.id), isNull(rq.cancelledAt), stillOwned(artifact));
  const [, cancelled] = await db.batch([
    auditEvent(
      db,
      {
        ownerId: artifact.ownerId,
        kind: "review.cancelled",
        actor: { type: "user", id: input.userId },
        targetId: request.id,
        artifactId: artifact.id,
        detail: {},
        now: input.now,
      },
      sql`exists (select 1 from ${rq} where ${live})`,
    ),
    db
      .update(rq)
      .set({ cancelledAt: input.now, cancelReason: "cancelled", updatedAt: input.now })
      .where(live)
      .returning({ id: rq.id }),
  ]);
  if (cancelled.length === 0) return noRequest();
  return getApprovalReview(db, input);
}

export interface ApprovalVerdictRequest {
  userId: string;
  artifactId: string;
  verdict: ApprovalVerdict;
  note?: string | undefined;
  /** The version the reviewer was looking at, when the client says. */
  versionId?: string | undefined;
  now: number;
}

/**
 * A requested reviewer's verdict on the version under review, or a change of it while that
 * version is current. Only a signed-in person whose verified address is listed and who can open
 * the artifact now; a service token never gives one. Anyone who cannot open the artifact gets
 * what a missing artifact gives; anyone else who is not listed (or when there is no open
 * request) gets the same `forbidden`, so it tells nothing about a hidden request. Never behind
 * the plan.
 */
export async function submitApprovalVerdict(
  db: RegionalDb,
  input: ApprovalVerdictRequest,
): Promise<Result<ApprovalReviewView>> {
  // A verdict is a person's judgment: a token is nobody here, like in the comments.
  if (isServiceTokenId(input.userId)) return missing();
  const standing = await commentStanding(db, input);
  if (!standing || standing.role === null) return missing();
  if (["draft", "purging", "deleted"].includes(standing.state)) return missing();
  const { artifact } = standing;
  const email = await verifiedEmailOf(db, standing);
  const request = await openRequest(db, artifact.id);
  if (!request || email === null) return notReviewer();
  const [listed] = await db
    .select()
    .from(rr)
    .where(and(eq(rr.requestId, request.id), eq(rr.email, email)))
    .limit(1);
  if (!listed) return notReviewer();
  const target = checkVerdictTarget({
    state: standing.state,
    currentVersionId: artifact.currentVersionId,
    requestVersionId: request.versionId,
    seenVersionId: input.versionId,
  });
  if (!target.ok) return target;
  const versionId = target.value;
  const note = input.note === undefined || input.note === "" ? null : input.note;
  const [previous] = await db
    .select({ verdict: rv.verdict, note: rv.note })
    .from(rv)
    .where(and(eq(rv.requestId, request.id), eq(rv.email, email), eq(rv.versionId, versionId)))
    .limit(1);
  if (previous?.verdict === input.verdict && previous.note === note && listed.droppedAt === null) {
    // Giving the same verdict again changes nothing and records nothing.
    return getApprovalReview(db, input);
  }
  const hits = await hitRateLimit(
    db.global.$client,
    `approvals:verdict:${input.userId}:${artifact.id}`,
    APPROVALS.verdictsPerReviewerPerHour.windowSeconds * 1000,
    input.now,
  );
  if (hits.count > APPROVALS.verdictsPerReviewerPerHour.max) {
    return fail("rate_limited", APPROVAL_MESSAGES.verdictsLimited);
  }

  // The request is still open on this version, the reviewer still listed, and the artifact still
  // has it as current under the owner read: a publish, a cancel, a removal or a transfer in
  // between makes the whole batch a no-op.
  const guard = sql`exists (select 1 from ${rq} where ${rq.id} = ${request.id} and ${rq.cancelledAt} is null and ${rq.versionId} = ${versionId}) and exists (select 1 from ${rr} where ${rr.requestId} = ${request.id} and ${rr.email} = ${email}) and ${stillCurrent(artifact, versionId)}`;
  const differs = sql`not exists (select 1 from ${rv} where ${rv.requestId} = ${request.id} and ${rv.email} = ${email} and ${rv.versionId} = ${versionId} and ${rv.verdict} = ${input.verdict} and ${rv.note} is ${note})`;
  const results = await db.batch([
    auditEvent(
      db,
      {
        ownerId: artifact.ownerId,
        kind: "review.verdict",
        actor: { type: "user", id: input.userId },
        targetId: request.id,
        artifactId: artifact.id,
        detail: { verdict: input.verdict, version: 1 },
        computed: {
          version: sql`(select ${schema.versions.number} from ${schema.versions} where ${schema.versions.id} = ${versionId})`,
        },
        now: input.now,
      },
      sql`${guard} and (${differs} or exists (select 1 from ${rr} where ${rr.requestId} = ${request.id} and ${rr.email} = ${email} and ${rr.droppedAt} is not null))`,
    ),
    db
      .insert(rv)
      // Columns in schema order: request, email, version, author, verdict, note, bytes, created, updated.
      .select(
        sql`select ${request.id}, ${email}, ${versionId}, ${input.userId}, ${input.verdict}, ${note}, ${note === null ? 0 : utf8Length(note)}, ${input.now}, ${input.now} where ${guard}`,
      )
      .onConflictDoUpdate({
        target: [rv.requestId, rv.email, rv.versionId],
        set: {
          authorId: input.userId,
          verdict: input.verdict,
          note,
          noteBytes: note === null ? 0 : utf8Length(note),
          updatedAt: input.now,
        },
      })
      .returning({ email: rv.email }),
    // They can open it now, so they count again if the scan had dropped them.
    db
      .update(rr)
      .set({ droppedAt: null })
      .where(and(eq(rr.requestId, request.id), eq(rr.email, email), guard)),
    db
      .update(rq)
      .set({ revision: sql`${rq.revision} + 1`, updatedAt: input.now })
      .where(and(eq(rq.id, request.id), guard)),
    announce(db, request.id, guard),
  ]);
  if ((results[1] as unknown[]).length === 0) {
    const now = await openRequest(db, artifact.id);
    const [fresh] = await db.select().from(a).where(eq(a.id, artifact.id)).limit(1);
    if (!now || now.id !== request.id) return notReviewer();
    if (now.versionId !== versionId || fresh?.currentVersionId !== versionId) {
      return fail("version_conflict", APPROVAL_MESSAGES.notCurrent);
    }
    return changed();
  }
  return getApprovalReview(db, input);
}

interface ReviewerIdentity {
  id: string;
  name: string;
}

/** The accounts whose verified address is one of `emails`, by address. */
async function identities(db: RegionalDb, emails: readonly string[]) {
  const found = new Map<string, ReviewerIdentity>();
  if (emails.length === 0) return found;
  const rows = await db.global
    .select({
      id: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
      verified: schema.users.emailVerified,
    })
    .from(schema.users)
    .where(inArray(schema.users.email, [...emails]));
  for (const row of rows) {
    if (row.verified) found.set(row.email, { id: row.id, name: row.name });
  }
  return found;
}

async function nameOf(db: RegionalDb, userId: string | null): Promise<string | null> {
  if (userId === null || isServiceTokenId(userId)) return null;
  const [row] = await db.global
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return row?.name ?? null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** An opaque, stable ID for a reviewer of one request, so the address never leaves the owner side. */
async function reviewerKey(requestId: string, email: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${requestId}\n${email}`),
  );
  return `rvw_${[...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The review as the caller may see it. The owner side (and a service token that may manage it)
 * sees everything; a reviewer sees the request and the verdicts within their comment scope, and
 * always their own; anyone else who can open the artifact sees the overall status only when the
 * request shows it, and otherwise exactly what an artifact without a request gives. Anyone who
 * cannot open the artifact gets what a missing one gives. Never behind the plan.
 */
export async function getApprovalReview(
  db: RegionalDb,
  input: { userId: string; artifactId: string; now: number },
): Promise<Result<ApprovalReviewView>> {
  let artifact: ArtifactRow;
  let role: "owner" | "participant" | null;
  let viewerEmail: string | null = null;
  let scope: "all" | "own" = "all";
  let ownerSide: readonly string[] = [];
  let owner: Entitlements;
  if (isServiceTokenId(input.userId)) {
    const managed = await loadManaged(db, input.userId, input.artifactId);
    if (!managed.ok) return managed.code === "forbidden" ? missing() : managed;
    artifact = managed.value;
    role = "owner";
    owner = await ownerEntitlements(db.global, artifact.ownerId, input.now);
  } else {
    const standing = await commentStanding(db, input);
    if (!standing || standing.role === null) return missing();
    if (["draft", "purging", "deleted"].includes(standing.state)) return missing();
    artifact = standing.artifact;
    role = standing.role;
    viewerEmail = await verifiedEmailOf(db, standing);
    scope = standing.scope;
    ownerSide = standing.ownerSide;
    owner = standing.entitlements;
  }
  const available = hasFeature(owner, APPROVAL_FEATURE);
  const request = await openRequest(db, artifact.id);
  const reviewers = request ? await reviewersOf(db, request.id) : [];
  const listed = viewerEmail !== null && reviewers.some((row) => row.email === viewerEmail);
  const viewerRole = approvalViewerRole({ role, listed }) ?? "reader";
  const base = { artifactId: artifact.id, role: viewerRole, available };
  if (!request) return ok({ ...base, review: approvalSummary(null, []), request: null });

  const verdicts = await db
    .select()
    .from(rv)
    .where(and(eq(rv.requestId, request.id), eq(rv.versionId, request.versionId)));
  const verdictOf = new Map(verdicts.map((row) => [row.email, row]));
  const facts: ApprovalReviewerFacts[] = reviewers.map((row) => ({
    active: row.droppedAt === null,
    verdict: verdictOf.get(row.email)?.verdict ?? null,
  }));
  const review: ApprovalSummary = approvalSummary({ required: request.required }, facts);
  if (viewerRole === "reader") {
    return ok(
      approvalStatusVisible("reader", request.showStatus)
        ? { ...base, review, request: null }
        : { ...base, review: approvalSummary(null, []), request: null },
    );
  }

  const people = await identities(
    db,
    reviewers.map((row) => row.email),
  );
  const entries: ApprovalReviewerView[] = [];
  for (const row of reviewers) {
    const person = people.get(row.email) ?? null;
    const visible = approvalEntryVisible({
      role: viewerRole,
      scope,
      viewerId: input.userId,
      ownerSide,
      reviewerId: person?.id ?? null,
    });
    const you = row.email === viewerEmail;
    if (!visible && !you) continue;
    const verdict = verdictOf.get(row.email);
    entries.push({
      id: await reviewerKey(request.id, row.email),
      name: person?.name ?? null,
      email: viewerRole === "owner" ? row.email : null,
      active: row.droppedAt === null,
      you,
      verdict: verdict?.verdict ?? null,
      note: verdict?.note ?? null,
      decidedAt: verdict ? iso(verdict.updatedAt) : null,
    });
  }

  let history: ApprovalHistoryEntry[] = [];
  if (viewerRole === "owner") {
    const earlier = await db
      .select()
      .from(rv)
      .innerJoin(rq, eq(rq.id, rv.requestId))
      .where(and(eq(rq.artifactId, artifact.id), sql`${rv.versionId} <> ${request.versionId}`))
      .orderBy(desc(rv.updatedAt))
      .limit(APPROVALS.historyListed);
    const names = await identities(db, [
      ...new Set(earlier.map((row) => row.review_verdicts.email)),
    ]);
    history = await Promise.all(
      earlier.map(async ({ review_verdicts: row }) => ({
        reviewer: await reviewerKey(row.requestId, row.email),
        name: names.get(row.email)?.name ?? null,
        versionId: row.versionId,
        verdict: row.verdict,
        note: row.note,
        decidedAt: iso(row.updatedAt),
      })),
    );
  }

  return ok({
    ...base,
    review,
    request: {
      id: request.id,
      versionId: request.versionId,
      requiredApprovals: request.required,
      showStatus: request.showStatus,
      requestedAt: iso(request.createdAt),
      updatedAt: iso(request.updatedAt),
      requestedBy: await nameOf(db, request.requestedBy),
      reviewers: entries,
      history,
    },
  });
}

// Statements other use cases add to their own batches.

/**
 * Publish and rollback: the open request follows the new version with no verdicts, in the batch
 * of the switch and on its condition. Verdicts given on the old version stay as its history.
 */
export function moveApprovalReview(
  db: Db,
  input: { artifactId: string; versionId: string; switched: SQL; now: number },
): BatchItem<"sqlite"> {
  return db
    .update(rq)
    .set({
      versionId: input.versionId,
      updatedAt: input.now,
      revision: sql`${rq.revision} + 1`,
      announced: null,
    })
    .where(and(eq(rq.artifactId, input.artifactId), isNull(rq.cancelledAt), input.switched));
}

/**
 * A transfer cancels the open request in its batch, on its condition: the reviewers were chosen
 * under the old owner. The transfer's own audit events record the move.
 */
export function cancelApprovalReviewOnTransfer(
  db: Db,
  input: { artifactId: string; condition: SQL; now: number },
): BatchItem<"sqlite"> {
  return db
    .update(rq)
    .set({ cancelledAt: input.now, cancelReason: "transferred", updatedAt: input.now })
    .where(and(eq(rq.artifactId, input.artifactId), isNull(rq.cancelledAt), input.condition));
}

/**
 * Account deletion: the account's verdicts go (the status is derived, so its counts follow) and
 * the requests it made keep no trace of it. Its address stays on requests that name it, as the
 * owner's own list, like the reader list.
 */
export function eraseApprovalAuthor(db: Db, userId: string): BatchItem<"sqlite">[] {
  return [
    db.delete(rv).where(eq(rv.authorId, userId)),
    db.update(rq).set({ requestedBy: null }).where(eq(rq.requestedBy, userId)),
  ];
}

/**
 * Maintenance: re-checks who can still open the artifact for the open requests checked longest
 * ago, dropping reviewers who cannot (they stop counting) and counting again those who can.
 * Idempotent; a request whose artifact is not active is only marked checked.
 */
export async function recheckApprovalReviewers(
  db: RegionalDb,
  now: number,
  limit: number = APPROVALS.recheckPerRun,
): Promise<{ checked: number; dropped: number }> {
  const due = await db
    .select({ request: rq, artifact: a })
    .from(rq)
    .innerJoin(a, eq(a.id, rq.artifactId))
    .where(isNull(rq.cancelledAt))
    .orderBy(rq.checkedAt)
    .limit(limit);
  let dropped = 0;
  for (const { request, artifact } of due) {
    const owner = await ownerEntitlements(db.global, artifact.ownerId, now);
    const reviewers = await reviewersOf(db, request.id);
    const statements: BatchItem<"sqlite">[] = [];
    if (stateOf(artifact, now) === "active") {
      for (const row of reviewers) {
        const { takesPart } = await addressTakesPart(db, artifact, row.email, owner);
        if (takesPart === (row.droppedAt === null)) continue;
        if (!takesPart) dropped += 1;
        statements.push(
          db
            .update(rr)
            .set({ droppedAt: takesPart ? null : now })
            .where(
              and(
                eq(rr.requestId, request.id),
                eq(rr.email, row.email),
                takesPart ? sql`${rr.droppedAt} is not null` : isNull(rr.droppedAt),
              ),
            ),
        );
      }
    }
    const open = sql`exists (select 1 from ${rq} where ${rq.id} = ${request.id} and ${rq.cancelledAt} is null)`;
    statements.push(
      db.update(rq).set({ checkedAt: now }).where(eq(rq.id, request.id)),
      announce(db, request.id, open),
    );
    await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  }
  return { checked: due.length, dropped };
}

/**
 * The open request of the artifact whose ID `artifactId` names, as one JSON value for a list
 * or lookup query (null without one): its required number and each reviewer's standing and
 * verdict on the version under review. `approvalSummaryOf` turns it into the block.
 */
export function approvalReviewColumn(artifactId: SQL): SQL<string | null> {
  const q = sql.identifier("approval_rq");
  const r = sql.identifier("approval_rr");
  const v = sql.identifier("approval_rv");
  return sql<
    string | null
  >`(select json_object('required', ${q}."required", 'reviewers', json_group_array(json_object('active', ${r}."dropped_at" is null, 'verdict', (select ${v}."verdict" from "review_verdicts" as ${v} where ${v}."request_id" = ${q}."id" and ${v}."email" = ${r}."email" and ${v}."version_id" = ${q}."version_id")))) from "review_requests" as ${q} join "review_reviewers" as ${r} on ${r}."request_id" = ${q}."id" where ${q}."artifact_id" = ${artifactId} and ${q}."cancelled_at" is null group by ${q}."id")`;
}

/** The block of the artifact list and view, from `approvalReviewColumn`'s value. */
export function approvalSummaryOf(value: string | null): ApprovalSummary {
  if (value === null) return approvalSummary(null, []);
  const parsed = JSON.parse(value) as {
    required: number | null;
    reviewers: { active: number | boolean; verdict: ApprovalVerdict | null }[];
  };
  return approvalSummary(
    { required: parsed.required },
    parsed.reviewers.map((reviewer) => ({
      active: Boolean(reviewer.active),
      verdict: reviewer.verdict,
    })),
  );
}
