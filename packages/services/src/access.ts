// The owner's access policy of an artifact (plan section 5): read it, and change the mode, the
// reader list, indexing, embedding, the Portifact bar and who sees the comments (plan section 8)
// in one transaction. Every change but the bar and comment visibility bumps the policy
// generation, which read sessions carry, so a revocation applies quickly.
import {
  type AccessAudience,
  type AccessMode,
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
  checkAccessChange,
  checkCommentVisibilityChange,
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
import { authorizeOn } from "./actors.ts";
import { auditEvent } from "./audit.ts";
import { markWebhookEvent } from "./webhook-activity.ts";
import { accessAudience } from "./workspace-domains.ts";

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
    (change.removeReaders?.length ?? 0) > 0
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
  const p = schema.ownerPlans;
  const [row] = await db
    .select({
      artifact: schema.artifacts,
      // The owner's plan comes with the artifact, so the webhook event costs no read.
      plan: { plan: p.plan, seats: p.seats, validUntil: p.validUntil, overrides: p.overrides },
    })
    .from(schema.artifacts)
    .leftJoin(p, eq(p.ownerId, schema.artifacts.ownerId))
    .where(eq(schema.artifacts.id, artifactId))
    .limit(1);
  const artifact = row?.artifact;
  if (!artifact || artifact.state === "deleted" || artifact.state === "purging") return missing();
  const actor = await authorizeOn(db, userId, artifact, "access", missing);
  if (!actor.ok) return actor;
  return ok({ artifact, actor: actor.value, plan: row.plan });
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
  // A token without `artifacts:share` reads the policy without the readers' addresses.
  const rows = seesReaders(actor.token) ? await readerRows(db, artifact.id) : [];
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
  });
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
    ...accessAuditEvent(db, {
      artifact,
      actorId: actor.userId,
      change,
      added: add,
      removed: remove,
      exceptions: exceptions.length,
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
