// Maintenance jobs (plan section 10). Each job takes a small batch, is idempotent and safe to
// run concurrently: state changes are conditional on the lifecycle generation, and storage is
// released only by the statement that actually deletes the object rows.
import { type Db, schema } from "@portifact/db";
import { purgeDate } from "@portifact/domain";
import { and, eq, inArray, isNotNull, lte, ne, notExists, or, sql } from "drizzle-orm";
import { pruneOperations } from "./idempotency.ts";
import { abortPublish } from "./publish.ts";

const DEFAULT_BATCH = 50;

export interface JobResult {
  processed: number;
}

/** Archives active artifacts whose 30 days are over. Delivery already treats them as archived. */
export async function archiveExpired(
  db: Db,
  now: number,
  limit = DEFAULT_BATCH,
): Promise<JobResult> {
  const due = await db
    .select({
      id: schema.artifacts.id,
      generation: schema.artifacts.lifecycleGeneration,
      expiresAt: schema.artifacts.expiresAt,
    })
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.state, "active"), lte(schema.artifacts.expiresAt, now)))
    .limit(limit);

  let processed = 0;
  for (const artifact of due) {
    // The archive starts at the expiry, not when this job happens to run.
    const archivedAt = artifact.expiresAt ?? now;
    const archived = await db
      .update(schema.artifacts)
      .set({
        state: "archived",
        archivedAt,
        purgeAt: purgeDate(new Date(archivedAt)).getTime(),
        lifecycleGeneration: artifact.generation + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.artifacts.id, artifact.id),
          eq(schema.artifacts.state, "active"),
          eq(schema.artifacts.lifecycleGeneration, artifact.generation),
          lte(schema.artifacts.expiresAt, now),
        ),
      )
      .returning({ id: schema.artifacts.id });
    if (archived.length === 0) continue;
    processed += 1;
    await db.insert(schema.lifecycleEvents).values({
      artifactId: artifact.id,
      actorId: null,
      channel: "system",
      event: "archived",
      at: now,
    });
  }
  return { processed };
}

/** Releases uploads that were never committed within their 24 hours. */
export async function expireUploads(
  db: Db,
  now: number,
  limit = DEFAULT_BATCH,
): Promise<JobResult> {
  const stale = await db
    .select({ id: schema.uploadSessions.id, ownerId: schema.uploadSessions.ownerId })
    .from(schema.uploadSessions)
    .where(
      and(
        inArray(schema.uploadSessions.state, ["uploading", "ready"]),
        lte(schema.uploadSessions.expiresAt, now),
      ),
    )
    .limit(limit);
  for (const session of stale) {
    await abortPublish(db, { ownerId: session.ownerId, sessionId: session.id, now }, "expired");
  }
  return { processed: stale.length };
}

/**
 * Deletes versions nobody can reach any more: previous versions past their seven days and
 * versions whose upload was abandoned. Then releases the objects only they referenced.
 */
export async function pruneVersions(
  db: Db,
  bucket: R2Bucket,
  now: number,
  limit = DEFAULT_BATCH,
): Promise<JobResult> {
  const closedUpload = sql`exists (select 1 from ${schema.uploadSessions} where ${schema.uploadSessions.versionId} = ${schema.versions.id} and ${schema.uploadSessions.state} in ('failed', 'aborted', 'expired'))`;
  const victims = await db
    .select({ id: schema.versions.id, artifactId: schema.versions.artifactId })
    .from(schema.versions)
    .innerJoin(schema.artifacts, eq(schema.artifacts.id, schema.versions.artifactId))
    .where(
      and(
        or(
          sql`${schema.artifacts.currentVersionId} is null`,
          ne(schema.artifacts.currentVersionId, schema.versions.id),
        ),
        or(
          and(isNotNull(schema.versions.expiresAt), lte(schema.versions.expiresAt, now)),
          and(eq(schema.versions.state, "uploading"), closedUpload),
        ),
      ),
    )
    .limit(limit);

  let processed = 0;
  for (const version of victims) {
    const owners = await db
      .select({ ownerId: schema.versionFiles.ownerId, sha256: schema.versionFiles.sha256 })
      .from(schema.versionFiles)
      .where(eq(schema.versionFiles.versionId, version.id));
    const deleted = await db
      .delete(schema.versions)
      .where(
        and(
          eq(schema.versions.id, version.id),
          // Never delete the version an artifact points at, even if it changed meanwhile.
          notExists(
            db
              .select({ one: sql`1` })
              .from(schema.artifacts)
              .where(eq(schema.artifacts.currentVersionId, version.id)),
          ),
        ),
      )
      .returning({ id: schema.versions.id });
    if (deleted.length === 0) continue;
    processed += 1;
    await releaseOrphans(db, bucket, owners, now);
  }
  return { processed };
}

/**
 * Permanently deletes artifacts six months after archiving: claims them as `purging` (so a
 * restore can no longer happen), removes versions, readers and orphaned objects, and leaves a
 * tombstone so the ID is never reused. Resumes artifacts left in `purging` by a failed run.
 */
