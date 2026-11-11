// Annotations (plan section 8): threads and messages on an artifact's versions, moderation, the
// annotations mode, incremental refresh and export. Every operation loads the artifact, decides
// with the rules in `@portifact/domain`, and then writes in one batch whose first statement
// claims the change by inserting an `annotation_events` row under the same conditions, checked
// against the live data: artifact state and mode, current version, access policy generation,
// rate limits and the row's previous state. Every other write of the batch runs only if that
// event (found by its per-request `write_id`) exists. If the claim does not happen the checks
// run again to explain why, falling back to `version_conflict`. Owner quotas are also CHECK
// constraints kept by triggers (`0007_annotation_usage_triggers.sql`).
//
// Threads point at one version and never move. Visitors see only the current version's
// threads, so a new version or a rollback needs no hook here: what is current follows
// `artifacts.current_version_id`.
//
// Who sees which threads (`commentScope` in the domain): every read path (list, get by ID,
// export, refresh cursors and `removed`) and every write that names a thread or message filters
// by the caller's scope, so a thread outside it answers exactly like a missing one. Writes on
// someone else's thread re-check the scope inside the batch, so narrowing the visibility wins
// over a reply in flight.
//
// Bodies are untrusted plain text and are never logged.
import {
  ANNOTATION_LIMITS,
  type AnnotationDeleteResult,
  type AnnotationEditResult,
  type AnnotationExport,
  type AnnotationPage,
  type AnnotationsState,
  type AnnotationTarget,
  type AnnotationThreadState,
  type AnnotationThreadView,
  type AnnotationVersionFilter,
  type ArtifactState,
  type CommentScope,
  DEFAULT_REGION,
  isServiceTokenId,
  isWorkspaceId,
  UNTRUSTED_ANNOTATIONS_NOTICE,
  utf8Length,
} from "@portifact/contracts";
import { bothSides, type Db, type RegionalDb, schema } from "@portifact/db";
import {
  type Actor,
  type AnnotationAction,
  type AnnotationRole,
  type AnnotationUsageSnapshot,
  type AnnotationWrite,
  actsForOwner,
  canRead,
  checkAnnotationAction,
  checkAnnotationCapacity,
  checkAnnotationModeChange,
  checkAnnotationWrite,
  checkDeleteOwnMessage,
  checkEditMessage,
  checkHumanVerdict,
  checkResolve,
  checkThreadWritable,
  commentScope,
  type Entitlements,
  effectiveState,
  emailDomainOf,
  entitlements,
  fail,
  type GroupMatch,
  type HumanVerdict,
  type ModerationAction,
  moderationTransition,
  needsHumanCheck,
  ok,
  type Result,
  requireFeature,
  threadInScope,
  threadVisible,
} from "@portifact/domain";
import { and, asc, eq, gt, inArray, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { actorAndPlanOn, actorOn, ownerSide } from "./actors.ts";
import { platformProtection } from "./budget.ts";
import { markCommentActivity } from "./comment-activity.ts";
import { ownerPlanRecord } from "./plans.ts";
import { type ThreadViewContext, threadViews } from "./thread-views.ts";
import { markWebhookEvent } from "./webhook-activity.ts";
import { policyDomains } from "./workspace-domains.ts";
import {
  artifactGroupRows,
  groupMembershipsOf,
  groupScopeSql,
  viewerGroups,
} from "./workspace-groups.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** D1 binds at most 100 parameters per statement. */
const IN_CHUNK = 90;
const MODES: readonly AnnotationsState[] = ["open", "locked", "off"];
/** Events that write a body and count toward the rate limits. */
const WRITE_KINDS = sql.raw("('thread_created', 'message_created', 'message_edited')");

type ArtifactRow = typeof schema.artifacts.$inferSelect;
type ThreadRow = typeof schema.annotationThreads.$inferSelect;
type EventKind = (typeof schema.annotationEvents.$inferInsert)["kind"];

interface Loaded {
  artifact: ArtifactRow;
  role: AnnotationRole | null;
  state: ArtifactState;
  /** The caller's ID, their verified address (or null) and which threads they see. */
  viewerId: string;
  verifiedEmail: string | null;
  scope: CommentScope;
  /** Groups the artifact lists that the caller belongs to and that grant (decision 0014). */
  groupIds: readonly string[];
  /**
   * Who acts for the artifact's owner: the user of a personal space, or a workspace's admins and
   * editors. Their threads are "the owner's" in the `own` scope.
   */
  ownerSide: readonly string[];
  /**
   * What the owner's plan grants, read with the artifact: the annotation quota and whether a
   * write marks comment notice activity, with no read of its own.
   */
  entitlements: Entitlements;
}

interface Authorized extends Loaded {
  role: AnnotationRole;
}

export interface AnnotationActor {
  userId: string;
  artifactId: string;
  now: number;
}

/**
 * The human check a new comment may need (plan section 13), built by the adapter from the
 * request: the Turnstile token the client sent, if any, and a verifier bound to the provider and
 * the caller's IP. API, dashboard and MCP all pass one, so they decide identically; clients that
 * cannot show the challenge simply send no token.
 */
export interface HumanCheck {
  token: string | undefined;
  verify(token: string): Promise<HumanVerdict>;
}

export interface AnnotationListInput extends AnnotationActor {
  cursor?: string | undefined;
  limit: number;
  version: AnnotationVersionFilter;
  state?: AnnotationThreadState | undefined;
}

const missingArtifact = () => fail<never>("not_found", "Artifact not found.");
const missingThread = () => fail<never>("not_found", "Thread not found.");
const missingMessage = () => fail<never>("not_found", "Message not found.");
const changed = () =>
  fail<never>("version_conflict", "The annotations changed meanwhile. Reload and try again.");

// Loading and authorization

/**
 * The artifact with its owner's plan, and the caller's actor on the owner. Plans are global and
 * artifacts regional (decision 0005). With one database the plan comes with the artifact, as it
 * always did; with a separate global database it comes in the membership's own batch
 * (`actorAndPlanOn`), so a workspace's paths gain no call, and only a personal space whose
 * region is not the global database (no deployment has one) pays one read for it.
 */
async function loadWithPlan(db: RegionalDb, userId: string, artifactId: string) {
  const both = bothSides(db);
  if (both) {
    const p = schema.ownerPlans;
    const [row] = await both
      .select({
        artifact: schema.artifacts,
        plan: {
          plan: p.plan,
          seats: p.seats,
          validUntil: p.validUntil,
          overrides: p.overrides,
          grace: p.grace,
        },
      })
      .from(schema.artifacts)
      .leftJoin(p, eq(p.ownerId, schema.artifacts.ownerId))
      .where(eq(schema.artifacts.id, artifactId))
      .limit(1);
    if (!row) return undefined;
    const actor = isServiceTokenId(userId)
      ? ok(null)
      : await actorOn(db.global, userId, row.artifact.ownerId);
    // A request policy refuses the person on the workspace (decision 0020): nothing here.
    if (!actor.ok) return actor;
    return { artifact: row.artifact, plan: row.plan, actor: actor.value };
  }
  const [artifact] = await db
    .select()
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, artifactId))
    .limit(1);
  if (!artifact) return undefined;
  const found = isServiceTokenId(userId)
    ? ok({ actor: null, plan: await ownerPlanRecord(db.global, artifact.ownerId) })
    : await actorAndPlanOn(db.global, userId, artifact.ownerId);
  if (!found.ok) return found;
  return { artifact, plan: found.value.plan, actor: found.value.actor };
}

/** What `load` answers: the loaded artifact, nothing (missing), or a request policy's refusal. */
type LoadOutcome = Loaded | undefined | Extract<Result<never>, { ok: false }>;

async function load(db: RegionalDb, input: AnnotationActor): Promise<LoadOutcome> {
  const loaded = await loadWithPlan(db, input.userId, input.artifactId);
  if (!loaded) return undefined;
  if ("ok" in loaded) return loaded;
  const { artifact, actor, plan } = loaded;
  const state = effectiveState(
    {
      state: artifact.state,
      expiresAt: artifact.expiresAt === null ? null : new Date(artifact.expiresAt),
      archivedAt: artifact.archivedAt === null ? null : new Date(artifact.archivedAt),
    },
    new Date(input.now),
  );
  const owner = entitlements(plan, input.now);
  const { role, verifiedEmail, exception, groups } = await roleOf(
    db,
    artifact,
    input.userId,
    actor,
    owner,
  );
  const scope = commentScope(
    role ?? "participant",
    artifact.commentVisibility,
    exception,
    groups.map((group) => group.commentVisibility),
  );
  return {
    artifact,
    state,
    role,
    viewerId: input.userId,
    verifiedEmail,
    scope,
    groupIds: groups.map((group) => group.id),
    // A personal space needs no read.
    ownerSide: await ownerSide(db.global, artifact.ownerId),
    entitlements: owner,
  };
}

