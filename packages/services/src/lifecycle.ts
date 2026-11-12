// Owner actions on an artifact's lifecycle (plan section 10): renew, archive, restore, delete,
// and pin and unpin (premium plan P2). Each transition is conditional on the state read and on the lifecycle generation, so
// it cannot race with maintenance jobs or another request.
import { type Db, type RegionalDb, schema } from "@portifact/db";
import {
  type Actor,
  checkPin,
  checkPolicyPin,
  checkRestore,
  checkUnpin,
  effectiveArchivedAt,
  fail,
  maxLifeOf,
  nextExpiry,
  ok,
  POLICY_MESSAGES,
  policyExpiry,
  purgeDate,
  type Result,
  requireFeature,
  uncappedExpiry,
} from "@portifact/domain";
import { and, eq, type SQL, sql } from "drizzle-orm";
import { authorizeOn } from "./actors.ts";
import { auditEvent } from "./audit.ts";
import { searchIndexJob } from "./content-search.ts";
import { heldRefusal, isHeld, notHeldSql } from "./legal-holds.ts";
import { deleteArtifactData } from "./maintenance.ts";
import { cappedExpirySql, uncappedExpirySql } from "./max-life.ts";
import { OUTBOX_INLINE_GRACE_MS, purgeJobs } from "./outbox.ts";
import { ownerEntitlements } from "./plans.ts";

export interface LifecycleInput {
  /** The signed-in user; an admin or editor of the artifact's owner may change its lifecycle. */
  userId: string;
  artifactId: string;
  now: number;
}

export interface LifecycleOutcome {
  state: "active" | "archived" | "deleted";
  expiresAt: number | null;
  purgeAt: number | null;
  /** Pinned: active with no expiry until unpinned. */
  pinned: boolean;
}

const missing = () => fail<never>("not_found", "Artifact not found.");

async function load(db: RegionalDb, input: LifecycleInput) {
  const [artifact] = await db
    .select()
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, input.artifactId))
    .limit(1);
  // An artifact of an owner the user has no role on looks the same as a missing one.
  if (!artifact) return missing();
  const actor = await authorizeOn(db, input.userId, artifact, "lifecycle", missing);
  if (!actor.ok) return actor;
  return ok(Object.assign(artifact, { actor: actor.value as Actor }));
}

function record(artifact: {
  state: string;
  expiresAt: number | null;
  archivedAt: number | null;
  purgeAt: number | null;
  pinned: boolean;
}) {
  return {
    state: artifact.state as "active",
    expiresAt: artifact.expiresAt === null ? null : new Date(artifact.expiresAt),
    archivedAt: artifact.archivedAt === null ? null : new Date(artifact.archivedAt),
    purgeAt: artifact.purgeAt === null ? null : new Date(artifact.purgeAt),
    pinned: artifact.pinned,
  };
}

/**
 * The artifact is still where and as the request read it: the same owner (a transfer in between
 * means the role was decided on another owner), state and lifecycle generation.
 */
const guard = (artifact: {
  id: string;
  ownerId: string;
  state: string;
  lifecycleGeneration: number;
}) =>
  and(
    eq(schema.artifacts.id, artifact.id),
    eq(schema.artifacts.ownerId, artifact.ownerId),
    eq(schema.artifacts.state, artifact.state as "active"),
    eq(schema.artifacts.lifecycleGeneration, artifact.lifecycleGeneration),
  );

/** The artifact still matches the guard: the audit event's condition, before the update. */
const stillAsRead = (artifact: Parameters<typeof guard>[0]) =>
  sql`exists (select 1 from ${schema.artifacts} where ${guard(artifact)})`;

/** The audit event of a lifecycle change, written before its guarded update on the same guard. */
function lifecycleEvent(
  db: Db,
  artifact: Parameters<typeof guard>[0],
  input: LifecycleInput,
  kind:
    | "artifact.renewed"
    | "artifact.archived"
    | "artifact.restored"
    | "artifact.deleted"
    | "artifact.pinned"
    | "artifact.unpinned",
) {
  return auditEvent(
    db,
    {
      ownerId: artifact.ownerId,
      kind,
      actor: { type: "user", id: input.userId },
      targetId: artifact.id,
      artifactId: artifact.id,
      detail: {},
      now: input.now,
    },
    stillAsRead(artifact),
  );
}

