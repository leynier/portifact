// Maintenance jobs (plan section 10). Each job takes a small batch, is idempotent and safe to
// run concurrently: state changes are conditional on the lifecycle generation, and storage is
// released only by the statement that actually deletes the object rows.
import { type Db, schema } from "@portifact/db";
import { purgeDate } from "@portifact/domain";
import { SECURE_RENDERER_VERSION } from "@portifact/render";
import { and, eq, inArray, isNotNull, lte, ne, notExists, or, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { eraseAccessEventsJob } from "./access-log.ts";
import { processAccountDeletions } from "./account-data.ts";
import { renderDocument, renderingStatements, storeRenderings } from "./documents.ts";
import { pruneEmailCounters, pruneEmailSuppressions } from "./email.ts";
import { scheduleExpiryNotices } from "./expiry-notices.ts";
import { pruneOperations } from "./idempotency.ts";
import { closeJobs, OUTBOX_INLINE_GRACE_MS, purgeJobs } from "./outbox.ts";
import { abortPublish } from "./publish.ts";
import { pruneReadSessions } from "./read-access.ts";
import { pruneReviewSessions } from "./review-access.ts";
import { pruneTrafficCounters } from "./traffic.ts";

const DEFAULT_BATCH = 50;
const RELEASE_CHUNK = 40;

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
      const a = schema.artifacts;
      const stillDue = and(
        eq(a.id, artifact.id),
        eq(a.state, "archived"),
        eq(a.lifecycleGeneration, artifact.generation),
        lte(a.purgeAt, now),
      ) as SQL;
      // The job is written with the claim, conditioned on the same old state, so a crash after
      // the claim leaves the purge to the queue; the claim goes last.
      const [, claimed] = await db.batch([
        purgeJobs(db, stillDue, now, now + OUTBOX_INLINE_GRACE_MS),
        db
          .update(a)
          .set({ state: "purging", lifecycleGeneration: artifact.generation + 1, updatedAt: now })
          .where(stillDue)
          .returning({ id: a.id }),
      ]);
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
    // Its access log is in another database: a job erases it, written only by the batch that
    // deletes the artifact.
    eraseAccessEventsJob(
      db,
      "artifact",
      artifactId,
      sql`exists (select 1 from ${schema.artifacts} where ${schema.artifacts.id} = ${artifactId} and ${schema.artifacts.state} = 'purging')`,
      now,
    ),
    // Cascades to readers, versions and manifest entries.
    db
      .delete(schema.artifacts)
      .where(and(eq(schema.artifacts.id, artifactId), eq(schema.artifacts.state, "purging"))),
    closeJobs(
      db,
      "purge_artifact",
      artifactId,
      sql`not exists (select 1 from ${schema.artifacts} where ${schema.artifacts.id} = ${artifactId})`,
    ),
  ]);
  await releaseOrphans(db, bucket, files, now);
}

/**
 * Deletes objects that no manifest references any more. One batch writes a `delete_objects` job
 * with their R2 keys, releases their bytes from the account and deletes their rows, so only the
 * run whose batch deletes a row releases it, and a crash before the R2 delete leaves it to the
 * queue instead of leaking the object.
 */