interface Caller {
  role: AnnotationRole | null;
  verifiedEmail: string | null;
  /** The reader's exception on the list, matched by verified address in any access mode. */
  exception: CommentScope | null;
  /** Listed groups the caller belongs to, with their exceptions, in any access mode. */
  groups: GroupMatch["matched"];
}

/**
 * The owner (an admin or editor of the artifact's owner), a reader admitted by the access
 * policy, or nobody. Members of a workspace are readers like anyone else unless the policy
 * admits them; members and domain readers of a `workspace` or `domain` artifact are participants
 * whose scope follows the artifact's comment visibility and their exception (decision 0010).
 */
async function roleOf(
  db: RegionalDb,
  artifact: ArtifactRow,
  userId: string,
  /** The caller's actor on the artifact's owner (`actorAndPlanOn`), or null for none. */
  actor: Actor | null,
  owner: Entitlements,
): Promise<Caller> {
  // Comments are people's words: a service token takes no part, whatever its role (decision
  // 0011), and gets what a missing artifact gives.
  if (isServiceTokenId(userId))
    return { role: null, verifiedEmail: null, exception: null, groups: [] };
  if (actsForOwner(actor, artifact.ownerId)) {
    return { role: "owner", verifiedEmail: null, exception: null, groups: [] };
  }
  const [user] = await db.global
    .select({ email: schema.users.email, emailVerified: schema.users.emailVerified })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!user) return { role: null, verifiedEmail: null, exception: null, groups: [] };
  const verifiedEmail = user.emailVerified ? user.email.toLowerCase() : null;
  const r = schema.artifactReaders;
  const columns = { email: r.email, commentVisibility: r.commentVisibility };
  // A restricted artifact needs the whole list to decide access; otherwise only the caller's row
  // matters, for their exception.
  const listed =
    artifact.accessMode === "restricted"
      ? await db.select(columns).from(r).where(eq(r.artifactId, artifact.id))
      : verifiedEmail === null
        ? []
        : await db
            .select(columns)
            .from(r)
            .where(and(eq(r.artifactId, artifact.id), eq(r.email, verifiedEmail)));
  const verifiedEmails = verifiedEmail === null ? [] : [verifiedEmail];
  // A member of the owning workspace may be in groups the artifact lists: they can admit them in
  // `restricted` mode and carry exceptions in every mode (decision 0014). Nobody else reads them.
  const groups =
    actor?.ownerId === artifact.ownerId
      ? await viewerGroups(db.global, {
          ownerId: artifact.ownerId,
          actor,
          listed: await artifactGroupRows(db, artifact.id),
          entitlements: owner,
        })
      : undefined;
  const decision = canRead(
    {
      mode: artifact.accessMode,
      ownerId: artifact.ownerId,
      readers: artifact.accessMode === "restricted" ? listed.map((row) => row.email) : [],
      domains: await policyDomains(db.global, {
        mode: artifact.accessMode,
        ownerId: artifact.ownerId,
        actor,
        verifiedEmails,
        entitlements: owner,
      }),
      groups,
    },
    { userId, verifiedEmails },
    actor,
  );
  const exception =
    verifiedEmail === null
      ? null
      : (listed.find((row) => row.email === verifiedEmail)?.commentVisibility ?? null);
  return {
    role: decision.ok ? "participant" : null,
    verifiedEmail,
    exception,
    groups: groups?.matched ?? [],
  };
}

/** Whether the caller sees a thread started by `authorId`. */
function inScope(loaded: Loaded, authorId: string): boolean {
  return threadInScope(loaded.scope, loaded.viewerId, loaded.ownerSide, authorId);
}

/** The threads of the caller's scope, as a filter on `annotation_threads`. */
function scopeFilter(loaded: Loaded): SQL | undefined {
  if (loaded.scope === "all") return undefined;
  return inArray(schema.annotationThreads.authorId, [loaded.viewerId, ...loaded.ownerSide]);
}

async function authorize(
  db: RegionalDb,
  input: AnnotationActor,
  action: AnnotationAction,
): Promise<Result<Authorized>> {
  const loaded = await load(db, input);
  if (!loaded) return missingArtifact();
  if ("ok" in loaded) return loaded;
  const decision = checkAnnotationAction(
    { role: loaded.role, state: loaded.state, mode: loaded.artifact.annotations },
    action,
  );
  if (!decision.ok) return decision;
  return ok(loaded as Authorized);
}

async function findThread(db: RegionalDb, loaded: Authorized, threadId: string) {
  const [thread] = await db
    .select()
    .from(schema.annotationThreads)
    .where(
      and(
        eq(schema.annotationThreads.id, threadId),
        eq(schema.annotationThreads.artifactId, loaded.artifact.id),
      ),
    )
    .limit(1);
  // Another artifact's thread, an older version's thread for a visitor, or a thread outside the
  // caller's comment scope, looks missing.
  if (
    !thread ||
    !threadVisible(loaded.role, thread.versionId, loaded.artifact.currentVersionId) ||
    !inScope(loaded, thread.authorId)
  ) {
    return undefined;
  }
  return thread;
}

async function findMessage(db: RegionalDb, loaded: Authorized, messageId: string) {
  const [message] = await db
    .select()
    .from(schema.annotationMessages)
    .where(
      and(
        eq(schema.annotationMessages.id, messageId),
        eq(schema.annotationMessages.artifactId, loaded.artifact.id),
      ),
    )
    .limit(1);
  if (!message) return undefined;
  const thread = await findThread(db, loaded, message.threadId);
  return thread ? { message, thread } : undefined;
}

/**
 * One's own message, whatever the scope of its thread: an author can always edit and delete
 * their words (plan section 8), also in a thread they no longer see. Anyone else's message
 * needs its thread in scope, so the answer for it stays that of a missing one.
 */
async function findOwnMessage(db: RegionalDb, loaded: Authorized, messageId: string) {
  const [message] = await db
    .select()
    .from(schema.annotationMessages)
    .where(
      and(
        eq(schema.annotationMessages.id, messageId),
        eq(schema.annotationMessages.artifactId, loaded.artifact.id),
      ),
    )
    .limit(1);
  if (!message) return undefined;
  if (message.authorId !== loaded.viewerId) return findMessage(db, loaded, messageId);
  const [thread] = await db
    .select()
    .from(schema.annotationThreads)
    .where(eq(schema.annotationThreads.id, message.threadId))
    .limit(1);
  if (!thread || !threadVisible(loaded.role, thread.versionId, loaded.artifact.currentVersionId)) {
    return undefined;
  }
  return { message, thread };
}

/**
 * The thread after a change to one's own message, or `null` when the caller does not see it (any
 * more). The caller is loaded again, so a visibility change that landed meanwhile counts.
 */
async function threadIfVisible(
  db: RegionalDb,
  input: AnnotationActor,
  threadId: string,
): Promise<Result<AnnotationDeleteResult>> {
  const authorized = await authorize(db, input, "read");
  const loaded = authorized.ok ? authorized.value : undefined;
  const thread = loaded ? await findThread(db, loaded, threadId) : undefined;
  if (!loaded || !thread) return ok({ threadId, thread: null });
  const [view] = await threadViews(db, viewContext(loaded), loaded.viewerId, [thread]);
  return ok({ threadId, thread: view as AnnotationThreadView });
}

// Guards evaluated inside the write batch

/** Modes in which the caller's role may perform `action`, from the domain rules. */
function allowedModes(role: AnnotationRole, action: AnnotationAction): AnnotationsState[] {
  return MODES.filter((mode) => checkAnnotationAction({ role, state: "active", mode }, action).ok);
}

/**
 * The artifact is still active and unexpired, in a mode that allows `action` for the role and,
 * for visitors, under the same access policy generation, so a revocation in between wins.
 */
