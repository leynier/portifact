// Maintenance jobs (plan section 10). Each job takes a small batch, is idempotent and safe to
// run concurrently: state changes are conditional on the lifecycle generation, and storage is
// released only by the statement that actually deletes the object rows.

import { DEFAULT_REGION, type WorkspacePolicy } from "@portifact/contracts";
import {
  bothSides,
  type Db,
  type GlobalDb,
  type Region,
  type RegionalDb,
  schema,
} from "@portifact/db";
import {
  type Entitlements,
  entitlements,
  FREE_LIMIT_COLUMNS,
  maxLifeOf,
  purgeDate,
  type VersionRetention,
  versionRetention,
} from "@portifact/domain";
import { SECURE_RENDERER_VERSION } from "@portifact/render";
import { and, asc, eq, gt, inArray, lte, notExists, or, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { eraseAccessEventsJob } from "./access-log.ts";
import { processAccountDeletions } from "./account-data.ts";
import { recheckApprovalReviewers } from "./approval-reviews.ts";
import { dataEraseJob } from "./artifact-data.ts";
import { auditEvent, pruneAuditEvents } from "./audit.ts";
import { pruneAuthRecords } from "./auth-records.ts";
import { scheduleCommentNotices } from "./comment-notices.ts";
import { enforceCommentRetention } from "./comment-retention.ts";
import { dropLapsedSearchIndexes, scheduleSearchIndexing } from "./content-search.ts";
import { domainDbsOf, releaseArtifactDomains } from "./custom-domains.ts";
import { renderDocument, renderingStatements, storeRenderings } from "./documents.ts";
import { pruneEmailCounters, pruneEmailSuppressions } from "./email.ts";
import { scheduleExpiryNotices } from "./expiry-notices.ts";
import { pruneFederatedCredentials, pruneUsedGitHubTokens } from "./github-trust.ts";
import {
  markArtifactGone,
  pruneGoneHistory,
  pruneStaleFindings,
  pruneUploadHistory,
} from "./history-retention.ts";
import { pruneOperations } from "./idempotency.ts";
import { prunePendingConnections } from "./integrations.ts";
import { pruneExpiredInvitations } from "./invitations.ts";
import { releaseDueHolds } from "./legal-holds.ts";
import {
  cursorFor,
  cursorRead,
  resumeAt,
  type ScanCaps,
  savedCursorSql,
} from "./maintenance-cursors.ts";
import { giveBackTarget } from "./max-life.ts";
import { closeJobs, OUTBOX_INLINE_GRACE_MS, purgeJobs } from "./outbox.ts";
import { scheduleGraceNotices } from "./plan-grace-notices.ts";
import {
  alignPlanLimits,
  maintainPlanGraces,
  ownerEntitlements,
  redateDatedPlans,
  unpinLapsedPlans,
} from "./plans.ts";
import { closeUploadSession } from "./publish.ts";
import { pruneReadSessions } from "./read-access.ts";
import { previousPrunableSql } from "./retention.ts";
import { pruneReviewSessions } from "./review-access.ts";
import { pruneDirectoryUsers } from "./scim.ts";
import { jsonValues, ownerOfRegion } from "./shapes.ts";
import { pruneShareLinks } from "./share-links.ts";
import { syncSsoRequirementStates } from "./sso-required.ts";
import { requeueThreadIssues } from "./thread-issues.ts";
import { pruneTrafficCounters } from "./traffic.ts";
import { maintainWebhooks } from "./webhooks.ts";
import { pruneArtifactGroups, pruneGroupTombstones } from "./workspace-groups.ts";
import { enforceWorkspacePolicies, ownerEntitlementsAndPolicy } from "./workspace-policies.ts";
import { type DeletionRegions, processWorkspaceDeletions, singleRegion } from "./workspaces.ts";

const DEFAULT_BATCH = 50;
const RELEASE_CHUNK = 40;

export interface JobResult {
  processed: number;
}

/**
 * Archives active artifacts whose 30 days are over. Delivery already treats them as archived.
 * Pinned artifacts have no expiry, so they are never due. Each archive is kept for the months of
 * its owner's plan at this moment.
 */
export async function archiveExpired(
  db: RegionalDb,
  now: number,
  limit = DEFAULT_BATCH,
): Promise<JobResult> {
  const due = await db
    .select({
      id: schema.artifacts.id,
      ownerId: schema.artifacts.ownerId,
      generation: schema.artifacts.lifecycleGeneration,
      expiresAt: schema.artifacts.expiresAt,
      capped: schema.artifacts.uncappedExpiresAt,
    })
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.state, "active"), lte(schema.artifacts.expiresAt, now)))
    .limit(limit);

  let processed = 0;
  const owners = new Map<string, { owner: Entitlements; policy: WorkspacePolicy | undefined }>();
  for (const artifact of due) {
    // The archive starts at the expiry, not when this job happens to run.
    const archivedAt = artifact.expiresAt ?? now;
    let found = owners.get(artifact.ownerId);
    if (!found) {
      // The plan and, for a workspace, its policy in one round trip, as the plan alone was.
      found = await ownerEntitlementsAndPolicy(db.global, artifact.ownerId, now);
      owners.set(artifact.ownerId, found);
    }
    const { owner, policy } = found;
    const still = and(
      eq(schema.artifacts.id, artifact.id),
      eq(schema.artifacts.state, "active"),
      eq(schema.artifacts.lifecycleGeneration, artifact.generation),
      lte(schema.artifacts.expiresAt, now),
    );
    const archive = db
      .update(schema.artifacts)
      .set({
        state: "archived",
        archivedAt,
        purgeAt: purgeDate(new Date(archivedAt), owner.limits.archiveMonths).getTime(),
        lifecycleGeneration: artifact.generation + 1,
        updatedAt: now,
      })
      .where(still)
      .returning({ id: schema.artifacts.id });
    let archived: { id: string }[];
    if (artifact.capped === null) {
      archived = await archive;
    } else {
      // A cap no current rule asks for (decision 0023: the maximum was removed or lengthened while
      // the artifact was out of the policy's reach) is given back first, in the same batch: it
      // moves the generation, so the archive and its event below then match nothing. An artifact
      // still capped by its workspace's current maximum is archived with the trail of a manual
      // archive (`artifact.archived` by the system, naming the policy); never a policy the owner
      // does not have.
      const target = giveBackTarget(policy, now);
      const credited = maxLifeOf(policy) !== null;
      const [back, ...rest] = (await db.batch([
        db
          .update(schema.artifacts)
          .set({
            expiresAt: sql`max(${schema.artifacts.expiresAt}, ${target})`,
            uncappedExpiresAt: sql`case when ${target} >= ${schema.artifacts.uncappedExpiresAt} then null else ${schema.artifacts.uncappedExpiresAt} end`,
            lifecycleGeneration: artifact.generation + 1,
            updatedAt: now,
          })
          .where(
            and(
              still,
              sql`${schema.artifacts.uncappedExpiresAt} is not null and ${schema.artifacts.pinned} = 0 and ${target} > ${now}`,
            ),
          )
          .returning({ id: schema.artifacts.id }),
        ...(credited
          ? [
              auditEvent(
                db,
                {
                  ownerId: artifact.ownerId,
                  kind: "artifact.archived",
                  actor: { type: "system" },
                  targetId: artifact.id,
                  artifactId: artifact.id,
                  detail: { policy: "artifactMaxDays" },
                  now,
                },
                sql`exists (select 1 from ${schema.artifacts} where ${still} and ${schema.artifacts.uncappedExpiresAt} is not null)`,
              ),
            ]
          : []),
        archive,
      ])) as unknown as [{ id: string }[], ...unknown[]];
      if (back.length > 0) continue;
      archived = rest.at(-1) as { id: string }[];
    }
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
    await closeUploadSession(
      db,
      { ownerId: session.ownerId, sessionId: session.id, now },
      "expired",
    );
  }
  return { processed: stale.length };
}

