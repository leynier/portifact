// Comment retention (decision 0023, "Comment retention"): who sets it, the plan and its lapse,
// the preview and the confirmation, the notice period, what is deleted and what is kept, the rule
// in force at the moment of every delete (also against a save racing the scan, in both layouts),
// moves, the restore (tombstones and the guard), the bounds and fairness, the trail, the notices,
// the query plans, and the invariant as a property with counters and mutation checks.
import { env } from "cloudflare:test";
import { DEFAULT_POLICY, WORKSPACE_POLICIES, type WorkspacePolicy } from "@portifact/contracts";
import { type Regions, regionalDb, regionsFromEnv, schema } from "@portifact/db";
import {
  NOTICE_EMAILS_PER_CYCLE,
  POLICY_MESSAGES,
  policyOf,
  storedPolicy,
  threadDeletable,
} from "@portifact/domain";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { applyTombstones, exportTombstones } from "../src/backups.ts";
import {
  armCommentRetention,
  COMMENT_RETENTION_EPOCH_KEY,
  dueThreadIds,
  enforceCommentRetention,
  syncBucketEpoch,
  writeCommentTombstones,
} from "../src/comment-retention.ts";
import {
  type CommentRetentionNotifier,
  sendCommentRetentionNotice as sendNotice,
} from "../src/comment-retention-notices.ts";
import { RecipientSuppressedError, recordEmailsSent, suppressEmail } from "../src/email.ts";
import { reinstateArtifact, suspendArtifact } from "../src/moderation.ts";
import { commitPublish, preparePublish } from "../src/publish.ts";
import { createServiceToken } from "../src/service-tokens.ts";
import { transferArtifact } from "../src/transfer.ts";
import { rollbackArtifact } from "../src/versions.ts";
import {
  applyWorkspacePolicies,
  exportWorkspacePolicies,
  previewWorkspacePolicy,
  setWorkspacePolicy,
  staleCapOwners,
} from "../src/workspace-policies.ts";
import { DAY, db, grantPlan, NOW, racing, sha256, value } from "./fixtures.ts";
import { raceBeforeBatchWith, raceBeforeFirstWrite, raceGlobalBeforeStatement } from "./race.ts";

const hex = () => crypto.randomUUID().replaceAll("-", "");
const regions = (): Regions => regionsFromEnv(env);
const NOTICE = WORKSPACE_POLICIES.retentionNoticeDays * DAY;
const FROM = NOW + NOTICE;
const retention = (days: number | null, extra: Partial<WorkspacePolicy> = {}): WorkspacePolicy => ({
  ...DEFAULT_POLICY,
  ...extra,
  commentRetentionDays: days,
  commentRetentionFrom: null,
});
const th = schema.annotationThreads;
const m = schema.annotationMessages;

async function person(name: string) {
  const id = `u_${hex()}`;
  const email = `${name.toLowerCase()}-${hex().slice(0, 8)}@example.test`;
  await db()
    .insert(schema.users)
    .values({
      id,
      name,
      email,
      emailVerified: true,
      createdAt: new Date(NOW - 30 * DAY),
      updatedAt: new Date(NOW),
    });
  return { id, email };
}

async function team(region: "default" | "eu" = "default") {
  const id = `ws_${hex()}`;
  const slug = `c${hex().slice(0, 20)}`;
  const t = {
    id,
    slug,
    region,
    admin: await person("Admin"),
    editor: await person("Editor"),
    member: await person("Member"),
  };
  await regions()
    .global.insert(schema.workspaces)
    .values({ id, slug, name: "Team", createdBy: t.admin.id, updatedAt: NOW, region });
  await regions()
    .global.insert(schema.workspaceMembers)
    .values([
      { workspaceId: id, userId: t.admin.id, role: "admin", updatedAt: NOW },
      { workspaceId: id, userId: t.editor.id, role: "editor", updatedAt: NOW },
      { workspaceId: id, userId: t.member.id, role: "member", updatedAt: NOW },
    ]);
  await grantPlan(id, "enterprise", { seats: 10 });
  return t;
}
type Team = Awaited<ReturnType<typeof team>>;
const home = (t: { region: "default" | "eu" }) => regions().get(t.region).db;
const bucketOf = (t: { region: "default" | "eu" }) =>
  t.region === "eu" ? env.ARTIFACTS_EU : env.ARTIFACTS;

async function publishIn(
  userId: string,
  ownerId: string,
  region: "default" | "eu" = "default",
  next?: { artifactId: string; baseVersionId: string; now: number },
) {
  const body = `<p>${crypto.randomUUID()}</p>`;
  const digest = await sha256(body);
  const target = regions().get(region).db;
  const at = next?.now ?? NOW - 400 * DAY;
  const prepared = value(
    await preparePublish(target, {
      userId,
      targetOwnerId: ownerId,
      ...(next ? { artifactId: next.artifactId } : {}),
      type: "site",
      name: "Plan",
      entrypoint: "index.html",
      baseVersionId: next?.baseVersionId ?? null,
      files: [
        {
          path: "index.html",
          kind: "published" as const,
          sha256: digest,
          size: body.length,
          contentType: "text/html",
        },
      ],
      now: at,
    }),
  );
  const bucket = region === "eu" ? env.ARTIFACTS_EU : env.ARTIFACTS;
  await bucket.put(`objects/${ownerId}/${digest}`, body);
  return value(
    await commitPublish(target, bucket, {
      userId,
      sessionId: prepared.sessionId,
      now: at,
    }),
  );
}

/** A new version of `artifact` at `now`: its current version stops being current then. */
const publishNext = (t: Team, artifact: { artifactId: string; versionId: string }, now: number) =>
  publishIn(t.editor.id, t.id, t.region, {
    artifactId: artifact.artifactId,
    baseVersionId: artifact.versionId,
    now,
  });

/**
 * A thread written directly, with `messages` messages, last active `agoDays` before NOW. The
 * `annotation_usage` triggers count it as any thread.
 */
async function thread(
  t: { id: string; region: "default" | "eu"; editor: { id: string } },
  artifact: { artifactId: string; versionId: string },
  options: { agoDays: number; state?: "open" | "resolved"; version?: string; messages?: number },
) {
  const id = `th_${hex()}`;
  const at = NOW - options.agoDays * DAY;
  const target = home(t);
  await target.insert(th).values({
    id,
    artifactId: artifact.artifactId,
    versionId: options.version ?? artifact.versionId,
    ownerId: t.id,
    authorId: t.editor.id,
    target: JSON.stringify({ schema: 1, path: "index.html", anchor: { kind: "document" } }),
    targetBytes: 60,
    path: "index.html",
    state: options.state ?? "resolved",
    messageCount: options.messages ?? 2,
    createdAt: at,
    updatedAt: at,
  });
  for (let i = 0; i < (options.messages ?? 2); i += 1) {
    await target.insert(m).values({
      id: `msg_${hex()}`,
      threadId: id,
      artifactId: artifact.artifactId,
      ownerId: t.id,
      authorId: t.editor.id,
      body: "x".repeat(10),
      bodyBytes: 10,
      createdAt: at,
    });
  }
  return id;
}

async function exists(t: { region: "default" | "eu" }, id: string) {
  return (await home(t).select({ id: th.id }).from(th).where(eq(th.id, id))).length === 1;
}

const preview = (t: Team, next: WorkspacePolicy, now = NOW) =>
  previewWorkspacePolicy(regions(), { userId: t.admin.id, slug: t.slug, policy: next, now });

async function revision(t: Team) {
  const [row] = await regions()
    .global.select({ revision: schema.workspaces.policyRevision })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, t.id));
  return row?.revision ?? 0;
}

async function save(
  t: Team,
  next: WorkspacePolicy,
  options: { now?: number; userId?: string; confirm?: boolean } = {},
) {
  const now = options.now ?? NOW;
  const shown = options.confirm === false ? undefined : await preview(t, next, now);
  return setWorkspacePolicy(regions(), {
    userId: options.userId ?? t.admin.id,
    slug: t.slug,
    policy: next,
    revision: await revision(t),
    confirmed: shown?.ok ? shown.value : undefined,
    now,
  });
}

async function stored(t: Team) {
  const [row] = await regions()
    .global.select({ policy: schema.workspaces.policy })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, t.id));
  return policyOf(row?.policy ?? null);
}

/** An in-memory bucket for the restore guard's mark, so a test never leaves the shared one paused. */
function memoryBucket(initial?: string, fail: { get?: boolean; put?: boolean } = {}) {
  let held = initial;
  const bucket = {
    get: async (key: string) => {
      if (fail.get) throw new Error("r2 unavailable");
      return key === COMMENT_RETENTION_EPOCH_KEY && held !== undefined
        ? { text: async () => held as string }
        : null;
    },
    put: async (key: string, text: string) => {
      if (fail.put) throw new Error("r2 unavailable");
      if (key === COMMENT_RETENTION_EPOCH_KEY) held = text;
    },
  };
  return Object.assign(bucket as unknown as R2Bucket, { held: () => held });
}

const scan = (t: { region: "default" | "eu" }, now: number) =>
  enforceCommentRetention(home(t), bucketOf(t), now, t.region);

