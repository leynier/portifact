// Moving an artifact between spaces (premium plan T1): from the caller's personal space to a
// workspace, back, or between two workspaces, by someone who is an admin or editor on both sides.
// The artifact keeps its ID, URL, versions, readers and comments; its active slot, stored bytes and
// annotation usage move to the target in one batch, and the target's CHECK constraints refuse the
// move when it has no room.
//
// Objects are deduplicated per owner, so the artifact's objects may also back other artifacts of
// the source. The target gets its own object row for every object it does not store yet, pointing
// at the same R2 key (no bytes are copied), counted in the target's storage. The source keeps its
// rows while other artifacts reference them; rows nothing references any more are released after
// the batch (`releaseOrphans`), and an R2 key is deleted only once no row of any owner has it.
import { isWorkspaceId } from "@portifact/contracts";
import { bothSides, type Db, type GlobalDb, type RegionalDb, schema } from "@portifact/db";
import {
  authorize,
  checkPolicyTransfer,
  checkTransfer,
  checkTransferSize,
  fail,
  ok,
  type Result,
} from "@portifact/domain";
import { and, eq, gt, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import { actorOn, authorizeOn } from "./actors.ts";
import { accessHistoryMoveJob } from "./analytics.ts";
import { cancelApprovalReviewOnTransfer } from "./approval-reviews.ts";
import type { ArtifactRow } from "./artifacts.ts";
import { auditEvent } from "./audit.ts";
import { searchIndexJob } from "./content-search.ts";
import { domainDbsOf, releaseArtifactDomains } from "./custom-domains.ts";
import { releaseOrphans } from "./maintenance.ts";
import { ownerEntitlements } from "./plans.ts";
import { OPEN_UPLOAD_STATES } from "./usage.ts";
import { readerDomainSql } from "./workspace-policies.ts";
import { missingWorkspace, workspaceBySlug } from "./workspaces.ts";

const missingArtifact = () => fail<never>("not_found", "Artifact not found.");

export interface TransferInput {
  userId: string;
  artifactId: string;
  /** The target workspace's slug, or null for the caller's personal space. */
  workspace: string | null;
  now: number;
}

function monthStart(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function causeIncludes(error: unknown, text: string): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (e.message.includes(text)) return true;
  }
  return false;
}

async function targetOwner(global: GlobalDb, userId: string, slug: string | null) {
  if (slug === null) return ok(userId);
  const workspace = await workspaceBySlug(global, slug);
  return workspace ? ok(workspace.id) : missingWorkspace();
}

const noRoom = () =>
  fail<never>(
    "quota_exceeded",
    "The target space has no room for this artifact: free an active slot, storage or comment space there first.",
  );

const keyTaken = () =>
  fail<never>(
    "invalid_input",
    "The target space already has an artifact with this publish key. Delete that artifact or publish this one again without the key, then move it.",
  );

/**
 * Moves an artifact to another space. A retry after a move that happened answers the artifact as
 * it is now. Refused across regions, while an upload to the artifact is open, and when the target
 * lacks room.
 */
