// Owner actions on an artifact's lifecycle (plan section 10): renew, archive, restore and
// delete. Each transition is conditional on the state read and on the lifecycle generation, so
// it cannot race with maintenance jobs or another request.
import { type Db, schema } from "@portifact/db";
import {
  checkRestore,
  effectiveArchivedAt,
  fail,
  nextExpiry,
  ok,
  purgeDate,
  type Result,
} from "@portifact/domain";
import { and, eq, type SQL } from "drizzle-orm";
import { deleteArtifactData } from "./maintenance.ts";
import { OUTBOX_INLINE_GRACE_MS, purgeJobs } from "./outbox.ts";
import { ownerEntitlements } from "./plans.ts";

export interface LifecycleInput {
  ownerId: string;
  artifactId: string;
  now: number;
}

export interface LifecycleOutcome {
  state: "active" | "archived" | "deleted";
  expiresAt: number | null;
  purgeAt: number | null;
}

async function load(db: Db, input: LifecycleInput) {
  const [artifact] = await db
    .select()
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, input.artifactId))
    .limit(1);
  // Someone else's artifact looks the same as a missing one.
  return artifact && artifact.ownerId === input.ownerId ? artifact : null;
}

function record(artifact: { state: string; expiresAt: number | null; archivedAt: number | null }) {
  return {
    state: artifact.state as "active",
    expiresAt: artifact.expiresAt === null ? null : new Date(artifact.expiresAt),
    archivedAt: artifact.archivedAt === null ? null : new Date(artifact.archivedAt),
  };
}

const guard = (artifact: { id: string; state: string; lifecycleGeneration: number }) =>
  and(
    eq(schema.artifacts.id, artifact.id),
    eq(schema.artifacts.state, artifact.state as "active"),
    eq(schema.artifacts.lifecycleGeneration, artifact.lifecycleGeneration),
  );

const conflict = () =>
  fail<never>("version_conflict", "The artifact changed meanwhile. Try again.");

/** Restarts the 30 days of an active artifact. */
export async function renewArtifact(
  db: Db,
  input: LifecycleInput,
): Promise<Result<LifecycleOutcome>> {
  const artifact = await load(db, input);
  if (!artifact) return fail("not_found", "Artifact not found.");
  if (
    artifact.state !== "active" ||
    (artifact.expiresAt !== null && artifact.expiresAt <= input.now)
  ) {
    return fail("artifact_archived", "Only active artifacts can be renewed; restore it instead.");
  }
  const expiresAt = nextExpiry(new Date(input.now)).getTime();
  const updated = await db
    .update(schema.artifacts)
    .set({ expiresAt, lifecycleGeneration: artifact.lifecycleGeneration + 1, updatedAt: input.now })
    .where(guard(artifact))
    .returning({ id: schema.artifacts.id });
  if (updated.length === 0) return conflict();
  await logEvent(db, input, "renewed");
  return ok({ state: "active", expiresAt, purgeAt: null });
}

/** Archives an artifact now; it stops being served and its six months start. */
export async function archiveArtifact(
  db: Db,
  input: LifecycleInput,
): Promise<Result<LifecycleOutcome>> {
  const artifact = await load(db, input);
  if (!artifact) return fail("not_found", "Artifact not found.");
  if (artifact.state !== "active")
    return fail("invalid_input", "Only active artifacts can be archived.");
  // An artifact past its expiry is already archived from the expiry date.
  const archivedAt =
    effectiveArchivedAt(record(artifact), new Date(input.now))?.getTime() ?? input.now;
  const purgeAt = purgeDate(new Date(archivedAt)).getTime();
  const updated = await db
    .update(schema.artifacts)
    .set({
      state: "archived",
      archivedAt,
      purgeAt,
      lifecycleGeneration: artifact.lifecycleGeneration + 1,
      updatedAt: input.now,
    })
    .where(guard(artifact))
    .returning({ id: schema.artifacts.id });
  if (updated.length === 0) return conflict();
  await logEvent(db, input, "archived");
  return ok({ state: "archived", expiresAt: artifact.expiresAt, purgeAt });
}

/** Brings an archived artifact back for another 30 days, at the same URL and with the same access. */
export async function restoreArtifact(
  db: Db,
  input: LifecycleInput,
): Promise<Result<LifecycleOutcome>> {
  const artifact = await load(db, input);
  if (!artifact) return fail("not_found", "Artifact not found.");
  const [usage] = await db
    .select({ active: schema.accountUsage.activeArtifacts })
    .from(schema.accountUsage)
    .where(eq(schema.accountUsage.ownerId, input.ownerId))
    .limit(1);
  // An active artifact past its expiry already holds its slot, so it does not need a free one.
  const used = (usage?.active ?? 0) - (artifact.state === "active" ? 1 : 0);
  const owner = await ownerEntitlements(db, input.ownerId, input.now);
  const check = checkRestore(record(artifact), new Date(input.now), used, owner.limits);
  if (!check.ok) return check;
  const expiresAt = check.value.expiresAt.getTime();

  // An active artifact past its expiry still holds its slot (maintenance has not archived it),
  // so it only gets new dates; an archived one goes back to active and the trigger retakes the slot.
  try {
    const updated = await db
      .update(schema.artifacts)
      .set({
        state: "active",
        expiresAt,
        archivedAt: null,
        purgeAt: null,
        lifecycleGeneration: artifact.lifecycleGeneration + 1,
        updatedAt: input.now,
      })
      .where(guard(artifact))
      .returning({ id: schema.artifacts.id });
    if (updated.length === 0) return conflict();
  } catch (error) {
    if (String((error as Error)?.cause ?? error).includes("CHECK constraint failed")) {
      return fail(
        "quota_exceeded",
        `You already have ${owner.limits.activeArtifacts} active artifacts.`,
      );
    }
    throw error;
  }
  await logEvent(db, input, "restored");
  return ok({ state: "active", expiresAt, purgeAt: null });
}

/** Deletes an artifact permanently: its content, sources, readers and history. Not reversible. */
export async function deleteArtifact(
  db: Db,
  bucket: R2Bucket,
  input: LifecycleInput,
): Promise<Result<LifecycleOutcome>> {
  const artifact = await load(db, input);
  if (!artifact) return fail("not_found", "Artifact not found.");
  if (artifact.state === "purging" || artifact.state === "deleted")
    return ok({ state: "deleted", expiresAt: null, purgeAt: null });
  // The purge job is written with the claim, on the same old state, so the queue finishes the
  // deletion if this request dies before it does.
  const unchanged = guard(artifact) as SQL;
  const [, claimed] = await db.batch([
    purgeJobs(db, unchanged, input.now, input.now + OUTBOX_INLINE_GRACE_MS),
    db
      .update(schema.artifacts)
      .set({
        state: "purging",
        lifecycleGeneration: artifact.lifecycleGeneration + 1,
        updatedAt: input.now,
      })
      .where(unchanged)
      .returning({ id: schema.artifacts.id }),
  ]);
  if (claimed.length === 0) return conflict();
  await deleteArtifactData(db, bucket, artifact.id, input.now);
  return ok({ state: "deleted", expiresAt: null, purgeAt: null });
}

async function logEvent(db: Db, input: LifecycleInput, event: string) {
  await db.insert(schema.lifecycleEvents).values({
    artifactId: input.artifactId,
    actorId: input.ownerId,
    channel: "system",
    event,
    at: input.now,
  });
}