async function usage(t: { id: string; region: "default" | "eu" }) {
  const [row] = await home(t)
    .select({ messages: schema.annotationUsage.messages, bytes: schema.annotationUsage.bytes })
    .from(schema.annotationUsage)
    .where(eq(schema.annotationUsage.ownerId, t.id));
  return row;
}

describe("setting comment retention", () => {
  it("is an admin's, gated on the plan to set or shorten, never to lengthen or remove", async () => {
    const t = await team();
    for (const userId of [t.editor.id, t.member.id]) {
      expect(await save(t, retention(90), { userId, confirm: false })).toMatchObject({
        code: "forbidden",
      });
    }
    const token = value(
      await createServiceToken(regions().global, {
        userId: t.admin.id,
        slug: t.slug,
        body: {
          label: "CI",
          role: "editor",
          scopes: ["artifacts:read", "artifacts:write"],
          expiresInDays: 30,
          restriction: { kind: "none" },
        },
        now: NOW,
      }),
    ).token.id;
    expect(await save(t, retention(90), { userId: token, confirm: false })).toMatchObject({
      code: "forbidden",
    });
    value(await save(t, retention(90)));
    expect(await stored(t)).toMatchObject({ commentRetentionDays: 90, commentRetentionFrom: FROM });
    await regions().global.delete(schema.ownerPlans).where(eq(schema.ownerPlans.ownerId, t.id));
    expect(await save(t, retention(60))).toMatchObject({ code: "plan_required" });
    value(await save(t, retention(120)));
    // Lengthening keeps the date the rule had.
    expect(await stored(t)).toMatchObject({
      commentRetentionDays: 120,
      commentRetentionFrom: FROM,
    });
    value(await save(t, retention(null)));
    expect(await stored(t)).toEqual(DEFAULT_POLICY);
  });

  it("counts what it deletes, refuses until confirmed, and again when it grew", async () => {
    const t = await team();
    const artifact = await publishIn(t.editor.id, t.id);
    await thread(t, artifact, { agoDays: 200, messages: 3 });
    await thread(t, artifact, { agoDays: 80, messages: 2 });
    await thread(t, artifact, { agoDays: 200, state: "open" });
    const shown = value(await preview(t, retention(90)));
    // At the effective date (NOW + 7): the 200-day thread; within 30 days after, the 80-day one;
    // the open one on the current version never.
    expect(shown).toMatchObject({ threadsAtStart: 1, messagesAtStart: 3, threadsSoon: 1 });
    expect(await save(t, retention(90), { confirm: false })).toMatchObject({
      code: "policy_refused",
    });
    await thread(t, artifact, { agoDays: 300 });
    expect(
      await setWorkspacePolicy(regions(), {
        userId: t.admin.id,
        slug: t.slug,
        policy: retention(90),
        revision: await revision(t),
        confirmed: shown,
        now: NOW,
      }),
    ).toEqual({ ok: false, code: "policy_refused", message: POLICY_MESSAGES.impactChanged });
    value(await save(t, retention(90)));
  });
});

describe("what is deleted, and when", () => {
  it("deletes nothing before the effective date, then whole threads past their period", async () => {
    const t = await team();
    const artifact = await publishIn(t.editor.id, t.id);
    const old = await thread(t, artifact, { agoDays: 200, messages: 3 });
    const recent = await thread(t, artifact, { agoDays: 10 });
    const openHere = await thread(t, artifact, { agoDays: 200, state: "open" });
    const openBefore = await thread(t, artifact, {
      agoDays: 200,
      state: "open",
      version: "ver_earlier",
    });
    const before = await usage(t);
    value(await save(t, retention(90)));
    for (const at of [NOW, NOW + DAY, FROM - 1]) {
      await scan(t, at);
      expect(await exists(t, old)).toBe(true);
    }
    await scan(t, FROM);
    expect(await exists(t, old)).toBe(false);
    expect(await exists(t, openBefore)).toBe(false);
    // Kept: recent activity, and open on the current version (what reviewers wait on).
    expect(await exists(t, recent)).toBe(true);
    expect(await exists(t, openHere)).toBe(true);
    // Messages went with them, and the quota counts them no more (triggers, never code).
    expect(await home(t).select().from(m).where(eq(m.threadId, old))).toEqual([]);
    const after = await usage(t);
    expect(after?.messages).toBe((before?.messages ?? 0) - 5);
    // The trail: an event per thread for clients, a tombstone per thread, one audit event.
    const events = await home(t)
      .select()
      .from(schema.annotationEvents)
      .where(
        and(
          eq(schema.annotationEvents.threadId, old),
          eq(schema.annotationEvents.kind, "thread_deleted"),
        ),
      );
    expect(events).toHaveLength(1);
    const tombstones = await regions()
      .global.select()
      .from(schema.tombstones)
      .where(eq(schema.tombstones.kind, "comment_thread"));
    expect(tombstones.map((row) => row.id)).toEqual(expect.arrayContaining([old, openBefore]));
    const audit = await home(t)
      .select()
      .from(schema.auditEvents)
      .where(
        and(eq(schema.auditEvents.ownerId, t.id), eq(schema.auditEvents.kind, "policy.enforced")),
      );
    expect(audit.map((event) => event.detail)).toContainEqual(
      expect.objectContaining({ threadsDeleted: 2, messagesDeleted: 5 }),
    );
    expect(audit[0]).toMatchObject({ actorType: "system" });
  });

  it("never selects a thread before the rule takes effect, in the statement itself", async () => {
    // The scan also skips a rule before its date; this is the second layer, in the SQL.
    const t = await team();
    const artifact = await publishIn(t.editor.id, t.id);
    const old = await thread(t, artifact, { agoDays: 400 });
    const rule = { days: 30, from: FROM };
    const select = (now: number) => home(t).all<{ id: string }>(dueThreadIds(t.id, rule, now, 50));
    expect(await select(NOW)).toEqual([]);
    expect(await select(FROM - 1)).toEqual([]);
    expect(await select(FROM)).toEqual([{ id: old }]);
  });

  it("keeps the threads of a suspended artifact, and deletes them once it is reinstated", async () => {
    const t = await team();
    const artifact = await publishIn(t.editor.id, t.id);
    const old = await thread(t, artifact, { agoDays: 200 });
    value(await save(t, retention(90)));
    value(
      await suspendArtifact(home(t), { artifactId: artifact.artifactId, reason: "spam", now: NOW }),
    );
    await scan(t, FROM);
    expect(await exists(t, old)).toBe(true);
    value(await reinstateArtifact(home(t), { artifactId: artifact.artifactId, now: FROM }));
    await scan(t, FROM + DAY);
    expect(await exists(t, old)).toBe(false);
  });
});

describe("only a rule in force deletes", () => {
  it("stops at once when it is removed or lengthened, with no job to wait for", async () => {
    const t = await team();
    const artifact = await publishIn(t.editor.id, t.id);
    const old = await thread(t, artifact, { agoDays: 200 });
    const mid = await thread(t, artifact, { agoDays: 120 });
    value(await save(t, retention(90)));
    value(await save(t, retention(150), { now: NOW + DAY }));
    await scan(t, FROM);
    expect(await exists(t, old)).toBe(false);
    expect(await exists(t, mid)).toBe(true);
    value(await save(t, retention(null), { now: FROM }));
    await scan(t, FROM + 100 * DAY);
    expect(await exists(t, mid)).toBe(true);
  });

  it("deletes nothing when the rule is removed between the scan's read and its delete", async () => {
    const t = await team();
    const artifact = await publishIn(t.editor.id, t.id);
    const old = await thread(t, artifact, { agoDays: 200 });
    value(await save(t, retention(90)));
    const raced = racing(async () => {
      value(await save(t, retention(null), { now: FROM }));
    });
    // The first batch that writes races: the guard's epoch bump, then the delete itself.
    const run = await enforceCommentRetention(raced, env.ARTIFACTS, FROM, "default");
    expect(run.threads).toBe(0);
    expect(await exists(t, old)).toBe(true);
  });

  it("deletes nothing when the plan lapses, and suspends the rule until an admin sets it again", async () => {
    const t = await team();
    const artifact = await publishIn(t.editor.id, t.id);
    const old = await thread(t, artifact, { agoDays: 200 });
    value(await save(t, retention(90)));
    await regions()
      .global.update(schema.ownerPlans)
      .set({ validUntil: NOW + DAY })
      .where(eq(schema.ownerPlans.ownerId, t.id));
    const run = await scan(t, FROM);
    expect(run).toMatchObject({ threads: 0, suspended: 1 });
    expect(await exists(t, old)).toBe(true);
    expect((await stored(t)).commentRetentionDays).toBeNull();
    const changed = await regions()
      .global.select()
      .from(schema.auditEvents)
      .where(
        and(eq(schema.auditEvents.ownerId, t.id), eq(schema.auditEvents.kind, "policy.changed")),
      );
    expect(changed.map((event) => event.detail)).toContainEqual(
      expect.objectContaining({ reason: "plan_lapsed", commentRetentionDays: null }),
    );
  });
});