export async function purgeArchived(
  db: Db,
  bucket: R2Bucket,
  now: number,
  limit = DEFAULT_BATCH,
): Promise<JobResult> {
  const due = await db
    .select({
      id: schema.artifacts.id,
      state: schema.artifacts.state,
      generation: schema.artifacts.lifecycleGeneration,
    })
    .from(schema.artifacts)
    .where(
      or(
        and(eq(schema.artifacts.state, "archived"), lte(schema.artifacts.purgeAt, now)),
        eq(schema.artifacts.state, "purging"),
      ),
    )
    .limit(limit);

  let processed = 0;
  for (const artifact of due) {
    if (artifact.state === "archived") {
      const claimed = await db
        .update(schema.artifacts)
        .set({ state: "purging", lifecycleGeneration: artifact.generation + 1, updatedAt: now })
        .where(
          and(
            eq(schema.artifacts.id, artifact.id),
            eq(schema.artifacts.state, "archived"),
            eq(schema.artifacts.lifecycleGeneration, artifact.generation),
            lte(schema.artifacts.purgeAt, now),
          ),
        )
        .returning({ id: schema.artifacts.id });
      if (claimed.length === 0) continue;
    }
    await deleteArtifactData(db, bucket, artifact.id, now);
    processed += 1;
  }
  return { processed };
}

export async function deleteArtifactData(
  db: Db,
  bucket: R2Bucket,
  artifactId: string,
  now: number,
) {
  const files = await db
    .select({ ownerId: schema.versionFiles.ownerId, sha256: schema.versionFiles.sha256 })
    .from(schema.versionFiles)
    .innerJoin(schema.versions, eq(schema.versions.id, schema.versionFiles.versionId))
    .where(eq(schema.versions.artifactId, artifactId));
  await db.batch([
    db
      .insert(schema.tombstones)
      .values({ kind: "artifact", id: artifactId, deletedAt: now })
      .onConflictDoNothing(),
    db.insert(schema.lifecycleEvents).values({
      artifactId,
      actorId: null,
      channel: "system",
      event: "purged",
      at: now,
    }),
    // Cascades to readers, versions and manifest entries.
    db
      .delete(schema.artifacts)
      .where(and(eq(schema.artifacts.id, artifactId), eq(schema.artifacts.state, "purging"))),
  ]);
  await releaseOrphans(db, bucket, files, now);
}

/**
 * Deletes objects that no manifest references any more. Only the statement that deletes a row
 * releases its bytes, so concurrent runs never release the same object twice.
 */
async function releaseOrphans(
  db: Db,
  bucket: R2Bucket,
  candidates: { ownerId: string; sha256: string }[],
  now: number,
): Promise<void> {
  const byOwner = new Map<string, Set<string>>();
  for (const { ownerId, sha256 } of candidates) {
    const set = byOwner.get(ownerId) ?? new Set<string>();
    set.add(sha256);
    byOwner.set(ownerId, set);
  }
  for (const [ownerId, hashes] of byOwner) {
    const list = [...hashes];
    for (let i = 0; i < list.length; i += 80) {
      const chunk = list.slice(i, i + 80);
      const removed = await db
        .delete(schema.objects)
        .where(
          and(
            eq(schema.objects.ownerId, ownerId),
            inArray(schema.objects.sha256, chunk),
            notExists(
              db
                .select({ one: sql`1` })
                .from(schema.versionFiles)
                .where(
                  and(
                    eq(schema.versionFiles.ownerId, schema.objects.ownerId),
                    eq(schema.versionFiles.sha256, schema.objects.sha256),
                  ),
                ),
            ),
          ),
        )
        .returning({
          size: schema.objects.size,
          r2Key: schema.objects.r2Key,
          state: schema.objects.state,
        });
      if (removed.length === 0) continue;
      await bucket.delete(removed.map((object) => object.r2Key));
      const freed = removed
        .filter((object) => object.state === "verified")
        .reduce((sum, object) => sum + object.size, 0);
      if (freed > 0) {
        await db
          .update(schema.accountUsage)
          .set({
            storedBytes: sql`max(0, ${schema.accountUsage.storedBytes} - ${freed})`,
            updatedAt: now,
          })
          .where(eq(schema.accountUsage.ownerId, ownerId));
      }
    }
  }
}

/**
 * Releases objects that no manifest references, for example the pending uploads of a first
 * publish that was aborted (its draft artifact and version are gone) or leftovers of a crash.
 */
export async function sweepOrphanObjects(
  db: Db,
  bucket: R2Bucket,
  now: number,
  limit = DEFAULT_BATCH,
): Promise<JobResult> {
  const orphans = await db
    .select({ ownerId: schema.objects.ownerId, sha256: schema.objects.sha256 })
    .from(schema.objects)
    .where(
      notExists(
        db
          .select({ one: sql`1` })
          .from(schema.versionFiles)
          .where(
            and(
              eq(schema.versionFiles.ownerId, schema.objects.ownerId),
              eq(schema.versionFiles.sha256, schema.objects.sha256),
            ),
          ),
      ),
    )
    .limit(limit);
  await releaseOrphans(db, bucket, orphans, now);
  return { processed: orphans.length };
}

/** Runs every job once. Called from the scheduled handler. */
export async function runMaintenance(db: Db, bucket: R2Bucket, now: number) {
  return {
    archived: (await archiveExpired(db, now)).processed,
    expiredUploads: (await expireUploads(db, now)).processed,
    prunedVersions: (await pruneVersions(db, bucket, now)).processed,
    purged: (await purgeArchived(db, bucket, now)).processed,
    orphanObjects: (await sweepOrphanObjects(db, bucket, now)).processed,
    prunedOperations: await pruneOperations(db, now),
  };
}