function artifactGuard(loaded: Authorized, action: AnnotationAction, now: number): SQL {
  const t = schema.artifacts;
  const a = loaded.artifact;
  // The same owner too: a transfer in between means the role was decided on another owner.
  return sql`exists (select 1 from ${t} where ${t.id} = ${a.id} and ${t.ownerId} = ${a.ownerId} and ${t.state} = 'active' and (${t.expiresAt} is null or ${t.expiresAt} > ${now}) and ${inArray(t.annotations, allowedModes(loaded.role, action))}${
    loaded.role === "participant" ? sql` and ${t.policyGeneration} = ${a.policyGeneration}` : sql``
  })`;
}

/** The thread still belongs to the artifact's current version. */
function currentThreadGuard(threadId: string): SQL {
  const th = schema.annotationThreads;
  const t = schema.artifacts;
  return sql`exists (select 1 from ${th} join ${t} on ${t.id} = ${th.artifactId} where ${th.id} = ${threadId} and ${th.versionId} = ${t.currentVersionId})`;
}

/**
 * For a reader, the thread is still within their comment scope: they or the owner started it,
 * or their exception on the list (by verified address), else the widest scope of the listed
 * groups they belong to, else the artifact's setting, shows them every thread. The same rule as
 * `commentScope`, evaluated on the live rows (the groups the caller belongs to were read from the
 * global database when the request loaded; the artifact's group rows are live).
 */
function scopeGuard(loaded: Authorized, threadId: string): SQL {
  if (loaded.role === "owner") return sql`1`;
  const th = schema.annotationThreads;
  const t = schema.artifacts;
  const r = schema.artifactReaders;
  const setting = sql`case ${t.commentVisibility} when 'everyone' then 'all' else 'own' end`;
  const reader =
    loaded.verifiedEmail === null
      ? sql`null`
      : sql`(select ${r.commentVisibility} from ${r} where ${r.artifactId} = ${t.id} and ${r.email} = ${loaded.verifiedEmail})`;
  const scope = sql`coalesce(${reader}, ${groupScopeSql(t.id, loaded.groupIds, setting)}, ${setting})`;
  const owners = sql.join(
    [loaded.viewerId, ...loaded.ownerSide].map((id) => sql`${id}`),
    sql`, `,
  );
  return sql`exists (select 1 from ${th} join ${t} on ${t.id} = ${th.artifactId} where ${th.id} = ${threadId} and (${th.authorId} in (${owners}) or ${scope} = 'all'))`;
}

/** The author and the artifact are under their write limits. */
function rateGuard(actorId: string, artifactId: string, now: number): SQL {
  const e = schema.annotationEvents;
  return sql`(select count(*) from ${e} where ${e.actorId} = ${actorId} and ${e.kind} in ${WRITE_KINDS} and ${e.at} > ${now - MINUTE_MS}) < ${ANNOTATION_LIMITS.writesPerMinute}
    and (select count(*) from ${e} where ${e.actorId} = ${actorId} and ${e.kind} in ${WRITE_KINDS} and ${e.at} > ${now - DAY_MS}) < ${ANNOTATION_LIMITS.writesPer24h}
    and (select count(*) from ${e} where ${e.artifactId} = ${artifactId} and ${e.kind} in ${WRITE_KINDS} and ${e.at} > ${now - DAY_MS}) < ${ANNOTATION_LIMITS.artifactWritesPer24h}`;
}

function claimed(writeId: string): SQL {
  const e = schema.annotationEvents;
  return sql`exists (select 1 from ${e} where ${e.writeId} = ${writeId})`;
}

function claimedEventId(writeId: string): SQL {
  const e = schema.annotationEvents;
  return sql`(select ${e.id} from ${e} where ${e.writeId} = ${writeId})`;
}

interface Claim {
  artifactId: string;
  threadId: string;
  messageId: string | null;
  actorId: string;
  kind: EventKind;
  now: number;
}

/** Inserts the event that claims a change, only when `guard` holds. Returns its ID if it did. */
function claim(db: RegionalDb, writeId: string, event: Claim, guard: SQL) {
  // Drizzle lists every column in schema order for an insert from raw SQL; `null` is the ID.
  return db
    .insert(schema.annotationEvents)
    .select(
      sql`select null, ${event.artifactId}, ${event.threadId}, ${event.messageId}, ${event.actorId}, ${writeId}, ${event.kind}, ${event.now} where ${guard}`,
    )
    .returning({ id: schema.annotationEvents.id });
}

/** Bumps the thread's revision and points its refresh cursor at the claiming event. */
function touchThread(db: RegionalDb, threadId: string, writeId: string, now: number, extra = {}) {
  const th = schema.annotationThreads;
  return db
    .update(th)
    .set({
      ...extra,
      revision: sql`${th.revision} + 1`,
      changeSeq: claimedEventId(writeId),
      updatedAt: now,
    })
    .where(and(eq(th.id, threadId), claimed(writeId)));
}

type Batch = [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];

/**
 * The comment notice mark and the webhook events of a claimed write, each only when the owner's
 * plan has the feature.
 */
function noticeMark(
  db: RegionalDb,
  loaded: Loaded,
  writeId: string,
  mark: {
    threadId: string;
    actorId: string;
    activity: "thread" | "reply" | "resolved";
    now: number;
  },
): BatchItem<"sqlite">[] {
  const statement = markCommentActivity(db, {
    ...mark,
    entitlements: loaded.entitlements,
    artifactId: loaded.artifact.id,
    ownerSide: loaded.ownerSide,
    claimed: claimed(writeId),
  });
  // The owner's webhooks (decision 0009): a comment or reply is `comment.created`, a resolution
  // `thread.resolved`; the actor is named only when they act for the owner.
  const hooks = markWebhookEvent(db, {
    entitlements: loaded.entitlements,
    ownerId: loaded.artifact.ownerId,
    artifactId: loaded.artifact.id,
    type: mark.activity === "resolved" ? "thread.resolved" : "comment.created",
    actorId: loaded.ownerSide.includes(mark.actorId) ? mark.actorId : null,
    now: mark.now,
    condition: claimed(writeId),
  });
  return [...(statement ? [statement] : []), ...hooks];
}

/**
 * Runs a claimed batch. Returns whether the claim happened; a CHECK constraint failure (the
 * owner's quota or a full thread, after a race) becomes `quota_exceeded`.
 */
async function runClaimed(db: RegionalDb, statements: Batch): Promise<Result<boolean>> {
  try {
    const [first] = (await db.batch(statements)) as [{ id: number }[]];
    return ok(first.length === 1);
  } catch (error) {
    if (causeMatches(error, /CHECK constraint failed: annotation_threads_counters/)) {
      return fail(
        "quota_exceeded",
        `A thread can hold at most ${ANNOTATION_LIMITS.messagesPerThread} messages.`,
      );
    }
    if (causeMatches(error, /CHECK constraint failed: annotation_usage/)) {
      return fail("quota_exceeded", "The owner of this artifact has no room for more comments.");
    }
    throw error;
  }
}

function causeMatches(error: unknown, pattern: RegExp): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (pattern.test(e.message)) return true;
  }
  return false;
}

/** Runs `precheck`, writes, and on a lost claim runs `precheck` again to explain why. */
/**
 * Comments by the author on artifacts they do not own, counted up to the number that still
 * needs a human check. Events go with their artifact, so deleting one may ask again.
 */
async function commentsOnOthersArtifacts(db: RegionalDb, userId: string): Promise<number> {
  const e = schema.annotationEvents;
  const t = schema.artifacts;
  const [row] = await db.all<{ count: number }>(
    sql`select count(*) as count from (select 1 from ${e} join ${t} on ${t.id} = ${e.artifactId} where ${e.actorId} = ${userId} and ${e.kind} in ('thread_created', 'message_created') and ${t.ownerId} <> ${userId} limit ${ANNOTATION_LIMITS.humanCheckedComments})`,
  );
  return Number(row?.count ?? 0);
}

/**
 * Decides the human check of one comment. The token is single use at the provider and a
 * write that loses its claim runs its checks again, so the verdict is fetched at most once.
 */
