// A space's open feedback (premium plan T9): the open threads of every artifact of one owner that
// the caller sees, newest activity first, in one query per page. There is no privileged path:
// `feedbackReach` (domain) turns the per-artifact rules (access, the artifact's state and comment
// mode, the comment scope) into conditions on the artifact and thread rows, so the listing holds
// exactly the threads the per-artifact list (`listAnnotations` with the current version and the
// `open` state) would show the caller on each artifact. Threads outside them are never listed,
// counted or used for a cursor.
//
// The page is read with `annotation_threads_owner_state_updated_idx` (owner, state, updated_at,
// id), joined to each thread's artifact by its primary key, so a page reads the owner's open
// threads in order until it is full and never sorts them all.
import { type FeedbackArtifact, isServiceTokenId, isWorkspaceId } from "@portifact/contracts";
import { type RegionalDb, schema } from "@portifact/db";
import type { AnnotationRole } from "@portifact/domain";
import {
  type Actor,
  actsForOwner,
  decodeFeedbackCursor,
  encodeFeedbackCursor,
  type FeedbackReach,
  fail,
  feedbackReach,
  ok,
  type Result,
  requireFeature,
} from "@portifact/domain";
import { and, desc, eq, getTableColumns, gt, inArray, lt, or, type SQL, sql } from "drizzle-orm";
import { ownerSide } from "./actors.ts";
import { ownerEntitlements } from "./plans.ts";
import { type ThreadRow, threadViews } from "./thread-views.ts";
import { policyDomains } from "./workspace-domains.ts";
import { groupScopeSql, viewerGroupIds } from "./workspace-groups.ts";

export interface FeedbackInput {
  /** The caller acting on the space (from `resolveOwnerScope`). */
  actor: Actor;
  cursor?: string | undefined;
  limit: number;
  /** Only threads with activity after this time (milliseconds). */
  since?: number | undefined;
  /** Only threads the caller wrote in, or on artifacts the caller published. */
  mine?: boolean | undefined;
  now: number;
}

export interface FeedbackEntry {
  artifact: Omit<FeedbackArtifact, "url"> & { customHost: string | null };
  thread: Awaited<ReturnType<typeof threadViews>>[number];
  counts: { messages: number; artifactOpenThreads: number };
}

export interface FeedbackResult {
  role: AnnotationRole;
  items: FeedbackEntry[];
  nextCursor: string | null;
}

const th = schema.annotationThreads;
const t = schema.artifacts;
const r = schema.artifactReaders;
const ag = schema.artifactGroups;
const m = schema.annotationMessages;

interface Caller {
  userId: string;
  verifiedEmail: string | null;
  reach: FeedbackReach;
  ownerSide: readonly string[];
}

/** Values of fixed enums, written into the SQL as literals so they bind no parameter. */
function literals(values: readonly string[]): SQL {
  return sql.raw(values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", "));
}

/** The artifact's state as the rules see it: an active artifact past its expiry is archived. */
function effectiveStateSql(now: number): SQL {
  return sql`case when ${t.state} = 'active' and ${t.expiresAt} is not null and ${t.expiresAt} <= ${now} then 'archived' else ${t.state} end`;
}

/** Conditions every listed thread meets, whatever the page. */
function visibleThreads(caller: Caller, input: FeedbackInput): SQL {
  const { reach } = caller;
  const owner = input.actor.ownerId;
  const pairs = reach.readable.map(
    ({ state, mode }) => sql`(${literals([state])}, ${literals([mode])})`,
  );
  const readable =
    pairs.length === 0
      ? sql`0`
      : sql`(${effectiveStateSql(input.now)}, ${t.annotations}) in (values ${sql.join(pairs, sql`, `)})`;
  return and(
    eq(th.ownerId, owner),
    eq(th.state, "open"),
    eq(t.ownerId, owner),
    // Visitors see only the current version's threads; the listing is the current version's for
    // everyone, like the per-artifact list's default.
    eq(th.versionId, t.currentVersionId),
    readable,
    accessCondition(caller),
    scopeCondition(caller),
    input.since === undefined ? undefined : gt(th.updatedAt, input.since),
    input.mine ? mineCondition(caller.userId) : undefined,
  ) as SQL;
}

/** The artifact's access policy admits the caller (`canRead`). */
function accessCondition(caller: Caller): SQL | undefined {
  const { reach, verifiedEmail } = caller;
  if (reach.openModes === null) return undefined;
  const open =
    reach.openModes.length === 0 ? sql`0` : sql`${t.accessMode} in (${literals(reach.openModes)})`;
  const listed: SQL[] = [];
  if (reach.readerList && verifiedEmail !== null) {
    listed.push(
      sql`exists (select 1 from ${r} where ${r.artifactId} = ${t.id} and ${r.email} = ${verifiedEmail})`,
    );
  }
  // A group the artifact lists and the caller belongs to (decision 0014).
  if (reach.groupList) {
    listed.push(
      sql`exists (select 1 from ${ag} where ${ag.artifactId} = ${t.id} and ${inArray(ag.groupId, [...reach.groups])})`,
    );
  }
  if (listed.length === 0) return open;
  return sql`(${open} or (${t.accessMode} = 'restricted' and (${sql.join(listed, sql` or `)})))`;
}

/**
 * The thread is in the caller's comment scope (`commentScope`, `threadInScope`): they or the owner
 * started it, or their exception on the reader list (by verified address), else the widest scope
 * of the listed groups they belong to, else the artifact's setting, shows them every thread. The
 * same rule as the per-artifact `scopeGuard`.
 */
