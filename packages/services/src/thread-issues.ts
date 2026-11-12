// Issues created from comment threads (premium plan T7, decision 0018). The owner side of an
// artifact (admins and editors; never a service token, which takes no part in comments) asks for
// an issue from one thread it can see; the request's own batch writes the request and its
// `thread_issue` outbox job, and only the jobs Worker calls GitHub, Linear or Jira. What is sent
// is decided by `issueSections` in the domain from the parts the person left on (written as
// Markdown by `issueBody`, or as a Jira document by `issueDocument`), reading the thread when
// the job sends; the thread then shows a link to the issue to everyone who sees it.
import { INTEGRATION_LIMITS, type IssueParts, type ThreadIssueFailure } from "@portifact/contracts";
import { type Db, type RegionalDb, schema } from "@portifact/db";
import {
  actsForOwner,
  allowedTarget,
  anchorQuote,
  entitlements,
  fail,
  hasFeature,
  ISSUE_FAILURE_MESSAGES,
  issueTitle,
  MAX_ISSUE_ATTEMPTS,
  nextIssueAttemptAt,
  ok,
  type Result,
  requireFeature,
  threadLink,
  utcDayStart,
} from "@portifact/domain";
import { and, asc, eq, type SQL, sql } from "drizzle-orm";
import { actorOn } from "./actors.ts";
import { readableThread } from "./annotations.ts";
import { auditEvent } from "./audit.ts";
import {
  type CallOptions,
  createIssue,
  failedOutcome,
  findIssue,
  type IssueCallOutcome,
  verifyJiraSite,
} from "./integration-clients.ts";
import { type IntegrationKey, openCredential } from "./integration-keys.ts";
import {
  connectionSite,
  INTEGRATION_FEATURE,
  INTEGRATIONS_UNAVAILABLE,
  type IntegrationSwitch,
  markAttention,
  storedTargets,
} from "./integrations.ts";
import type { JobOutcome } from "./outbox.ts";
import { ownerPlanRecord } from "./plans.ts";
import { type ThreadIssueRecord, threadIssueRecord } from "./thread-issue-views.ts";

const ti = schema.threadIssues;
const c = schema.integrationConnections;
const o = schema.outbox;
type IssueRow = typeof ti.$inferSelect;

function hexId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const unavailable = () => fail<never>("capacity_unavailable", INTEGRATIONS_UNAVAILABLE);

export interface ThreadIssueRequest {
  connectionId: string;
  target: string;
  title: string;
  include: IssueParts;
}

/**
 * Asks for an issue from one thread. The thread must be one the caller reads now (a hidden
 * thread answers like a missing one) and the caller must act for the artifact's owner; the plan
 * is the artifact owner's, never the caller's. A retry with the same idempotency key answers the
 * same request, whether or not the first one's answer arrived.
 */