describe("moves", () => {
  it("brings an artifact moved in under the rule only after the move notice", async () => {
    const t = await team();
    value(await save(t, retention(90)));
    const mine = await publishIn(t.editor.id, t.editor.id);
    const old = await thread({ ...t, id: t.editor.id }, mine, { agoDays: 200 });
    const at = FROM + DAY;
    value(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: t.editor.id,
        artifactId: mine.artifactId,
        workspace: t.slug,
        now: at,
      }),
    );
    await scan(t, at);
    expect(await exists(t, old)).toBe(true);
    await scan(t, at + WORKSPACE_POLICIES.commentMoveNoticeDays * DAY - 1);
    expect(await exists(t, old)).toBe(true);
    await scan(t, at + WORKSPACE_POLICIES.commentMoveNoticeDays * DAY);
    expect(await exists(t, old)).toBe(false);
  });

  it("stops applying the moment an artifact moves out", async () => {
    const t = await team();
    const artifact = await publishIn(t.editor.id, t.id);
    const old = await thread(t, artifact, { agoDays: 200 });
    value(await save(t, retention(90)));
    value(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: t.admin.id,
        artifactId: artifact.artifactId,
        workspace: null,
        now: NOW + DAY,
      }),
    );
    await scan(t, FROM + DAY);
    expect(await exists(t, old)).toBe(true);
  });
});

describe("restores", () => {
  it("re-deletes a thread a restore brought back, through its tombstone", async () => {
    const t = await team();
    const artifact = await publishIn(t.editor.id, t.id);
    const old = await thread(t, artifact, { agoDays: 200 });
    value(await save(t, retention(90)));
    await scan(t, FROM);
    expect(await exists(t, old)).toBe(false);
    const markers = await exportTombstones(regions());
    expect(markers).toContainEqual(expect.objectContaining({ kind: "comment_thread", id: old }));
    // The restore brings the thread back (and loses the tombstone) ...
    await regions().global.delete(schema.tombstones).where(eq(schema.tombstones.id, old));
    await home(t).insert(th).values({
      id: old,
      artifactId: artifact.artifactId,
      versionId: artifact.versionId,
      ownerId: t.id,
      authorId: t.editor.id,
      target: "{}",
      targetBytes: 2,
      path: "index.html",
      state: "resolved",
      messageCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
    // ... and the rule removed after the deletion, so only the tombstone can delete it again.
    value(await save(t, retention(null), { now: FROM + DAY }));
    const applied = await applyTombstones(regions(), markers, FROM + 2 * DAY);
    expect(applied.commentThreads).toBe(1);
    expect(await exists(t, old)).toBe(false);
  });

  it("pauses after the global database is rewound, until the policies are applied again", async () => {
    const t = await team();
    const artifact = await publishIn(t.editor.id, t.id);
    const old = await thread(t, artifact, { agoDays: 200 });
    value(await save(t, retention(90)));
    // A removal moved the epoch, the bucket learned it, then a restore rewound the database to
    // before it: the database's epoch is behind the bucket's, and the rule is back.
    const [row] = await regions()
      .global.select({ cursor: schema.maintenanceCursors.cursor })
      .from(schema.maintenanceCursors)
      .where(eq(schema.maintenanceCursors.name, "comment_retention_epoch"));
    const epoch = Math.max(Number(row?.cursor ?? 0), FROM);
    await env.ARTIFACTS.put(COMMENT_RETENTION_EPOCH_KEY, String(epoch + 1));
    const paused = await scan(t, epoch);
    expect(paused).toMatchObject({ paused: true, threads: 0 });
    expect(await exists(t, old)).toBe(true);
    // `apply-policies` re-arms it once the policies are back, from the clock alone.
    expect(
      await applyWorkspacePolicies(
        regions().global,
        await exportWorkspacePolicies(regions().global),
        epoch + 2,
      ),
    ).toMatchObject({ ok: true });
    const resumed = await scan(t, epoch + 2);
    expect(resumed.paused).toBe(false);
    expect(await exists(t, old)).toBe(false);
  });

  it("raises a bucket's mark and never lowers it", async () => {
    const bucket = memoryBucket();
    await syncBucketEpoch(bucket, 500);
    await syncBucketEpoch(bucket, 400);
    expect(bucket.held()).toBe("500");
  });

  it("pauses on a mark it cannot read, and never overwrites it", async () => {
    const t = await team();
    const old = await thread(t, await publishIn(t.editor.id, t.id), { agoDays: 400 });
    value(await save(t, retention(90)));
    const bucket = memoryBucket("not a number");
    const run = await enforceCommentRetention(home(t), bucket, FROM + 500 * DAY, "default");
    expect(run.paused).toBe(true);
    expect(await exists(t, old)).toBe(true);
    expect(bucket.held()).toBe("not a number");
  });

  it("re-arms from the clock alone, ahead of every bucket", async () => {
    const epoch = await armCommentRetention(regions().global, NOW + 400 * DAY);
    expect(epoch).toBeGreaterThanOrEqual(NOW + 400 * DAY);
  });
});

describe("bounds and fairness", () => {
  it("takes at most a batch per workspace and a run's budget, and reaches every workspace", async () => {
    const teams = [await team(), await team(), await team(), await team(), await team()];
    const all: { t: Team; ids: string[] }[] = [];
    for (const t of teams) {
      const artifact = await publishIn(t.editor.id, t.id);
      const ids: string[] = [];
      for (let i = 0; i < 55; i += 1)
        ids.push(await thread(t, artifact, { agoDays: 200, messages: 1 }));
      value(await save(t, retention(90)));
      all.push({ t, ids });
    }
    const run = await scan(teams[0] as Team, FROM);
    expect(run.threads).toBeLessThanOrEqual(WORKSPACE_POLICIES.commentDeleteRun);
    const left = async () =>
      Promise.all(
        all.map(
          async ({ t, ids }) =>
            (await Promise.all(ids.map((id) => exists(t, id)))).filter(Boolean).length,
        ),
      );
    const afterOne = await left();
    for (const count of afterOne)
      expect(count).toBeGreaterThanOrEqual(55 - WORKSPACE_POLICIES.commentDeleteBatch);
    for (let i = 0; i < 6; i += 1) await scan(teams[0] as Team, FROM);
    expect(await left()).toEqual([0, 0, 0, 0, 0]);
  });
});

describe("query plans without table statistics", () => {
  it("reads one workspace's threads through its index", async () => {
    const query = db()
      .select({ id: th.id })
      .from(th)
      .where(sql`${th.id} in (${dueThreadIds("ws_a", { days: 90, from: NOW }, NOW, 50)})`);
    const { sql: text, params } = query.toSQL();
    const { results } = await env.DB.prepare(`explain query plan ${text}`)
      .bind(...params)
      .all<{ detail: string }>();
    const plan = results.map((row) => row.detail).join("\n");
    expect(plan).toContain(
      "annotation_threads_owner_state_updated_idx (owner_id=? AND state=? AND updated_at<?)",
    );
    expect(plan).not.toMatch(/SCAN annotation_threads\b/);
  });
});

describe("the admins' notices", () => {
  const notifier = () => {
    const sent: Parameters<CommentRetentionNotifier["send"]>[0][] = [];
    return { sent, send: async (notice: (typeof sent)[number]) => void sent.push(notice) };
  };
  async function jobs(t: Team) {
    return regions()
      .global.select()
      .from(schema.outbox)
      .where(
        and(eq(schema.outbox.topic, "comment_retention_notice"), eq(schema.outbox.subject, t.id)),
      );
  }

  const payloadOf = (row: { payload: unknown }) =>
    (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as {
      kind: string;
      at: number;
    };

  it("sends the set notice once, and decides the soon one once, before a first deletion long after it", async () => {
    const t = await team();
    const artifact = await publishIn(t.editor.id, t.id);
    // Last active 60 days ago: under 90 days it is deleted on day 30, long after the save.
    await thread(t, artifact, { agoDays: 60, messages: 4 });
    value(await save(t, retention(90)));
    const [set] = await jobs(t);
    if (!set) throw new Error("no notice");
    const fake = notifier();
    expect(await sendNotice(home(t), set, NOW, fake)).toBe("done");
    expect(fake.sent[0]).toMatchObject({ kind: "set", days: 90, from: FROM, threads: 0 });
    // The first scan decides it: due to go out 3 days before day 30, saying day 30.
    await scan(t, NOW + DAY);
    const [soon] = await jobs(t);
    if (!soon) throw new Error("no second notice");
    expect(payloadOf(soon)).toMatchObject({ kind: "soon", at: NOW + 30 * DAY });
    expect(soon.availableAt).toBe(NOW + 27 * DAY);
    // Decided once: later scans write nothing more.
    for (const day of [2, 10, 26]) await scan(t, NOW + day * DAY);
    expect(await jobs(t)).toHaveLength(1);
    expect(await sendNotice(home(t), soon, NOW + 27 * DAY, fake)).toBe("done");
    expect(fake.sent.at(-1)).toMatchObject({
      kind: "soon",
      at: NOW + 30 * DAY,
      threads: 1,
      messages: 4,
    });
  });

  it("decides no second notice when deletions start at the effective date, and never sends one after", async () => {
    const t = await team();
    const artifact = await publishIn(t.editor.id, t.id);
    const first = await thread(t, artifact, { agoDays: 400 });
    await thread(t, artifact, { agoDays: 70 });
    value(await save(t, retention(90)));
    for (const job of await jobs(t)) await sendNotice(home(t), job, NOW, notifier());
    await scan(t, FROM);
    expect(await exists(t, first)).toBe(false);
    for (let day = 8; day <= 20; day += 1) await scan(t, NOW + day * DAY);
    expect(await jobs(t)).toEqual([]);
  });

  it("drops a soon notice that a lengthening left with nothing due on its date", async () => {
    const t = await team();
    const artifact = await publishIn(t.editor.id, t.id);
    await thread(t, artifact, { agoDays: 60 });
    value(await save(t, retention(90)));
    for (const job of await jobs(t)) await sendNotice(home(t), job, NOW, notifier());
    await scan(t, NOW + DAY);
    // Lengthened: the effective date and its decision stay, the job recounts at send time.
    value(await save(t, retention(120), { now: NOW + 2 * DAY }));
    await scan(t, NOW + 3 * DAY);
    const [soon] = await jobs(t);
    if (!soon) throw new Error("no second notice");
    const fake = notifier();
    expect(await sendNotice(home(t), soon, NOW + 27 * DAY, fake)).toBe("stale");
    expect(fake.sent).toEqual([]);
  });

  it("is moot once the rule is removed, and goes out with the days in force after a lengthening", async () => {
    const t = await team();
    value(await save(t, retention(60)));
    value(await save(t, retention(90)));
    const [first] = await jobs(t);
    if (!first) throw new Error("no notice");
    const fake = notifier();
    expect(await sendNotice(home(t), first, NOW, fake)).toBe("done");
    expect(fake.sent[0]).toMatchObject({ days: 90 });
    value(await save(t, retention(30)));
    value(await save(t, retention(null)));
    const [later] = await jobs(t);
    if (!later) throw new Error("no notice");
    expect(await sendNotice(home(t), later, NOW, notifier())).toBe("stale");
  });
});

describe("the EU region (separate database)", () => {
  async function tombstoneJobs(t: Team) {
    return home(t)
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.topic, "comment_tombstones"), eq(schema.outbox.subject, t.id)));
  }
  const tombstoned = async (id: string) =>
    (await regions().global.select().from(schema.tombstones).where(eq(schema.tombstones.id, id)))
      .length === 1;

  it("deletes on the EU database, and its tombstones through a job written in the same batch", async () => {
    const t = await team("eu");
    const artifact = await publishIn(t.editor.id, t.id, "eu");
    const old = await thread(t, artifact, { agoDays: 200 });
    value(await save(t, retention(90)));
    const run = await scan(t, FROM);
    expect(run).toMatchObject({ paused: false, failed: 0, threads: 1 });
    expect(await exists(t, old)).toBe(false);
    // Deleted, and the job that writes its tombstone waiting in the region's outbox.
    expect(await tombstoned(old)).toBe(false);
    const [job] = await tombstoneJobs(t);
    if (!job) throw new Error("no tombstone job");
    expect(await writeCommentTombstones(home(t), job)).toBe("done");
    expect(await tombstoned(old)).toBe(true);
    // Idempotent: run again (the queue delivers at least once), nothing changes.
    expect(await writeCommentTombstones(home(t), job)).toBe("done");
    expect(await tombstoned(old)).toBe(true);
  });

  it("keeps the tombstone job when the global write fails after the deletion, and writes it on the retry", async () => {
    const t = await team("eu");
    const artifact = await publishIn(t.editor.id, t.id, "eu");
    const old = await thread(t, artifact, { agoDays: 200 });
    value(await save(t, retention(90)));
    await scan(t, FROM);
    const [job] = await tombstoneJobs(t);
    if (!job) throw new Error("no tombstone job");
    // A crash between the regional batch and the global write: the job fails, its row stays.
    const crashing = regionalDb(
      env.DB_EU,
      raceGlobalBeforeStatement(/^insert into "tombstones"/i, async () => {
        throw new Error("crash");
      }),
    );
    await expect(writeCommentTombstones(crashing, job)).rejects.toThrow();
    expect(await tombstoned(old)).toBe(false);
    expect(await tombstoneJobs(t)).toHaveLength(1);
    expect(await writeCommentTombstones(home(t), job)).toBe("done");
    expect(await tombstoned(old)).toBe(true);
  });

  it("drops a tombstone job it cannot read", async () => {
    const t = await team("eu");
    const [row] = await home(t)
      .insert(schema.outbox)
      .values({
        topic: "comment_tombstones",
        payload: "{not json" as never,
        availableAt: NOW,
        createdAt: NOW,
        subject: t.id,
        attempts: 0,
      })
      .returning();
    if (!row) throw new Error("no row");
    expect(await writeCommentTombstones(home(t), { ...row, payload: "{not json" })).toBe("stale");
  });

  it("deletes nothing when the rule is removed before the batch reads the revision again", async () => {
    const t = await team("eu");
    const artifact = await publishIn(t.editor.id, t.id, "eu");
    const old = await thread(t, artifact, { agoDays: 200 });
    value(await save(t, retention(90)));
    // Removed after the scan's global read, when the guard moves the epoch (the run's first
    // global write), before the EU batch: the revision read again just before it stops it.
    const raced = regionalDb(
      env.DB_EU,
      // The guard's epoch bump: after the scan's read, before the EU batch.
      raceGlobalBeforeStatement(/^insert into "maintenance_cursors"/i, async () => {
        value(await save(t, retention(null), { now: FROM }));
      }),
    );
    const run = await enforceCommentRetention(raced, env.ARTIFACTS_EU, FROM, "eu");
    expect(run).toMatchObject({ paused: false, failed: 0 });
    expect(await exists(t, old)).toBe(true);
    expect((await stored(t)).commentRetentionDays).toBeNull();
  });

  it("deletes nothing when the plan is removed before the batch reads it again", async () => {
    const t = await team("eu");
    const artifact = await publishIn(t.editor.id, t.id, "eu");
    const old = await thread(t, artifact, { agoDays: 200 });
    value(await save(t, retention(90)));
    // The plan row goes after the scan's read, before the EU batch: its second read stops it.
    const raced = regionalDb(
      env.DB_EU,
      raceGlobalBeforeStatement(/^insert into "maintenance_cursors"/i, async () => {
        await regions().global.delete(schema.ownerPlans).where(eq(schema.ownerPlans.ownerId, t.id));
      }),
    );
    const run = await enforceCommentRetention(raced, env.ARTIFACTS_EU, FROM, "eu");
    expect(run).toMatchObject({ failed: 0 });
    expect(await exists(t, old)).toBe(true);
  });

  it("deletes at most one batch when the removal lands inside the documented window", async () => {
    const t = await team("eu");
    const artifact = await publishIn(t.editor.id, t.id, "eu");
    const ids: string[] = [];
    for (let i = 0; i < WORKSPACE_POLICIES.commentDeleteBatch + 5; i += 1) {
      ids.push(await thread(t, artifact, { agoDays: 200, messages: 1 }));
    }
    value(await save(t, retention(90)));
    // Removed between the revision's second read and the EU batch: no statement can span the two
    // databases, so this batch still runs (decision 0023, the worst window); nothing after it.
    const raced = raceBeforeFirstWrite(async () => {
      value(await save(t, retention(null), { now: FROM }));
    }, env.DB_EU);
    await enforceCommentRetention(raced, env.ARTIFACTS_EU, FROM, "eu");
    await scan(t, FROM + DAY);
    const left = (await Promise.all(ids.map((id) => exists(t, id)))).filter(Boolean).length;
    expect(ids.length - left).toBeLessThanOrEqual(WORKSPACE_POLICIES.commentDeleteBatch);
  });
});