function scopeCondition(caller: Caller): SQL | undefined {
  const { reach, verifiedEmail } = caller;
  if (reach.role === "owner") return undefined;
  const setting = sql`case ${t.commentVisibility} when 'everyone' then ${literals([reach.scopeOf.everyone])} else ${literals([reach.scopeOf.owner])} end`;
  const reader =
    verifiedEmail === null
      ? sql`null`
      : sql`(select ${r.commentVisibility} from ${r} where ${r.artifactId} = ${t.id} and ${r.email} = ${verifiedEmail})`;
  const scope = sql`coalesce(${reader}, ${groupScopeSql(t.id, reach.groups, setting)}, ${setting})`;
  return or(inArray(th.authorId, [caller.userId, ...caller.ownerSide]), sql`${scope} = 'all'`);
}

/** Threads the caller started or replied to, or on artifacts the caller published. */
function mineCondition(userId: string): SQL {
  return sql`(${th.authorId} = ${userId} or ${t.createdBy} = ${userId} or exists (select 1 from ${m} where ${m.threadId} = ${th.id} and ${m.authorId} = ${userId} and ${m.state} <> 'deleted'))`;
}

/** The caller's verified address, which the reader list and its exceptions match. */
async function verifiedEmailOf(db: RegionalDb, userId: string): Promise<string | null> {
  const [user] = await db.global
    .select({ email: schema.users.email, emailVerified: schema.users.emailVerified })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return user?.emailVerified ? user.email.toLowerCase() : null;
}

/**
 * The open threads of the actor's space that the caller sees. A personal space needs no plan; a
 * workspace needs `workspaces` in the workspace's plan. A service token reads no comments
 * (decision 0011), so it gets an empty page, as every per-artifact list answers it like a missing
 * artifact.
 */
export async function listOpenFeedback(
  db: RegionalDb,
  input: FeedbackInput,
): Promise<Result<FeedbackResult>> {
  const owner = input.actor.ownerId;
  const entitlements = await ownerEntitlements(db.global, owner, input.now);
  if (isWorkspaceId(owner)) {
    const gate = requireFeature(entitlements, "workspaces");
    if (!gate.ok) return gate;
  }
  const after = input.cursor === undefined ? undefined : decodeFeedbackCursor(input.cursor);
  if (input.cursor !== undefined && !after) return fail("invalid_input", "Invalid cursor.");
  const userId = input.actor.userId;
  if (isServiceTokenId(userId)) return ok({ role: "participant", items: [], nextCursor: null });

  const verifiedEmail = await verifiedEmailOf(db, userId);
  const verifiedEmails = verifiedEmail === null ? [] : [verifiedEmail];
  const domains = await policyDomains(db.global, {
    mode: "domain",
    ownerId: owner,
    actor: input.actor,
    verifiedEmails,
    entitlements,
  });
  // The caller's groups in the workspace (one global read), which grant only while the plan
  // includes `workspaces`, like on each artifact (`viewerGroups`).
  const groupsAvailable = requireFeature(entitlements, "workspaces").ok;
  const groupIds =
    isWorkspaceId(owner) && groupsAvailable && !actsForOwner(input.actor, owner)
      ? [...(await viewerGroupIds(db.global, owner, userId))]
      : [];
  const caller: Caller = {
    userId,
    verifiedEmail,
    reach: feedbackReach(input.actor, { userId, verifiedEmails }, domains, {
      featureAvailable: groupsAvailable,
      ids: groupIds,
    }),
    ownerSide: await ownerSide(db.global, owner),
  };
  const visible = visibleThreads(caller, input);

  const rows = await db
    .select({
      thread: getTableColumns(th),
      artifact: {
        id: t.id,
        name: t.name,
        type: t.type,
        customHost: t.customHost,
        currentVersionId: t.currentVersionId,
      },
    })
    .from(th)
    .innerJoin(t, eq(t.id, th.artifactId))
    .where(
      and(
        visible,
        after
          ? or(
              lt(th.updatedAt, after.updatedAt),
              and(eq(th.updatedAt, after.updatedAt), lt(th.id, after.threadId)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(th.updatedAt), desc(th.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  if (page.length === 0) return ok({ role: caller.reach.role, items: [], nextCursor: null });

  const artifacts = new Map(page.map((row) => [row.artifact.id, row.artifact]));
  const views = await threadViews(
    db,
    {
      role: caller.reach.role,
      ownerSide: caller.ownerSide,
      currentVersionOf: (artifactId) => artifacts.get(artifactId)?.currentVersionId ?? null,
    },
    userId,
    page.map((row) => row.thread as ThreadRow),
  );
  const perArtifact = await db
    .select({ artifactId: th.artifactId, count: sql<number>`count(*)` })
    .from(th)
    .innerJoin(t, eq(t.id, th.artifactId))
    .where(and(visible, inArray(th.artifactId, [...artifacts.keys()])))
    .groupBy(th.artifactId);
  const counts = new Map(perArtifact.map((row) => [row.artifactId, Number(row.count)]));

  const items = page.map((row, index): FeedbackEntry => {
    const view = views[index] as FeedbackEntry["thread"];
    return {
      artifact: {
        id: row.artifact.id,
        name: row.artifact.name,
        type: row.artifact.type,
        customHost: row.artifact.customHost,
      },
      thread: view,
      counts: {
        messages: view.messages.filter((message) => message.state !== "deleted").length,
        artifactOpenThreads: counts.get(row.artifact.id) ?? 0,
      },
    };
  });
  const last = page.at(-1);
  return ok({
    role: caller.reach.role,
    items,
    nextCursor:
      rows.length > input.limit && last
        ? encodeFeedbackCursor({ updatedAt: last.thread.updatedAt, threadId: last.thread.id })
        : null,
  });
}