export async function requestThreadIssue(
  db: RegionalDb,
  input: {
    userId: string;
    artifactId: string;
    threadId: string;
    request: ThreadIssueRequest;
    idempotencyKey: string;
    service: IntegrationSwitch;
    now: number;
  },
): Promise<Result<ThreadIssueRecord>> {
  if (!input.service.enabled) return unavailable();
  const readable = await readableThread(db, input);
  if (!readable.ok) return readable;
  const { standing, thread } = readable.value;
  if (standing.role !== "owner") {
    return fail("forbidden", "Only the artifact's admins and editors can create issues.");
  }
  const gate = requireFeature(standing.entitlements, INTEGRATION_FEATURE);
  if (!gate.ok) return gate;
  const ownerId = standing.artifact.ownerId;
  const [connection] = await db
    .select()
    .from(c)
    .where(and(eq(c.id, input.request.connectionId), eq(c.ownerId, ownerId)))
    .limit(1);
  if (!connection) return fail("not_found", "Connection not found.");
  if (connection.attention !== null) {
    return fail(
      "invalid_input",
      connection.attention === "site_mismatch"
        ? "This connection needs an admin's attention: its Jira site changed its address."
        : "This connection needs an admin's attention: its credential no longer works.",
    );
  }
  const target = allowedTarget(storedTargets(connection.targets), input.request.target);
  if (!target) {
    return fail("invalid_input", "The connection does not allow that repository, team or project.");
  }
  const title = issueTitle(input.request.title);
  if (!title.ok) return title;
  // Counted before the regional batch (the counter is global), and given back when the batch
  // inserts nothing: an idempotent retry of the same request or a lost race costs nothing.
  const day = `integration:issues:${ownerId}:${utcDayStart(input.now)}`;
  const [counted] = await db.global.all<{ count: number; window_start: number }>(
    sql`insert into rate_limits (key, window_start, count) values (${day}, ${input.now}, 1) on conflict (key) do update set count = case when window_start <= ${input.now} - ${2 * 86_400_000} then 1 else count + 1 end, window_start = case when window_start <= ${input.now} - ${2 * 86_400_000} then ${input.now} else window_start end returning count, window_start`,
  );
  // An upsert with RETURNING always answers its row.
  const count = counted as { count: number; window_start: number };
  const giveBack = () =>
    db.global.run(
      sql`update rate_limits set count = count - 1 where key = ${day} and window_start = ${Number(count.window_start)} and count > 0`,
    );
  if (Number(count.count) > INTEGRATION_LIMITS.issuesPerOwnerPerDay) {
    await giveBack();
    return fail(
      "rate_limited",
      `At most ${INTEGRATION_LIMITS.issuesPerOwnerPerDay} issues can be created a day. Try again tomorrow.`,
    );
  }
  const id = hexId("ti_");
  const writeId = crypto.randomUUID();
  const parts = input.request.include;
  const a = schema.artifacts;
  const th = schema.annotationThreads;
  // Columns in schema order. Inserted only while the connection is still the owner's and usable,
  // the thread is still the artifact's and the artifact still the owner's (a transfer in between
  // means the role was decided on another owner), and the thread has room for another issue.
  const inserted = await db.batch([
    db
      .insert(ti)
      .select(
        sql`select ${id}, ${thread.id}, ${standing.artifact.id}, ${ownerId}, ${connection.id}, ${connection.service}, ${target.id}, ${target.name}, ${input.userId}, ${input.idempotencyKey}, ${writeId}, ${parts.link}, ${parts.artifactName}, ${parts.quote}, ${parts.message}, ${title.value}, 'pending', null, 0, null, null, null, ${input.now}, null where exists (select 1 from ${c} where ${c.id} = ${connection.id} and ${c.ownerId} = ${ownerId} and ${c.attention} is null) and exists (select 1 from ${th} where ${th.id} = ${thread.id} and ${th.artifactId} = ${standing.artifact.id}) and exists (select 1 from ${a} where ${a.id} = ${standing.artifact.id} and ${a.ownerId} = ${ownerId}) and (select count(*) from ${ti} where ${ti.threadId} = ${thread.id} and ${ti.state} <> 'failed') < ${INTEGRATION_LIMITS.issuesPerThread}`,
      )
      .onConflictDoNothing()
      .returning(),
    // Columns: id, topic, payload, available, dispatched, attempts, created, subject, generation.
    db
      .insert(o)
      .select(
        sql`select null, 'thread_issue', '{}', ${input.now}, null, 0, ${input.now}, ${id}, null where exists (select 1 from ${ti} where ${ti.writeId} = ${writeId})`,
      ),
  ]);
  const [row] = inserted[0] as IssueRow[];
  if (row) return ok(threadIssueRecord(row, input.userId));
  await giveBack();
  const [existing] = await db
    .select()
    .from(ti)
    .where(and(eq(ti.requestedBy, input.userId), eq(ti.idempotencyKey, input.idempotencyKey)))
    .limit(1);
  if (existing) {
    return existing.threadId === thread.id
      ? ok(threadIssueRecord(existing, input.userId))
      : fail("invalid_input", "This Idempotency-Key was used for a different request.");
  }
  const [open] = await db
    .select({ count: sql<number>`count(*)` })
    .from(ti)
    .where(and(eq(ti.threadId, thread.id), sql`${ti.state} <> 'failed'`));
  if (Number((open as { count: number }).count) >= INTEGRATION_LIMITS.issuesPerThread) {
    return fail(
      "quota_exceeded",
      `A thread can have at most ${INTEGRATION_LIMITS.issuesPerThread} issues.`,
    );
  }
  return fail("version_conflict", "The thread or the connection changed meanwhile. Try again.");
}

// The job

/** What sending needs besides D1: the keys, the network and the origin of thread links. */
export interface ThreadIssueDeps extends CallOptions {
  keys: readonly IntegrationKey[];
  appOrigin: string;
  /** `INTEGRATIONS_ENABLED`: without it nothing is sent and pending requests fail. */
  enabled: boolean;
}

