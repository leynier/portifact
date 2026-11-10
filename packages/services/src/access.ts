// The owner's access policy of an artifact (plan section 5): read it, and change the mode, the
// reader list, indexing, embedding, the Portifact bar and who sees the comments (plan section 8)
// in one transaction. Every change but the bar and comment visibility bumps the policy
// generation, which read sessions carry, so a revocation applies quickly.
import {
  type AccessAudience,
  type AccessMode,
  type ArtifactGroupView,
  type CommentScope,
  type CommentVisibility,
  isWorkspaceAccessMode,
  isWorkspaceId,
  LIMITS,
  type ReaderCommentVisibility,
} from "@portifact/contracts";
import { type Db, type RegionalDb, schema } from "@portifact/db";
import {
  type Actor,
  authorize,
  checkAccessChange,
  checkArtifactGroups,
  checkCommentVisibilityChange,
  checkPolicyAccess,
  checkPolicyReaders,
  emailDomains,
  entitlements,
  fail,
  ok,
  type Result,
  requireFeature,
  seesReaders,
} from "@portifact/domain";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { actorAndPlanOn, authorizeOn } from "./actors.ts";
import { approvalAccessStatements } from "./approval-reviews.ts";
import { auditEvent } from "./audit.ts";
import { ownerPlanRecord } from "./plans.ts";
import { markWebhookEvent } from "./webhook-activity.ts";
import { accessAudience } from "./workspace-domains.ts";
import { artifactGroupRows, groupSummaries } from "./workspace-groups.ts";

export interface AccessPolicyState {
  mode: AccessMode;
  readers: string[];
  indexable: boolean;
  embeddable: boolean;
  bar: boolean;
  commentVisibility: CommentVisibility;
  /** Readers with an exception to `commentVisibility`, by address. */
  readerCommentVisibility: { email: string; commentVisibility: CommentScope }[];
  policyGeneration: number;
  /** Who the workspace modes reach on the owner; null for a personal artifact. */
  audience: AccessAudience | null;
  /** Groups of the owning workspace the artifact lists (decision 0014). */
  groups: ArtifactGroupView[];
}

export interface AccessChange {
  mode?: AccessMode | undefined;
  indexable?: boolean | undefined;
  embeddable?: boolean | undefined;
  bar?: boolean | undefined;
  /** Lowercased email addresses. */
  addReaders?: readonly string[] | undefined;
  removeReaders?: readonly string[] | undefined;
  commentVisibility?: CommentVisibility | undefined;
  /** Exceptions for readers on the list after this change; `inherit` drops one. */
  readerCommentVisibility?:
    | readonly { email: string; commentVisibility: ReaderCommentVisibility }[]
    | undefined;
  /** Groups of the artifact's workspace, by ID (decision 0014). */
  addGroups?: readonly string[] | undefined;
  removeGroups?: readonly string[] | undefined;
  /** Exceptions for groups on the artifact after this change; `inherit` drops one. */
  groupCommentVisibility?:
    | readonly { group: string; commentVisibility: ReaderCommentVisibility }[]
    | undefined;
}

/**
 * Whether a change can narrow or widen who reads or how the artifact is delivered to other
 * sites. Only those end read and review sessions (the generation moves); the Portifact bar and
 * who sees the comments change neither, so they keep every reader's sessions (the annotation
 * services check comment visibility on every request and inside every write). The update is still
 * conditioned on the generation read, so it conflicts with a concurrent access change.
 */
function changesAccess(change: AccessChange): boolean {
  return (
    change.mode !== undefined ||
    change.indexable !== undefined ||
    change.embeddable !== undefined ||
    (change.addReaders?.length ?? 0) > 0 ||
    (change.removeReaders?.length ?? 0) > 0 ||
    (change.addGroups?.length ?? 0) > 0 ||
    (change.removeGroups?.length ?? 0) > 0
  );
}

type PlanRow = Parameters<typeof entitlements>[0];