/**
 * How much of the plans the pruning reads per run (decision 0005, "Second delivery"): at most
 * `maxPages` pages of `pageSize` plan rows (with one database, one regional read per row), then
 * it resumes from `maintenance_cursors` on the next run, wrapping around at the end.
 */
export const PRUNE_PLAN_CAPS: ScanCaps = { pageSize: 50, maxPages: 1 };
/** With a separate regional database, the free owners' candidate versions read per run. */
export const PRUNE_FREE_CAPS: ScanCaps = { pageSize: 200, maxPages: 1 };

/**
 * Deletes versions nobody can reach any more: previous versions their owner's plan no longer
 * keeps (past its days, or older than its number of previous versions), read at `now`, and
 * versions whose upload was abandoned. Then releases the objects only they referenced. Owners
 * without a plan row are pruned with the free plan's values in one query; each owner with a row
 * gets its own, and each delete is conditioned on the plan row it was decided from, so a grant
 * that lands meanwhile is never pruned with stale values. At most `limit` versions per run, and
 * at most `caps` of the plans read, resumed on the next run.
 */
export async function pruneVersions(
  db: RegionalDb,
  bucket: R2Bucket,
  now: number,
  limit = DEFAULT_BATCH,
  /** The region `db` is, for a separate regional database: which plan owners live there. */
  region: Region = DEFAULT_REGION,
  caps: { plans?: ScanCaps; free?: ScanCaps } = {},
): Promise<JobResult> {
  const plans = caps.plans ?? PRUNE_PLAN_CAPS;
  const both = bothSides(db);
  if (both) return pruneOneDatabase(db, both, bucket, now, limit, region, plans);
  return pruneSeparateRegion(db, bucket, now, limit, region, plans, caps.free ?? PRUNE_FREE_CAPS);
}