const conflict = () =>
  fail<never>("version_conflict", "The artifact changed meanwhile. Try again.");

/**
 * Restarts the 30 days of an active artifact. A pinned artifact has no expiry to restart, so
 * renewing it changes nothing and it stays pinned.
 */
export async function renewArtifact(
  db: RegionalDb,
  input: LifecycleInput,
): Promise<Result<LifecycleOutcome>> {
  const loaded = await load(db, input);
  if (!loaded.ok) return loaded;
  const artifact = loaded.value;
  if (artifact.state === "active" && artifact.pinned) {
    return ok({ state: "active", expiresAt: null, purgeAt: null, pinned: true });
  }
  if (
    artifact.state !== "active" ||
    (artifact.expiresAt !== null && artifact.expiresAt <= input.now)
  ) {
    return fail("artifact_archived", "Only active artifacts can be renewed; restore it instead.");
  }
  // A workspace's maximum life (decision 0023) caps the renewal at the artifact's deadline,
  // counted from its last publish or restore, in the statement itself: no read for it.
  const planExpiry = nextExpiry(new Date(input.now)).getTime();
  const capped = cappedExpirySql(artifact.actor.policy, planExpiry, input.now);
  // A renewal never archives: past its maximum life an artifact needs a new publish.
  const within = sql`${guard(artifact)} and ${capped} > ${input.now}`;
  const [, updated] = await db.batch([
    auditEvent(
      db,
      {
        ownerId: artifact.ownerId,
        kind: "artifact.renewed",
        actor: { type: "user", id: input.userId },
        targetId: artifact.id,
        artifactId: artifact.id,
        detail: {},
        now: input.now,
      },
      sql`exists (select 1 from ${schema.artifacts} where ${within})`,
    ),
    db
      .update(schema.artifacts)
      .set({
        expiresAt: capped,
        uncappedExpiresAt: uncappedExpirySql(artifact.actor.policy, planExpiry, input.now),
        lifecycleGeneration: artifact.lifecycleGeneration + 1,
        updatedAt: input.now,
      })
      .where(within)
      .returning({ id: schema.artifacts.id, expiresAt: schema.artifacts.expiresAt }),
  ]);
  const [renewed] = updated;
  if (!renewed) {
    // Only on this failure path, and only under a maximum life: which of the two it was.
    const life = maxLifeOf(artifact.actor.policy);
    if (life) {
      const [still] = await db
        .select({ id: schema.artifacts.id })
        .from(schema.artifacts)
        .where(guard(artifact))
        .limit(1);
      if (still) return fail("policy_refused", POLICY_MESSAGES.maxLifeReached(life.days));
    }
    return conflict();
  }
  await recordLifecycleEvent(db, input, "renewed");
  return ok({ state: "active", expiresAt: renewed.expiresAt, purgeAt: null, pinned: false });
}

/**
 * Archives an artifact now; it stops being served and its archive starts, as long as the owner's
 * plan keeps archives (`archiveMonths`) at this moment. Archiving a pinned artifact unpins it.
 */
export async function archiveArtifact(
  db: RegionalDb,
  input: LifecycleInput,
): Promise<Result<LifecycleOutcome>> {
  const loaded = await load(db, input);
  if (!loaded.ok) return loaded;
  const artifact = loaded.value;
  if (artifact.state !== "active")
    return fail("invalid_input", "Only active artifacts can be archived.");
  // An artifact past its expiry is already archived from the expiry date.
  const archivedAt =
    effectiveArchivedAt(record(artifact), new Date(input.now))?.getTime() ?? input.now;
  const owner = await ownerEntitlements(db.global, artifact.ownerId, input.now);
  const purgeAt = purgeDate(new Date(archivedAt), owner.limits.archiveMonths).getTime();
  const [, updated] = await db.batch([
    lifecycleEvent(db, artifact, input, "artifact.archived"),
    db
      .update(schema.artifacts)
      .set({
        state: "archived",
        archivedAt,
        purgeAt,
        pinned: false,
        lifecycleGeneration: artifact.lifecycleGeneration + 1,
        updatedAt: input.now,
      })
      .where(guard(artifact))
      .returning({ id: schema.artifacts.id }),
  ]);
  if (updated.length === 0) return conflict();
  await recordLifecycleEvent(db, input, "archived");
  return ok({ state: "archived", expiresAt: artifact.expiresAt, purgeAt, pinned: false });
}