/**
 * The `workspace` and `domain` modes (decision 0010) exist only for workspace artifacts, need
 * `workspaces` in the owner's plan, and `domain` needs a verified domain. Checked after
 * authorization, only when switching to one of them: narrowing never needs the plan.
 */
async function checkWorkspaceMode(
  db: RegionalDb,
  ownerId: string,
  mode: AccessMode,
  owner: ReturnType<typeof entitlements>,
): Promise<Result<true>> {
  if (!isWorkspaceAccessMode(mode)) return ok(true);
  if (!isWorkspaceId(ownerId)) {
    return fail(
      "invalid_input",
      "Only workspace artifacts can be shared with a workspace or an email domain.",
    );
  }
  const gate = requireFeature(owner, "workspaces");
  if (!gate.ok) return gate;
  if (mode === "domain") {
    const audience = await accessAudience(db.global, ownerId, owner);
    if (!audience || audience.domains.length === 0) {
      return fail(
        "invalid_input",
        "Verify an email domain on the workspace's Members page before sharing with it.",
      );
    }
  }
  return ok(true);
}

const missing = () => fail<never>("not_found", "Artifact not found.");

/**
 * The artifact and the actor managing its access: an admin or editor of its owner. A user with
 * no role on the owner, or an artifact being deleted, looks the same as a missing one.
 */
async function loadManaged(
  db: RegionalDb,
  userId: string,
  artifactId: string,
): Promise<
  Result<{ artifact: typeof schema.artifacts.$inferSelect; actor: Actor; plan: PlanRow }>
> {
  const [artifact] = await db
    .select()
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, artifactId))
    .limit(1);
  if (!artifact || artifact.state === "deleted" || artifact.state === "purging") return missing();
  // The owner's plan is global (decision 0005): read in the membership's own batch, so the
  // webhook event costs no read.
  const { actor, plan } = await actorAndPlanOn(db.global, userId, artifact);
  if (!actor) return missing();
  const authorized = authorize(actor, "access");
  if (!authorized.ok) return authorized;
  return ok({ artifact, actor: authorized.value, plan });
}

async function readerRows(db: Db, artifactId: string) {
  return db
    .select({
      email: schema.artifactReaders.email,
      commentVisibility: schema.artifactReaders.commentVisibility,
    })
    .from(schema.artifactReaders)
    .where(eq(schema.artifactReaders.artifactId, artifactId))
    .orderBy(schema.artifactReaders.email);
}

async function readers(db: Db, artifactId: string): Promise<string[]> {
  return (await readerRows(db, artifactId)).map((row) => row.email);
}

export async function getAccess(
  db: RegionalDb,
  input: { userId: string; artifactId: string; now?: number | undefined },
): Promise<Result<AccessPolicyState>> {
  const loaded = await loadManaged(db, input.userId, input.artifactId);
  if (!loaded.ok) return loaded;
  const { artifact, actor } = loaded.value;
  // A token without `artifacts:share` reads the policy without the readers' addresses or groups.
  const sees = seesReaders(actor.token);
  const rows = sees ? await readerRows(db, artifact.id) : [];
  const groups = sees ? await groupViews(db, artifact.ownerId, artifact.id) : [];
  const audience = await accessAudience(
    db.global,
    artifact.ownerId,
    entitlements(loaded.value.plan, input.now ?? Date.now()),
  );
  return ok({
    mode: artifact.accessMode,
    readers: rows.map((row) => row.email),
    indexable: artifact.indexable,
    embeddable: artifact.embeddable,
    bar: artifact.bar,
    commentVisibility: artifact.commentVisibility,
    readerCommentVisibility: rows.flatMap((row) =>
      row.commentVisibility === null
        ? []
        : [{ email: row.email, commentVisibility: row.commentVisibility }],
    ),
    policyGeneration: artifact.policyGeneration,
    audience,
    groups,
  });
}

/**
 * The groups an artifact lists, with their current names and member counts (global) and their
 * exceptions (regional), by name. A listed group that was deleted is left out: it grants nothing
 * and the maintenance scan removes its row.
 */