type OutboxRow = typeof o.$inferSelect;

/** Ends a pending request with a failure, conditioned on this run's claim. */
function failRequest(
  db: RegionalDb,
  id: string,
  failure: ThreadIssueFailure,
  now: number,
  claim?: number,
) {
  return db
    .update(ti)
    .set({ state: "failed", failure, title: null, startedAt: null, completedAt: now })
    .where(
      and(
        eq(ti.id, id),
        eq(ti.state, "pending"),
        claim === undefined ? undefined : eq(ti.startedAt, claim),
      ),
    );
}

/**
 * Runs one `thread_issue` job (decision 0018, "Sending"). Returns `done` when the request ended
 * (created, failed or gone) and `kept` when it moved itself to a later attempt or another run
 * holds the attempt.
 */
export async function runThreadIssue(
  db: RegionalDb,
  job: OutboxRow,
  now: number,
  deps: ThreadIssueDeps,
): Promise<JobOutcome> {
  const [found] = await db
    .select({ issue: ti, connection: c })
    .from(ti)
    .leftJoin(c, eq(c.id, ti.connectionId))
    .where(eq(ti.id, String(job.subject)))
    .limit(1);
  if (found?.issue.state !== "pending") return "done";
  // A duplicate message before the retry is due does nothing.
  if (job.availableAt > now) return "kept";
  const { issue, connection } = found;
  if (!deps.enabled) {
    await failRequest(db, issue.id, "unavailable", now);
    return "done";
  }
  if (!connection || connection.ownerId !== issue.ownerId) {
    await failRequest(db, issue.id, "connection_removed", now);
    return "done";
  }
  if (connection.attention !== null) {
    await failRequest(
      db,
      issue.id,
      connection.attention === "site_mismatch" ? "site_changed" : "credential_rejected",
      now,
    );
    return "done";
  }
  // The connection as it is now: a repository, team or project an admin removed is never written
  // to. A Jira project brings the issue type checked with it.
  const allowed = allowedTarget(storedTargets(connection.targets), issue.target);
  const target = storedTargets(connection.targets).find((one) => one.id === allowed?.id);
  if (!target) {
    await failRequest(db, issue.id, "target_removed", now);
    return "done";
  }
  // A hard stop, whatever brought the job back (a lost row requeued, a duplicate message).
  if (issue.attempts >= MAX_ISSUE_ATTEMPTS) {
    await failRequest(db, issue.id, "service_unavailable", now);
    return "done";
  }
  const standing = await requesterStanding(db, issue, now);
  if (standing !== "ok") {
    await failRequest(db, issue.id, standing, now);
    return "done";
  }
  // The plan is the owner's, read now: a lapsed plan stops issues and keeps every row.
  if (
    !hasFeature(
      entitlements(await ownerPlanRecord(db.global, issue.ownerId), now),
      INTEGRATION_FEATURE,
    )
  ) {
    await failRequest(db, issue.id, "plan_lapsed", now);
    return "done";
  }
  // Claims the attempt: one run at a time, taken over only after a stale start.
  const [claimed] = await db
    .update(ti)
    .set({ attempts: sql`${ti.attempts} + 1`, startedAt: now })
    .where(
      and(
        eq(ti.id, issue.id),
        eq(ti.state, "pending"),
        sql`${ti.attempts} < ${MAX_ISSUE_ATTEMPTS}`,
        sql`coalesce(${ti.startedAt}, 0) < ${now - INTEGRATION_LIMITS.attemptStaleMs}`,
      ),
    )
    .returning({ attempts: ti.attempts });
  if (!claimed) return "kept";
  // The daily cap: one atomic count per owner and UTC day, kept when connections are removed.
  const day = utcDayStart(now);
  const [cap] = await db.global.all<{ count: number }>(
    sql`insert into rate_limits (key, window_start, count) values (${`integration:attempts:${issue.ownerId}:${day}`}, ${now}, 1) on conflict (key) do update set count = case when window_start <= ${now} - ${2 * 86_400_000} then 1 else count + 1 end, window_start = case when window_start <= ${now} - ${2 * 86_400_000} then ${now} else window_start end returning count`,
  );
  if (Number((cap as { count: number }).count) > INTEGRATION_LIMITS.attemptsPerOwnerPerDay) {
    // Not an attempt: give it back and wait for the next UTC day.
    await db.batch([
      db
        .update(ti)
        .set({ attempts: sql`${ti.attempts} - 1`, startedAt: null })
        .where(and(eq(ti.id, issue.id), eq(ti.startedAt, now))),
      db
        .update(o)
        .set({ availableAt: day + 86_400_000, dispatchedAt: null })
        .where(eq(o.id, job.id)),
    ]);
    return "kept";
  }
  const credential = await openCredential(
    deps.keys,
    connection.keyId,
    connection.id,
    connection.credentialBox,
  );
  if (credential === null) {
    await markAttention(db, connection, "key_unavailable", { type: "system" }, now);
    await failRequest(db, issue.id, "credential_rejected", now, now);
    return "done";
  }
  // An earlier attempt may have created the issue and lost the answer: look before creating.
  let outcome: Exclude<IssueCallOutcome, { kind: "absent" }> | null = null;
  if (claimed.attempts > 1) {
    const found = await findIssue(
      issue.service,
      credential,
      {
        target: issue.target,
        reference: issue.id,
        identity: connection.identity,
        requestedAt: issue.createdAt,
      },
      deps,
      connectionSite(connection),
    );
    if (found.kind !== "absent") outcome = found;
  }
  if (outcome === null) {
    const source = await issueSource(db, issue, deps.appOrigin);
    // The thread or the artifact went away, or moved, since the check: nothing is sent, and the
    // request ends on this run's claim so it is never requeued.
    if (!source) {
      await failRequest(db, issue.id, "thread_gone", now, now);
      return "done";
    }
    // Jira: the site was proven when the connection was checked; on the first attempt the job
    // proves it again, so no issue links to a name the cloud ID no longer serves. Retries do not
    // (one call fewer each); a site renamed within those hours is caught by the next request or
    // an admin's Test (decision 0018, "Addendum: Jira").
    const site = connectionSite(connection);
    if (issue.service === "jira" && site !== null && claimed.attempts === 1) {
      const proof = await verifyJiraSite(credential, site, deps);
      if (proof.kind === "other") {
        await markAttention(db, connection, "site_mismatch", { type: "system" }, now);
        await failRequest(db, issue.id, "site_changed", now, now);
        return "done";
      }
      if (proof.kind === "failed") {
        return settle(db, job, issue, connection, failedOutcome(proof.result), 1, now);
      }
    }
    outcome = await createIssue(
      issue.service,
      credential,
      {
        target: issue.target,
        // A pending request always has its title; it is cleared once the request ends.
        title: String(issue.title),
        source,
        parts: {
          link: issue.includeLink,
          artifactName: issue.includeName,
          quote: issue.includeQuote,
          message: issue.includeMessage,
        },
        issueType: target.issueType,
      },
      deps,
      connectionSite(connection),
    );
  }
  return settle(db, job, issue, connection, outcome, claimed.attempts, now);
}