function humanGate(db: RegionalDb, userId: string, check: HumanCheck) {
  let verdict: Promise<HumanVerdict> | undefined;
  return async (loaded: Authorized): Promise<Result<true>> => {
    if (!needsHumanCheck(loaded.role, await commentsOnOthersArtifacts(db, userId))) {
      return ok(true);
    }
    if (check.token === undefined) return checkHumanVerdict("missing");
    const token = check.token;
    verdict ??= check.verify(token).catch((): HumanVerdict => "unavailable");
    return checkHumanVerdict(await verdict);
  };
}

async function guardedWrite<T, P>(
  precheck: () => Promise<Result<P>>,
  write: (prepared: P) => Promise<Result<boolean>>,
  after: (prepared: P) => Promise<Result<T>>,
): Promise<Result<T>> {
  const prepared = await precheck();
  if (!prepared.ok) return prepared;
  const written = await write(prepared.value);
  if (!written.ok) return written;
  if (!written.value) {
    const again = await precheck();
    return again.ok ? changed() : again;
  }
  return after(prepared.value);
}

async function usage(
  db: RegionalDb,
  loaded: Authorized,
  actorId: string,
  now: number,
  threadMessages: number,
): Promise<AnnotationUsageSnapshot> {
  const e = schema.annotationEvents;
  const th = schema.annotationThreads;
  const u = schema.annotationUsage;
  const [row] = await db.all<Record<string, number>>(
    sql`select
      (select count(*) from ${e} where ${e.actorId} = ${actorId} and ${e.kind} in ${WRITE_KINDS} and ${e.at} > ${now - MINUTE_MS}) as author_minute,
      (select count(*) from ${e} where ${e.actorId} = ${actorId} and ${e.kind} in ${WRITE_KINDS} and ${e.at} > ${now - DAY_MS}) as author_day,
      (select count(*) from ${e} where ${e.artifactId} = ${loaded.artifact.id} and ${e.kind} in ${WRITE_KINDS} and ${e.at} > ${now - DAY_MS}) as artifact_day,
      (select count(*) from ${th} where ${th.artifactId} = ${loaded.artifact.id}) as threads,
      coalesce((select ${u.messages} from ${u} where ${u.ownerId} = ${loaded.artifact.ownerId}), 0) as owner_messages,
      coalesce((select ${u.bytes} from ${u} where ${u.ownerId} = ${loaded.artifact.ownerId}), 0) as owner_bytes`,
  );
  // A select without FROM always returns one row.
  const values = row as Record<string, number>;
  const value = (key: string) => Number(values[key]);
  return {
    authorWritesLastMinute: value("author_minute"),
    authorWritesLast24h: value("author_day"),
    artifactWritesLast24h: value("artifact_day"),
    artifactThreads: value("threads"),
    threadMessages,
    ownerMessages: value("owner_messages"),
    ownerBytes: value("owner_bytes"),
  };
}

async function checkLimits(
  db: RegionalDb,
  loaded: Authorized,
  actorId: string,
  now: number,
  write: AnnotationWrite,
  threadMessages = 0,
): Promise<Result<true>> {
  // Budget protection pauses new comments (plan section 12); moderation never passes through here.
  const capacity = checkAnnotationCapacity((await platformProtection(db.global, now)).actions);
  if (!capacity.ok) return capacity;
  // The quota is the artifact owner's, so it follows the owner's plan, whoever writes.
  return checkAnnotationWrite(
    await usage(db, loaded, actorId, now, threadMessages),
    write,
    loaded.entitlements.limits,
  );
}

// Mode

/** Turns annotations off, opens them or locks them. Owner only; threads are never deleted. */
export async function setAnnotationMode(
  db: RegionalDb,
  input: AnnotationActor & { mode: AnnotationsState },
): Promise<Result<{ annotations: AnnotationsState }>> {
  const loaded = await load(db, input);
  if (!loaded) return missingArtifact();
  if ("ok" in loaded) return loaded;
  const allowed = checkAnnotationModeChange({ role: loaded.role, state: loaded.state });
  if (!allowed.ok) return allowed;
  if (loaded.artifact.annotations === input.mode) return ok({ annotations: input.mode });
  const t = schema.artifacts;
  const updated = await db
    .update(t)
    .set({ annotations: input.mode, updatedAt: input.now })
    .where(
      and(
        eq(t.id, loaded.artifact.id),
        eq(t.ownerId, loaded.artifact.ownerId),
        inArray(t.state, ["active", "archived"]),
      ),
    )
    .returning({ id: t.id });
  if (updated.length === 0) return changed();
  await db.insert(schema.lifecycleEvents).values({
    artifactId: loaded.artifact.id,
    actorId: input.userId,
    channel: "system",
    event: "annotations_changed",
    details: { mode: input.mode },
    at: input.now,
  });
  return ok({ annotations: input.mode });
}

// Threads and messages

/** Starts a thread with its first message on the artifact's current version. */
export async function createAnnotationThread(
  db: RegionalDb,
  input: AnnotationActor & {
    versionId: string;
    target: AnnotationTarget;
    body: string;
    humanCheck: HumanCheck;
  },
): Promise<Result<AnnotationThreadView>> {
  const targetJson = JSON.stringify(input.target);
  const targetBytes = utf8Length(targetJson);
  const bodyBytes = utf8Length(input.body);
  const threadId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const writeId = crypto.randomUUID();
  const checkHuman = humanGate(db, input.userId, input.humanCheck);

  return guardedWrite(
    async () => {
      const loaded = await authorize(db, input, "participate");
      if (!loaded.ok) return loaded;
      const writable = checkThreadWritable(input.versionId, loaded.value.artifact.currentVersionId);
      if (!writable.ok) return writable;
      const [file] = await db
        .select({ path: schema.versionFiles.path })
        .from(schema.versionFiles)
        .where(
          and(
            eq(schema.versionFiles.versionId, input.versionId),
            eq(schema.versionFiles.kind, "published"),
            eq(schema.versionFiles.path, input.target.path),
          ),
        )
        .limit(1);
      if (!file) return fail("invalid_input", "target.path: No such file in this version.");
      const limits = await checkLimits(db, loaded.value, input.userId, input.now, {
        kind: "thread",
        addedBytes: bodyBytes + targetBytes,
      });
      if (!limits.ok) return limits;
      const human = await checkHuman(loaded.value);
      return human.ok ? loaded : human;
    },
    async (loaded) => {
      const a = loaded.artifact;
      const th = schema.annotationThreads;
      const guard = sql`${artifactGuard(loaded, "participate", input.now)} and exists (select 1 from ${schema.artifacts} where ${schema.artifacts.id} = ${a.id} and ${schema.artifacts.currentVersionId} = ${input.versionId}) and ${rateGuard(input.userId, a.id, input.now)} and (select count(*) from ${th} where ${th.artifactId} = ${a.id}) < ${ANNOTATION_LIMITS.threadsPerArtifact}`;
      return runClaimed(db, [
        claim(
          db,
          writeId,
          {
            artifactId: a.id,
            threadId,
            messageId,
            actorId: input.userId,
            kind: "thread_created",
            now: input.now,
          },
          guard,
        ),
        // Columns in schema order: id, artifact, version, owner, author, target, target bytes,
        // path, state, messages, revision, change_seq, resolved_at, resolved_by, created, updated.
        db
          .insert(th)
          .select(
            sql`select ${threadId}, ${a.id}, ${input.versionId}, ${a.ownerId}, ${input.userId}, ${targetJson}, ${targetBytes}, ${input.target.path}, 'open', 1, 1, ${claimedEventId(writeId)}, null, null, ${input.now}, ${input.now} where ${claimed(writeId)}`,
          ),
        insertMessage(db, {
          id: messageId,
          threadId,
          artifact: a,
          authorId: input.userId,
          body: input.body,
          bodyBytes,
          now: input.now,
          writeId,
        }),
        ...noticeMark(db, loaded, writeId, {
          threadId,
          actorId: input.userId,
          activity: "thread",
          now: input.now,
        }),
      ]);
    },
    (loaded) => threadResult(db, loaded, input.userId, threadId),
  );
}