async function groupViews(
  db: RegionalDb,
  ownerId: string,
  artifactId: string,
): Promise<ArtifactGroupView[]> {
  if (!isWorkspaceId(ownerId)) return [];
  const rows = await artifactGroupRows(db, artifactId);
  const summaries = await groupSummaries(
    db.global,
    ownerId,
    rows.map((row) => row.groupId),
  );
  return rows
    .flatMap((row) => {
      const summary = summaries.get(row.groupId);
      return summary
        ? [
            {
              id: row.groupId,
              name: summary.name,
              members: summary.members,
              commentVisibility: row.commentVisibility,
            },
          ]
        : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * Checks the groups of a change against the artifact (decision 0014): only a workspace artifact
 * lists groups, adding one needs `workspaces` in the owner's plan and a group of that workspace,
 * at most `WORKSPACE_GROUPS.perArtifact` stay listed, and an exception names a group that is
 * listed after the change. Removing never needs the plan. Returns the groups to add and remove.
 */
async function checkGroupChange(
  db: RegionalDb,
  artifact: { id: string; ownerId: string },
  change: AccessChange,
  owner: ReturnType<typeof entitlements>,
): Promise<
  Result<{ add: string[]; remove: string[]; stale: string[]; after: string[] | undefined }>
> {
  const add = [...new Set(change.addGroups ?? [])];
  const remove = [...new Set(change.removeGroups ?? [])].filter((id) => !add.includes(id));
  const exceptions = change.groupCommentVisibility ?? [];
  if (add.length === 0 && remove.length === 0 && exceptions.length === 0) {
    return ok({ add, remove, stale: [], after: undefined });
  }
  // Rows whose group was deleted grant nothing and are not shown: they do not count toward the
  // cap, and this change removes them (decision 0014, "Data and regions").
  const listed = (await artifactGroupRows(db, artifact.id)).map((row) => row.groupId);
  const alive = isWorkspaceId(artifact.ownerId)
    ? await groupSummaries(db.global, artifact.ownerId, listed)
    : new Map();
  const current = listed.filter((id) => alive.has(id));
  const stale = listed.filter((id) => !alive.has(id) && !add.includes(id));
  const adding = add.filter((id) => !current.includes(id));
  const after = new Set([...current.filter((id) => !remove.includes(id)), ...add]);
  const allowed = checkArtifactGroups({
    ownerId: artifact.ownerId,
    adding: adding.length > 0,
    after: after.size,
  });
  if (!allowed.ok) return allowed;
  if (adding.length > 0) {
    const gate = requireFeature(owner, "workspaces");
    if (!gate.ok) return gate;
    const known = await groupSummaries(db.global, artifact.ownerId, adding);
    const unknown = adding.find((id) => !known.has(id));
    if (unknown) return fail("invalid_input", `${unknown} is not a group of this workspace.`);
  }
  // An exception belongs to a group on the artifact; it never adds one.
  const unlisted = exceptions.find((entry) => !after.has(entry.group));
  if (unlisted) {
    return fail(
      "invalid_input",
      `${unlisted.group} is not on the artifact. Add the group before choosing what it sees.`,
    );
  }
  return ok({ add, remove, stale, after: [...after] });
}

/**
 * Applies a change to the policy. The artifact update is conditional on the generation read, and
 * reader writes are conditional on that update having happened, so a concurrent change gives a
 * clean `version_conflict` with nothing half-applied.
 */
export async function updateAccess(
  db: RegionalDb,
  input: { userId: string; artifactId: string; change: AccessChange; now: number },
): Promise<Result<AccessPolicyState>> {
  const loaded = await loadManaged(db, input.userId, input.artifactId);
  if (!loaded.ok) return loaded;
  const { artifact, actor } = loaded.value;
  const owner = entitlements(loaded.value.plan, input.now);
  if (artifact.state === "suspended") {
    return fail("forbidden", "This artifact is suspended; its access cannot change.");
  }
  const { change } = input;
  const visibility = checkCommentVisibilityChange(actor.token, change);
  if (!visibility.ok) return visibility;
  // Widening the audience is checked against the age of the account making the change (the
  // owner's, in a personal space); narrowing it never is.
  if (change.mode && change.mode !== artifact.accessMode) {
    // The workspace's policy (decision 0015), read with the actor, first: it binds admins and
    // tokens too, and refusing here costs no read.
    const policy = checkPolicyAccess(actor.policy, change.mode);
    if (!policy.ok) return policy;
    // A service token has no account: its own age counts (decision 0011).
    const [actingUser] = actor.token
      ? [{ createdAt: new Date(actor.token.createdAt) }]
      : await db.global
          .select({ createdAt: schema.users.createdAt })
          .from(schema.users)
          .where(eq(schema.users.id, actor.userId))
          .limit(1);
    const allowed = checkAccessChange(
      change.mode,
      actingUser?.createdAt ?? new Date(input.now),
      new Date(input.now),
    );
    if (!allowed.ok) return allowed;
    const workspaceMode = await checkWorkspaceMode(db, artifact.ownerId, change.mode, owner);
    if (!workspaceMode.ok) return workspaceMode;
  }
  const add = [...new Set(change.addReaders ?? [])];
  const remove = [...new Set(change.removeReaders ?? [])].filter((email) => !add.includes(email));
  const exceptions = change.readerCommentVisibility ?? [];
  const readerPolicy = checkPolicyReaders(actor.policy, add);
  if (!readerPolicy.ok) return readerPolicy;
  if (add.length > 0 || exceptions.length > 0) {
    const current = await readers(db, artifact.id);
    const after = new Set([...current.filter((email) => !remove.includes(email)), ...add]);
    if (after.size > LIMITS.readersPerArtifact) {
      return fail(
        "quota_exceeded",
        `An artifact can list at most ${LIMITS.readersPerArtifact} readers.`,
      );
    }
    // An exception belongs to a reader on the list; it never adds one.
    const unlisted = exceptions.find((entry) => !after.has(entry.email));
    if (unlisted) {
      return fail(
        "invalid_input",
        `${unlisted.email} is not on the reader list. Add the reader before choosing what they see.`,
      );
    }
  }

  const groupChange = await checkGroupChange(db, artifact, change, owner);
  if (!groupChange.ok) return groupChange;
  const {
    add: addGroups,
    remove: removeGroups,
    stale: staleGroups,
    after: groupsAfter,
  } = groupChange.value;
  const groupExceptions = change.groupCommentVisibility ?? [];

  const unchangedPolicy = sql`exists (select 1 from ${schema.artifacts} where ${schema.artifacts.id} = ${artifact.id} and ${schema.artifacts.ownerId} = ${artifact.ownerId} and ${schema.artifacts.policyGeneration} = ${artifact.policyGeneration})`;
  // Approval reviewers who would no longer take part stop counting with this change, in its
  // batch and on its condition (decision 0013).
  const modeChanges = change.mode !== undefined && change.mode !== artifact.accessMode;
  const reviewDrops =
    remove.length > 0 || modeChanges || removeGroups.length > 0
      ? await approvalAccessStatements(db, {
          artifact,
          policy: {
            mode: change.mode ?? artifact.accessMode,
            readers: [
              ...(await readers(db, artifact.id)).filter((email) => !remove.includes(email)),
              ...add,
            ],
            // A group removed with this change stops admitting its members as reviewers in the
            // same batch, like a removed reader (decision 0014).
            ...(groupsAfter === undefined ? {} : { groups: groupsAfter }),
          },
          owner,
          condition: unchangedPolicy,
          now: input.now,
        })
      : [];
  // Reader writes run first, conditioned on the generation this request read, and the guarded
  // update runs last in the same transaction. A concurrent change that committed first moved the
  // generation, so this one skips its reader writes and its update matches no row.
  // The same owner too: a transfer in between means the role was decided on another owner.
  const unchanged = sql`exists (select 1 from ${schema.artifacts} where ${schema.artifacts.id} = ${artifact.id} and ${schema.artifacts.ownerId} = ${artifact.ownerId} and ${schema.artifacts.policyGeneration} = ${artifact.policyGeneration})`;
  const statements: BatchItem<"sqlite">[] = [
    ...(remove.length > 0
      ? [
          db
            .delete(schema.artifactReaders)
            .where(
              and(
                eq(schema.artifactReaders.artifactId, artifact.id),
                inArray(schema.artifactReaders.email, remove),
                unchanged,
              ),
            ),
        ]
      : []),
    ...add.map((email) =>
      db
        .insert(schema.artifactReaders)
        // Columns in schema order: artifact, email, created, comment visibility (inherited).
        .select(sql`select ${artifact.id}, ${email}, ${input.now}, null where ${unchanged}`)
        .onConflictDoNothing(),
    ),
    // After the inserts, so an exception can go with the reader it is for.
    ...exceptions.map((entry) =>
      db
        .update(schema.artifactReaders)
        .set({
          commentVisibility: entry.commentVisibility === "inherit" ? null : entry.commentVisibility,
        })
        .where(
          and(
            eq(schema.artifactReaders.artifactId, artifact.id),
            eq(schema.artifactReaders.email, entry.email),
            unchanged,
          ),
        ),
    ),
    // Groups (decision 0014), like readers: removals, inserts, then exceptions.
    ...(removeGroups.length + staleGroups.length > 0
      ? [
          db
            .delete(schema.artifactGroups)
            .where(
              and(
                eq(schema.artifactGroups.artifactId, artifact.id),
                inArray(schema.artifactGroups.groupId, [...removeGroups, ...staleGroups]),
                unchanged,
              ),
            ),
        ]
      : []),
    ...addGroups.map((groupId) =>
      db
        .insert(schema.artifactGroups)
        // Columns in schema order: artifact, group, comment visibility (inherited), created,
        // checked.
        .select(sql`select ${artifact.id}, ${groupId}, null, ${input.now}, null where ${unchanged}`)
        .onConflictDoNothing(),
    ),
    ...groupExceptions.map((entry) =>
      db
        .update(schema.artifactGroups)
        .set({
          commentVisibility: entry.commentVisibility === "inherit" ? null : entry.commentVisibility,
        })
        .where(
          and(
            eq(schema.artifactGroups.artifactId, artifact.id),
            eq(schema.artifactGroups.groupId, entry.group),
            unchanged,
          ),
        ),
    ),
    // Before the guarded update and on the same old state: the event exists exactly when the
    // change does. Only changes that move the generation are access changes for webhooks.
    ...(changesAccess(change)
      ? markWebhookEvent(db, {
          entitlements: owner,
          ownerId: artifact.ownerId,
          artifactId: artifact.id,
          type: "artifact.access_changed",
          actorId: actor.userId,
          access: change.mode ?? artifact.accessMode,
          now: input.now,
          condition: unchanged,
        })
      : []),
    ...reviewDrops,
    ...accessAuditEvent(db, {
      artifact,
      actorId: actor.userId,
      change,
      added: add,
      removed: remove,
      exceptions: exceptions.length,
      groupsAdded: addGroups.length,
      groupsRemoved: removeGroups.length,
      groupExceptions: groupExceptions.length,
      now: input.now,
      condition: unchanged,
    }),
    db
      .update(schema.artifacts)
      .set({
        ...(change.mode ? { accessMode: change.mode } : {}),
        ...(change.indexable === undefined ? {} : { indexable: change.indexable }),
        ...(change.embeddable === undefined ? {} : { embeddable: change.embeddable }),
        ...(change.bar === undefined ? {} : { bar: change.bar }),
        ...(change.commentVisibility === undefined
          ? {}
          : { commentVisibility: change.commentVisibility }),
        policyGeneration: artifact.policyGeneration + (changesAccess(change) ? 1 : 0),
        updatedAt: input.now,
      })
      .where(
        and(
          eq(schema.artifacts.id, artifact.id),
          eq(schema.artifacts.policyGeneration, artifact.policyGeneration),
        ),
      )
      .returning({ id: schema.artifacts.id }),
  ];
  // The update always closes the list, so the batch is never empty.
  const results = await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  const update = results.at(-1) as { id: string }[];
  if (update.length === 0) {
    return fail("version_conflict", "The access policy changed meanwhile. Try again.");
  }
  await db.insert(schema.lifecycleEvents).values({
    artifactId: artifact.id,
    actorId: actor.userId,
    channel: "system",
    event: "access_changed",
    details: {
      ...(change.mode ? { mode: change.mode } : {}),
      added: add.length,
      removed: remove.length,
      ...(change.commentVisibility ? { commentVisibility: change.commentVisibility } : {}),
      ...(exceptions.length > 0 ? { readerExceptions: exceptions.length } : {}),
      ...(addGroups.length > 0 ? { groupsAdded: addGroups.length } : {}),
      ...(removeGroups.length > 0 ? { groupsRemoved: removeGroups.length } : {}),
      ...(groupExceptions.length > 0 ? { groupExceptions: groupExceptions.length } : {}),
    },
    at: input.now,
  });
  return getAccess(db, input);
}

/**
 * The audit event of an access change, before the guarded update on the same old state: what
 * changed, readers as counts and the domains of their addresses, never the addresses. Nothing when
 * the change changes nothing.
 */
function accessAuditEvent(
  db: Db,
  input: {
    artifact: {
      id: string;
      ownerId: string;
      accessMode: AccessMode;
      bar: boolean;
      indexable: boolean;
      embeddable: boolean;
      commentVisibility: CommentVisibility;
    };
    actorId: string;
    change: AccessChange;
    added: string[];
    removed: string[];
    exceptions: number;
    groupsAdded: number;
    groupsRemoved: number;
    groupExceptions: number;
    now: number;
    condition: SQL;
  },
): BatchItem<"sqlite">[] {
  const { artifact, change } = input;
  const differs = <T>(next: T | undefined, current: T) =>
    next !== undefined && next !== current ? { value: next } : null;
  const mode = differs(change.mode, artifact.accessMode);
  const bar = differs(change.bar, artifact.bar);
  const indexable = differs(change.indexable, artifact.indexable);
  const embeddable = differs(change.embeddable, artifact.embeddable);
  const commentVisibility = differs(change.commentVisibility, artifact.commentVisibility);
  const detail = {
    ...(mode ? { mode: mode.value } : {}),
    ...(input.added.length > 0 ? { readersAdded: input.added.length } : {}),
    ...(input.removed.length > 0 ? { readersRemoved: input.removed.length } : {}),
    ...(input.added.length + input.removed.length > 0
      ? { readerDomains: emailDomains([...input.added, ...input.removed]) }
      : {}),
    ...(input.exceptions > 0 ? { readerExceptions: input.exceptions } : {}),
    ...(input.groupsAdded > 0 ? { groupsAdded: input.groupsAdded } : {}),
    ...(input.groupsRemoved > 0 ? { groupsRemoved: input.groupsRemoved } : {}),
    ...(input.groupExceptions > 0 ? { groupExceptions: input.groupExceptions } : {}),
    ...(bar ? { bar: bar.value } : {}),
    ...(commentVisibility ? { commentVisibility: commentVisibility.value } : {}),
    ...(indexable ? { indexable: indexable.value } : {}),
    ...(embeddable ? { embeddable: embeddable.value } : {}),
  };
  if (Object.keys(detail).length === 0) return [];
  return [
    auditEvent(
      db,
      {
        ownerId: artifact.ownerId,
        kind: "access.changed",
        actor: { type: "user", id: input.actorId },
        targetId: artifact.id,
        artifactId: artifact.id,
        detail,
        now: input.now,
      },
      input.condition,
    ),
  ];
}