const planColumns = {
  ownerId: schema.ownerPlans.ownerId,
  plan: schema.ownerPlans.plan,
  seats: schema.ownerPlans.seats,
  validUntil: schema.ownerPlans.validUntil,
  overrides: schema.ownerPlans.overrides,
  grace: schema.ownerPlans.grace,
  updatedAt: schema.ownerPlans.updatedAt,
};

async function pruneOneDatabase(
  db: RegionalDb,
  w: Db,
  bucket: R2Bucket,
  now: number,
  limit: number,
  region: Region,
  caps: ScanCaps,
): Promise<JobResult> {
  const v = schema.versions;
  const a = schema.artifacts;
  const p = schema.ownerPlans;
  const closedUpload = sql`exists (select 1 from ${schema.uploadSessions} where ${schema.uploadSessions.versionId} = ${v.id} and ${schema.uploadSessions.state} in ('failed', 'aborted', 'expired'))`;
  const victims: { id: string; guard: SQL }[] = (
    await w
      .select({ id: v.id })
      .from(v)
      .where(and(eq(v.state, "uploading"), closedUpload))
      .limit(limit)
  ).map(({ id }) => ({ id, guard: sql`1` }));

  const free = versionRetention(entitlements(null, now).limits);
  const noPlan = (ownerId: SQL) =>
    sql`not exists (select 1 from ${p} where ${p.ownerId} = ${ownerId})`;
  if (victims.length < limit) {
    const rows = await w
      .select({ id: v.id, ownerId: a.ownerId })
      .from(v)
      .innerJoin(a, eq(a.id, v.artifactId))
      .where(and(previousPrunableSql(free, now), noPlan(sql`${a.ownerId}`)))
      .limit(limit - victims.length);
    for (const row of rows) {
      victims.push({
        id: row.id,
        guard: sql`${previousPrunableSql(free, now)} and ${noPlan(sql`${row.ownerId}`)}`,
      });
    }
  }

  // The plans, a page at a time from where the last run stopped; the saved cursor is read in the
  // batch of the first page, so a pass that fits in one run costs what it always did.
  const name = `prune_versions:${region}`;
  const page = (after: SQL) =>
    w.select(planColumns).from(p).where(after).orderBy(asc(p.ownerId)).limit(caps.pageSize);
  let started = "";
  let cursor: string | null = null;
  let resume: string | null = null;
  let ended = false;
  let examined = 0;
  const maxPlans = caps.pageSize * caps.maxPages;
  while (victims.length < limit && examined < maxPlans) {
    let plans: Awaited<ReturnType<typeof page>>;
    if (cursor === null) {
      const [saved, first] = await w.batch([
        cursorRead(w, name),
        page(sql`${p.ownerId} > ${savedCursorSql(name)}`),
      ]);
      started = saved[0]?.cursor ?? "";
      resume = started;
      plans = first;
    } else {
      plans = await page(gt(p.ownerId, cursor));
    }
    if (plans.length === 0) {
      ended = true;
      break;
    }
    cursor = (plans.at(-1) as (typeof plans)[number]).ownerId;
    for (const plan of plans) {
      if (victims.length >= limit || examined >= maxPlans) break;
      examined += 1;
      const retention = versionRetention(entitlements(plan, now).limits);
      const prunable = previousPrunableSql(retention, now);
      const wanted = limit - victims.length;
      const rows = await w
        .select({ id: v.id })
        .from(v)
        .innerJoin(a, eq(a.id, v.artifactId))
        .where(and(eq(a.ownerId, plan.ownerId), prunable))
        .limit(wanted);
      const samePlan = sql`exists (select 1 from ${p} where ${p.ownerId} = ${plan.ownerId} and ${p.updatedAt} = ${plan.updatedAt})`;
      for (const row of rows) victims.push({ id: row.id, guard: sql`${prunable} and ${samePlan}` });
      // An owner whose versions filled the run is read again next time.
      if (rows.length < wanted) resume = plan.ownerId;
    }
  }
  if (cursor !== null) await resumeAt(w, name, started, ended ? null : resume, now);

  let processed = 0;
  for (const version of victims) {
    const owners = await w
      .select({ ownerId: schema.versionFiles.ownerId, sha256: schema.versionFiles.sha256 })
      .from(schema.versionFiles)
      .where(eq(schema.versionFiles.versionId, version.id));
    const deleted = await w
      .delete(v)
      .where(
        and(
          eq(v.id, version.id),
          version.guard,
          // Never delete the version an artifact points at, even if it changed meanwhile.
          notExists(
            w
              .select({ one: sql`1` })
              .from(schema.artifacts)
              .where(eq(schema.artifacts.currentVersionId, version.id)),
          ),
        ),
      )
      .returning({ id: v.id });
    if (deleted.length === 0) continue;
    processed += 1;
    await releaseOrphans(db, bucket, owners, now);
  }
  return { processed };
}