/**
 * Whether the person who asked may still send this thread out, decided now as at request time:
 * the artifact is still the request's owner's, the person still acts for that owner (an admin or
 * editor; a deleted account never does) and reads the thread (`readableThread`). The owner side's
 * comment scope is every thread, so reading it is the same check every read path makes.
 */
async function requesterStanding(
  db: RegionalDb,
  issue: IssueRow,
  now: number,
): Promise<"ok" | "artifact_moved" | "requester_left" | "thread_gone"> {
  if (issue.requestedBy === null) return "requester_left";
  // The row cascades from its artifact, so the artifact is there; its owner may have changed.
  const owners = await db
    .select({ ownerId: schema.artifacts.ownerId })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, issue.artifactId));
  if (!owners.some((row) => row.ownerId === issue.ownerId)) return "artifact_moved";
  // The job runs in the background, which request policies never bind (decision 0020).
  const actor = await actorOn(db.global, issue.requestedBy, issue.ownerId);
  if (!actor.ok || !actsForOwner(actor.value, issue.ownerId)) return "requester_left";
  const readable = await readableThread(db, {
    userId: issue.requestedBy,
    artifactId: issue.artifactId,
    threadId: issue.threadId,
    now,
  });
  return readable.ok && readable.value.standing.role === "owner" ? "ok" : "thread_gone";
}

