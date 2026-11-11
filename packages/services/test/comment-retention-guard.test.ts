// Comment retention's restore guard, one workspace at a time (decision 0023, "Restores", with
// its state table). This file has its own storage, so no other workspace's deleting run moves the
// epoch between the change under test and the restore and hides a missing guard write: every
// loosening (a removal or lengthening saved or applied, a lapse recorded by the scan or caused by
// the operator) must raise the mark before its batch and move the epoch in it; the scan raises a
// mark behind the epoch before anything else; the mark is raise-only under concurrent writers;
// `apply-policies` re-arms only when no stored rule is stricter than the file's.
import { env } from "cloudflare:test";
import { DEFAULT_POLICY, type WorkspacePolicy } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { storedPolicy } from "@portifact/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import {
  COMMENT_RETENTION_EPOCH_KEY,
  enforceCommentRetention,
  raiseBucketMark,
  raiseMarkAt,
} from "../src/comment-retention.ts";
import { removeOwnerPlan, setOwnerPlan } from "../src/plans.ts";
import { applyWorkspacePolicies, exportWorkspacePolicies } from "../src/workspace-policies.ts";
import {
  exists,
  FROM,
  home,
  memoryBucket,
  NOTICE,
  publishIn,
  regions,
  retention,
  save,
  stored,
  type Team,
  team,
  thread,
} from "./comment-retention-fixtures.ts";
import { DAY, NOW, value } from "./fixtures.ts";
import { raceGlobalBeforeFirstWrite } from "./race.ts";

const g = () => regions().global;
const W = schema.workspaces;
const C = schema.maintenanceCursors;
const P = schema.ownerPlans;

async function epoch(): Promise<number> {
  const [row] = await g().select().from(C).where(eq(C.name, "comment_retention_epoch"));
  return Number(row?.cursor ?? 0);
}

/** What a D1 Time Travel restore of the global database puts back for one workspace. */
async function snapshot(t: Team) {
  return {
    ws: (await g().select().from(W).where(eq(W.id, t.id)))[0],
    plan: (await g().select().from(P).where(eq(P.ownerId, t.id)))[0],
    epoch: (await g().select().from(C).where(eq(C.name, "comment_retention_epoch")))[0],
  };
}

/** The restore: the workspace's row, its plan row and the epoch row go back; R2 stays. */
async function restore(t: Team, snap: Awaited<ReturnType<typeof snapshot>>) {
  await g()
    .update(W)
    .set({ policy: snap.ws?.policy ?? null, policyRevision: snap.ws?.policyRevision ?? 0 })
    .where(eq(W.id, t.id));
  await g().delete(P).where(eq(P.ownerId, t.id));
  if (snap.plan) await g().insert(P).values(snap.plan);
  if (snap.epoch) {
    await g()
      .update(C)
      .set({ cursor: snap.epoch.cursor })
      .where(eq(C.name, "comment_retention_epoch"));
  } else {
    await g().delete(C).where(eq(C.name, "comment_retention_epoch"));
  }
}

/** A team with a 90-day rule in effect and two threads long past it, scanned once already. */
async function armedTeam(bucket: R2Bucket) {
  const t = await team();
  const artifact = await publishIn(t.editor.id, t.id);
  value(await save(t, retention(90), { via: regionsFromEnv({ ...env, ARTIFACTS: bucket }) }));
  await enforceCommentRetention(home(t), bucket, FROM, "default");
  const threads = [
    await thread(t, artifact, { agoDays: 400 }),
    await thread(t, artifact, { agoDays: 400 }),
  ];
  return { t, threads, via: regionsFromEnv({ ...env, ARTIFACTS: bucket }) };
}

const left = async (t: Team, ids: string[]) =>
  (await Promise.all(ids.map((id) => exists(t, id)))).filter(Boolean).length;

afterEach(async () => {
  // One workspace per test: the next starts with no rule anywhere.
  await g().update(W).set({ policy: null });
});