function insertMessage(
  db: RegionalDb,
  m: {
    id: string;
    threadId: string;
    artifact: ArtifactRow;
    authorId: string;
    body: string;
    bodyBytes: number;
    now: number;
    writeId: string;
  },
) {
  // Columns in schema order: id, thread, artifact, owner, author, body, bytes, state, revision,
  // edited_at, created_at.
  return db
    .insert(schema.annotationMessages)
    .select(
      sql`select ${m.id}, ${m.threadId}, ${m.artifact.id}, ${m.artifact.ownerId}, ${m.authorId}, ${m.body}, ${m.bodyBytes}, 'visible', 1, null, ${m.now} where ${claimed(m.writeId)}`,
    );
}

/** Adds a reply to a thread of the current version. */
export async function replyToAnnotationThread(
  db: RegionalDb,
  input: AnnotationActor & { threadId: string; body: string; humanCheck: HumanCheck },
): Promise<Result<AnnotationThreadView>> {
  const bodyBytes = utf8Length(input.body);
  const messageId = crypto.randomUUID();
  const writeId = crypto.randomUUID();
  const checkHuman = humanGate(db, input.userId, input.humanCheck);
  return guardedWrite(
    async () => {
      const loaded = await authorize(db, input, "participate");
      if (!loaded.ok) return loaded;
      const thread = await findThread(db, loaded.value, input.threadId);
      if (!thread) return missingThread();
      const writable = checkThreadWritable(
        thread.versionId,
        loaded.value.artifact.currentVersionId,
      );
      if (!writable.ok) return writable;
      const limits = await checkLimits(
        db,
        loaded.value,
        input.userId,
        input.now,
        { kind: "reply", addedBytes: bodyBytes },
        thread.messageCount,
      );
      if (!limits.ok) return limits;
      const human = await checkHuman(loaded.value);
      return human.ok ? loaded : human;
    },
    (loaded) => {
      const a = loaded.artifact;
      const guard = sql`${artifactGuard(loaded, "participate", input.now)} and ${currentThreadGuard(input.threadId)} and ${scopeGuard(loaded, input.threadId)} and ${rateGuard(input.userId, a.id, input.now)}`;
      return runClaimed(db, [
        claim(
          db,
          writeId,
          {
            artifactId: a.id,
            threadId: input.threadId,
            messageId,
            actorId: input.userId,
            kind: "message_created",
            now: input.now,
          },
          guard,
        ),
        insertMessage(db, {
          id: messageId,
          threadId: input.threadId,
          artifact: a,
          authorId: input.userId,
          body: input.body,
          bodyBytes,
          now: input.now,
          writeId,
        }),
        touchThread(db, input.threadId, writeId, input.now, {
          messageCount: sql`${schema.annotationThreads.messageCount} + 1`,
        }),
        ...noticeMark(db, loaded, writeId, {
          threadId: input.threadId,
          actorId: input.userId,
          activity: "reply",
          now: input.now,
        }),
      ]);
    },
    (loaded) => threadResult(db, loaded, input.userId, input.threadId),
  );
}

/**
 * Edits one's own message, based on the message revision the client holds. The author may edit
 * it even in a thread they no longer see; the answer is then `{ threadId, thread: null }`.
 */
export async function editAnnotationMessage(
  db: RegionalDb,
  input: AnnotationActor & { messageId: string; body: string; revision: number },
): Promise<Result<AnnotationEditResult>> {
  const bodyBytes = utf8Length(input.body);
  const writeId = crypto.randomUUID();
  return guardedWrite(
    async () => {
      const loaded = await authorize(db, input, "participate");
      if (!loaded.ok) return loaded;
      const found = await findOwnMessage(db, loaded.value, input.messageId);
      if (!found) return missingMessage();
      const editable = checkEditMessage(input.userId, found.message);
      if (!editable.ok) return editable;
      const writable = checkThreadWritable(
        found.thread.versionId,
        loaded.value.artifact.currentVersionId,
      );
      if (!writable.ok) return writable;
      if (found.message.revision !== input.revision) {
        return fail("version_conflict", "The message changed meanwhile. Reload and try again.");
      }
      const limits = await checkLimits(db, loaded.value, input.userId, input.now, {
        kind: "edit",
        addedBytes: bodyBytes - found.message.bodyBytes,
      });
      return limits.ok ? ok({ loaded: loaded.value, threadId: found.thread.id }) : limits;
    },
    ({ loaded, threadId }) => {
      const m = schema.annotationMessages;
      // Authorship, not the thread's scope: the author edits their own words wherever they are.
      const guard = sql`${artifactGuard(loaded, "participate", input.now)} and ${currentThreadGuard(threadId)} and ${rateGuard(input.userId, loaded.artifact.id, input.now)} and exists (select 1 from ${m} where ${m.id} = ${input.messageId} and ${m.authorId} = ${input.userId} and ${m.state} = 'visible' and ${m.revision} = ${input.revision})`;
      return runClaimed(db, [
        claim(
          db,
          writeId,
          {
            artifactId: loaded.artifact.id,
            threadId,
            messageId: input.messageId,
            actorId: input.userId,
            kind: "message_edited",
            now: input.now,
          },
          guard,
        ),
        db
          .update(m)
          .set({
            body: input.body,
            bodyBytes,
            revision: sql`${m.revision} + 1`,
            editedAt: input.now,
          })
          .where(and(eq(m.id, input.messageId), claimed(writeId))),
        touchThread(db, threadId, writeId, input.now),
      ]);
    },
    async ({ threadId }) => {
      const result = await threadIfVisible(db, input, threadId);
      if (!result.ok) return result;
      const { threadId: id, thread } = result.value;
      return ok<AnnotationEditResult>(thread ?? { threadId: id, thread: null });
    },
  );
}

/**
 * Deletes one's own message, also in a thread the author no longer sees (then the answer's
 * `thread` is `null`). A thread left without live messages is removed.
 */
export async function deleteOwnAnnotationMessage(
  db: RegionalDb,
  input: AnnotationActor & { messageId: string },
): Promise<Result<AnnotationDeleteResult>> {
  return removeMessage(db, input, "delete_own");
}

/** Owner moderation: hide, unhide or delete another person's message. */
export async function moderateAnnotationMessage(
  db: RegionalDb,
  input: AnnotationActor & { messageId: string; action: ModerationAction },
): Promise<Result<AnnotationDeleteResult>> {
  if (input.action === "delete") return removeMessage(db, input, "moderate");
  const writeId = crypto.randomUUID();
  return guardedWrite(
    async () => {
      const loaded = await authorize(db, input, "moderate");
      if (!loaded.ok) return loaded;
      const found = await findMessage(db, loaded.value, input.messageId);
      if (!found) return missingMessage();
      const next = moderationTransition(found.message, input.action);
      if (!next.ok) return next;
      return ok({ loaded: loaded.value, found, next: next.value });
    },
    async ({ loaded, found, next }) => {
      if (next === null) return ok(true);
      const m = schema.annotationMessages;
      const guard = sql`${artifactGuard(loaded, "moderate", input.now)} and exists (select 1 from ${m} where ${m.id} = ${input.messageId} and ${m.state} = ${found.message.state})`;
      return runClaimed(db, [
        claim(
          db,
          writeId,
          {
            artifactId: loaded.artifact.id,
            threadId: found.thread.id,
            messageId: input.messageId,
            actorId: input.userId,
            kind: next === "hidden" ? "message_hidden" : "message_unhidden",
            now: input.now,
          },
          guard,
        ),
        db
          .update(m)
          .set({ state: next, revision: sql`${m.revision} + 1` })
          .where(and(eq(m.id, input.messageId), claimed(writeId))),
        touchThread(db, found.thread.id, writeId, input.now),
      ]);
    },
    async ({ loaded, found }) => {
      const view = await threadResult(db, loaded, input.userId, found.thread.id);
      if (!view.ok) return view;
      return ok({ threadId: found.thread.id, thread: view.value });
    },
  );
}

/**
 * Deletes a message, keeping a marker so replies keep their place. When no other message of
 * the thread is left, the thread is removed. Deleting a deleted message changes nothing.
 */