export async function transferArtifact(
  db: RegionalDb,
  bucket: R2Bucket,
  input: TransferInput,
): Promise<Result<ArtifactRow>> {
  const a = schema.artifacts;
  const [artifact] = await db.select().from(a).where(eq(a.id, input.artifactId)).limit(1);
  if (!artifact) return missingArtifact();
  const source = await authorizeOn(db, input.userId, artifact, "transfer", missingArtifact);
  if (!source.ok) return source;

  const targetId = await targetOwner(db.global, input.userId, input.workspace);
  if (!targetId.ok) return targetId;
  const targetActor = await actorOn(db.global, input.userId, targetId.value);
  if (!targetActor.ok) return targetActor;
  if (!targetActor.value) return missingWorkspace();
  const target = authorize(targetActor.value, "transfer");
  if (!target.ok) return target;
  // Already there: a retried move, or nothing to do.
  if (artifact.ownerId === target.value.ownerId) return ok(artifact);
  // Out of a workspace only with an admin of it, so an editor cannot take its content along; in
  // a personal space the user is its admin.
  const leaving = authorize(source.value, "transfer_out");
  if (!leaving.ok) return leaving;
  const allowed = checkTransfer(artifact, source.value, target.value);
  if (!allowed.ok) return allowed;

  const from = artifact.ownerId;
  const to = target.value.ownerId;
  // The target workspace's policies (decision 0015), read with its actor: an artifact that breaks
  // them is refused, never narrowed by the move. Readers and links are read only when a policy
  // restricts them, and the batch below holds only while none appeared meanwhile.
  const policy = target.value.policy;
  const policyReaders = policy?.readerDomains
    ? (
        await db
          .select({ email: schema.artifactReaders.email })
          .from(schema.artifactReaders)
          .where(eq(schema.artifactReaders.artifactId, artifact.id))
      ).map((row) => row.email)
    : [];
  const l = schema.shareLinks;
  const liveLinks = and(
    eq(l.artifactId, artifact.id),
    isNull(l.revokedAt),
    or(isNull(l.expiresAt), gt(l.expiresAt, input.now)),
  );
  const activeLinks =
    policy?.shareLinks === "disabled"
      ? (await db.select({ id: l.id }).from(l).where(liveLinks).limit(1)).length
      : 0;
  const allowedByPolicy = checkPolicyTransfer(policy, {
    accessMode: artifact.accessMode,
    readers: policyReaders,
    activeLinks,
  });
  if (!allowedByPolicy.ok) return allowedByPolicy;
  const policyHolds = and(
    ...(policy?.publicAccess === "forbidden" ? [sql`${a.accessMode} <> 'public'`] : []),
    // The domain rule itself, in SQL: at most 20 domains bound, however many readers it lists.
    ...(policy?.readerDomains
      ? [
          sql`not exists (select 1 from ${schema.artifactReaders} where ${schema.artifactReaders.artifactId} = ${artifact.id} and ${readerDomainSql} not in ${policy.readerDomains})`,
        ]
      : []),
    ...(policy?.shareLinks === "disabled"
      ? [sql`not exists (select 1 from ${l} where ${liveLinks})`]
      : []),
  );
  const open = await db
    .select({ id: schema.uploadSessions.id })
    .from(schema.uploadSessions)
    .where(
      and(
        eq(schema.uploadSessions.artifactId, artifact.id),
        inArray(schema.uploadSessions.state, OPEN_UPLOAD_STATES),
      ),
    )
    .limit(1);
  if (open.length > 0) {
    return fail(
      "version_conflict",
      "An upload to this artifact is still open. Finish or cancel it, then move the artifact.",
    );
  }

  // A custom domain belongs to its owner's quota and verification: the artifact moves only
  // without one, attached, being set up or being removed. Domains and claims are global
  // (decision 0005), so they are read from the global database; the batch below holds only while
  // the regional `custom_host` is still empty, which attaching sets last.
  const domains = sql`(exists (select 1 from ${schema.customDomains} where ${schema.customDomains.artifactId} = ${artifact.id}) or exists (select 1 from ${schema.domainClaims} where ${schema.domainClaims.artifactId} = ${artifact.id}))`;
  const [domain] = await db.global.all<{ found: number }>(sql`select ${domains} as found`);
  if (Number(domain?.found ?? 0) === 1 || artifact.customHost !== null) {
    return fail(
      "invalid_input",
      "This artifact has a custom domain or a pending one. Remove it before moving the artifact.",
    );
  }

  const o = schema.objects;
  const vf = schema.versionFiles;
  const v = schema.versions;
  const versionIds = sql`(select ${v.id} from ${v} where ${v.artifactId} = ${artifact.id})`;
  const hashes = sql`(select distinct ${vf.sha256} from ${vf} where ${vf.versionId} in ${versionIds} and ${vf.ownerId} = ${from})`;
  const missingInTarget = sql`${o.ownerId} = ${from} and ${o.sha256} in ${hashes} and not exists (select 1 from ${o} as "mine" where "mine"."owner_id" = ${to} and "mine"."sha256" = ${o.sha256})`;

  const artifactHashes = (
    await db.all<{ sha256: string }>(
      sql`select distinct ${vf.sha256} as sha256 from ${vf} where ${vf.versionId} in ${versionIds} and ${vf.ownerId} = ${from}`,
    )
  ).map((row) => row.sha256);

  // Room in the target, checked first for a clear answer; the CHECK constraints repeat it.
  const owner = await ownerEntitlements(db.global, to, input.now);
  const [usage] = await db
    .select({
      active: schema.accountUsage.activeArtifacts,
      bytes: sql<number>`${schema.accountUsage.storedBytes} + ${schema.accountUsage.reservedBytes}`,
    })
    .from(schema.accountUsage)
    .where(eq(schema.accountUsage.ownerId, to))
    .limit(1);
  const [incoming] = await db.all<{ bytes: number }>(
    sql`select coalesce(sum(${o.size}), 0) as bytes from ${o} where ${missingInTarget} and ${o.state} = 'verified'`,
  );
  // The current version must fit the target's per-artifact size, as a publish there would.
  const [current] = await db.all<{ bytes: number }>(
    sql`select coalesce(sum(${vf.size}), 0) as bytes from ${vf} where ${vf.versionId} = ${artifact.currentVersionId} and ${vf.kind} = 'published'`,
  );
  const size = checkTransferSize(Number(current?.bytes ?? 0), owner.limits.artifactBytes);
  if (!size.ok) return size;
  const activeAfter = (usage?.active ?? 0) + (artifact.state === "active" ? 1 : 0);
  const bytesAfter = Number(usage?.bytes ?? 0) + Number(incoming?.bytes ?? 0);
  if (
    (artifact.state === "active" && activeAfter > owner.limits.activeArtifacts) ||
    bytesAfter > owner.limits.accountBytes
  ) {
    return noRoom();
  }

  // Every write holds only while the artifact is where and as the request read it; the move of
  // the artifact row itself runs last, so a concurrent change makes the whole batch a no-op.
  // With one database the domains are part of the condition, as they always were: a domain or
  // claim that appears before the batch makes it a no-op. With a separate regional database the
  // regional `custom_host` is (attaching sets it last), and a claim that lands between the global
  // check and the move is released right after it (decision 0005, "Two-region audit").
  const both = bothSides(db);
  const w = both ?? db;
  const noDomains = both ? sql` and not ${domains}` : sql``;
  const unchanged = sql`exists (select 1 from ${a} where ${a.id} = ${artifact.id} and ${a.ownerId} = ${from} and ${a.lifecycleGeneration} = ${artifact.lifecycleGeneration} and ${a.state} = ${artifact.state} and ${a.customHost} is null${policyHolds ? sql` and ${policyHolds}` : sql``}) and not exists (select 1 from ${schema.uploadSessions} where ${schema.uploadSessions.artifactId} = ${artifact.id} and ${schema.uploadSessions.state} in ('uploading', 'ready', 'verifying'))${noDomains}`;
  const guarded = (condition: SQL) => and(condition, unchanged) as SQL;
  let results: unknown[];
  try {
    results = (await w.batch([
      w
        .insert(schema.accountUsage)
        .select(
          sql`select ${to}, 0, 0, 0, 0, 0, ${monthStart(input.now)}, ${input.now}, ${owner.limits.activeArtifacts}, ${owner.limits.accountBytes} where ${unchanged}`,
        )
        .onConflictDoNothing(),
      w
        .update(schema.accountUsage)
        .set({
          storedBytes: sql`${schema.accountUsage.storedBytes} + (select coalesce(sum(${o.size}), 0) from ${o} where ${missingInTarget} and ${o.state} = 'verified')`,
          updatedAt: input.now,
        })
        .where(guarded(eq(schema.accountUsage.ownerId, to))),
      w
        .insert(o)
        // Columns in schema order: owner, sha256, size, r2 key, state, created at.
        .select(
          sql`select ${to}, ${o.sha256}, ${o.size}, ${o.r2Key}, ${o.state}, ${input.now} from ${o} where ${missingInTarget} and ${unchanged}`,
        )
        .onConflictDoNothing(),
      w
        .update(vf)
        .set({ ownerId: to })
        .where(guarded(sql`${vf.versionId} in ${versionIds} and ${vf.ownerId} = ${from}`)),
      w
        .update(schema.annotationThreads)
        .set({ ownerId: to })
        .where(guarded(eq(schema.annotationThreads.artifactId, artifact.id))),
      w
        .update(schema.annotationMessages)
        .set({ ownerId: to })
        .where(guarded(eq(schema.annotationMessages.artifactId, artifact.id))),
      // Events still waiting for the source's webhooks: a delivery only builds events for
      // artifacts its webhook's owner still owns, so they would be dropped later and linger here.
      // Activity after the move goes to the target's webhooks, which key on the current owner.
      w
        .delete(schema.webhookEvents)
        .where(
          guarded(
            sql`${schema.webhookEvents.artifactId} = ${artifact.id} and ${schema.webhookEvents.webhookId} in (select ${schema.webhooks.id} from ${schema.webhooks} where ${schema.webhooks.ownerId} = ${from})`,
          ),
        ),
      // Issues still waiting to be created through the source's connections (decision 0018): the
      // artifact is no longer that owner's, so they fail here instead of going out under it.
      w
        .update(schema.threadIssues)
        .set({
          state: "failed",
          failure: "artifact_moved",
          title: null,
          startedAt: null,
          completedAt: input.now,
        })
        .where(
          guarded(
            sql`${schema.threadIssues.artifactId} = ${artifact.id} and ${schema.threadIssues.state} = 'pending'`,
          ),
        ),
      // Groups name the source workspace's people: the artifact leaves them behind (decision
      // 0014), in the same batch, so no target member is ever matched against them.
      w
        .delete(schema.artifactGroups)
        .where(guarded(eq(schema.artifactGroups.artifactId, artifact.id))),
      // Reviewers were chosen under the old owner: the open approval review ends (decision 0013).
      cancelApprovalReviewOnTransfer(w, {
        artifactId: artifact.id,
        condition: unchanged,
        now: input.now,
      }),
      // The access history follows the artifact (the job re-owns its openings and views).
      accessHistoryMoveJob(w, artifact.id, unchanged, input.now),
      // The move drops its search rows (a trigger); the target indexes it if its plan searches.
      ...(artifact.state === "active" && artifact.currentVersionId
        ? searchIndexJob(w, {
            entitlements: owner,
            artifactId: artifact.id,
            versionId: artifact.currentVersionId,
            condition: unchanged,
            now: input.now,
          })
        : []),
      w.insert(schema.lifecycleEvents).select(
        // Columns in schema order: id, artifact, actor, channel, event, details, at.
        sql`select null, ${artifact.id}, ${input.userId}, 'system', 'transferred', ${JSON.stringify({ from, to })}, ${input.now} where ${unchanged}`,
      ),
      // One event for each side, on the same conditions.
      ...transferEvents(
        w,
        { artifactId: artifact.id, from, to, userId: input.userId, now: input.now },
        unchanged,
      ),
      // The triggers of the workspace_members_invitations migration move the active slot and the annotation usage with these updates.
      w
        .update(a)
        // A move ends read, review and link sessions and refuses writes authorized on the old
        // owner: both generations move with it.
        .set({
          ownerId: to,
          updatedAt: input.now,
          lifecycleGeneration: sql`${a.lifecycleGeneration} + 1`,
          policyGeneration: sql`${a.policyGeneration} + 1`,
          // `workspace` and `domain` name the old owner's people (decision 0010): the artifact
          // becomes restricted (its reader list stays) wherever it goes.
          accessMode: sql`case when ${a.accessMode} in ('workspace', 'domain') then 'restricted' else ${a.accessMode} end`,
        })
        // The same conditions as every other statement, so the row never moves without them.
        .where(and(eq(a.id, artifact.id), unchanged))
        .returning({ id: a.id }),
    ])) as unknown[];
  } catch (error) {
    if (causeIncludes(error, "CHECK constraint failed")) return noRoom();
    // The partial unique index on (owner, publish key): the target already publishes under it.
    if (causeIncludes(error, "artifacts.external_key")) return keyTaken();
    throw error;
  }
  if ((results.at(-1) as unknown[]).length === 0) {
    return fail("version_conflict", "The artifact changed meanwhile. Try again.");
  }

  // The source's rows that nothing references any more; a crash here leaves them to the orphan
  // sweep. Keys the target now holds stay in R2.
  await releaseOrphans(
    db,
    bucket,
    artifactHashes.map((sha256) => ({ ownerId: from, sha256 })),
    input.now,
  );
  const [moved] = await db.select().from(a).where(eq(a.id, artifact.id)).limit(1);
  // A domain claim started between the global check and the move (domains are global, the move
  // regional, decision 0005) belongs to the source, which no longer owns the artifact: it is
  // released, so a moved artifact never keeps a name or a pending claim of its old owner.
  if (!both && moved && moved.ownerId === to) {
    const [late] = await db.global.all<{ found: number }>(sql`select ${domains} as found`);
    if (Number(late?.found ?? 0) === 1) {
      await releaseArtifactDomains(domainDbsOf(db), artifact.id, "removed", input.now);
    }
  }
  return moved ? ok(moved) : missingArtifact();
}

/** The audit events of a move: out of the source and into the target, both on `condition`. */
function transferEvents(
  db: Db,
  input: { artifactId: string; from: string; to: string; userId: string; now: number },
  condition: SQL,
) {
  const side = (ownerId: string) => (isWorkspaceId(ownerId) ? "workspace" : "personal");
  const common = {
    actor: { type: "user" as const, id: input.userId },
    targetId: input.artifactId,
    artifactId: input.artifactId,
    now: input.now,
  };
  return [
    auditEvent(
      db,
      {
        ...common,
        ownerId: input.from,
        kind: "artifact.transferred_out",
        detail: { to: side(input.to) },
      },
      condition,
    ),
    auditEvent(
      db,
      {
        ...common,
        ownerId: input.to,
        kind: "artifact.transferred_in",
        detail: { from: side(input.from) },
      },
      condition,
    ),
  ];
}