describe("a removal saved by an admin", () => {
  it("raises the mark before its batch and moves the epoch in it: a restore to before it pauses", async () => {
    const bucket = memoryBucket();
    const { t, threads, via } = await armedTeam(bucket);
    const snap = await snapshot(t);
    let ruleAtRaise: number | null | undefined;
    const hooked = memoryBucket(
      bucket.held(),
      {},
      {
        beforePut: async () => {
          ruleAtRaise = (await stored(t)).commentRetentionDays;
        },
      },
    );
    value(
      await save(t, retention(null), {
        now: FROM + DAY,
        via: regionsFromEnv({ ...env, ARTIFACTS: hooked }),
      }),
    );
    // The mark went up while the rule was still stored: before the batch, never after it.
    expect(ruleAtRaise).toBe(90);
    expect(Number(hooked.held())).toBe(await epoch());
    // Not paused without a restore: the batch moved the epoch to the mark.
    const quiet = await enforceCommentRetention(home(t), hooked, FROM + 2 * DAY, "default");
    expect(quiet.paused).toBe(false);
    await restore(t, snap);
    const after = await enforceCommentRetention(home(t), hooked, FROM + 3 * DAY, "default");
    expect(after.paused).toBe(true);
    expect(await left(t, threads)).toBe(2);
    expect(via).toBeDefined();
  });

  it("goes through when the raise fails, and the next scan raises the mark before anything else", async () => {
    const fail = { put: false };
    const bucket = memoryBucket(undefined, fail);
    const { t, threads, via } = await armedTeam(bucket);
    const snap = await snapshot(t);
    fail.put = true;
    value(await save(t, retention(null), { now: FROM + DAY, via }));
    expect((await stored(t)).commentRetentionDays).toBeNull();
    expect(Number(bucket.held())).toBeLessThan(await epoch());
    fail.put = false;
    // A scan with nothing to delete anywhere: it raises the mark to the epoch first.
    const run = await enforceCommentRetention(home(t), bucket, FROM + 2 * DAY, "default");
    expect(run).toMatchObject({ paused: false, threads: 0 });
    expect(Number(bucket.held())).toBe(await epoch());
    await restore(t, snap);
    const after = await enforceCommentRetention(home(t), bucket, FROM + 3 * DAY, "default");
    expect(after.paused).toBe(true);
    expect(await left(t, threads)).toBe(2);
  });

  it("pauses the region until apply-policies when the batch fails after the raise", async () => {
    const bucket = memoryBucket();
    const { t, threads, via } = await armedTeam(bucket);
    // The save's batch fails (a crash after the raise): the mark is ahead of the epoch.
    const failing = regionsFromEnv({ ...env, ARTIFACTS: bucket });
    const broken = {
      ...failing,
      global: raceGlobalBeforeFirstWrite(async () => {
        throw new Error("crash");
      }),
    } as typeof failing;
    await expect(save(t, retention(null), { now: FROM + DAY, via: broken })).rejects.toThrow();
    expect(Number(bucket.held())).toBeGreaterThan(await epoch());
    const run = await enforceCommentRetention(home(t), bucket, FROM + 2 * DAY, "default");
    expect(run.paused).toBe(true);
    expect(await left(t, threads)).toBe(2);
  });
});

describe("a plan lapse", () => {
  it("recorded by a run that deletes nothing raises the mark first and moves the epoch: a restore pauses", async () => {
    const bucket = memoryBucket();
    const { t, threads } = await armedTeam(bucket);
    const snap = await snapshot(t);
    await g().delete(P).where(eq(P.ownerId, t.id));
    const before = await epoch();
    const lapse = await enforceCommentRetention(home(t), bucket, FROM + DAY, "default");
    expect(lapse).toMatchObject({ suspended: 1, threads: 0, paused: false });
    expect(await epoch()).toBeGreaterThan(before);
    expect(Number(bucket.held())).toBe(await epoch());
    // Not paused without a restore.
    expect((await enforceCommentRetention(home(t), bucket, FROM + 2 * DAY, "default")).paused).toBe(
      false,
    );
    await restore(t, snap);
    const after = await enforceCommentRetention(home(t), bucket, FROM + 3 * DAY, "default");
    expect(after.paused).toBe(true);
    expect(await left(t, threads)).toBe(2);
  });

  it("whose raise fails pauses that run, and the next raises the mark: a restore then pauses", async () => {
    const fail = { put: false };
    const bucket = memoryBucket(undefined, fail);
    const { t, threads } = await armedTeam(bucket);
    const snap = await snapshot(t);
    await g().delete(P).where(eq(P.ownerId, t.id));
    // R2 answers the run's first read, then refuses writes: the lapse is recorded, unraised.
    fail.put = true;
    const lapse = await enforceCommentRetention(home(t), bucket, FROM + DAY, "default");
    expect(lapse).toMatchObject({ suspended: 1, paused: true });
    fail.put = false;
    await enforceCommentRetention(home(t), bucket, FROM + 2 * DAY, "default");
    expect(Number(bucket.held())).toBe(await epoch());
    await restore(t, snap);
    const after = await enforceCommentRetention(home(t), bucket, FROM + 3 * DAY, "default");
    expect(after.paused).toBe(true);
    expect(await left(t, threads)).toBe(2);
  });
});