describe("an open thread's clock", () => {
  it("gives an open thread the whole period from the publish that made its version earlier", async () => {
    const t = await team();
    const artifact = await publishIn(t.editor.id, t.id);
    const open = await thread(t, artifact, { agoDays: 400, state: "open" });
    // Kept while its version is current, and counted nowhere.
    expect(value(await preview(t, retention(90)))).toMatchObject({
      threadsAtStart: 0,
      threadsSoon: 0,
    });
    value(await save(t, retention(90)));
    await scan(t, FROM);
    expect(await exists(t, open)).toBe(true);
    // A publish the day after: the thread's clock starts then, not at its last activity.
    await publishNext(t, artifact, FROM + DAY);
    await scan(t, FROM + DAY);
    expect(await exists(t, open)).toBe(true);
    await scan(t, FROM + DAY + 90 * DAY - 1);
    expect(await exists(t, open)).toBe(true);
    await scan(t, FROM + DAY + 90 * DAY);
    expect(await exists(t, open)).toBe(false);
  });

  it("starts the clock at a rollback that made the version earlier", async () => {
    const t = await team();
    const v1 = await publishIn(t.editor.id, t.id);
    const v2 = await publishNext(t, v1, NOW - 300 * DAY);
    const open = await thread(t, v2, { agoDays: 300, state: "open" });
    value(await save(t, retention(90)));
    value(
      await rollbackArtifact(db(), {
        userId: t.editor.id,
        artifactId: v1.artifactId,
        versionId: v1.versionId,
        baseVersionId: v2.versionId,
        now: FROM,
      }),
    );
    await scan(t, FROM + 89 * DAY);
    expect(await exists(t, open)).toBe(true);
    await scan(t, FROM + 90 * DAY);
    expect(await exists(t, open)).toBe(false);
  });

  it("reads a pruned version's replacement from the current version's commit, never earlier", async () => {
    const t = await team();
    const v1 = await publishIn(t.editor.id, t.id);
    const open = await thread(t, v1, { agoDays: 400, state: "open" });
    const v2 = await publishNext(t, v1, NOW - 100 * DAY);
    const v3 = await publishNext(t, v2, NOW - 10 * DAY);
    // v1 pruned (its row gone): the clock is v3's commit, later than v1's true replacement.
    await db().delete(schema.versions).where(eq(schema.versions.id, v1.versionId));
    value(await save(t, retention(90)));
    await scan(t, NOW + 79 * DAY);
    expect(await exists(t, open)).toBe(true);
    await scan(t, NOW + 80 * DAY);
    expect(await exists(t, open)).toBe(false);
    expect(v3.versionId).not.toBe(v2.versionId);
  });

  it("counts in the preview exactly what the scan then deletes", async () => {
    const t = await team();
    const artifact = await publishIn(t.editor.id, t.id);
    await thread(t, artifact, { agoDays: 400, messages: 3 });
    await thread(t, artifact, { agoDays: 400, state: "open" });
    const next = await publishNext(t, artifact, NOW - 200 * DAY);
    await thread(t, next, { agoDays: 150, messages: 2 });
    await thread(t, next, { agoDays: 10 });
    const shown = value(await preview(t, retention(90)));
    // The resolved 400-day thread, the open one replaced 200 days ago, the resolved 150-day one.
    expect(shown).toMatchObject({ threadsAtStart: 3, messagesAtStart: 7 });
    value(await save(t, retention(90)));
    const run = await scan(t, FROM);
    expect(run.threads).toBeGreaterThanOrEqual(3);
    const left = await home(t)
      .select({ id: th.id })
      .from(th)
      .where(eq(th.artifactId, artifact.artifactId));
    expect(left).toHaveLength(1);
  });
});