export async function releaseOrphans(
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
  const o = schema.objects;
  const vf = schema.versionFiles;
  for (const [ownerId, hashes] of byOwner) {
    const list = [...hashes];
    // Each statement repeats the chunk at most twice and D1 binds at most 100 values.
    for (let i = 0; i < list.length; i += RELEASE_CHUNK) {
      const chunk = list.slice(i, i + RELEASE_CHUNK);
      const orphan = sql`${o.ownerId} = ${ownerId} and ${o.sha256} in (${sql.join(
        chunk.map((hash) => sql`${hash}`),
        sql`, `,
      )}) and not exists (select 1 from ${vf} where ${vf.ownerId} = ${o.ownerId} and ${vf.sha256} = ${o.sha256})`;
      const [job, , removed] = await db.batch([
        db
          .insert(schema.outbox)
          .select(
            sql`select null, 'delete_objects', json_object('keys', json_group_array(${o.r2Key})), ${now + OUTBOX_INLINE_GRACE_MS}, null, 0, ${now}, ${ownerId}, null from ${o} where ${orphan} having count(*) > 0`,
          )
          .returning({ id: schema.outbox.id }),
        db
          .update(schema.accountUsage)
          .set({
            storedBytes: sql`max(0, ${schema.accountUsage.storedBytes} - (select coalesce(sum(${o.size}), 0) from ${o} where ${orphan} and ${o.state} = 'verified'))`,
            updatedAt: now,
          })
          .where(eq(schema.accountUsage.ownerId, ownerId)),
        db.delete(o).where(orphan).returning({ r2Key: o.r2Key }),
      ]);
      if (removed.length === 0) continue;
      await bucket.delete(removed.map((object) => object.r2Key));
      const jobId = job[0]?.id;
      if (jobId !== undefined) {
        await db.delete(schema.outbox).where(eq(schema.outbox.id, jobId));
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

/**
 * Re-renders retained document versions whose rendering is older than the oldest secure
 * renderer, or missing. Documents are otherwise never re-rendered, so this does nothing until a
 * security fix raises `SECURE_RENDERER_VERSION`. The fix applies even to an account at its
 * storage limit: the new bytes are counted up to the limit, never refused.
 */
export async function rerenderDocuments(
  db: Db,
  bucket: R2Bucket,
  now: number,
  limit = 10,
): Promise<JobResult> {
  const due = await db
    .select({
      versionId: schema.versions.id,
      entrypoint: schema.versions.entrypoint,
      rendererVersion: schema.versions.rendererVersion,
      ownerId: schema.artifacts.ownerId,
      type: schema.artifacts.type,
      name: schema.artifacts.name,
      sourceSha256: schema.objects.sha256,
      sourceKey: schema.objects.r2Key,
    })
    .from(schema.versions)
    .innerJoin(schema.artifacts, eq(schema.artifacts.id, schema.versions.artifactId))
    .innerJoin(
      schema.versionFiles,
      and(
        eq(schema.versionFiles.versionId, schema.versions.id),
        eq(schema.versionFiles.kind, "published"),
        eq(schema.versionFiles.path, schema.versions.entrypoint),
      ),
    )
    .innerJoin(
      schema.objects,
      and(
        eq(schema.objects.ownerId, schema.versionFiles.ownerId),
        eq(schema.objects.sha256, schema.versionFiles.sha256),
      ),
    )
    .where(
      and(
        inArray(schema.artifacts.type, ["markdown", "text"]),
        inArray(schema.artifacts.state, ["active", "archived", "suspended"]),
        eq(schema.versions.state, "committed"),
        sql`(${schema.versions.rendererVersion} is null or cast(${schema.versions.rendererVersion} as integer) < ${Number(SECURE_RENDERER_VERSION)})`,
      ),
    )
    .limit(limit);

  let processed = 0;
  for (const version of due) {
    if (version.type === "site") continue;
    const rendered = await renderDocument(bucket, {
      type: version.type,
      name: version.name,
      sourceKey: version.sourceKey,
      sourceSha256: version.sourceSha256,
    });
    // A committed source rendered once, so this only fails if its bytes are gone; skip it.
    if (!rendered.ok) continue;
    const previous = await db
      .select({ ownerId: schema.versionFiles.ownerId, sha256: schema.versionFiles.sha256 })
      .from(schema.versionFiles)
      .where(
        and(
          eq(schema.versionFiles.versionId, version.versionId),
          inArray(schema.versionFiles.kind, ["rendered", "block_map"]),
        ),
      );
    await storeRenderings(bucket, version.ownerId, rendered.value.files);
    // Only the run that still sees the old renderer version applies its rendering.
    const unchanged = sql`exists (select 1 from ${schema.versions} where ${schema.versions.id} = ${version.versionId} and ${schema.versions.rendererVersion} is ${version.rendererVersion})`;
    const accountUpdates = rendered.value.files.map((file) =>
      db
        .update(schema.accountUsage)
        .set({
          storedBytes: sql`min(${schema.accountUsage.storedBytes} + ${file.bytes.byteLength}, ${schema.accountUsage.bytesLimit} - ${schema.accountUsage.reservedBytes})`,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.accountUsage.ownerId, version.ownerId),
            unchanged,
            sql`not exists (select 1 from ${schema.objects} where ${schema.objects.ownerId} = ${version.ownerId} and ${schema.objects.sha256} = ${file.sha256} and ${schema.objects.state} = 'verified')`,
          ),
        ),
    );
    // Bytes are counted before the objects become verified, so each new object counts once,
    // and the version moves to the new renderer last.
    const statements: BatchItem<"sqlite">[] = [
      ...accountUpdates,
      ...renderingStatements(db, {
        ownerId: version.ownerId,
        versionId: version.versionId,
        entrypoint: version.entrypoint,
        files: rendered.value.files,
        state: "verified",
        guard: unchanged,
        now,
      }),
      db
        .update(schema.versions)
        .set({ rendererVersion: rendered.value.rendererVersion })
        .where(and(eq(schema.versions.id, version.versionId), unchanged)),
    ];
    await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
    await releaseOrphans(db, bucket, previous, now);
    processed += 1;
  }
  return { processed };
}

/** Runs every job once. Called from the scheduled handler. */
export async function runMaintenance(db: Db, bucket: R2Bucket, now: number) {
  return {
    archived: (await archiveExpired(db, now)).processed,
    expiryNotices: (await scheduleExpiryNotices(db, now)).owners,
    expiredUploads: (await expireUploads(db, now)).processed,
    prunedVersions: (await pruneVersions(db, bucket, now)).processed,
    purged: (await purgeArchived(db, bucket, now)).processed,
    orphanObjects: (await sweepOrphanObjects(db, bucket, now)).processed,
    rerendered: (await rerenderDocuments(db, bucket, now)).processed,
    prunedOperations: await pruneOperations(db, now),
    readSessions: (await pruneReadSessions(db, now)).processed,
    accountDeletions: (await processAccountDeletions(db, bucket, now)).finished,
    reviewSessions: (await pruneReviewSessions(db, now)).processed,
    prunedTrafficCounters: await pruneTrafficCounters(db, now),
    prunedEmailCounters: await pruneEmailCounters(db, now),
    prunedEmailSuppressions: await pruneEmailSuppressions(db, now),
  };
}