async function removeMessage(
  db: RegionalDb,
  input: AnnotationActor & { messageId: string },
  action: "delete_own" | "moderate",
): Promise<Result<AnnotationDeleteResult>> {
  const writeId = crypto.randomUUID();
  const m = schema.annotationMessages;
  return guardedWrite(
    async () => {
      const loaded = await authorize(db, input, action);
      if (!loaded.ok) return loaded;
      const found =
        action === "delete_own"
          ? await findOwnMessage(db, loaded.value, input.messageId)
          : await findMessage(db, loaded.value, input.messageId);
      if (!found) return missingMessage();
      if (action === "delete_own") {
        const allowed = checkDeleteOwnMessage(input.userId, found.message);
        if (!allowed.ok) return allowed;
      }
      const [others] = await db
        .select({ count: sql<number>`count(*)` })
        .from(m)
        .where(
          and(
            eq(m.threadId, found.thread.id),
            sql`${m.id} <> ${input.messageId}`,
            sql`${m.state} <> 'deleted'`,
          ),
        );
      const remaining = Number((others as { count: number }).count);
      return ok({ loaded: loaded.value, found, removesThread: remaining === 0 });
    },
    async ({ loaded, found, removesThread }) => {
      if (found.message.state === "deleted") return ok(true);
      const th = schema.annotationThreads;
      const others = sql`exists (select 1 from ${m} where ${m.threadId} = ${found.thread.id} and ${m.id} <> ${input.messageId} and ${m.state} <> 'deleted')`;
      const guard = sql`${artifactGuard(loaded, action, input.now)} and exists (select 1 from ${m} where ${m.id} = ${input.messageId} and ${m.state} <> 'deleted') and ${removesThread ? sql`not ${others}` : others}${
        // A participant only deletes their own message (checked above, and authors never
        // change), so the thread's scope does not matter here.
        loaded.role === "participant" ? sql` and ${currentThreadGuard(found.thread.id)}` : sql``
      }`;
      const event: Claim = {
        artifactId: loaded.artifact.id,
        threadId: found.thread.id,
        messageId: input.messageId,
        actorId: input.userId,
        kind: removesThread
          ? "thread_deleted"
          : action === "moderate"
            ? "message_removed"
            : "message_deleted",
        now: input.now,
      };
      if (removesThread) {
        return runClaimed(db, [
          claim(db, writeId, event, guard),
          db.delete(th).where(and(eq(th.id, found.thread.id), claimed(writeId))),
        ]);
      }
      return runClaimed(db, [
        claim(db, writeId, event, guard),
        db
          .update(m)
          .set({ state: "deleted", body: null, bodyBytes: 0, revision: sql`${m.revision} + 1` })
          .where(and(eq(m.id, input.messageId), claimed(writeId))),
        touchThread(db, found.thread.id, writeId, input.now),
      ]);
    },
    async ({ loaded, found, removesThread }): Promise<Result<AnnotationDeleteResult>> => {
      if (removesThread && found.message.state !== "deleted") {
        return ok({ threadId: found.thread.id, thread: null });
      }
      return threadIfVisible(db, input, found.thread.id);
    },
  );
}

/** Resolves or reopens a thread: the owner any thread, a participant the threads they started. */
export async function setAnnotationThreadState(
  db: RegionalDb,
  input: AnnotationActor & { threadId: string; state: AnnotationThreadState },
): Promise<Result<AnnotationThreadView>> {
  const writeId = crypto.randomUUID();
  return guardedWrite(
    async () => {
      const loaded = await authorize(db, input, "resolve");
      if (!loaded.ok) return loaded;
      const thread = await findThread(db, loaded.value, input.threadId);
      if (!thread) return missingThread();
      const allowed = checkResolve(loaded.value.role, input.userId, thread.authorId);
      if (!allowed.ok) return allowed;
      return ok({ loaded: loaded.value, thread });
    },
    async ({ loaded, thread }) => {
      if (thread.state === input.state) return ok(true);
      const th = schema.annotationThreads;
      const guard = sql`${artifactGuard(loaded, "resolve", input.now)} and exists (select 1 from ${th} where ${th.id} = ${thread.id} and ${th.state} = ${thread.state})${
        loaded.role === "participant" ? sql` and ${currentThreadGuard(thread.id)}` : sql``
      }`;
      const resolved = input.state === "resolved";
      return runClaimed(db, [
        claim(
          db,
          writeId,
          {
            artifactId: loaded.artifact.id,
            threadId: thread.id,
            messageId: null,
            actorId: input.userId,
            kind: resolved ? "thread_resolved" : "thread_reopened",
            now: input.now,
          },
          guard,
        ),
        touchThread(db, thread.id, writeId, input.now, {
          state: input.state,
          resolvedAt: resolved ? input.now : null,
          resolvedBy: resolved ? input.userId : null,
        }),
        // Reopening a thread is not news for anyone.
        ...(resolved
          ? noticeMark(db, loaded, writeId, {
              threadId: thread.id,
              actorId: input.userId,
              activity: "resolved",
              now: input.now,
            })
          : []),
      ]);
    },
    ({ loaded, thread }) => threadResult(db, loaded, input.userId, thread.id),
  );
}

/** Owner moderation: removes a whole thread and its messages. */
export async function deleteAnnotationThread(
  db: RegionalDb,
  input: AnnotationActor & { threadId: string },
): Promise<Result<{ threadId: string }>> {
  const writeId = crypto.randomUUID();
  const th = schema.annotationThreads;
  return guardedWrite(
    async () => {
      const loaded = await authorize(db, input, "moderate");
      if (!loaded.ok) return loaded;
      const thread = await findThread(db, loaded.value, input.threadId);
      return thread ? ok(loaded.value) : missingThread();
    },
    (loaded) =>
      runClaimed(db, [
        claim(
          db,
          writeId,
          {
            artifactId: loaded.artifact.id,
            threadId: input.threadId,
            messageId: null,
            actorId: input.userId,
            kind: "thread_deleted",
            now: input.now,
          },
          sql`${artifactGuard(loaded, "moderate", input.now)} and exists (select 1 from ${th} where ${th.id} = ${input.threadId})`,
        ),
        db.delete(th).where(and(eq(th.id, input.threadId), claimed(writeId))),
      ]),
    async () => ok({ threadId: input.threadId }),
  );
}

// Reading

/** One thread with its messages, if the caller can see it. */
export async function getAnnotationThread(
  db: RegionalDb,
  input: AnnotationActor & { threadId: string },
): Promise<Result<AnnotationThreadView>> {
  const loaded = await authorize(db, input, "read");
  if (!loaded.ok) return loaded;
  return threadResult(db, loaded.value, input.userId, input.threadId);
}

async function threadResult(
  db: RegionalDb,
  loaded: Authorized,
  viewerId: string,
  threadId: string,
): Promise<Result<AnnotationThreadView>> {
  const thread = await findThread(db, loaded, threadId);
  if (!thread) return missingThread();
  const [view] = await threadViews(db, viewContext(loaded), viewerId, [thread]);
  return ok(view as AnnotationThreadView);
}

/** Opaque refresh cursor: the last annotation event the page covers. */
export function encodeAnnotationCursor(seq: number): string {
  return btoa(`a${seq}`).replace(/=+$/, "");
}