describe("the restore guard fails closed", () => {
  async function databaseEpoch() {
    const [row] = await regions()
      .global.select({ cursor: schema.maintenanceCursors.cursor })
      .from(schema.maintenanceCursors)
      .where(eq(schema.maintenanceCursors.name, "comment_retention_epoch"));
    return row?.cursor ?? null;
  }
  /** Puts the global epoch back to `cursor` (a restore of the global database), then re-arms. */
  async function rewound<T>(cursor: string | null, work: () => Promise<T>): Promise<T> {
    const c = schema.maintenanceCursors;
    const current = await databaseEpoch();
    try {
      if (cursor === null)
        await regions().global.delete(c).where(eq(c.name, "comment_retention_epoch"));
      else
        await regions()
          .global.update(c)
          .set({ cursor })
          .where(eq(c.name, "comment_retention_epoch"));
      return await work();
    } finally {
      await armCommentRetention(regions().global, Math.max(Number(current ?? 0), NOW + 2000 * DAY));
    }
  }

  it("deletes nothing in the run when the bucket cannot be read or written", async () => {
    const a = await team();
    const b = await team();
    const ta = await thread(a, await publishIn(a.editor.id, a.id), { agoDays: 400 });
    const tb = await thread(b, await publishIn(b.editor.id, b.id), { agoDays: 400 });
    value(await save(a, retention(90)));
    value(await save(b, retention(90)));
    const broken = memoryBucket(undefined, { get: true, put: true });
    const run = await enforceCommentRetention(home(a), broken, FROM + 500 * DAY, "default");
    expect(run.paused).toBe(true);
    expect(await exists(a, ta)).toBe(true);
    expect(await exists(b, tb)).toBe(true);
  });

  it("deletes nothing when the bucket cannot be raised to the epoch, at the start or before the first deletion", async () => {
    const t = await team();
    const old = await thread(t, await publishIn(t.editor.id, t.id), { agoDays: 400 });
    value(await save(t, retention(90)));
    // Behind the epoch, and the raise fails: paused.
    const behind = memoryBucket("0", { put: true });
    expect(
      (await enforceCommentRetention(home(t), behind, FROM + 500 * DAY, "default")).paused,
    ).toBe(true);
    expect(await exists(t, old)).toBe(true);
    // Level with it, and the raise before the first deletion fails: paused, nothing deleted.
    const level = memoryBucket(String(await databaseEpoch()), { put: true });
    expect(
      (await enforceCommentRetention(home(t), level, FROM + 500 * DAY, "default")).paused,
    ).toBe(true);
    expect(await exists(t, old)).toBe(true);
    expect(level.held()).not.toBeUndefined();
  });

  it("deletes nothing when the global epoch cannot be read", async () => {
    const t = await team();
    const old = await thread(t, await publishIn(t.editor.id, t.id), { agoDays: 400 });
    value(await save(t, retention(90)));
    const run = await rewound("garbled", () =>
      enforceCommentRetention(home(t), memoryBucket(), FROM + 500 * DAY, "default"),
    );
    expect(run.paused).toBe(true);
    expect(await exists(t, old)).toBe(true);
  });

  it("pauses after a restore to before a plan lapse", async () => {
    const t = await team();
    const artifact = await publishIn(t.editor.id, t.id);
    await thread(t, artifact, { agoDays: 400 });
    value(await save(t, retention(90)));
    const bucket = memoryBucket();
    const T0 = FROM + 600 * DAY;
    await enforceCommentRetention(home(t), bucket, T0, "default");
    const g = regions().global;
    const [ws] = await g.select().from(schema.workspaces).where(eq(schema.workspaces.id, t.id));
    const [plan] = await g
      .select()
      .from(schema.ownerPlans)
      .where(eq(schema.ownerPlans.ownerId, t.id));
    const point = await databaseEpoch();
    const late = await thread(t, artifact, { agoDays: 400 });
    // The plan goes; the next scan removes the rule and raises the bucket.
    await g.delete(schema.ownerPlans).where(eq(schema.ownerPlans.ownerId, t.id));
    expect((await enforceCommentRetention(home(t), bucket, T0 + DAY, "default")).suspended).toBe(1);
    // A restore of the global database to before the lapse: the rule and the plan are back.
    const after = await rewound(point, async () => {
      await g
        .update(schema.workspaces)
        .set({ policy: ws?.policy, policyRevision: ws?.policyRevision })
        .where(eq(schema.workspaces.id, t.id));
      if (plan) await g.insert(schema.ownerPlans).values(plan);
      return enforceCommentRetention(home(t), bucket, T0 + 2 * DAY, "default");
    });
    expect(after.paused).toBe(true);
    expect(await exists(t, late)).toBe(true);
  });

  it("raises the bucket at the next scan when a removal's own raise failed", async () => {
    const t = await team();
    const old = await thread(t, await publishIn(t.editor.id, t.id), { agoDays: 400 });
    const policyBefore = retention(90);
    value(await save(t, policyBefore));
    const failing = memoryBucket(undefined, { put: true });
    const point = await databaseEpoch();
    const [before] = await regions()
      .global.select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, t.id));
    // The removal is saved; the bucket write right after it fails (logged, the save succeeds).
    const failingRegions = regionsFromEnv({ ...env, ARTIFACTS: failing });
    value(
      await setWorkspacePolicy(failingRegions, {
        userId: t.admin.id,
        slug: t.slug,
        policy: retention(null),
        revision: await revision(t),
        now: FROM,
      }),
    );
    expect(failing.held()).toBeUndefined();
    // The next scan raises it (the same bucket, writable again) before anything else.
    const bucket = memoryBucket();
    await enforceCommentRetention(home(t), bucket, FROM + DAY, "default");
    expect(Number(bucket.held())).toBeGreaterThan(Number(point));
    // A restore to before the removal now pauses.
    const after = await rewound(point, async () => {
      await regions()
        .global.update(schema.workspaces)
        .set({ policy: before?.policy, policyRevision: before?.policyRevision })
        .where(eq(schema.workspaces.id, t.id));
      return enforceCommentRetention(home(t), bucket, FROM + 500 * DAY, "default");
    });
    expect(after.paused).toBe(true);
    expect(await exists(t, old)).toBe(true);
  });
});

describe("what the selection is held to", () => {
  it("never deletes a thread whose artifact another owner holds", async () => {
    const t = await team();
    const other = await team();
    const theirs = await publishIn(other.editor.id, other.id);
    // A thread that names the workspace while its artifact is another owner's.
    const stray = await thread(t, theirs, { agoDays: 400 });
    value(await save(t, retention(90)));
    await scan(t, FROM + 500 * DAY);
    expect(await exists(t, stray)).toBe(true);
  });

  it("goes on with every other workspace when one stored policy is not JSON", async () => {
    const good = await team();
    const kept = await thread(good, await publishIn(good.editor.id, good.id), { agoDays: 400 });
    value(await save(good, retention(90)));
    const bad = await team();
    const w = schema.workspaces;
    try {
      await regions()
        .global.update(w)
        .set({ policy: sql`'{not json'` as never })
        .where(eq(w.id, bad.id));
      const run = await scan(good, FROM + 700 * DAY);
      expect(run.paused).toBe(false);
      expect(await exists(good, kept)).toBe(false);
      // The maximum life's stale-cap sweep reads every policy in one statement too.
      await expect(staleCapOwners(db(), NOW, [], true)).resolves.toBeDefined();
    } finally {
      await regions().global.update(w).set({ policy: null }).where(eq(w.id, bad.id));
    }
  });
});