/** A version chosen for pruning, with the retention it was chosen under. */
interface Victim {
  id: string;
  /** Null for an abandoned upload, which no plan keeps. */
  ownerId: string | null;
  retention: string | null;
  guard: SQL;
}

type PlanRow = {
  ownerId: string;
  plan: string;
  seats: number;
  validUntil: number | null;
  overrides: unknown;
  updatedAt: number;
};

/** The retention an owner's plan row gives at `now` (none, expired or unknown: the free one). */
function retentionOf(plan: PlanRow | null | undefined, now: number): VersionRetention {
  return versionRetention(entitlements(plan ?? null, now).limits);
}

/**
 * Version pruning in a region with its own database (decision 0005). Every owner is pruned by
 * exactly one of two branches, by the retention its plan row gives at `now`:
 *
 * - the free retention (no plan row, an expired or an unknown plan): candidate versions are read
 *   in version order from a cursor, with their owners' plan rows read from the global database,
 *   and the ones whose owner has a better retention are left to the second branch;
 * - any other retention: the region's plans are paged from the global database from their own
 *   cursor and grouped by retention, one regional query per group.
 *
 * Both cursors live in the region's `maintenance_cursors` and wrap around, so versions that are
 * skipped never hold back the rest. A delete cannot be conditioned on the global plan row, so the
 * owner's plan is read again right before each delete and the version is kept when the
 * retention it gives changed: a grant that lands in the one round trip between that read and the
 * delete is the window.
 */