export function decodeAnnotationCursor(cursor: string): number | undefined {
  try {
    const match = /^a(\d{1,15})$/.exec(atob(cursor));
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

/** Which version's threads to return, or `undefined` for all of them. */
function versionScope(
  loaded: Authorized,
  version: AnnotationVersionFilter,
): Result<string | null | undefined> {
  const current = loaded.artifact.currentVersionId;
  if (version === "current" || version === current) return ok(current);
  if (loaded.role !== "owner") {
    return fail("forbidden", "Only the owner can see threads of other versions.");
  }
  return ok(version === "all" ? undefined : version);
}

function threadFilter(
  loaded: Authorized,
  scope: string | null | undefined,
  state: AnnotationThreadState | undefined,
): SQL | undefined {
  const th = schema.annotationThreads;
  return and(
    eq(th.artifactId, loaded.artifact.id),
    scopeFilter(loaded),
    scope === undefined ? undefined : scope === null ? sql`0` : eq(th.versionId, scope),
    state ? eq(th.state, state) : undefined,
  );
}

/**
 * With the `own` scope, the events of threads the caller or the owner started, found by the
 * `thread_created` event that outlives a deleted thread; with `all`, every event.
 */
function eventScopeFilter(loaded: Loaded): SQL | undefined {
  if (loaded.scope === "all") return undefined;
  const e = schema.annotationEvents;
  // Interpolating an alias renders only its name, so the FROM clause names the table itself.
  const owners = sql.join(
    [loaded.viewerId, ...loaded.ownerSide].map((id) => sql`${id}`),
    sql`, `,
  );
  return sql`${e.threadId} in (select created.thread_id from ${e} as created where created.artifact_id = ${loaded.artifact.id} and created.kind = 'thread_created' and created.actor_id in (${owners}))`;
}

/**
 * A page of threads in change order. Without a cursor it starts from the beginning; with one it
 * returns the threads changed since, and lists in `removed` the threads that were deleted or no
 * longer match the filter, so a client can refresh incrementally.
 */
export async function listAnnotations(
  db: RegionalDb,
  input: AnnotationListInput,
): Promise<Result<AnnotationPage>> {
  const authorized = await authorize(db, input, "read");
  if (!authorized.ok) return authorized;
  const loaded = authorized.value;
  const since = input.cursor === undefined ? 0 : decodeAnnotationCursor(input.cursor);
  if (since === undefined) return fail("invalid_input", "Invalid cursor.");
  const scope = versionScope(loaded, input.version);
  if (!scope.ok) return scope;

  const th = schema.annotationThreads;
  const rows = await db
    .select()
    .from(th)
    .where(
      and(
        since === 0
          ? threadFilter(loaded, scope.value, input.state)
          : and(eq(th.artifactId, loaded.artifact.id), scopeFilter(loaded)),
        gt(th.changeSeq, since),
      ),
    )
    .orderBy(asc(th.changeSeq))
    .limit(input.limit + 1);
  const hasMore = rows.length > input.limit;
  const page = rows.slice(0, input.limit);
  const matches = (thread: ThreadRow) =>
    (scope.value === undefined || thread.versionId === scope.value) &&
    (!input.state || thread.state === input.state);

  const e = schema.annotationEvents;
  let upper = since;
  const last = page.at(-1);
  if (hasMore && last) {
    upper = last.changeSeq;
  } else {
    // With the `own` scope only the events of threads in it count, so the cursor never moves
    // because of activity the caller cannot see.
    const [latest] = await db
      .select({ id: sql<number | null>`max(${e.id})` })
      .from(e)
      .where(and(eq(e.artifactId, loaded.artifact.id), eventScopeFilter(loaded)));
    upper = Math.max(since, Number(latest?.id ?? 0));
  }

  const removed = new Set<string>();
  if (since > 0) {
    for (const thread of page) if (!matches(thread)) removed.add(thread.id);
    const deleted = await db
      .select({ threadId: e.threadId })
      .from(e)
      .where(
        and(
          eq(e.artifactId, loaded.artifact.id),
          eq(e.kind, "thread_deleted"),
          gt(e.id, since),
          sql`${e.id} <= ${upper}`,
          eventScopeFilter(loaded),
        ),
      );
    for (const row of deleted) removed.add(row.threadId);
  }

  return ok({
    artifactId: loaded.artifact.id,
    annotations: loaded.artifact.annotations,
    currentVersionId: loaded.artifact.currentVersionId,
    role: loaded.role,
    commentScope: loaded.scope,
    humanCheck:
      loaded.role === "participant" &&
      needsHumanCheck(loaded.role, await commentsOnOthersArtifacts(db, input.userId)),
    threads: await threadViews(db, viewContext(loaded), input.userId, page.filter(matches)),
    removed: [...removed],
    cursor: encodeAnnotationCursor(upper),
    hasMore,
  });
}

/** Every thread the caller can see, oldest first, for JSON or Markdown export. */
export async function exportAnnotations(
  db: RegionalDb,
  input: AnnotationActor & {
    version: AnnotationVersionFilter;
    state?: AnnotationThreadState | undefined;
  },
): Promise<Result<AnnotationExport>> {
  const authorized = await authorize(db, input, "read");
  if (!authorized.ok) return authorized;
  const loaded = authorized.value;
  const scope = versionScope(loaded, input.version);
  if (!scope.ok) return scope;
  const th = schema.annotationThreads;
  const rows = await db
    .select()
    .from(th)
    .where(threadFilter(loaded, scope.value, input.state))
    .orderBy(asc(th.createdAt), asc(th.id));
  const a = loaded.artifact;
  return ok({
    notice: UNTRUSTED_ANNOTATIONS_NOTICE,
    exportedAt: new Date(input.now).toISOString(),
    artifact: {
      id: a.id,
      name: a.name,
      type: a.type,
      annotations: a.annotations,
      currentVersionId: a.currentVersionId,
    },
    threads: await threadViews(db, viewContext(loaded), input.userId, rows),
  });
}

// Views

/** How the caller sees the threads of one loaded artifact. */
function viewContext(loaded: Authorized): ThreadViewContext {
  return {
    role: loaded.role,
    ownerSide: loaded.ownerSide,
    currentVersionOf: () => loaded.artifact.currentVersionId,
  };
}

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += IN_CHUNK) out.push(items.slice(i, i + IN_CHUNK));
  return out;
}

/**
 * Removes a deleted account's words from one thread on someone else's artifact (plan section 5,
 * "Borrado de cuenta"): a message that others replied to after it becomes the "message deleted"
 * marker, any other message of the account disappears, and a thread left without visible
 * messages is removed. The batch is claimed under the thread revision this run read, so a reply
 * that lands meanwhile makes the claim fail and the next run looks again. Returns whether the
 * thread changed.
 */
export async function eraseAuthorFromThread(
  db: RegionalDb,
  input: { authorId: string; threadId: string; now: number },
): Promise<boolean> {
  const th = schema.annotationThreads;
  const m = schema.annotationMessages;
  const [thread] = await db
    .select({ id: th.id, artifactId: th.artifactId, revision: th.revision })
    .from(th)
    .where(eq(th.id, input.threadId))
    .limit(1);
  if (!thread) return false;
  const messages = await db
    .select({ id: m.id, authorId: m.authorId, state: m.state })
    .from(m)
    .where(eq(m.threadId, thread.id))
    .orderBy(asc(m.createdAt), sql`${m}.rowid`);
  const repliedTo = (index: number) =>
    messages
      .slice(index + 1)
      .some((later) => later.authorId !== input.authorId && later.state !== "deleted");
  const remove: string[] = [];
  const mark: string[] = [];
  messages.forEach((message, index) => {
    if (message.authorId !== input.authorId) return;
    if (!repliedTo(index)) remove.push(message.id);
    else if (message.state !== "deleted") mark.push(message.id);
  });
  if (remove.length === 0 && mark.length === 0) return false;
  const visibleLeft = messages.some(
    (message) => message.authorId !== input.authorId && message.state !== "deleted",
  );

  const writeId = crypto.randomUUID();
  const guard = sql`exists (select 1 from ${th} where ${th.id} = ${thread.id} and ${th.revision} = ${thread.revision})`;
  const event: Claim = {
    artifactId: thread.artifactId,
    threadId: thread.id,
    messageId: null,
    actorId: input.authorId,
    kind: visibleLeft ? "message_deleted" : "thread_deleted",
    now: input.now,
  };
  const statements: Batch = visibleLeft
    ? [
        claim(db, writeId, event, guard),
        ...chunks(remove).map((ids) =>
          db.delete(m).where(and(inArray(m.id, ids), claimed(writeId))),
        ),
        ...chunks(mark).map((ids) =>
          db
            .update(m)
            .set({ state: "deleted", body: null, bodyBytes: 0, revision: sql`${m.revision} + 1` })
            .where(and(inArray(m.id, ids), claimed(writeId))),
        ),
        touchThread(db, thread.id, writeId, input.now, {
          messageCount: sql`(select count(*) from ${m} where ${m.threadId} = ${thread.id})`,
        }),
      ]
    : [
        claim(db, writeId, event, guard),
        db.delete(th).where(and(eq(th.id, thread.id), claimed(writeId))),
      ];
  const [first] = (await db.batch(statements)) as [{ id: number }[]];
  return first.length === 1;
}

// Comment notices

/** What a recipient may see of one artifact's threads when their comment notice is sent. */
export interface NoticeView {
  name: string;
  entitlements: Entitlements;
  /** The threads among those asked about that the recipient may read now. */
  threadIds: Set<string>;
}

/**
 * The threads among `threadIds` that `userId` may read now, by the same rules as every read
 * path (the role on the artifact, its state and comment mode, the comment scope and the version
 * a visitor sees), or null when they may read none of the artifact's comments any more.
 */