describe("the invariant, as a property", () => {
  /**
   * Seeded sequences of saves (set, shorten, lengthen, remove), replies, resolutions, publishes,
   * suspensions, reinstatements, moves out and back in, and saves racing a scan's deletion batch,
   * each followed by a scan. Before every scan the model lists, from the policy in force at the
   * moment of the delete and each thread's state, the threads the rule may delete
   * (`threadDeletable`, with the clock from the versions table); after it, every thread gone must
   * be in that list, have its tombstone and be counted by the scan's `policy.enforced` events, and
   * the owner's `annotation_usage.messages` must equal the messages left. Counters, over all
   * seeds, require that each shape was reached: deletions, threads held back only by the
   * effective date, only by the move notice, open threads on the current version past their
   * deadline, open threads kept by a publish's clock, threads spared only by a racing save, rules
   * removed or lengthened with threads they would have deleted, moves and suspensions.
   */
  const SEEDS = [7, 2, 99, 1234, 31337];
  const totals = {
    deleted: 0,
    blockedByFrom: 0,
    blockedByMove: 0,
    openOnCurrentPastDeadline: 0,
    keptByPublishClock: 0,
    sparedByRace: 0,
    sparedByChange: 0,
    moved: 0,
    suspended: 0,
    published: 0,
  };

  async function leftCurrentOf(
    one: typeof th.$inferSelect,
    current: string | null,
  ): Promise<number | null> {
    const v = schema.versions;
    const [own] = await db().select({ at: v.supersededAt }).from(v).where(eq(v.id, one.versionId));
    if (own?.at != null) return own.at;
    if (current === null) return null;
    const [now] = await db().select({ at: v.committedAt }).from(v).where(eq(v.id, current));
    return now?.at ?? null;
  }

  it.each(SEEDS)("never deletes outside the rule in force, seed %i", async (initial) => {
    let seed = initial;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return Math.floor(seed / 65536) % n;
    };
    const failures: unknown[] = [];
    for (let sequence = 0; sequence < 3; sequence += 1) {
      const t = await team();
      const artifact = await publishIn(t.editor.id, t.id);
      const ids: string[] = [];
      for (const agoDays of [300, 200, 120, 95, 60, 20]) {
        ids.push(
          await thread(t, artifact, {
            agoDays,
            state: rnd(3) === 0 ? "open" : "resolved",
            messages: 1 + rnd(3),
          }),
        );
      }
      for (const agoDays of [400, 250]) {
        ids.push(await thread(t, artifact, { agoDays, state: "open" }));
      }
      // A thread on a version whose row is gone (pruned): the clock's fallback.
      ids.push(await thread(t, artifact, { agoDays: 250, state: "open", version: "ver_gone" }));
      let now = NOW;
      let previous: number | null = null;
      for (let step = 0; step < 9; step += 1) {
        now += (1 + rnd(12)) * DAY;
        let race: WorkspacePolicy | null = null;
        const [art0] = await db()
          .select()
          .from(schema.artifacts)
          .where(eq(schema.artifacts.id, artifact.artifactId));
        switch (rnd(7)) {
          case 0:
          case 1: {
            const days = [null, 30, 90, 180][rnd(4)] as number | null;
            value(await save(t, retention(days), { now }));
            break;
          }
          case 2: {
            const id = ids[rnd(ids.length)] as string;
            await home(t)
              .update(th)
              .set({ updatedAt: now, state: rnd(2) ? "open" : "resolved" })
              .where(eq(th.id, id));
            break;
          }
          case 3: {
            if (art0?.state === "active") {
              await suspendArtifact(home(t), {
                artifactId: artifact.artifactId,
                reason: "spam",
                now,
              });
              totals.suspended += 1;
            } else if (art0?.state === "suspended") {
              await reinstateArtifact(home(t), { artifactId: artifact.artifactId, now });
            }
            break;
          }
          case 4: {
            if (art0?.state !== "active") break;
            const out = art0.ownerId === t.id;
            const moved = await transferArtifact(db(), env.ARTIFACTS, {
              userId: t.admin.id,
              artifactId: artifact.artifactId,
              workspace: out ? null : t.slug,
              now,
            });
            if (moved.ok) totals.moved += 1;
            break;
          }
          case 5: {
            if (art0?.state !== "active" || art0.ownerId !== t.id || !art0.currentVersionId) break;
            await publishNext(
              t,
              { artifactId: artifact.artifactId, versionId: art0.currentVersionId },
              now,
            );
            totals.published += 1;
            break;
          }
          default: {
            // A save that commits between the scan's read and its deletion batch.
            const current = (await stored(t)).commentRetentionDays;
            race = retention(current === null ? null : rnd(2) ? null : current + 60);
          }
        }
        const ruleOf = (policy: WorkspacePolicy) =>
          policy.commentRetentionDays === null
            ? null
            : { days: policy.commentRetentionDays, from: policy.commentRetentionFrom ?? 0 };
        const [art] = await db()
          .select()
          .from(schema.artifacts)
          .where(eq(schema.artifacts.id, artifact.artifactId));
        const rows = await home(t).select().from(th).where(eq(th.artifactId, artifact.artifactId));
        const facts = await Promise.all(
          rows.map(async (one) => ({
            one,
            thread: {
              state: one.state,
              onCurrentVersion: one.versionId === art?.currentVersionId,
              artifactState: art?.state ?? "deleted",
              lastActivity: one.updatedAt,
              movedIn: art?.lifeStartedAt ?? null,
              leftCurrent: await leftCurrentOf(one, art?.currentVersionId ?? null),
            },
          })),
        );
        const allowedBy = (rule: { days: number; from: number } | null) =>
          new Set(
            facts
              .filter(
                ({ thread: x }) =>
                  rule !== null && art?.ownerId === t.id && threadDeletable(rule, x, now),
              )
              .map(({ one }) => one.id),
          );
        const before = ruleOf(await stored(t));
        // Shapes the scan must hold back, counted from the rule read before it.
        if (before !== null && art?.ownerId === t.id) {
          for (const { thread: x } of facts) {
            const due = threadDeletable(before, x, now);
            if (due) continue;
            if (before.from > now && threadDeletable({ ...before, from: 0 }, x, now))
              totals.blockedByFrom += 1;
            if (threadDeletable(before, { ...x, movedIn: null }, now)) totals.blockedByMove += 1;
            if (
              x.state === "open" &&
              x.onCurrentVersion &&
              threadDeletable(before, { ...x, onCurrentVersion: false }, now)
            )
              totals.openOnCurrentPastDeadline += 1;
            if (
              x.state === "open" &&
              !x.onCurrentVersion &&
              threadDeletable(before, { ...x, leftCurrent: null }, now)
            )
              totals.keptByPublishClock += 1;
          }
        }
        let fired = false;
        const target = race
          ? raceBeforeBatchWith(/^delete from "annotation_threads"/i, async () => {
              fired = true;
              value(await save(t, race as WorkspacePolicy, { now }));
            })
          : home(t);
        await enforceCommentRetention(target, env.ARTIFACTS, now, "default");
        if (race && !fired) value(await save(t, race, { now }));
        const inForce = fired ? ruleOf(await stored(t)) : before;
        const allowed = allowedBy(inForce);
        if (fired) {
          const spared = [...allowedBy(before)].filter((id) => !allowed.has(id));
          if (spared.length > 0) totals.sparedByRace += 1;
        }
        // A rule removed or lengthened since a scan that could delete: what it would have taken.
        const after = ruleOf(await stored(t));
        const was = previous;
        if (was !== null && (after === null || after.days > was)) {
          if (rows.some((one) => one.updatedAt + was * DAY <= now && !allowedBy(after).has(one.id)))
            totals.sparedByChange += 1;
        }
        previous = after?.days ?? null;
        const left = new Set(
          (
            await home(t)
              .select({ id: th.id })
              .from(th)
              .where(eq(th.artifactId, artifact.artifactId))
          ).map((one) => one.id),
        );
        const gone = rows.filter((one) => !left.has(one.id));
        for (const one of gone) {
          totals.deleted += 1;
          if (!allowed.has(one.id)) failures.push({ sequence, step, id: one.id, inForce, now });
          const [marker] = await regions()
            .global.select()
            .from(schema.tombstones)
            .where(eq(schema.tombstones.id, one.id));
          if (marker?.kind !== "comment_thread") failures.push({ step, missingTombstone: one.id });
        }
        // The trail of this scan for the workspace, counts only, equal to what went.
        const events = await home(t)
          .select({ detail: schema.auditEvents.detail })
          .from(schema.auditEvents)
          .where(
            and(
              eq(schema.auditEvents.ownerId, t.id),
              eq(schema.auditEvents.kind, "policy.enforced"),
              eq(schema.auditEvents.at, now),
            ),
          );
        const counted = events.reduce(
          (sum, event) => {
            const d = event.detail as { threadsDeleted?: number; messagesDeleted?: number };
            return {
              threads: sum.threads + (d.threadsDeleted ?? 0),
              messages: sum.messages + (d.messagesDeleted ?? 0),
            };
          },
          { threads: 0, messages: 0 },
        );
        const expected = {
          threads: gone.length,
          messages: gone.reduce((sum, one) => sum + one.messageCount, 0),
        };
        if (JSON.stringify(counted) !== JSON.stringify(expected))
          failures.push({ step, counted, expected });
        // The quota, kept by the triggers alone.
        const [usage] = await home(t)
          .select({ messages: schema.annotationUsage.messages })
          .from(schema.annotationUsage)
          .where(eq(schema.annotationUsage.ownerId, t.id));
        const [kept] = await home(t)
          .select({ n: sql<number>`count(*)` })
          .from(m)
          .where(and(eq(m.ownerId, t.id), sql`${m.state} <> 'deleted'`));
        if (Number(usage?.messages ?? 0) !== Number(kept?.n ?? 0))
          failures.push({ step, usage: usage?.messages, kept: kept?.n });
      }
    }
    expect(failures.slice(0, 3)).toEqual([]);
  });

  it("reached every shape over the seeds", () => {
    for (const [shape, count] of Object.entries(totals)) {
      expect({ shape, reached: count > 0 }).toEqual({ shape, reached: true });
    }
  });
});