/** What the body is built from, read when the job sends: never stored with the request. */
async function issueSource(db: RegionalDb, issue: IssueRow, appOrigin: string) {
  const th = schema.annotationThreads;
  const m = schema.annotationMessages;
  const a = schema.artifacts;
  const [row] = await db
    .select({ target: th.target, path: th.path, artifactId: a.id, name: a.name })
    .from(th)
    .innerJoin(a, eq(a.id, th.artifactId))
    .where(and(eq(th.id, issue.threadId), eq(a.ownerId, issue.ownerId)))
    .limit(1);
  if (!row) return null;
  // The first message only while it is visible: a hidden or deleted one is left out.
  const [first] = issue.includeMessage
    ? await db
        .select({ body: m.body, state: m.state })
        .from(m)
        .where(eq(m.threadId, issue.threadId))
        .orderBy(asc(m.createdAt), sql`${m}.rowid`)
        .limit(1)
    : [];
  let target: unknown = null;
  try {
    target = JSON.parse(row.target);
  } catch {
    target = null;
  }
  return {
    service: issue.service,
    link: threadLink(appOrigin, row.artifactId, row.path, issue.threadId),
    artifactName: row.name,
    quote: anchorQuote(target),
    message: first && first.state === "visible" ? first.body : null,
    reference: issue.id,
  };
}

/** Records how the attempt ended: the link, a retry later, or a failure for the person. */
async function settle(
  db: RegionalDb,
  job: OutboxRow,
  issue: IssueRow,
  connection: typeof c.$inferSelect,
  outcome: Exclude<IssueCallOutcome, { kind: "absent" }>,
  attempt: number,
  now: number,
): Promise<JobOutcome> {
  const mine = and(eq(ti.id, issue.id), eq(ti.state, "pending"), eq(ti.startedAt, now)) as SQL;
  if (outcome.kind === "created") {
    await db.batch([
      // Before the update, on this run's claim: which parts left Portifact, never their text.
      auditEvent(
        db,
        {
          ownerId: issue.ownerId,
          kind: "issue.created",
          // Checked before the attempt: the person who asked still acts for the owner.
          actor: { type: "user", id: String(issue.requestedBy) },
          targetId: issue.artifactId,
          artifactId: issue.artifactId,
          detail: {
            service: issue.service,
            target: issue.target,
            link: issue.includeLink,
            artifactName: issue.includeName,
            quote: issue.includeQuote,
            message: issue.includeMessage,
          },
          now,
        },
        sql`exists (select 1 from ${ti} where ${mine})`,
      ),
      db
        .update(ti)
        .set({
          state: "created",
          issueKey: outcome.key,
          issueUrl: outcome.url,
          title: null,
          startedAt: null,
          completedAt: now,
        })
        .where(mine),
    ]);
    return "done";
  }
  const verdict = outcome.verdict;
  const failure = verdict.failure ?? "invalid_response";
  if (failure === "credential_rejected") {
    await markAttention(db, connection, "credential_rejected", { type: "system" }, now);
  }
  const next = verdict.retryable ? nextIssueAttemptAt(attempt, now) : null;
  if (next !== null) {
    await db.batch([
      db.update(ti).set({ startedAt: null }).where(mine),
      db.update(o).set({ availableAt: next, dispatchedAt: null }).where(eq(o.id, job.id)),
    ]);
    return "kept";
  }
  await failRequest(db, issue.id, failure, now, now);
  return "done";
}

/** The plain reason shown with a failed request, in English (the API's and CLI's text). */
export function threadIssueFailureMessage(failure: ThreadIssueFailure): string {
  return ISSUE_FAILURE_MESSAGES[failure];
}

/** Clears who asked for issues, for the batches that delete an account. */
export function forgetIssueRequester(db: Db, userId: string) {
  return db.update(ti).set({ requestedBy: null }).where(eq(ti.requestedBy, userId));
}

/** Pending requests whose job went missing get one again (the safety net of the outbox). */
export async function requeueThreadIssues(db: RegionalDb, now: number, limit = 200) {
  const requeued = await db
    .insert(o)
    .select(
      sql`select null, 'thread_issue', '{}', ${now}, null, 0, ${now}, ${ti.id}, null from ${ti} where ${ti.state} = 'pending' and ${ti.createdAt} <= ${now - 3_600_000} and not exists (select 1 from ${o} where ${o.topic} = 'thread_issue' and ${o.subject} = ${ti.id}) limit ${limit}`,
    )
    .returning({ id: o.id });
  return requeued.length;
}