async function pruneSeparateRegion(
  db: RegionalDb,
  bucket: R2Bucket,
  now: number,
  limit: number,
  region: Region,
  planCaps: ScanCaps,
  freeCaps: ScanCaps,
): Promise<JobResult> {
  const v = schema.versions;
  const a = schema.artifacts;
  const p = schema.ownerPlans;
  const closedUpload = sql`exists (select 1 from ${schema.uploadSessions} where ${schema.uploadSessions.versionId} = ${v.id} and ${schema.uploadSessions.state} in ('failed', 'aborted', 'expired'))`;
  const victims = new Map<string, Victim>();
  for (const { id } of await db
    .select({ id: v.id })
    .from(v)
    .where(and(eq(v.state, "uploading"), closedUpload))
    .limit(limit)) {
    victims.set(id, { id, ownerId: null, retention: null, guard: sql`1` });
  }

  const freeRetention = retentionOf(null, now);
  const freeKey = JSON.stringify(freeRetention);
  const free = previousPrunableSql(freeRetention, now);
  if (victims.size < limit) {
    const name = `prune_versions_free:${region}`;
    const started = await cursorFor(db, name);
    let cursor = started;
    let ended = false;
    for (let pages = 0; pages < freeCaps.maxPages && victims.size < limit; pages += 1) {
      const rows = await db
        .select({ id: v.id, ownerId: a.ownerId })
        .from(v)
        .innerJoin(a, eq(a.id, v.artifactId))
        .where(and(free, gt(v.id, cursor)))
        .orderBy(asc(v.id))
        .limit(freeCaps.pageSize);
      const plans = await plansOf(db.global, [...new Set(rows.map((row) => row.ownerId))]);
      let examined = 0;
      for (const row of rows) {
        if (victims.size >= limit) break;
        examined += 1;
        cursor = row.id;
        if (JSON.stringify(retentionOf(plans.get(row.ownerId), now)) !== freeKey) continue;
        if (victims.has(row.id)) continue;
        victims.set(row.id, { id: row.id, ownerId: row.ownerId, retention: freeKey, guard: free });
      }
      if (rows.length < freeCaps.pageSize && examined === rows.length) {
        ended = true;
        break;
      }
    }
    await resumeAt(db, name, started, ended ? null : cursor, now);
  }

  if (victims.size < limit) {
    const name = `prune_versions_plans:${region}`;
    const started = await cursorFor(db, name);
    let cursor = started;
    let resume = started;
    let ended = false;
    for (let pages = 0; pages < planCaps.maxPages && victims.size < limit; pages += 1) {
      const page = await db.global
        .select(planColumns)
        .from(p)
        .where(and(gt(p.ownerId, cursor), ownerOfRegion(p.ownerId, region)))
        .orderBy(asc(p.ownerId))
        .limit(planCaps.pageSize);
      if (page.length === 0) {
        ended = true;
        break;
      }
      const groups = new Map<string, { retention: VersionRetention; owners: string[] }>();
      for (const plan of page) {
        const retention = retentionOf(plan, now);
        const key = JSON.stringify(retention);
        // Owners with the free retention are the first branch's.
        if (key === freeKey) continue;
        const group = groups.get(key) ?? { retention, owners: [] };
        group.owners.push(plan.ownerId);
        groups.set(key, group);
      }
      let filled = false;
      for (const [key, group] of groups) {
        if (victims.size >= limit) break;
        const prunable = previousPrunableSql(group.retention, now);
        const wanted = limit - victims.size;
        const rows = await db
          .select({ id: v.id, ownerId: a.ownerId })
          .from(v)
          .innerJoin(a, eq(a.id, v.artifactId))
          .where(and(prunable, sql`${a.ownerId} in ${jsonValues(group.owners)}`))
          .orderBy(asc(v.id))
          .limit(wanted);
        for (const row of rows) {
          if (victims.has(row.id)) continue;
          victims.set(row.id, {
            id: row.id,
            ownerId: row.ownerId,
            retention: key,
            guard: prunable,
          });
        }
        if (rows.length >= wanted) filled = true;
      }
      cursor = (page.at(-1) as (typeof page)[number]).ownerId;
      // A page whose versions filled the run is read again next time.
      if (filled) break;
      resume = cursor;
      if (page.length < planCaps.pageSize) {
        ended = true;
        break;
      }
    }
    await resumeAt(db, name, started, ended ? null : resume, now);
  }

  let processed = 0;
  for (const version of victims.values()) {
    if (version.ownerId !== null) {
      const [current] = await db.global
        .select(planColumns)
        .from(p)
        .where(eq(p.ownerId, version.ownerId))
        .limit(1);
      if (JSON.stringify(retentionOf(current, now)) !== version.retention) continue;
    }
    const owners = await db
      .select({ ownerId: schema.versionFiles.ownerId, sha256: schema.versionFiles.sha256 })
      .from(schema.versionFiles)
      .where(eq(schema.versionFiles.versionId, version.id));
    const deleted = await db
      .delete(v)
      .where(
        and(
          eq(v.id, version.id),
          version.guard,
          notExists(
            db
              .select({ one: sql`1` })
              .from(schema.artifacts)
              .where(eq(schema.artifacts.currentVersionId, version.id)),
          ),
        ),
      )
      .returning({ id: v.id });
    if (deleted.length === 0) continue;
    processed += 1;
    await releaseOrphans(db, bucket, owners, now);
  }
  return { processed };
}