describe("the operator's plan changes", () => {
  it("remove-plan raises the mark before its batch and moves the epoch: a restore to before it pauses", async () => {
    const bucket = memoryBucket();
    const { t, threads } = await armedTeam(bucket);
    const snap = await snapshot(t);
    let planAtRaise = false;
    const hooked = memoryBucket(
      bucket.held(),
      {},
      {
        beforePut: async () => {
          planAtRaise = (await g().select().from(P).where(eq(P.ownerId, t.id))).length === 1;
        },
      },
    );
    const removed = await removeOwnerPlan(home(t), {
      ownerId: t.id,
      now: FROM + DAY,
      noGrace: true,
      bucket: hooked,
    });
    expect(removed.ok).toBe(true);
    expect(planAtRaise).toBe(true);
    expect(Number(hooked.held())).toBe(await epoch());
    // Restored before any scan saw the removal: the plan and the rule are back.
    await restore(t, snap);
    const after = await enforceCommentRetention(home(t), hooked, FROM + 2 * DAY, "default");
    expect(after.paused).toBe(true);
    expect(await left(t, threads)).toBe(2);
  });

  it("set-plan to a plan without policies does the same; one that keeps them moves nothing", async () => {
    const bucket = memoryBucket();
    const { t, threads } = await armedTeam(bucket);
    const before = await epoch();
    const grant = (plan: "enterprise" | "team") =>
      setOwnerPlan(home(t), {
        ownerId: t.id,
        plan,
        seats: 10,
        validUntil: null,
        overrides: null,
        grantedBy: "operator",
        note: null,
        now: FROM + DAY,
        noGrace: true,
        bucket,
      });
    value(await grant("enterprise"));
    expect(await epoch()).toBe(before);
    const snap = await snapshot(t);
    value(await grant("team"));
    expect(await epoch()).toBeGreaterThan(before);
    expect(Number(bucket.held())).toBe(await epoch());
    await restore(t, snap);
    const after = await enforceCommentRetention(home(t), bucket, FROM + 2 * DAY, "default");
    expect(after.paused).toBe(true);
    expect(await left(t, threads)).toBe(2);
  });

  it("reads nothing and moves nothing for a workspace without comment retention", async () => {
    const t = await team();
    const before = await epoch();
    const bucket = memoryBucket();
    value(await removeOwnerPlan(home(t), { ownerId: t.id, now: NOW, noGrace: true, bucket }));
    expect(await epoch()).toBe(before);
    expect(bucket.held()).toBeUndefined();
  });
});

