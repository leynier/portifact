// The owner's access policy of an artifact (plan section 5): read it, and change the mode, the
// reader list, indexing, embedding, the Portifact bar and who sees the comments (plan section 8)
// in one transaction. Every change but the bar and comment visibility bumps the policy
// generation, which read sessions carry, so a revocation applies quickly.
import {
  type AccessMode,
  type CommentScope,
  type CommentVisibility,
  LIMITS,
  type ReaderCommentVisibility,
} from "@portifact/contracts";
import { type Db, schema } from "@portifact/db";
import { checkAccessChange, fail, ok, type Result } from "@portifact/domain";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

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

async function loadOwned(db: Db, ownerId: string, artifactId: string) {
  const [artifact] = await db
    .select()
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, artifactId))
    .limit(1);
  // Someone else's artifact, or one being deleted, looks the same as a missing one.
  if (!artifact || artifact.ownerId !== ownerId) return undefined;
  if (artifact.state === "deleted" || artifact.state === "purging") return undefined;
  return artifact;
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
  db: Db,
  input: { ownerId: string; artifactId: string },
): Promise<Result<AccessPolicyState>> {
  const artifact = await loadOwned(db, input.ownerId, input.artifactId);
  if (!artifact) return fail("not_found", "Artifact not found.");
  const rows = await readerRows(db, artifact.id);
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
  });
}

/**
 * Applies a change to the policy. The artifact update is conditional on the generation read, and
 * reader writes are conditional on that update having happened, so a concurrent change gives a
 * clean `version_conflict` with nothing half-applied.
 */
export async function updateAccess(
  db: Db,
  input: { ownerId: string; artifactId: string; change: AccessChange; now: number },
): Promise<Result<AccessPolicyState>> {
  const artifact = await loadOwned(db, input.ownerId, input.artifactId);
  if (!artifact) return fail("not_found", "Artifact not found.");
  if (artifact.state === "suspended") {
    return fail("forbidden", "This artifact is suspended; its access cannot change.");
  }
  const { change } = input;
  // Widening the audience is checked against the account age; narrowing it never is.
  if (change.mode && change.mode !== artifact.accessMode) {
    const [owner] = await db
      .select({ createdAt: schema.users.createdAt })
      .from(schema.users)
      .where(eq(schema.users.id, input.ownerId))
      .limit(1);
    const allowed = checkAccessChange(
      change.mode,
      owner?.createdAt ?? new Date(input.now),
      new Date(input.now),
    );
    if (!allowed.ok) return allowed;
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
  const unchanged = sql`exists (select 1 from ${schema.artifacts} where ${schema.artifacts.id} = ${artifact.id} and ${schema.artifacts.policyGeneration} = ${artifact.policyGeneration})`;
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
    actorId: input.ownerId,
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