export async function noticeView(
  db: RegionalDb,
  input: AnnotationActor & { threadIds: readonly string[] },
): Promise<NoticeView | null> {
  const authorized = await authorize(db, input, "read");
  if (!authorized.ok) return null;
  const loaded = authorized.value;
  const th = schema.annotationThreads;
  const visible = new Set<string>();
  for (let i = 0; i < input.threadIds.length; i += IN_CHUNK) {
    const rows = await db
      .select({ id: th.id, versionId: th.versionId, authorId: th.authorId })
      .from(th)
      .where(
        and(
          eq(th.artifactId, loaded.artifact.id),
          inArray(th.id, input.threadIds.slice(i, i + IN_CHUNK)),
        ),
      );
    for (const thread of rows) {
      if (
        threadVisible(loaded.role, thread.versionId, loaded.artifact.currentVersionId) &&
        inScope(loaded, thread.authorId)
      ) {
        visible.add(thread.id);
      }
    }
  }
  return { name: loaded.artifact.name, entitlements: loaded.entitlements, threadIds: visible };
}

/**
 * Whether `userId` may read the artifact's comments: the same authorization as listing them.
 * Gives the owner's entitlements, for the comment notice preference of the artifact.
 */
export async function annotationReader(
  db: RegionalDb,
  input: AnnotationActor,
): Promise<Result<{ entitlements: Entitlements }>> {
  const authorized = await authorize(db, input, "read");
  return authorized.ok ? ok({ entitlements: authorized.value.entitlements }) : authorized;
}

/**
 * The caller's standing in the artifact's comments, as every annotation path decides it: the
 * artifact, its effective state, the role (owner side, participant or nobody), the verified
 * address, the comment scope, the owner side and the owner's entitlements. Approval reviews
 * (./approval-reviews.ts) decide who sees what with it, so they never reimplement the rule.
 * Undefined for an artifact that does not exist; a request policy's refusal as itself.
 */
export type CommentStanding = Loaded;

export function commentStanding(db: RegionalDb, input: AnnotationActor): Promise<LoadOutcome> {
  return load(db, input);
}

/**
 * A thread the caller may read now, by every read path's rules (role, state, comment mode,
 * comment scope and the version a visitor sees), with the caller's standing; a thread outside
 * them answers exactly like a missing one. Issue integrations (./thread-issues.ts) send a thread
 * out only through this, so they never reimplement who sees what.
 */
export async function readableThread(
  db: RegionalDb,
  input: AnnotationActor & { threadId: string },
): Promise<Result<{ standing: CommentStanding & { role: AnnotationRole }; thread: ThreadRow }>> {
  const loaded = await authorize(db, input, "read");
  if (!loaded.ok) return loaded;
  const thread = await findThread(db, loaded.value, input.threadId);
  return thread ? ok({ standing: loaded.value, thread }) : missingThread();
}

/** How one listed address stands with an artifact (approval reviews, decision 0013). */
export interface Participant {
  /** Whether the access rules let a signed-in person with this verified address take part. */
  takesPart: boolean;
  /**
   * The account, only when the address is the owner side or a member of the owning workspace:
   * people an admin or editor already works with. Null for anyone else, account or not.
   */
  knownUserId: string | null;
  side: "owner" | "member" | null;
  /** On the reader list read for this decision (restricted artifacts only). */
  listedReader: boolean;
  /** In a group the artifact lists (restricted workspace artifacts only). */
  inListedGroup: boolean;
  /** At a verified email domain of the owning workspace (`domain` artifacts only). */
  atVerifiedDomain: boolean;
}

/**
 * Whether people with these verified addresses would take part in the artifact's comments, by
 * the access rules that decide every caller's role (`canRead`, and the owner side), batched: one
 * read of the owner side and members among the addresses, one of the reader list (restricted
 * artifacts) and one of the verified email domains (`domain` artifacts), whatever the addresses
 * are. Whether an address belongs to an account outside the owner's people never changes the
 * reads or the answer: the decision comes from the listed data, so it reveals no account. Never a
 * new way in: it only asks the access rules about someone else. `policy` decides it for an
 * access change about to be written (its mode and its whole reader list).
 */
export async function participation(
  db: RegionalDb,
  artifact: Pick<ArtifactRow, "id" | "ownerId" | "accessMode">,
  emails: readonly string[],
  owner: Entitlements,
  policy?: {
    mode: ArtifactRow["accessMode"];
    readers: readonly string[];
    /** The groups the artifact lists after the change; read from the artifact when absent. */
    groups?: readonly string[] | undefined;
  },
): Promise<Map<string, Participant>> {
  const result = new Map<string, Participant>();
  const addresses = [...new Set(emails)];
  if (addresses.length === 0) return result;
  const mode = policy?.mode ?? artifact.accessMode;
  const u = schema.users;
  const m = schema.workspaceMembers;
  const known = new Map<string, { userId: string; role: "admin" | "editor" | "member" }>();
  if (isWorkspaceId(artifact.ownerId)) {
    const rows = await db.global
      .select({ userId: m.userId, role: m.role, email: u.email })
      .from(m)
      .innerJoin(u, eq(u.id, m.userId))
      .where(
        and(
          eq(m.workspaceId, artifact.ownerId),
          inArray(u.email, addresses),
          eq(u.emailVerified, true),
        ),
      );
    for (const row of rows) known.set(row.email, { userId: row.userId, role: row.role });
  } else {
    const rows = await db.global
      .select({ userId: u.id, email: u.email })
      .from(u)
      .where(
        and(eq(u.id, artifact.ownerId), inArray(u.email, addresses), eq(u.emailVerified, true)),
      );
    for (const row of rows) known.set(row.email, { userId: row.userId, role: "admin" });
  }
  let readers: Set<string> = new Set();
  if (mode === "restricted") {
    if (policy) readers = new Set(policy.readers);
    else {
      const r = schema.artifactReaders;
      readers = new Set(
        (
          await db
            .select({ email: r.email })
            .from(r)
            .where(and(eq(r.artifactId, artifact.id), inArray(r.email, addresses)))
        ).map((row) => row.email),
      );
    }
  }
  const domains = await policyDomains(db.global, {
    mode,
    ownerId: artifact.ownerId,
    actor: null,
    verifiedEmails: addresses,
    entitlements: owner,
  });
  // Groups (decision 0014) admit only members of the owning workspace, so only the members found
  // above are asked about: one regional read of the listed groups and one batched global read of
  // their memberships. An address outside the workspace never changes the reads.
  const groupsAvailable = requireFeature(owner, "workspaces").ok;
  const members = [...known.values()]
    .filter((person) => person.role === "member")
    .map((person) => person.userId);
  const listedGroups =
    mode === "restricted" && groupsAvailable && members.length > 0
      ? (policy?.groups ?? (await artifactGroupRows(db, artifact.id)).map((row) => row.groupId))
      : [];
  const inGroups = await groupMembershipsOf(db.global, artifact.ownerId, members, listedGroups);
  for (const email of addresses) {
    const person = known.get(email);
    const actor: Actor | null = person
      ? {
          userId: person.userId,
          ownerId: artifact.ownerId,
          role: person.role,
          region: DEFAULT_REGION,
        }
      : null;
    const decision = canRead(
      {
        mode,
        ownerId: artifact.ownerId,
        readers: readers.has(email) ? [email] : [],
        domains,
        groups: {
          featureAvailable: groupsAvailable,
          matched: (person ? (inGroups.get(person.userId) ?? []) : []).map((id) => ({
            id,
            commentVisibility: null,
          })),
        },
      },
      // Nobody outside the owner's people is told apart from an address with no account.
      { userId: person?.userId ?? "", verifiedEmails: [email] },
      actor,
    );
    const side = actsForOwner(actor, artifact.ownerId) ? "owner" : person ? "member" : null;
    const domain = emailDomainOf(email);
    result.set(email, {
      takesPart: decision.ok,
      knownUserId: person?.userId ?? null,
      side,
      listedReader: readers.has(email),
      inListedGroup: person ? (inGroups.get(person.userId) ?? []).length > 0 : false,
      atVerifiedDomain:
        domain !== null &&
        (domains?.featureAvailable ?? false) &&
        domains?.verified.includes(domain) === true,
    });
  }
  return result;
}