/** The plan rows of `owners`, read from the global database in one statement. */
async function plansOf(global: GlobalDb, owners: string[]): Promise<Map<string, PlanRow>> {
  if (owners.length === 0) return new Map();
  const p = schema.ownerPlans;
  const rows = await global
    .select(planColumns)
    .from(p)
    .where(sql`${p.ownerId} in ${jsonValues(owners)}`);
  return new Map(rows.map((row) => [row.ownerId, row]));
}

/**
 * Permanently deletes artifacts six months after archiving: claims them as `purging` (so a
 * restore can no longer happen), removes versions, readers and orphaned objects, and leaves a
 * tombstone so the ID is never reused. Resumes artifacts left in `purging` by a failed run.
 */
export async function purgeArchived(
  db: RegionalDb,
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
  db: RegionalDb,
  bucket: R2Bucket,
  artifactId: string,
  now: number,
) {
  // Its custom domains are global: detached first, so the name stops serving and Cloudflare's
  // hostname is deleted by its own job whatever happens to this batch.
  await releaseArtifactDomains(domainDbsOf(db), artifactId, "purged", now);
  const files = await db
    .select({ ownerId: schema.versionFiles.ownerId, sha256: schema.versionFiles.sha256 })
    .from(schema.versionFiles)
    .innerJoin(schema.versions, eq(schema.versions.id, schema.versionFiles.versionId))
    .where(eq(schema.versions.artifactId, artifactId));
  // The tombstone is global and the artifact regional (decision 0005): written first, so a
  // `purging` artifact never comes back; a crash before the batch below is finished by the next
  // run of the job, which finds the tombstone already there.
  await db.global
    .insert(schema.tombstones)
    .values({ kind: "artifact", id: artifactId, deletedAt: now })
    .onConflictDoNothing();
  await db.batch([
    db.insert(schema.lifecycleEvents).values({
      artifactId,
      actorId: null,
      channel: "system",
      event: "purged",
      at: now,
    }),
    // Its suspensions start their retention now (`pruneGoneHistory`).
    markArtifactGone(
      db,
      artifactId,
      sql`exists (select 1 from ${schema.artifacts} where ${schema.artifacts.id} = ${artifactId} and ${schema.artifacts.state} = 'purging')`,
      now,
    ),
    // Its access log is in another database: a job erases it, written only by the batch that
    // deletes the artifact.
    eraseAccessEventsJob(
      db,
      "artifact",
      artifactId,
      sql`exists (select 1 from ${schema.artifacts} where ${schema.artifacts.id} = ${artifactId} and ${schema.artifacts.state} = 'purging')`,
      now,
    ),
    // Its document database (decision 0026): the whole erase the purge requires, written from the
    // `artifact_data` row the delete below takes with it. An artifact without data gets none.
    dataEraseJob(
      db,
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
      // A transferred artifact's objects share their R2 key with the new owner's rows
      // (transfer.ts): a key goes only once no row of any owner has it.
      const keys = removed.map((object) => object.r2Key);
      const kept = new Set(
        (await db.select({ key: o.r2Key }).from(o).where(inArray(o.r2Key, keys))).map(
          (row) => row.key,
        ),
      );
      const gone = keys.filter((key) => !kept.has(key));
      if (gone.length > 0) await bucket.delete(gone);
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
    await storeRenderings(db, bucket, version.ownerId, rendered.value.files);
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
/**
 * The scans of a region other than the default one (decision 0005): what is stored in the
 * region, on its own database and bucket. The global scans (account and workspace deletions,
 * invitations, email counters and suppressions, group tombstones, global audit events) run once,
 * in `runMaintenance` with the default region, whose database is also the global one. Scans that
 * still read a plan or a setting through the regional database are left out until they read it
 * from the global one (decision 0005, "Two-region audit", what remains): they would read every
 * owner as free there. Leaving them out only delays work (versions kept longer, no expiry notice,
 * limit columns and pins realigned later), it never removes anything a plan keeps.
 */
export async function runRegionalMaintenance(
  db: RegionalDb,
  bucket: R2Bucket,
  now: number,
  region: Region,
) {
  // The scans of a region whose database is not the global one (decision 0005): every scan that
  // acts on an owner's data, each limited to the owners of `region` and bounded per run. The
  // global scans (deletions, invitations, directory users, email counters and suppressions, group
  // tombstones and the global audit events) run once, with the default region.
  return {
    // Holds whose release date came (docs/operations.md, "Legal holds"): first, so deletions
    // that waited for them go on in this run.
    releasedHolds: await releaseDueHolds(db, now),
    archived: (await archiveExpired(db, now)).processed,
    expiryNotices: (await scheduleExpiryNotices(db, now)).owners,
    commentNotices: (await scheduleCommentNotices(db, now)).recipients,
    expiredUploads: (await expireUploads(db, now)).processed,
    prunedVersions: (await pruneVersions(db, bucket, now, DEFAULT_BATCH, region)).processed,
    purged: (await purgeArchived(db, bucket, now)).processed,
    orphanObjects: (await sweepOrphanObjects(db, bucket, now)).processed,
    rerendered: (await rerenderDocuments(db, bucket, now)).processed,
    prunedOperations: await pruneOperations(db, now),
    // History retention: lifecycle and moderation records of what is gone, upload and usage
    // history, stale storage findings (docs/operations.md, "History retention").
    goneHistory: await pruneGoneHistory(db, now),
    uploadHistory: await pruneUploadHistory(db, now),
    staleFindings: await pruneStaleFindings(db, now),
    readSessions: (await pruneReadSessions(db, now)).processed,
    artifactGroups: (await pruneArtifactGroups(db, now)).removed,
    shareLinks: (await pruneShareLinks(db, now)).processed,
    reviewSessions: (await pruneReviewSessions(db, now)).processed,
    prunedTrafficCounters: await pruneTrafficCounters(db, now),
    redatedPlans: (await redateDatedPlans(db, now, region)).scheduled,
    graceNotices: (await scheduleGraceNotices(db, now, region)).scheduled,
    alignedPlanLimits: (await alignPlanLimits(db, now, 50, region)).processed,
    unpinned: (await unpinLapsedPlans(db, now, 50, region)).processed,
    droppedSearchIndexes: (await dropLapsedSearchIndexes(db, now)).dropped,
    scheduledSearchIndexing: (await scheduleSearchIndexing(db, now, undefined, region)).scheduled,
    webhooks: await maintainWebhooks(db, now),
    threadIssues: await requeueThreadIssues(db, now),
    // Slack connections started and never completed (decision 0025): one delete.
    pendingConnections: await prunePendingConnections(db, now),
    workspacePolicies: await enforceWorkspacePolicies(db, now),
    // Comment retention (decision 0023): deletes for good, bounded, held to the rule in force.
    commentRetention: await enforceCommentRetention(db, bucket, now, region),
    prunedAuditEvents: await pruneAuditEvents(db, db.global, now),
    // Last, with its own call and time budget, as in the default region.
    approvalReviewers: (await recheckApprovalReviewers(db, now)).checked,
  };
}

export async function runMaintenance(
  db: RegionalDb,
  bucket: R2Bucket,
  now: number,
  /** Every region, for the deletions that reach all of them; only `db`'s without it. */
  regions: DeletionRegions = singleRegion(db, bucket),
) {
  return {
    // Holds whose release date came (docs/operations.md, "Legal holds"): first, so deletions
    // that waited for them go on in this run.
    releasedHolds: await releaseDueHolds(db, now),
    archived: (await archiveExpired(db, now)).processed,
    expiryNotices: (await scheduleExpiryNotices(db, now)).owners,
    commentNotices: (await scheduleCommentNotices(db, now)).recipients,
    expiredUploads: (await expireUploads(db, now)).processed,
    prunedVersions: (await pruneVersions(db, bucket, now)).processed,
    purged: (await purgeArchived(db, bucket, now)).processed,
    orphanObjects: (await sweepOrphanObjects(db, bucket, now)).processed,
    rerendered: (await rerenderDocuments(db, bucket, now)).processed,
    prunedOperations: await pruneOperations(db, now),
    // History retention: lifecycle and moderation records of what is gone, upload and usage
    // history, stale storage findings (docs/operations.md, "History retention").
    goneHistory: await pruneGoneHistory(db, now),
    uploadHistory: await pruneUploadHistory(db, now),
    staleFindings: await pruneStaleFindings(db, now),
    // Expired sign-in records and unused app registrations (global; docs/operations.md).
    authRecords: await pruneAuthRecords(db.global, now),
    readSessions: (await pruneReadSessions(db, now)).processed,
    // Artifact group rows whose group is gone grant nothing; the scan removes them (decision 0014):
    // one read of at most 500 rows, at most 6 global reads of 90 group IDs and at most 14 writes
    // of 40 rows.
    artifactGroups: (await pruneArtifactGroups(db, now)).removed,
    // At most four statements of 500 rows (decision 0014, "Restores").
    groupTombstones: (await pruneGroupTombstones(db.global, now)).deleted,
    shareLinks: (await pruneShareLinks(db, now)).processed,
    accountDeletions: (await processAccountDeletions(regions, now)).finished,
    workspaceDeletions: (await processWorkspaceDeletions(regions, now)).finished,
    expiredInvitations: await pruneExpiredInvitations(db.global, now),
    // Credentials GitHub runs were issued (decision 0024), an hour after they expire: one
    // statement of at most 500 rows.
    federatedCredentials: await pruneFederatedCredentials(db.global, now),
    // GitHub ID tokens already exchanged, once they could no longer pass the time checks
    // (decision 0024): one statement of at most 500 rows.
    usedGitHubTokens: await pruneUsedGitHubTokens(db.global, now),
    // What a directory said about people who never got an account, once its pending row lapsed
    // (decision 0017): one delete over the users with no account link.
    directoryUsers: await pruneDirectoryUsers(db.global, now),
    reviewSessions: (await pruneReviewSessions(db, now)).processed,
    prunedTrafficCounters: await pruneTrafficCounters(db, now),
    prunedEmailCounters: await pruneEmailCounters(db.global, now),
    prunedEmailSuppressions: await pruneEmailSuppressions(db.global, now),
    // Plan graces (decision 0022) are global rows: stored and ended once, here, before the scans
    // that read them.
    planGraces: (await maintainPlanGraces(db.global, now)).processed,
    // After the grace scan, so a natural expiry's hold it stored is announced in the same run.
    graceNotices: (await scheduleGraceNotices(db, now)).scheduled,
    // Once after deploy (decision 0022): access log rows dated by the previous release's rule.
    redatedPlans: (await redateDatedPlans(db, now)).scheduled,
    alignedPlanLimits: (await alignPlanLimits(db, now)).processed,
    unpinned: (await unpinLapsedPlans(db, now)).processed,
    // "SSO required" entering or leaving suspension when a plan expires (decision 0021): one
    // global read per run, a batch only for a workspace whose state changed.
    ssoRequirements: (await syncSsoRequirementStates(db.global, now)).changed,
    // Content search (decision 0012): drop what a plan no longer covers, then index what is missing.
    droppedSearchIndexes: (await dropLapsedSearchIndexes(db, now)).dropped,
    scheduledSearchIndexing: (await scheduleSearchIndexing(db, now)).scheduled,
    webhooks: await maintainWebhooks(db, now),
    // Issues requested from threads whose job went missing get one again (decision 0018).
    threadIssues: await requeueThreadIssues(db, now),
    // Slack connections started and never completed, after 24 hours (decision 0025): one delete
    // of at most a few rows per owner, with no tombstone (they hold no credential).
    pendingConnections: await prunePendingConnections(db, now),
    // Workspace policies (decision 0015): brings back in line what a request that read a policy
    // before it tightened let through after the policy's job ran.
    workspacePolicies: await enforceWorkspacePolicies(db, now),
    // Comment retention (decision 0023): deletes for good, bounded, held to the rule in force and
    // paused after a restore of the global database until the policies are applied again. One
    // global call while no workspace of the region sets it.
    commentRetention: await enforceCommentRetention(db, bucket, now, DEFAULT_REGION),
    // The region's events, then the global ones (members, plans, domains); with one region both
    // passes read one database, and the second finds nothing left.
    prunedAuditEvents:
      (await pruneAuditEvents(db, db.global, now)) +
      (await pruneAuditEvents(db.global, db.global, now)),
    // Last, with its own call and time budget, so a backlog of review requests never keeps the
    // deletions and prunes above from running.
    approvalReviewers: (await recheckApprovalReviewers(db, now)).checked,
  };
}
