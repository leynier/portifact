// Comment retention (decision 0023, "Comment retention"): who sets it, the plan and its lapse,
// the preview and the confirmation, the notice period, what is deleted and what is kept, the rule
// in force at the moment of every delete (also against a save racing the scan, in both layouts),
// moves, the restore (tombstones and the guard), the bounds and fairness, the trail, the notices,
// the query plans, and the invariant as a property with counters and mutation checks.
import { env } from "cloudflare:test";
import { DEFAULT_POLICY, WORKSPACE_POLICIES, type WorkspacePolicy } from "@portifact/contracts";
import { regionalDb, regionsFromEnv, schema } from "@portifact/db";
import {
  NOTICE_EMAILS_PER_CYCLE,
  POLICY_MESSAGES,
  storedPolicy,
  threadDeletable,
} from "@portifact/domain";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { applyTombstones, exportTombstones } from "../src/backups.ts";
import {
  dueThreadIds,
  enforceCommentRetention,
  writeCommentTombstones,
} from "../src/comment-retention.ts";
import {
  type CommentRetentionNotifier,
  sendCommentRetentionNotice,
} from "../src/comment-retention-notices.ts";
import { RecipientSuppressedError, recordEmailsSent, suppressEmail } from "../src/email.ts";
import { reinstateArtifact, suspendArtifact } from "../src/moderation.ts";
import { createServiceToken } from "../src/service-tokens.ts";
import { transferArtifact } from "../src/transfer.ts";
import { rollbackArtifact } from "../src/versions.ts";
import {
  setWorkspacePolicy,
  staleCapOwners,
  workspaceRegionBucket,
} from "../src/workspace-policies.ts";
import {
  exists,
  FROM,
  hex,
  home,
  m,
  NOTICE,
  person,
  preview,
  publishIn,
  publishNext,
  regions,
  retention,
  revision,
  save,
  scan,
  stored,
  type Team,
  team,
  th,
  thread,
  usage,
} from "./comment-retention-fixtures.ts";
import { DAY, db, NOW, racing, value } from "./fixtures.ts";
import { raceBeforeBatchWith, raceBeforeFirstWrite, raceGlobalBeforeStatement } from "./race.ts";

/** The notice job as the jobs Worker runs it: with the workspace's region's bucket. */
const sendNotice = (
  db: Parameters<typeof sendCommentRetentionNotice>[0],
  row: Parameters<typeof sendCommentRetentionNotice>[1],
  now: number,
  notifier: CommentRetentionNotifier,
) =>
  sendCommentRetentionNotice(db, row, now, notifier, undefined, (id) =>
    workspaceRegionBucket(regionsFromEnv(env), id),
  );

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
    // The open-thread clock's fallback reads one artifact's publish trail through its index.
    expect(plan).toContain("lifecycle_events_artifact_at_idx (artifact_id=? AND at>?)");
    expect(plan).not.toMatch(/SCAN (le|lifecycle_events)\b/);
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
    // Removed after the scan's read and its guard record check, right before the revision is
    // read again for the EU batch: that second read stops it.
    const raced = regionalDb(
      env.DB_EU,
      raceGlobalBeforeStatement(/^select "workspaces"\."policy_revision"/i, async () => {
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
    // The plan row goes after the scan's read and its guard record check, before the EU batch:
    // its second read stops it.
    const raced = regionalDb(
      env.DB_EU,
      raceGlobalBeforeStatement(/^select "workspaces"\."policy_revision"/i, async () => {
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

  it("reads a pruned version's replacement from the publish trail, whatever is published later", async () => {
    const t = await team();
    const v1 = await publishIn(t.editor.id, t.id);
    const open = await thread(t, v1, { agoDays: 399, state: "open" });
    const v2 = await publishNext(t, v1, NOW - 50 * DAY);
    // v1 pruned (its row gone): the clock is the first publish after the thread, v2's.
    await db().delete(schema.versions).where(eq(schema.versions.id, v1.versionId));
    value(await save(t, retention(90)));
    // Later publishes never move it (they would, read from the current version's commit).
    await publishNext(t, v2, NOW + 20 * DAY);
    await scan(t, NOW + 40 * DAY - 1);
    expect(await exists(t, open)).toBe(true);
    await scan(t, NOW + 40 * DAY);
    expect(await exists(t, open)).toBe(false);
  });

  it("never takes a thread's own version's publish as its replacement", async () => {
    const t = await team();
    const v1 = await publishIn(t.editor.id, t.id);
    // Created in the same millisecond as v1's publish (both NOW - 400 days).
    const open = await thread(t, v1, { agoDays: 400, state: "open" });
    await publishNext(t, v1, NOW - 50 * DAY);
    await db().delete(schema.versions).where(eq(schema.versions.id, v1.versionId));
    value(await save(t, retention(90)));
    await scan(t, NOW + 40 * DAY - 1);
    expect(await exists(t, open)).toBe(true);
    await scan(t, NOW + 40 * DAY);
    expect(await exists(t, open)).toBe(false);
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
    const le = schema.lifecycleEvents;
    const [own] = await db().select({ at: v.supersededAt }).from(v).where(eq(v.id, one.versionId));
    if (own?.at != null) return own.at;
    const [trail] = await db()
      .select({ at: sql<number | null>`min(${le.at})` })
      .from(le)
      .where(
        and(
          eq(le.artifactId, one.artifactId),
          sql`${le.at} > ${one.createdAt}`,
          sql`${le.event} in ('published', 'rolled_back')`,
        ),
      );
    if (trail?.at != null) return Number(trail.at);
    if (current === null) return null;
    const [now] = await db().select({ at: v.committedAt }).from(v).where(eq(v.id, current));
    return now?.at ?? null;
  }

  // One history per test, each well inside its timeout on a slow CI runner (decision 0023,
  // "Validation": about 0.8 s here, a timeout of 60 s).
  const CASES = SEEDS.flatMap((initial) => [0, 1, 2].map((part) => [initial, part] as const));
  it.each(CASES)(
    "never deletes outside the rule in force, seed %i, history %i",
    async (initial, part) => {
      let seed = initial * 10 + part;
      const rnd = (n: number) => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return Math.floor(seed / 65536) % n;
      };
      const failures: unknown[] = [];
      for (let sequence = 0; sequence < 1; sequence += 1) {
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
              if (art0?.state !== "active" || art0.ownerId !== t.id || !art0.currentVersionId)
                break;
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
          const rows = await home(t)
            .select()
            .from(th)
            .where(eq(th.artifactId, artifact.artifactId));
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
            if (
              rows.some((one) => one.updatedAt + was * DAY <= now && !allowedBy(after).has(one.id))
            )
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
            if (marker?.kind !== "comment_thread")
              failures.push({ step, missingTombstone: one.id });
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
    },
    60_000,
  );

  it("reached every shape over the seeds", () => {
    for (const [shape, count] of Object.entries(totals)) {
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
