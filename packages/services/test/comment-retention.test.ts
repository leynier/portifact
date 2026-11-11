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
import {
  applyWorkspacePolicies,
  exportWorkspacePolicies,
  previewWorkspacePolicy,
  setWorkspacePolicy,
} from "../src/workspace-policies.ts";
import { DAY, db, grantPlan, NOW, racing, sha256, value } from "./fixtures.ts";
import { raceBeforeFirstWrite, raceGlobalBeforeStatement } from "./race.ts";

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

async function publishIn(userId: string, ownerId: string, region: "default" | "eu" = "default") {
  const body = `<p>${crypto.randomUUID()}</p>`;
  const digest = await sha256(body);
  const target = regions().get(region).db;
  const prepared = value(
    await preparePublish(target, {
      userId,
      targetOwnerId: ownerId,
      type: "site",
      name: "Plan",
      entrypoint: "index.html",
      baseVersionId: null,
      files: [
        {
          path: "index.html",
          kind: "published" as const,
          sha256: digest,
          size: body.length,
          contentType: "text/html",
        },
      ],
      now: NOW - 400 * DAY,
    }),
  );
  const bucket = region === "eu" ? env.ARTIFACTS_EU : env.ARTIFACTS;
  await bucket.put(`objects/${ownerId}/${digest}`, body);
  return value(
    await commitPublish(target, bucket, {
      userId,
      sessionId: prepared.sessionId,
      now: NOW - 400 * DAY,
    }),
  );
}

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

  it("raises a bucket's mark and never lowers it, reading an unreadable one as none", async () => {
    const epoch = await armCommentRetention(regions().global, NOW + 300 * DAY);
    await env.ARTIFACTS.put(COMMENT_RETENTION_EPOCH_KEY, "not a number");
    await syncBucketEpoch(env.ARTIFACTS, epoch);
    expect(await (await env.ARTIFACTS.get(COMMENT_RETENTION_EPOCH_KEY))?.text()).toBe(
      String(epoch),
    );
    await syncBucketEpoch(env.ARTIFACTS, epoch - DAY);
    expect(await (await env.ARTIFACTS.get(COMMENT_RETENTION_EPOCH_KEY))?.text()).toBe(
      String(epoch),
    );
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
    expect(plan).toContain("annotation_threads_owner_state_updated_idx (owner_id=?)");
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

  it("sends the set notice once, and the soon one before a first deletion long after it", async () => {
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
    // Day 26: the first deletion (day 30) is within 3 days... not yet; day 28 it is.
    await scan(t, NOW + 26 * DAY);
    expect(await jobs(t)).toEqual([]);
    await scan(t, NOW + 28 * DAY);
    const [soon] = await jobs(t);
    if (!soon) throw new Error("no second notice");
    expect(await sendNotice(home(t), soon, NOW + 28 * DAY, fake)).toBe("done");
    expect(fake.sent.at(-1)).toMatchObject({ kind: "soon", threads: 1, messages: 4 });
    // Once per revision.
    await scan(t, NOW + 29 * DAY);
    expect(await jobs(t)).toEqual([]);
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
  it("deletes on the EU database, with its tombstones on the global one", async () => {
    const t = await team("eu");
    const artifact = await publishIn(t.editor.id, t.id, "eu");
    const old = await thread(t, artifact, { agoDays: 200 });
    value(await save(t, retention(90)));
    const run = await scan(t, FROM);
    expect(run).toMatchObject({ paused: false, failed: 0 });
    expect(await exists(t, old)).toBe(false);
    const tombstone = await regions()
      .global.select()
      .from(schema.tombstones)
      .where(eq(schema.tombstones.id, old));
    expect(tombstone).toHaveLength(1);
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

describe("the invariant, as a property", () => {
  /**
   * Seeded sequences of saves (set, shorten, lengthen, remove), replies, resolutions, suspensions,
   * reinstatements, moves out and back in, and time passing, each followed by a scan. Before every
   * scan the model lists, from the policy in force and each thread's state, the threads the rule
   * may delete at that moment (`threadDeletable`); after it, every thread gone must be in that
   * list. Counters require that deletions happened, that removed or lengthened rules had threads
   * they would have deleted, and that moves and suspensions were reached.
   */
  const SEEDS = [7, 2, 99, 1234];
  it.each(SEEDS)("never deletes outside the rule in force, seed %i", async (initial) => {
    let seed = initial;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return Math.floor(seed / 65536) % n;
    };
    const seen = { deleted: 0, sparedByChange: 0, moved: 0, suspended: 0 };
    const failures: unknown[] = [];
    for (let sequence = 0; sequence < 4; sequence += 1) {
      const t = await team();
      const artifact = await publishIn(t.editor.id, t.id);
      const ids: string[] = [];
      for (const agoDays of [300, 200, 120, 95, 60, 20]) {
        ids.push(await thread(t, artifact, { agoDays, state: rnd(3) === 0 ? "open" : "resolved" }));
      }
      ids.push(await thread(t, artifact, { agoDays: 250, state: "open", version: "ver_old" }));
      let now = NOW;
      let previous: number | null = null;
      for (let step = 0; step < 8; step += 1) {
        now += (1 + rnd(10)) * DAY;
        switch (rnd(5)) {
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
            const [row] = await home(t)
              .select()
              .from(schema.artifacts)
              .where(eq(schema.artifacts.id, artifact.artifactId));
            if (row?.state === "active") {
              await suspendArtifact(home(t), {
                artifactId: artifact.artifactId,
                reason: "spam",
                now,
              });
              seen.suspended += 1;
            } else if (row?.state === "suspended") {
              await reinstateArtifact(home(t), { artifactId: artifact.artifactId, now });
            }
            break;
          }
          default: {
            const [row] = await home(t)
              .select()
              .from(schema.artifacts)
              .where(eq(schema.artifacts.id, artifact.artifactId));
            if (row?.state !== "active") break;
            const out = row.ownerId === t.id;
            const moved = await transferArtifact(db(), env.ARTIFACTS, {
              userId: t.admin.id,
              artifactId: artifact.artifactId,
              workspace: out ? null : t.slug,
              now,
            });
            if (moved.ok) seen.moved += 1;
          }
        }
        // The model's view at `now`, just before the scan.
        const policy = await stored(t);
        const rule =
          policy.commentRetentionDays === null
            ? null
            : { days: policy.commentRetentionDays, from: policy.commentRetentionFrom ?? 0 };
        const [art] = await home(t)
          .select()
          .from(schema.artifacts)
          .where(eq(schema.artifacts.id, artifact.artifactId));
        const rows = await home(t).select().from(th).where(eq(th.artifactId, artifact.artifactId));
        const allowed = new Set(
          rows
            .filter(
              (one) =>
                rule !== null &&
                art?.ownerId === t.id &&
                threadDeletable(
                  rule,
                  {
                    state: one.state,
                    onCurrentVersion: one.versionId === art.currentVersionId,
                    artifactState: art.state,
                    lastActivity: one.updatedAt,
                    movedIn: art.lifeStartedAt,
                  },
                  now,
                ),
            )
            .map((one) => one.id),
        );
        // A rule removed or lengthened since a scan that could delete: what it would have taken.
        const was = previous;
        if (was !== null && (rule === null || rule.days > was)) {
          const wouldHave = rows.filter(
            (one) => one.updatedAt + was * DAY <= now && !allowed.has(one.id),
          );
          if (wouldHave.length > 0) seen.sparedByChange += 1;
        }
        previous = rule?.days ?? null;
        await scan(t, now);
        const after = new Set(
          (
            await home(t)
              .select({ id: th.id })
              .from(th)
              .where(eq(th.artifactId, artifact.artifactId))
          ).map((one) => one.id),
        );
        for (const one of rows) {
          if (after.has(one.id)) continue;
          seen.deleted += 1;
          if (!allowed.has(one.id)) failures.push({ sequence, step, id: one.id, rule, now });
        }
      }
    }
    expect(seen.deleted).toBeGreaterThan(0);
    expect(seen.sparedByChange).toBeGreaterThan(0);
    expect(seen.moved + seen.suspended).toBeGreaterThan(0);
    expect(failures.slice(0, 3)).toEqual([]);
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