describe("the restore guard, as a property", () => {
  /**
   * The guard's invariant (decision 0023, "Restores"): every change that could make a restored
   * policy delete more than the current one (a removal, a lengthening, a recorded plan lapse) and
   * every deleting run moves the global epoch, and every epoch reaches the region's bucket before
   * that region deletes again; so after a restore of the global database to a point before such a
   * change, the first scan deletes nothing until `apply-policies` has run, and after any restore
   * it never deletes what the policies in force just before the restore would keep.
   *
   * Seeded histories over two workspaces of saves (set, shorten, lengthen, remove), plan removals
   * and grants, scans, and bucket writes that fail (only before the restore point, as R2 is
   * written again by every scan after it); a restore at a random point puts back the workspaces'
   * rows, their plan rows and the epoch row as D1 Time Travel would, and leaves the bucket as R2
   * does. Counters require the dangerous shapes: a rule removed or lengthened after the restore
   * point, a lapse recorded after it, and a failed bucket write before it.
   */
  const SEEDS = [3, 17, 404, 2026, 77777];
  const shapes = { removedAfter: 0, lapseAfter: 0, failedBefore: 0, pausedAfterChange: 0 };

  it.each(SEEDS)(
    "deletes nothing after a restore until the policies are applied, seed %i",
    async (initial) => {
      let seed = initial;
      const rnd = (n: number) => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return Math.floor(seed / 65536) % n;
      };
      const g = regions().global;
      const c = schema.maintenanceCursors;
      const w = schema.workspaces;
      const epochRow = async () =>
        (await g.select().from(c).where(eq(c.name, "comment_retention_epoch")))[0] ?? null;
      const original = await epochRow();
      const failures: unknown[] = [];
      try {
        for (let round = 0; round < 3; round += 1) {
          const teams = [await team(), await team()];
          const fail = { put: false };
          const bucket = memoryBucket(undefined, fail);
          const viaBucket = regionsFromEnv({ ...env, ARTIFACTS: bucket });
          const saveVia = async (t: Team, next: WorkspacePolicy, now: number) => {
            const shown = await previewWorkspacePolicy(viaBucket, {
              userId: t.admin.id,
              slug: t.slug,
              policy: next,
              now,
            });
            return setWorkspacePolicy(viaBucket, {
              userId: t.admin.id,
              slug: t.slug,
              policy: next,
              revision: await revision(t),
              confirmed: shown.ok ? shown.value : undefined,
              now,
            });
          };
          const artifacts = await Promise.all(teams.map((t) => publishIn(t.editor.id, t.id)));
          // Epochs are wall-clock times: this history starts after every epoch written so far.
          let now = Math.max(NOW, Number((await epochRow())?.cursor ?? 0));
          for (const t of teams) value(await saveVia(t, retention(90), now));
          const steps = 6 + rnd(6);
          const point = 1 + rnd(steps - 1);
          let snapshot: {
            workspaces: (typeof w.$inferSelect)[];
            plans: (typeof schema.ownerPlans.$inferSelect)[];
            epoch: typeof c.$inferSelect | null;
          } | null = null;
          let movedAfter = false;
          for (let step = 0; step < steps; step += 1) {
            if (step === point) {
              snapshot = {
                workspaces: await g
                  .select()
                  .from(w)
                  .where(
                    sql`${w.id} in (${sql.join(
                      teams.map((t) => sql`${t.id}`),
                      sql`, `,
                    )})`,
                  ),
                plans: await g
                  .select()
                  .from(schema.ownerPlans)
                  .where(
                    sql`${schema.ownerPlans.ownerId} in (${sql.join(
                      teams.map((t) => sql`${t.id}`),
                      sql`, `,
                    )})`,
                  ),
                epoch: await epochRow(),
              };
              fail.put = false;
            }
            now += (1 + rnd(5)) * DAY;
            const i = rnd(2);
            const t = teams[i] as Team;
            // Old threads keep coming, so a rule in force always has something to delete.
            await thread(t, artifacts[i] as { artifactId: string; versionId: string }, {
              agoDays: (NOW - now) / DAY + 400,
            });
            if (step < point && rnd(3) === 0) {
              fail.put = true;
              shapes.failedBefore += 1;
            }
            const current = (await stored(t)).commentRetentionDays;
            switch (step >= point ? ([1, 1, 2, 3][rnd(4)] as number) : rnd(4)) {
              case 0: {
                const days = current === null ? 90 : Math.max(30, current - 30);
                await saveVia(t, retention(days), now);
                break;
              }
              case 1: {
                if (current === null) break;
                const next = rnd(2) ? null : current + 60;
                if ((await saveVia(t, retention(next), now)).ok && step >= point) {
                  movedAfter = true;
                  shapes.removedAfter += 1;
                }
                break;
              }
              case 2: {
                const [plan] = await g
                  .select()
                  .from(schema.ownerPlans)
                  .where(eq(schema.ownerPlans.ownerId, t.id));
                if (plan)
                  await g.delete(schema.ownerPlans).where(eq(schema.ownerPlans.ownerId, t.id));
                else await grantPlan(t.id, "enterprise", { seats: 10 });
                break;
              }
              default:
                break;
            }
            // Steps are days apart and the scan runs every 15 minutes: one after every step.
            const run = await enforceCommentRetention(home(t), bucket, now, "default");
            if (step >= point && (run.suspended > 0 || run.threads > 0) && !run.paused) {
              movedAfter = true;
              if (run.suspended > 0) shapes.lapseAfter += 1;
            }
            if (step < point) fail.put = false;
          }
          if (!snapshot) throw new Error("no restore point");
          // What the policies in force just before the restore allow, per thread.
          const keptNow = new Map<string, Set<string>>();
          for (const t of teams) {
            const policy = await stored(t);
            const [plan] = await g
              .select()
              .from(schema.ownerPlans)
              .where(eq(schema.ownerPlans.ownerId, t.id));
            const rule =
              policy.commentRetentionDays === null || !plan
                ? null
                : { days: policy.commentRetentionDays, from: policy.commentRetentionFrom ?? 0 };
            const rows = await home(t).select().from(th).where(eq(th.ownerId, t.id));
            keptNow.set(
              t.id,
              new Set(
                rows
                  .filter(
                    (one) =>
                      rule === null ||
                      !threadDeletable(
                        rule,
                        {
                          state: one.state,
                          onCurrentVersion: false,
                          artifactState: "active",
                          lastActivity: one.updatedAt,
                          movedIn: null,
                          leftCurrent: null,
                        },
                        now + DAY,
                      ),
                  )
                  .map((one) => one.id),
              ),
            );
          }
          const exported = await exportWorkspacePolicies(g);
          // The restore: the workspaces' rows, their plan rows and the epoch row go back; R2 stays.
          for (const row of snapshot.workspaces) {
            await g
              .update(w)
              .set({ policy: row.policy, policyRevision: row.policyRevision })
              .where(eq(w.id, row.id));
          }
          for (const t of teams)
            await g.delete(schema.ownerPlans).where(eq(schema.ownerPlans.ownerId, t.id));
          for (const plan of snapshot.plans) await g.insert(schema.ownerPlans).values(plan);
          if (snapshot.epoch === null)
            await g.delete(c).where(eq(c.name, "comment_retention_epoch"));
          else
            await g
              .update(c)
              .set({ cursor: snapshot.epoch.cursor })
              .where(eq(c.name, "comment_retention_epoch"));
          const ids = async (t: Team) =>
            new Set(
              (await home(t).select({ id: th.id }).from(th).where(eq(th.ownerId, t.id))).map(
                (r) => r.id,
              ),
            );
          const before = await Promise.all(teams.map(ids));
          const first = await enforceCommentRetention(
            home(teams[0] as Team),
            bucket,
            now + DAY,
            "default",
          );
          const after = await Promise.all(teams.map(ids));
          teams.forEach((t, k) => {
            const gone = [...(before[k] as Set<string>)].filter(
              (id) => !(after[k] as Set<string>).has(id),
            );
            if (movedAfter && gone.length > 0)
              failures.push({ round, team: k, deletedAfterChange: gone.length });
            const kept = keptNow.get(t.id) as Set<string>;
            const wrong = gone.filter((id) => kept.has(id));
            if (wrong.length > 0)
              failures.push({ round, team: k, deletedWhatCurrentKeeps: wrong.length });
          });
          if (movedAfter) {
            if (!first.paused) failures.push({ round, notPaused: true });
            else shapes.pausedAfterChange += 1;
          }
          // `apply-policies` with the export taken before the restore re-arms it.
          await applyWorkspacePolicies(g, exported, now + 2 * DAY);
          const resumed = await enforceCommentRetention(
            home(teams[0] as Team),
            bucket,
            now + 3 * DAY,
            "default",
          );
          if (resumed.paused) failures.push({ round, stillPaused: true });
        }
      } finally {
        await armCommentRetention(g, Math.max(Number(original?.cursor ?? 0), NOW + 3000 * DAY));
      }
      expect(failures.slice(0, 3)).toEqual([]);
    },
  );

  it("reached the dangerous shapes over the seeds", () => {
    for (const [shape, count] of Object.entries(shapes)) {
      expect({ shape, reached: count > 0 }).toEqual({ shape, reached: true });
    }
  });
});