describe("the mark is raise-only under concurrent writers", () => {
  it("keeps the higher value whichever writer reads first (in-memory R2 model)", async () => {
    // A reads 5; B raises to 7 before A writes; A's write fails its precondition and stops.
    const first = memoryBucket("5", {}, { beforePut: () => raiseBucketMark(first, 7) });
    await raiseBucketMark(first, 6);
    expect(first.held()).toBe("7");
    // A reads 5 to raise to 7; B raises to 6 before A writes; A reads again and writes 7.
    const second = memoryBucket("5", {}, { beforePut: () => raiseBucketMark(second, 6) });
    await raiseBucketMark(second, 7);
    expect(second.held()).toBe("7");
  });

  it("keeps the higher value on workerd's R2 itself, in both orders, created or not", async () => {
    const key = `scratch/${crypto.randomUUID()}`;
    const racing = (before: () => Promise<void>) => {
      let hook: (() => Promise<void>) | null = before;
      return new Proxy(env.ARTIFACTS, {
        get(target, prop) {
          if (prop === "put") {
            return async (...args: Parameters<R2Bucket["put"]>) => {
              const run = hook;
              hook = null;
              if (run) await run();
              return target.put(...args);
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as R2Bucket;
    };
    // Absent: A creates 6 while B created 7 first.
    await raiseMarkAt(
      racing(() => raiseMarkAt(env.ARTIFACTS, key, 7)),
      key,
      6,
    );
    expect(await (await env.ARTIFACTS.get(key))?.text()).toBe("7");
    // A raises to 9 while B raises to 8 first: A reads again and writes 9.
    await raiseMarkAt(
      racing(() => raiseMarkAt(env.ARTIFACTS, key, 8)),
      key,
      9,
    );
    expect(await (await env.ARTIFACTS.get(key))?.text()).toBe("9");
    // A raises to 10 while B raises to 11 first: A stops at 11.
    await raiseMarkAt(
      racing(() => raiseMarkAt(env.ARTIFACTS, key, 11)),
      key,
      10,
    );
    expect(await (await env.ARTIFACTS.get(key))?.text()).toBe("11");
    await env.ARTIFACTS.delete(key);
  });

  it("never lowers a removal's raise with a scan's stale write, so a restore still pauses", async () => {
    let raced = false;
    let snap: Awaited<ReturnType<typeof snapshot>> | null = null;
    let team0: Team | null = null;
    const bucket = memoryBucket();
    const { t, threads } = await armedTeam(bucket);
    team0 = t;
    // Between the scan's read of the mark before its first deletion and its write, the admin
    // removes the rule (its own raise lands first).
    const racedBucket = memoryBucket(
      bucket.held(),
      {},
      {
        beforePut: async () => {
          if (raced || !team0) return;
          raced = true;
          snap = await snapshot(team0);
          value(
            await save(team0, retention(null), {
              now: FROM + DAY,
              via: regionsFromEnv({ ...env, ARTIFACTS: racedBucket }),
            }),
          );
        },
      },
    );
    await enforceCommentRetention(home(t), racedBucket, FROM + DAY, "default");
    expect(raced).toBe(true);
    expect(Number(racedBucket.held())).toBeGreaterThanOrEqual(await epoch());
    if (!snap) throw new Error("no snapshot");
    await restore(t, snap);
    const later = await thread(t, (await publishIn(t.editor.id, t.id)) as never, { agoDays: 400 });
    const after = await enforceCommentRetention(home(t), racedBucket, FROM + 2 * DAY, "default");
    expect(after.paused).toBe(true);
    expect(await exists(t, later)).toBe(true);
    expect(threads.length).toBe(2);
  });
});

describe("apply-policies re-arms only when no stored rule is stricter than the file's", () => {
  const buckets = (bucket: R2Bucket) => ({ default: bucket, eu: env.ARTIFACTS_EU });

  /** A team whose restored row has a 30-day rule, the region paused (the mark ahead). */
  async function restoredTeam(extra: Partial<WorkspacePolicy> = {}) {
    const t = await team();
    const artifact = await publishIn(t.editor.id, t.id);
    const old = await thread(t, artifact, { agoDays: 400 });
    await g()
      .update(W)
      .set({
        policy: storedPolicy({
          ...DEFAULT_POLICY,
          ...extra,
          commentRetentionDays: 30,
          commentRetentionFrom: NOW - 30 * DAY,
        }),
      })
      .where(eq(W.id, t.id));
    const bucket = memoryBucket(String((await epoch()) + 10));
    expect((await enforceCommentRetention(home(t), bucket, NOW + DAY, "default")).paused).toBe(
      true,
    );
    return { t, old, bucket };
  }

  it("applies a file's removal held back by an unusable provider, then re-arms (R-sso)", async () => {
    const { t, old, bucket } = await restoredTeam({ ssoRequired: true });
    const result = await applyWorkspacePolicies(
      g(),
      [{ workspaceId: t.id, policy: { ...DEFAULT_POLICY, ssoRequired: true } }],
      NOW + 2 * DAY,
      { buckets: buckets(bucket) },
    );
    expect(result).toMatchObject({ ok: true, ssoUnusable: [t.id], armed: true, heldBack: [] });
    expect((await stored(t)).commentRetentionDays).toBeNull();
    const run = await enforceCommentRetention(home(t), bucket, NOW + 3 * DAY, "default");
    expect(run.paused).toBe(false);
    expect(await exists(t, old)).toBe(true);
  });

  it("applies it on the lifting path while the current policy requires an unusable provider", async () => {
    const { t, old, bucket } = await restoredTeam({ ssoRequired: true, publicAccess: "forbidden" });
    const result = await applyWorkspacePolicies(
      g(),
      [{ workspaceId: t.id, policy: { ...DEFAULT_POLICY, ssoRequired: true } }],
      NOW + 2 * DAY,
      { buckets: buckets(bucket) },
    );
    expect(result).toMatchObject({ ok: true, armed: true, heldBack: [] });
    if (!result.ok) throw new Error("refused");
    expect(result.lifting.map((item) => item.workspaceId)).toEqual([t.id]);
    expect((await stored(t)).commentRetentionDays).toBeNull();
    expect((await stored(t)).publicAccess).toBe("forbidden");
    await enforceCommentRetention(home(t), bucket, NOW + 3 * DAY, "default");
    expect(await exists(t, old)).toBe(true);
  });

  it("decides again when a save moves the revision under it", async () => {
    const { t, old, bucket } = await restoredTeam();
    const raced = raceGlobalBeforeFirstWrite(async () => {
      await g()
        .update(W)
        .set({ policyRevision: sql`${W.policyRevision} + 1` })
        .where(eq(W.id, t.id));
    });
    const result = await applyWorkspacePolicies(
      raced,
      [{ workspaceId: t.id, policy: DEFAULT_POLICY }],
      NOW + 2 * DAY,
      { buckets: buckets(bucket) },
    );
    expect(result).toMatchObject({ ok: true, armed: true });
    expect((await stored(t)).commentRetentionDays).toBeNull();
    await enforceCommentRetention(home(t), bucket, NOW + 3 * DAY, "default");
    expect(await exists(t, old)).toBe(true);
  });

  it("clears a restored rule of a workspace missing from the file", async () => {
    const { t, old, bucket } = await restoredTeam();
    const result = await applyWorkspacePolicies(g(), [], NOW + 2 * DAY, {
      buckets: buckets(bucket),
    });
    expect(result).toMatchObject({ ok: true, retentionCleared: [t.id], armed: true });
    await enforceCommentRetention(home(t), bucket, NOW + 3 * DAY, "default");
    expect(await exists(t, old)).toBe(true);
  });

  it("does not re-arm while a stored rule stays stricter, and names the workspace", async () => {
    const { t, old, bucket } = await restoredTeam();
    // A policy that cannot be read cannot be compared: it holds the guard back.
    await g()
      .update(W)
      .set({ policy: sql`'{not json'` as never })
      .where(eq(W.id, t.id));
    const other = await team();
    await g()
      .update(W)
      .set({
        policy: storedPolicy({
          ...DEFAULT_POLICY,
          commentRetentionDays: 30,
          commentRetentionFrom: NOW,
        }),
      })
      .where(eq(W.id, other.id));
    const result = await applyWorkspacePolicies(
      g(),
      [
        {
          workspaceId: other.id,
          policy: { ...DEFAULT_POLICY, commentRetentionDays: 30, commentRetentionFrom: NOW },
        },
      ],
      NOW + 2 * DAY,
      { buckets: buckets(bucket) },
    );
    expect(result).toMatchObject({ ok: true, armed: false, armFailure: null });
    if (!result.ok) throw new Error("refused");
    expect(result.heldBack).toEqual([t.id]);
    const run = await enforceCommentRetention(home(t), bucket, NOW + 3 * DAY, "default");
    expect(run.paused).toBe(true);
    expect(await exists(t, old)).toBe(true);
  });

  it("moves the epoch for a removal it applies even when it cannot re-arm", async () => {
    // Not after a restore: the region is armed, and the file removes a rule.
    const bucket = memoryBucket();
    const { t, threads } = await armedTeam(bucket);
    const blocker = await team();
    await g()
      .update(W)
      .set({ policy: sql`'{not json'` as never })
      .where(eq(W.id, blocker.id));
    const snap = await snapshot(t);
    const result = await applyWorkspacePolicies(
      g(),
      [{ workspaceId: t.id, policy: DEFAULT_POLICY }],
      FROM + DAY,
      { buckets: buckets(bucket) },
    );
    expect(result).toMatchObject({ ok: true, armed: false, heldBack: [blocker.id] });
    expect((await stored(t)).commentRetentionDays).toBeNull();
    await g().update(W).set({ policy: null }).where(eq(W.id, blocker.id));
    // A restore to before the apply: the removal's own raise makes it pause.
    await restore(t, snap);
    const after = await enforceCommentRetention(home(t), bucket, FROM + 2 * DAY, "default");
    expect(after.paused).toBe(true);
    expect(await left(t, threads)).toBe(2);
  });

  it("does not re-arm without every region's bucket", async () => {
    const { t, bucket } = await restoredTeam();
    const result = await applyWorkspacePolicies(
      g(),
      [{ workspaceId: t.id, policy: DEFAULT_POLICY }],
      NOW + 2 * DAY,
      { buckets: { default: bucket } },
    );
    expect(result).toMatchObject({ ok: true, armed: false, heldBack: [], armFailure: "no_bucket" });
    expect((await enforceCommentRetention(home(t), bucket, NOW + 3 * DAY, "default")).paused).toBe(
      true,
    );
  });
});

describe("what a paused or idle run does", () => {
  it("decides and sends no second notice while paused", async () => {
    const t = await team();
    const artifact = await publishIn(t.editor.id, t.id);
    await thread(t, artifact, { agoDays: 60 });
    value(await save(t, retention(90)));
    const ahead = memoryBucket(String((await epoch()) + 10));
    expect((await enforceCommentRetention(home(t), ahead, NOW + DAY, "default")).paused).toBe(true);
    const soon = await g()
      .select()
      .from(schema.outbox)
      .where(sql`${schema.outbox.subject} = ${t.id} and ${schema.outbox.payload} like '%"soon"%'`);
    expect(soon).toEqual([]);
    const marks = await g()
      .select()
      .from(C)
      .where(eq(C.name, `comment_retention_warned:${t.id}`));
    expect(marks).toEqual([]);
  });

  it("skips R2 when no workspace of the region sets a rule and the epoch is the one last confirmed", async () => {
    let gets = 0;
    const inner = memoryBucket();
    const counting = new Proxy(inner, {
      get(target, prop) {
        if (prop === "get") {
          return (...args: Parameters<R2Bucket["get"]>) => {
            gets += 1;
            return target.get(...args);
          };
        }
        return Reflect.get(target, prop, target);
      },
    }) as R2Bucket;
    // Make sure an epoch exists, with no rule anywhere.
    const t = await team();
    value(await save(t, retention(90)));
    value(await save(t, retention(null), { now: NOW + DAY }));
    await enforceCommentRetention(home(t), counting, NOW + 2 * DAY, "default");
    const first = gets;
    expect(first).toBeGreaterThan(0);
    await enforceCommentRetention(home(t), counting, NOW + 3 * DAY, "default");
    expect(gets).toBe(first);
    // The epoch moves: it reads again.
    value(await save(t, retention(90), { now: NOW + 4 * DAY }));
    value(await save(t, retention(null), { now: NOW + 5 * DAY }));
    await enforceCommentRetention(home(t), counting, NOW + 6 * DAY, "default");
    expect(gets).toBeGreaterThan(first);
    expect(NOTICE).toBeGreaterThan(0);
    expect(COMMENT_RETENTION_EPOCH_KEY).toBeTruthy();
    expect(await exportWorkspacePolicies(g())).toBeDefined();
  });
});
