// The owner's access policy of an artifact (plan section 5): read it, and change the mode, the
// reader list, indexing, embedding and the Portifact bar in one transaction. Every change but the
// bar bumps the policy generation, which read sessions carry, so a revocation applies quickly.
import { type AccessMode, LIMITS } from "@portifact/contracts";
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
}

/**
 * Whether a change can narrow or widen who reads or how the artifact is delivered to other
 * sites. Only those end read and review sessions (the generation moves); the Portifact bar
 * changes neither, so turning it on or off keeps every reader's sessions. The update is still
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

async function readers(db: Db, artifactId: string): Promise<string[]> {
  const rows = await db
    .select({ email: schema.artifactReaders.email })
    .from(schema.artifactReaders)
    .where(eq(schema.artifactReaders.artifactId, artifactId))
    .orderBy(schema.artifactReaders.email);
  return rows.map((row) => row.email);
}

export async function getAccess(
  db: Db,
  input: { ownerId: string; artifactId: string },
): Promise<Result<AccessPolicyState>> {
  const artifact = await loadOwned(db, input.ownerId, input.artifactId);
  if (!artifact) return fail("not_found", "Artifact not found.");
  return ok({
    mode: artifact.accessMode,
    readers: await readers(db, artifact.id),
    indexable: artifact.indexable,
    embeddable: artifact.embeddable,
    bar: artifact.bar,
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
  if (add.length > 0) {
    const current = await readers(db, artifact.id);
    const total = new Set([...current.filter((email) => !remove.includes(email)), ...add]).size;
    if (total > LIMITS.readersPerArtifact) {
      return fail(
        "quota_exceeded",
        `An artifact can list at most ${LIMITS.readersPerArtifact} readers.`,
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
        .select(sql`select ${artifact.id}, ${email}, ${input.now} where ${unchanged}`)
        .onConflictDoNothing(),
    ),
    db
      .update(schema.artifacts)
      .set({
        ...(change.mode ? { accessMode: change.mode } : {}),
        ...(change.indexable === undefined ? {} : { indexable: change.indexable }),
        ...(change.embeddable === undefined ? {} : { embeddable: change.embeddable }),
        ...(change.bar === undefined ? {} : { bar: change.bar }),
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
    },
    at: input.now,
  });
  return getAccess(db, input);
}