/** Brings an archived artifact back for another 30 days, at the same URL and with the same access. */
export async function restoreArtifact(
  db: RegionalDb,
  input: LifecycleInput,
): Promise<Result<LifecycleOutcome>> {
  const loaded = await load(db, input);
  if (!loaded.ok) return loaded;
  const artifact = loaded.value;
  const [usage] = await db
    .select({ active: schema.accountUsage.activeArtifacts })
    .from(schema.accountUsage)
    .where(eq(schema.accountUsage.ownerId, artifact.ownerId))
    .limit(1);
  // An active artifact past its expiry already holds its slot, so it does not need a free one.
  const used = (usage?.active ?? 0) - (artifact.state === "active" ? 1 : 0);
  const owner = await ownerEntitlements(db.global, artifact.ownerId, input.now);
  const check = checkRestore(record(artifact), new Date(input.now), used, owner.limits);
  if (!check.ok) return check;
  // Restoring starts a new life (decision 0023): a maximum life counts from now, like a publish.
  const planExpiry = check.value.expiresAt.getTime();
  const expiresAt = policyExpiry(artifact.actor.policy, planExpiry, input.now, input.now);

  // An active artifact past its expiry still holds its slot (maintenance has not archived it),
  // so it only gets new dates; an archived one goes back to active and the trigger retakes the slot.
  try {
    const results = await db.batch([
      lifecycleEvent(db, artifact, input, "artifact.restored"),
      // Archiving dropped its text from the search index (decision 0012): index it again.
      ...(artifact.currentVersionId
        ? searchIndexJob(db, {
            entitlements: owner,
            artifactId: artifact.id,
            versionId: artifact.currentVersionId,
            condition: stillAsRead(artifact),
            now: input.now,
          })
        : []),
      db
        .update(schema.artifacts)
        .set({
          state: "active",
          expiresAt,
          archivedAt: null,
          purgeAt: null,
          pinned: false,
          lifeStartedAt: input.now,
          uncappedExpiresAt: uncappedExpiry(planExpiry, expiresAt),
          lifecycleGeneration: artifact.lifecycleGeneration + 1,
          updatedAt: input.now,
        })
        .where(guard(artifact))
        .returning({ id: schema.artifacts.id }),
    ]);
    const updated = results.at(-1) as { id: string }[];
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
  await recordLifecycleEvent(db, input, "restored");
  return ok({ state: "active", expiresAt, purgeAt: null, pinned: false });
}

/** Deletes an artifact permanently: its content, sources, readers and history. Not reversible. */
export async function deleteArtifact(
  db: RegionalDb,
  bucket: R2Bucket,
  input: LifecycleInput,
): Promise<Result<LifecycleOutcome>> {
  const loaded = await load(db, input);
  if (!loaded.ok) return loaded;
  const artifact = loaded.value;
  if (artifact.state === "purging" || artifact.state === "deleted")
    return ok({ state: "deleted", expiresAt: null, purgeAt: null, pinned: false });
  // A legal hold keeps it (docs/operations.md); held artifacts are always suspended.
  if (artifact.state === "suspended" && (await isHeld(db, artifact.id))) return heldRefusal();
  // The purge job is written with the claim, on the same old state, so the queue finishes the
  // deletion if this request dies before it does. A hold placed in between fails the claim.
  const unchanged = and(guard(artifact), notHeldSql()) as SQL;
  const [, , claimed] = await db.batch([
    purgeJobs(db, unchanged, input.now, input.now + OUTBOX_INLINE_GRACE_MS),
    lifecycleEvent(db, artifact, input, "artifact.deleted"),
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
  if (claimed.length === 0) {
    return (await isHeld(db, artifact.id)) ? heldRefusal() : conflict();
  }
  await deleteArtifactData(db, bucket, artifact.id, input.now);
  return ok({ state: "deleted", expiresAt: null, purgeAt: null, pinned: false });
}

/**
 * Pins an active artifact (premium plan P2): it stays published with no expiry until unpinned.
 * Refused with `plan_required` when the owner's plan (a workspace's for a workspace) does not
 * include `pin`. Pinning a pinned artifact changes nothing, so a retry is harmless. No cap on
 * pins: a pinned artifact holds an active slot, and the plan's active limit bounds those.
 */
export async function pinArtifact(
  db: RegionalDb,
  input: LifecycleInput,
): Promise<Result<LifecycleOutcome>> {
  const loaded = await load(db, input);
  if (!loaded.ok) return loaded;
  const artifact = loaded.value;
  const gate = requireFeature(
    await ownerEntitlements(db.global, artifact.ownerId, input.now),
    "pin",
  );
  if (!gate.ok) return gate;
  // A workspace's maximum life rules out "never expires" (decision 0023).
  const policy = checkPolicyPin(artifact.actor.policy);
  if (!policy.ok) return policy;
  const check = checkPin(record(artifact), new Date(input.now));
  if (!check.ok) return check;
  const pinned = { state: "active" as const, expiresAt: null, purgeAt: null, pinned: true };
  if (!check.value.changed) return ok(pinned);
  const [, updated] = await db.batch([
    lifecycleEvent(db, artifact, input, "artifact.pinned"),
    db
      .update(schema.artifacts)
      .set({
        pinned: true,
        expiresAt: null,
        uncappedExpiresAt: null,
        lifecycleGeneration: artifact.lifecycleGeneration + 1,
        updatedAt: input.now,
      })
      .where(guard(artifact))
      .returning({ id: schema.artifacts.id }),
  ]);
  if (updated.length === 0) return conflict();
  await recordLifecycleEvent(db, input, "pinned");
  return ok(pinned);
}

/**
 * Unpins an artifact: it gets a fresh 30-day expiry from now, like a renewal, and with it the
 * usual expiry notice. Needs no plan, so an owner can always undo a pin.
 */
export async function unpinArtifact(
  db: RegionalDb,
  input: LifecycleInput,
): Promise<Result<LifecycleOutcome>> {
  const loaded = await load(db, input);
  if (!loaded.ok) return loaded;
  const artifact = loaded.value;
  const check = checkUnpin(record(artifact), new Date(input.now));
  if (!check.ok) return check;
  const expiresAt = check.value.expiresAt?.getTime() ?? null;
  const outcome = { state: "active" as const, expiresAt, purgeAt: null, pinned: false };
  if (!check.value.changed || expiresAt === null) return ok(outcome);
  const [, updated] = await db.batch([
    lifecycleEvent(db, artifact, input, "artifact.unpinned"),
    db
      .update(schema.artifacts)
      .set({
        pinned: false,
        // Capped by a workspace's maximum life, like a renewal (decision 0023).
        expiresAt: cappedExpirySql(artifact.actor.policy, expiresAt, input.now),
        uncappedExpiresAt: uncappedExpirySql(artifact.actor.policy, expiresAt, input.now),
        lifecycleGeneration: artifact.lifecycleGeneration + 1,
        updatedAt: input.now,
      })
      .where(guard(artifact))
      .returning({ id: schema.artifacts.id, expiresAt: schema.artifacts.expiresAt }),
  ]);
  const [unpinned] = updated;
  if (!unpinned) return conflict();
  await recordLifecycleEvent(db, input, "unpinned");
  return ok({ ...outcome, expiresAt: unpinned.expiresAt });
}

async function recordLifecycleEvent(db: Db, input: LifecycleInput, event: string) {
  await db.insert(schema.lifecycleEvents).values({
    artifactId: input.artifactId,
    actorId: input.userId,
    channel: "system",
    event,
    at: input.now,
  });
}