describe("the notices' and the scan's edges", () => {
  const notifier = () => {
    const sent: Parameters<CommentRetentionNotifier["send"]>[0][] = [];
    return { sent, send: async (notice: (typeof sent)[number]) => void sent.push(notice) };
  };
  async function noticeJob(t: Team) {
    const [job] = await regions()
      .global.select()
      .from(schema.outbox)
      .where(
        and(eq(schema.outbox.topic, "comment_retention_notice"), eq(schema.outbox.subject, t.id)),
      );
    if (!job) throw new Error("no notice");
    return job;
  }

  it("puts the job back when the first send fails, and skips suppressed admins", async () => {
    const t = await team();
    value(await save(t, retention(90)));
    const failing: CommentRetentionNotifier = {
      send: async () => {
        throw new Error("down");
      },
    };
    await expect(sendNotice(home(t), await noticeJob(t), NOW, failing)).rejects.toThrow("down");
    // Back in the outbox; with its only admin suppressed, nothing goes out and the job ends.
    const back = await noticeJob(t);
    await suppressEmail(regions().global, {
      email: t.admin.email,
      reason: "hard_bounce",
      now: NOW,
    });
    expect(await sendNotice(home(t), back, NOW, notifier())).toBe("stale");
  });

  it("suppresses an address the provider refuses", async () => {
    const t = await team();
    value(await save(t, retention(90)));
    const provider: CommentRetentionNotifier = {
      send: async () => {
        throw new RecipientSuppressedError();
      },
    };
    expect(await sendNotice(home(t), await noticeJob(t), NOW, provider)).toBe("stale");
    const [suppressed] = await regions().global.select().from(schema.emailSuppressions).limit(1);
    expect(suppressed).toBeTruthy();
  });

  it("sends once whatever the delivery, and reads a payload stored as text", async () => {
    const t = await team();
    value(await save(t, retention(90)));
    const job = await noticeJob(t);
    const fake = notifier();
    const asText = { ...job, payload: JSON.stringify(job.payload) };
    expect(await sendNotice(home(t), asText, NOW, fake)).toBe("done");
    // Claimed by the first delivery: a second one sends nothing.
    expect(await sendNotice(home(t), job, NOW, fake)).toBe("done");
    expect(fake.sent).toHaveLength(1);
  });

  it("keeps going after one admin got it when a later send fails", async () => {
    const t = await team();
    const second = await person("Second");
    await regions()
      .global.insert(schema.workspaceMembers)
      .values({ workspaceId: t.id, userId: second.id, role: "admin", updatedAt: NOW });
    value(await save(t, retention(90)));
    let calls = 0;
    const flaky: CommentRetentionNotifier = {
      send: async () => {
        calls += 1;
        if (calls === 2) throw new Error("down");
      },
    };
    expect(await sendNotice(home(t), await noticeJob(t), NOW, flaky)).toBe("done");
    expect(calls).toBe(2);
  });

  it("stops at the notice capacity, and ends for a workspace with no admin", async () => {
    const t = await team();
    value(await save(t, retention(90)));
    const later = NOW + 400 * DAY;
    await recordEmailsSent(regions().global, later, NOTICE_EMAILS_PER_CYCLE);
    const fake = notifier();
    expect(await sendNotice(home(t), await noticeJob(t), later, fake)).toBe("stale");
    expect(fake.sent).toEqual([]);
    // A workspace whose admins are all gone (rows written directly: the product never leaves
    // one without an admin, but the job must not fail on it).
    const lone = `ws_${hex()}`;
    const from = NOW + NOTICE;
    await regions()
      .global.insert(schema.workspaces)
      .values({
        id: lone,
        slug: `l${hex().slice(0, 20)}`,
        name: "Lone",
        createdBy: t.admin.id,
        updatedAt: NOW,
        policy: storedPolicy({ ...retention(90), commentRetentionFrom: from }),
      });
    await regions()
      .global.insert(schema.outbox)
      .values({
        topic: "comment_retention_notice",
        payload: { kind: "set", days: 90, from, at: from, threads: 0, messages: 0, revision: 1 },
        availableAt: NOW,
        createdAt: NOW,
        subject: lone,
        attempts: 0,
      });
    const [orphan] = await regions()
      .global.select()
      .from(schema.outbox)
      .where(eq(schema.outbox.subject, lone));
    if (!orphan) throw new Error("no job");
    expect(await sendNotice(home(t), orphan, NOW, notifier())).toBe("stale");
  });

  it("is moot for a malformed payload or a workspace that is gone", async () => {
    const t = await team();
    value(await save(t, retention(90)));
    const job = await noticeJob(t);
    expect(await sendNotice(home(t), { ...job, payload: { kind: "later" } }, NOW, notifier())).toBe(
      "stale",
    );
    await regions()
      .global.insert(schema.outbox)
      .values({
        topic: "comment_retention_notice",
        payload: job.payload,
        availableAt: NOW,
        createdAt: NOW,
        subject: `ws_${hex()}`,
        attempts: 0,
      });
    const [orphan] = await regions()
      .global.select()
      .from(schema.outbox)
      .where(
        and(
          eq(schema.outbox.topic, "comment_retention_notice"),
          sql`${schema.outbox.subject} not in (select ${schema.workspaces.id} from ${schema.workspaces})`,
        ),
      )
      .limit(1);
    if (!orphan) throw new Error("no job");
    expect(await sendNotice(home(t), orphan, NOW, notifier())).toBe("stale");
  });

  it("keeps the job when the workspace's policy cannot be read, and sends it once it can", async () => {
    const jobs = (t: Team) =>
      regions()
        .global.select()
        .from(schema.outbox)
        .where(
          and(eq(schema.outbox.topic, "comment_retention_notice"), eq(schema.outbox.subject, t.id)),
        );
    const t = await team();
    value(await save(t, retention(90)));
    const [job] = await jobs(t);
    if (!job) throw new Error("no notice");
    const w = schema.workspaces;
    const [saved] = await regions().global.select().from(w).where(eq(w.id, t.id));
    await regions()
      .global.update(w)
      .set({ policy: { publicAccess: 5 } as never })
      .where(eq(w.id, t.id));
    await expect(sendNotice(home(t), job, NOW, notifier())).rejects.toThrow();
    expect(await jobs(t)).toHaveLength(1);
    await regions().global.update(w).set({ policy: saved?.policy }).where(eq(w.id, t.id));
    const fake = notifier();
    expect(await sendNotice(home(t), job, NOW, fake)).toBe("done");
    expect(fake.sent).toHaveLength(1);
  });

  it("deletes nothing without a bucket for the restore guard", async () => {
    const t = await team();
    const artifact = await publishIn(t.editor.id, t.id);
    const old = await thread(t, artifact, { agoDays: 200 });
    value(await save(t, retention(90)));
    const run = await enforceCommentRetention(home(t), undefined, FROM, "default");
    expect(run.paused).toBe(true);
    expect(await exists(t, old)).toBe(true);
  });

  it("counts an unreadable policy as a failure and goes on with the others", async () => {
    const t = await team();
    await regions()
      .global.update(schema.workspaces)
      .set({ policy: { commentRetentionDays: 90, unknown: true } as never })
      .where(eq(schema.workspaces.id, t.id));
    const run = await scan(t, FROM);
    expect(run.failed).toBeGreaterThan(0);
  });

  it("suspends the rule of a workspace with no plan row at all", async () => {
    const t = await team();
    value(await save(t, retention(90)));
    await regions().global.delete(schema.ownerPlans).where(eq(schema.ownerPlans.ownerId, t.id));
    // Other tests' workspaces share the run's bounds: a few runs reach this one.
    const runs: unknown[] = [];
    for (let run = 0; run < 10 && (await stored(t)).commentRetentionDays !== null; run += 1) {
      runs.push(await scan(t, FROM));
    }
    expect((await stored(t)).commentRetentionDays).toBeNull();
    // It never stopped the run for the others.
    expect(runs).not.toContainEqual(expect.objectContaining({ checked: 0, failed: 1 }));
  });
});
