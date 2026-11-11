// The sweep of comment retention guard records (decision 0023, "Restores", "The sweep"): a record
// in R2 that the stored policy does not vouch for is deleted by the scan, so a later restore of the
// global database finds nothing to agree with. Each residual the decision used to state ends with
// no record and a restore that deletes nothing; a save between its two writes is never swept;
// every error keeps the record; and a property over random histories with R2 failures and
// restores checks the guard invariant still holds and that one clean sweep leaves only records a
// stored rule vouches for. This file has its own storage.
import { env } from "cloudflare:test";
import { type GlobalDb, type Regions, regionsFromEnv, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enforceCommentRetention,
  GUARD_SWEEP,
  guardKey,
  sweepGuardRecords,
  writeGuardRecord,
} from "../src/comment-retention.ts";
import { getWorkspacePolicy } from "../src/workspace-policies.ts";
import { deleteWorkspace } from "../src/workspaces.ts";
import {
  exists,
  FROM,
  hex,
  home,
  memoryBucket,
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

const g = () => regions().global;
const W = schema.workspaces;
const P = schema.ownerPlans;
const O = schema.outbox;
const C = schema.maintenanceCursors;
type Bucket = ReturnType<typeof memoryBucket>;
const OLD = GUARD_SWEEP.minAgeMs + 60_000;

afterEach(() => {
  vi.restoreAllMocks();
});

function via(def: Bucket, eu: Bucket = memoryBucket()): Regions {
  return regionsFromEnv({ ...env, ARTIFACTS: def, ARTIFACTS_EU: eu });
}

/** What a D1 Time Travel restore of the global database puts back for one workspace. */
async function snapshot(t: Team) {
  return {
    ws: (await g().select().from(W).where(eq(W.id, t.id)))[0],
    plan: (await g().select().from(P).where(eq(P.ownerId, t.id)))[0],
    outbox: await g().select().from(O).where(eq(O.subject, t.id)),
  };
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>;

/** The restore: the workspace's row (put back if it was deleted), its plan and outbox rows. */
async function restore(t: Team, snap: Snapshot) {
  if (!snap.ws) throw new Error("no workspace in the snapshot");
  const [row] = await g().select({ id: W.id }).from(W).where(eq(W.id, t.id));
  if (row) {
    await g()
      .update(W)
      .set({ policy: snap.ws.policy, policyRevision: snap.ws.policyRevision })
      .where(eq(W.id, t.id));
  } else {
    await g().insert(W).values(snap.ws);
  }
  await g().delete(P).where(eq(P.ownerId, t.id));
  if (snap.plan) await g().insert(P).values(snap.plan);
  await g().delete(O).where(eq(O.subject, t.id));
  for (const outbox of snap.outbox) await g().insert(O).values(outbox);
}

const recordOf = (bucket: Bucket, t: { id: string }) => {
  const text = bucket.held(guardKey(t.id));
  return text === undefined ? null : (JSON.parse(text) as { token: string }).token;
};
const scanWith = (t: { region: "default" | "eu" }, bucket: Bucket, now: number) =>
  enforceCommentRetention(home(t), bucket, now, t.region);

/** A team with a 90-day rule in force (saved through `r`) and an old thread. */
async function ruled(r: Regions, region: "default" | "eu" = "default") {
  const t = await team(region);
  const artifact = await publishIn(t.editor.id, t.id, region);
  value(await save(t, retention(90), { via: r }));
  const old = await thread(t, artifact, { agoDays: 2000 });
  return { t, artifact, old };
}

/** The sweep on its own, from the start of a pass. */
const sweep = (bucket: Bucket, now: number, region: "default" | "eu" = "default", global = g()) =>
  sweepGuardRecords(global, bucket, now, region, "");

/** Whether the stored policy vouches for the record: the same token, days and date. */
async function vouched(bucket: Bucket, id: string): Promise<boolean> {
  const text = bucket.held(guardKey(id));
  if (text === undefined) return true;
  const [row] = await g().select({ policy: W.policy }).from(W).where(eq(W.id, id));
  const policy = row?.policy as Record<string, unknown> | null | undefined;
  const record = JSON.parse(text) as Record<string, unknown>;
  return (
    !!policy &&
    policy.commentRetentionToken === record.token &&
    policy.commentRetentionDays === record.days &&
    policy.commentRetentionFrom === record.from
  );
}

/** A global handle whose `method` throws after `allow` calls of it. */
function failingGlobal(method: "batch" | "insert", allow = 0): GlobalDb {
  let calls = 0;
  return new Proxy(g(), {
    get(target, prop) {
      const real = Reflect.get(target, prop, target);
      if (prop !== method) return typeof real === "function" ? real.bind(target) : real;
      return (...args: unknown[]) => {
        calls += 1;
        if (calls > allow) throw new Error("d1 unavailable");
        return (real as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

describe("the residuals of decision 0023 end with no record, and a restore then deletes nothing", () => {
  it("a removal whose two deletes both failed", async () => {
    const bucket = memoryBucket();
    const r = via(bucket);
    const { t, old } = await ruled(r);
    const snap = await snapshot(t);
    bucket.fail.delete = true;
    value(await save(t, retention(null), { via: r, now: NOW + DAY }));
    bucket.fail.delete = false;
    expect(recordOf(bucket, t)).not.toBeNull();
    bucket.age(OLD);
    const run = await scanWith(t, bucket, FROM + DAY);
    expect(run.guardSweep).toMatchObject({ deleted: 1, failed: 0 });
    expect(recordOf(bucket, t)).toBeNull();
    await restore(t, snap);
    expect((await scanWith(t, bucket, FROM + 3000 * DAY)).threads).toBe(0);
    expect(await exists(t, old)).toBe(true);
  });

  it("a late record whose confirmation failed", async () => {
    const bucket = memoryBucket();
    const r = via(bucket);
    const t = await team();
    const artifact = await publishIn(t.editor.id, t.id);
    const old = await thread(t, artifact, { agoDays: 2000 });
    let snap: Snapshot | null = null;
    // A's D1 write landed; while its record is in flight B removes the rule, and A's confirmation
    // cannot read R2 once its record lands.
    bucket.hooks.beforeWrite = async () => {
      snap = await snapshot(t);
      value(await save(t, retention(null), { via: r, now: NOW + DAY }));
      bucket.fail.get = true;
    };
    await save(t, retention(90), { via: r });
    bucket.fail.get = false;
    expect(recordOf(bucket, t)).not.toBeNull();
    expect((await stored(t)).commentRetentionDays).toBeNull();
    bucket.age(OLD);
    expect((await scanWith(t, bucket, FROM + DAY)).guardSweep.deleted).toBe(1);
    expect(recordOf(bucket, t)).toBeNull();
    if (!snap) throw new Error("no snapshot");
    await restore(t, snap);
    expect((await scanWith(t, bucket, FROM + 3000 * DAY)).threads).toBe(0);
    expect(await exists(t, old)).toBe(true);
  });

  it("a write that landed and threw, with its confirmation failing too", async () => {
    const inner = memoryBucket();
    let throwAfterPut = false;
    const realPut = inner.put.bind(inner);
    // The record lands, then the call throws (a timeout after the write).
    Object.assign(inner, {
      put: async (k: string, v: string) => {
        await realPut(k, v);
        if (throwAfterPut) throw new Error("timeout after write");
        return {};
      },
    });
    const r = via(inner);
    const t = await team();
    const artifact = await publishIn(t.editor.id, t.id);
    const old = await thread(t, artifact, { agoDays: 2000 });
    let snap: Snapshot | null = null;
    inner.hooks.beforeWrite = async () => {
      snap = await snapshot(t);
      value(await save(t, retention(null), { via: r, now: NOW + DAY }));
      throwAfterPut = true;
      inner.fail.get = true;
    };
    await save(t, retention(90), { via: r });
    inner.fail.get = false;
    throwAfterPut = false;
    expect(recordOf(inner, t)).not.toBeNull();
    inner.age(OLD);
    expect((await scanWith(t, inner, FROM + DAY)).guardSweep.deleted).toBe(1);
    expect(recordOf(inner, t)).toBeNull();
    if (!snap) throw new Error("no snapshot");
    await restore(t, snap);
    expect((await scanWith(t, inner, FROM + 3000 * DAY)).threads).toBe(0);
    expect(await exists(t, old)).toBe(true);
  });

  it("a workspace deleted with its record left", async () => {
    const bucket = memoryBucket();
    const r = via(bucket);
    const { t, old } = await ruled(r);
    const snap = await snapshot(t);
    bucket.fail.delete = true;
    value(await deleteWorkspace(r, { workspaceId: t.id, now: NOW + DAY }));
    bucket.fail.delete = false;
    expect(recordOf(bucket, t)).not.toBeNull();
    bucket.age(OLD);
    expect((await scanWith(t, bucket, FROM + DAY)).guardSweep.deleted).toBe(1);
    expect(recordOf(bucket, t)).toBeNull();
    await restore(t, snap);
    expect((await scanWith(t, bucket, FROM + 3000 * DAY)).threads).toBe(0);
    expect(await exists(t, old)).toBe(true);
  });
});

describe("what the sweep keeps", () => {
  it("never touches a record that agrees, and never writes one", async () => {
    const bucket = memoryBucket();
    const r = via(bucket);
    const { t } = await ruled(r);
    const token = recordOf(bucket, t);
    bucket.age(OLD);
    const writes = bucket.writes();
    const run = await sweep(bucket, FROM + DAY);
    expect(run).toEqual({ listed: 1, deleted: 0, young: 0, foreign: 0, failed: 0 });
    expect(recordOf(bucket, t)).toBe(token);
    expect(bucket.writes()).toBe(writes);
  });

  it("deletes a record whose token, days or date differ, a record with no rule, and one in another region", async () => {
    const bucket = memoryBucket();
    const eu = memoryBucket();
    const r = via(bucket, eu);
    const cases = [];
    for (const change of [{ token: "other" }, { days: 60 }, { from: 1 }]) {
      const { t } = await ruled(r);
      const record = JSON.parse(bucket.held(guardKey(t.id)) as string) as object;
      bucket.plant(guardKey(t.id), JSON.stringify({ ...record, ...change }));
      cases.push(t);
    }
    const plain = await team();
    bucket.plant(guardKey(plain.id), JSON.stringify({ token: "x", days: 90, from: FROM }));
    // A default-region workspace's record in the EU bucket vouches for nothing there.
    const { t: home } = await ruled(r);
    eu.plant(guardKey(home.id), bucket.held(guardKey(home.id)) as string);
    bucket.age(OLD);
    eu.age(OLD);
    expect((await sweep(bucket, FROM + DAY)).deleted).toBe(4);
    for (const t of [...cases, plain]) expect(recordOf(bucket, t)).toBeNull();
    expect(recordOf(bucket, home)).not.toBeNull();
    expect((await sweep(eu, FROM + DAY, "eu")).deleted).toBe(1);
    expect(recordOf(eu, home)).toBeNull();
  });

  it("deletes an unreadable record whose workspace sets a rule", async () => {
    const bucket = memoryBucket();
    const { t } = await ruled(via(bucket));
    bucket.plant(guardKey(t.id), "not a record", OLD);
    expect((await sweep(bucket, FROM + DAY)).deleted).toBe(1);
  });

  it("leaves a key that names no workspace, and logs it once", async () => {
    const bucket = memoryBucket();
    bucket.plant(`${guardKey("")}not-a-workspace-${hex()}`, "{}", OLD);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const logged = () =>
      errors.mock.calls.filter((call) =>
        String(call[0]).includes("comment_retention_guard_foreign"),
      ).length;
    expect(await sweep(bucket, FROM + DAY)).toMatchObject({ foreign: 1, deleted: 0, failed: 0 });
    expect(await sweep(bucket, FROM + 2 * DAY)).toMatchObject({ foreign: 1, deleted: 0 });
    expect(bucket.keys()).toHaveLength(1);
    expect(logged()).toBe(1);
  });

  it("pages through the prefix from a cursor that resumes across runs", async () => {
    const bucket = memoryBucket();
    const ids = Array.from({ length: GUARD_SWEEP.page + 5 }, () => `ws_${hex()}`);
    for (const id of ids)
      bucket.plant(guardKey(id), JSON.stringify({ token: "t", days: 90, from: 1 }), OLD);
    const t = { region: "eu" as const };
    const first = await scanWith(t, bucket, FROM);
    expect(first.guardSweep).toMatchObject({ listed: GUARD_SWEEP.page, deleted: GUARD_SWEEP.page });
    const [cursor] = await g().select().from(C).where(eq(C.name, "comment_retention_guard:eu"));
    expect(cursor?.cursor).toBe(guardKey([...ids].sort()[GUARD_SWEEP.page - 1] as string));
    const second = await scanWith(t, bucket, FROM + 1);
    expect(second.guardSweep).toMatchObject({ listed: 5, deleted: 5 });
    expect(bucket.keys()).toHaveLength(0);
    const [ended] = await g().select().from(C).where(eq(C.name, "comment_retention_guard:eu"));
    expect(ended?.cursor).toBe("");
  });
});

describe("a save between its two writes is never swept (the age bounds)", () => {
  it("D1 first: a new rule's record landing after the sweep read the row is kept", async () => {
    const bucket = memoryBucket();
    const r = via(bucket);
    const t = await team();
    const artifact = await publishIn(t.editor.id, t.id);
    const old = await thread(t, artifact, { agoDays: 2000 });
    // A stale record from long ago, then a new rule whose D1 write lands and whose record is in
    // flight while the sweep runs.
    bucket.plant(guardKey(t.id), JSON.stringify({ token: "stale", days: 90, from: 1 }), OLD);
    bucket.fail.put = true;
    const at = NOW + 10 * DAY;
    value(await save(t, retention(90), { via: r, now: at }));
    bucket.fail.put = false;
    const rule = await stored(t);
    // The record lands between the sweep's read of it and its delete.
    bucket.hooks.beforeWrite = async () => {
      await writeGuardRecord(bucket, t.id, {
        token: rule.commentRetentionToken as string,
        days: rule.commentRetentionDays as number,
        from: rule.commentRetentionFrom as number,
      });
    };
    const run = await sweep(bucket, at + 60_000);
    expect(run).toMatchObject({ deleted: 0, young: 1 });
    // The in-flight record lands now if the sweep did not reach a delete.
    const landing = bucket.hooks.beforeWrite;
    delete bucket.hooks.beforeWrite;
    if (landing) await landing();
    expect(recordOf(bucket, t)).toBe(rule.commentRetentionToken);
    expect(
      value(
        await getWorkspacePolicy(g(), {
          userId: t.admin.id,
          slug: t.slug,
          now: at,
          bucketOf: () => bucket,
        }),
      ).commentRetentionInForce,
    ).toBe(true);
    expect((await scanWith(t, bucket, FROM + 3000 * DAY)).threads).toBe(1);
    expect(await exists(t, old)).toBe(false);
  });

  it("R2 first: a lengthening's record written before its D1 write is kept", async () => {
    const bucket = memoryBucket();
    const r = via(bucket);
    const { t } = await ruled(r);
    bucket.age(OLD);
    const at = NOW + 30 * DAY;
    // The longer rule's record has landed; the sweep runs before its D1 write.
    bucket.hooks.afterWrite = async () => {
      expect((await sweep(bucket, at)).deleted).toBe(0);
    };
    const saved = value(await save(t, retention(180), { via: r, now: at }));
    expect(saved.commentRetentionInForce).toBe(true);
    expect(recordOf(bucket, t)).toBe((await stored(t)).commentRetentionToken);
  });

  it("keeps a record rewritten since the list, by its etag", async () => {
    const bucket = memoryBucket();
    const { t } = await ruled(via(bucket));
    bucket.plant(guardKey(t.id), JSON.stringify({ token: "stale", days: 90, from: 1 }), OLD);
    const listing = bucket.list.bind(bucket);
    (bucket as unknown as { list: typeof listing }).list = async (options) => {
      const page = await listing(options);
      bucket.plant(guardKey(t.id), JSON.stringify({ token: "newer", days: 90, from: 1 }), OLD);
      return page;
    };
    expect(await sweep(bucket, FROM + DAY)).toMatchObject({ deleted: 0, young: 1 });
  });
});

describe("every error keeps the record", () => {
  async function stale() {
    const bucket = memoryBucket();
    const t = await team();
    bucket.plant(guardKey(t.id), JSON.stringify({ token: "stale", days: 90, from: 1 }), OLD);
    return { bucket, t };
  }

  it.each(["list", "get", "delete"] as const)("R2's %s failing", async (call) => {
    const { bucket, t } = await stale();
    bucket.fail[call] = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await sweep(bucket, FROM + DAY)).toMatchObject({ deleted: 0, failed: 1 });
    bucket.fail[call] = false;
    expect(recordOf(bucket, t)).toBe("stale");
    expect(errors.mock.calls.map(String).join()).toContain(`"reason":"${call}"`);
  });

  it("the global read failing keeps the cursor, and the next run goes on", async () => {
    const { bucket, t } = await stale();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await sweep(bucket, FROM + DAY, "default", failingGlobal("batch"))).toMatchObject({
      deleted: 0,
      failed: 1,
    });
    expect(recordOf(bucket, t)).toBe("stale");
    expect((await sweep(bucket, FROM + DAY)).deleted).toBe(1);
  });

  it("an unreadable stored policy", async () => {
    const { bucket, t } = await stale();
    await env.DB.prepare("update workspaces set policy = '{not json' where id = ?")
      .bind(t.id)
      .run();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await sweep(bucket, FROM + DAY)).toMatchObject({ deleted: 0, failed: 1 });
    expect(recordOf(bucket, t)).toBe("stale");
  });

  it("the cursor's write and the foreign key's mark failing", async () => {
    const bucket = memoryBucket();
    for (let i = 0; i < GUARD_SWEEP.page + 1; i += 1) {
      bucket.plant(guardKey(`foreign-${i}`), "{}", OLD);
    }
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await sweep(bucket, FROM, "default", failingGlobal("insert"))).toMatchObject({
      foreign: GUARD_SWEEP.page,
      failed: 2,
    });
  });

  it("no bucket: nothing to sweep", async () => {
    expect(await sweepGuardRecords(g(), undefined, FROM, "default", "")).toEqual({
      listed: 0,
      deleted: 0,
      young: 0,
      foreign: 0,
      failed: 0,
    });
  });
});

describe("the guard with the sweep, as a property", () => {
  /**
   * Random histories over two workspaces sharing a bucket: saves (set, shorten, lengthen,
   * remove), each with an outcome (R2 answers; R2 refuses; a removal's deletes both fail; a new
   * rule's record landing after a removal with its confirmation failing), scans that sweep aged
   * records (some with R2 failing), then a restore of one workspace's rows to a random earlier
   * point and a scan with threads due. The guard invariant: the scan deletes exactly when the
   * restored rule is set and its token, days and date are the record's. Then one clean sweep of
   * aged records leaves only records a stored rule vouches for. Counters require stale records
   * to have been generated and swept.
   */
  const shapes = { stale: 0, swept: 0, sweepFailed: 0, deletedAfterRestore: 0, held: 0 };
  const SEEDS = [3, 17, 404, 2026, 7, 99, 1234, 31337, 5, 11, 23, 42];

  it.each(SEEDS)(
    "keeps the invariant and leaves no unvouched record, seed %i",
    async (initial) => {
      let seed = initial;
      const rnd = (n: number) => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return Math.floor(seed / 65536) % n;
      };
      const bucket = memoryBucket();
      const r = via(bucket);
      const teams = [await ruled(r), await ruled(r)];
      let now = NOW;
      const steps = 4 + rnd(4);
      const subject = teams[rnd(2)] as (typeof teams)[number];
      const point = rnd(steps + 1);
      let snap: Snapshot | null = null;
      for (let step = 0; step < steps; step += 1) {
        if (step === point) snap = await snapshot(subject.t);
        now += (1 + rnd(4)) * DAY;
        const { t } = teams[rnd(2)] as (typeof teams)[number];
        const current = (await stored(t)).commentRetentionDays;
        const pick = rnd(4);
        const days =
          pick === 0
            ? 90
            : pick === 1
              ? Math.max(30, (current ?? 90) - 30)
              : pick === 2
                ? (current ?? 90) + 30
                : null;
        const outcome = rnd(4);
        if (outcome === 1) bucket.fail.put = true;
        if (outcome === 2) bucket.fail.delete = true;
        if (outcome === 3 && days !== null) {
          // The record lands after a removal of the same rule, and its confirmation fails.
          bucket.hooks.beforeWrite = async () => {
            delete bucket.hooks.beforeWrite;
            bucket.fail.get = false;
            await save(t, retention(null), { via: r, now: now + 1 }).catch(() => null);
            bucket.fail.get = true;
          };
        }
        await save(t, retention(days), { via: r, now }).catch(() => null);
        delete bucket.hooks.beforeWrite;
        bucket.fail.put = false;
        bucket.fail.delete = false;
        bucket.fail.get = false;
        for (const { t: each } of teams) if (!(await vouched(bucket, each.id))) shapes.stale += 1;
        if (rnd(2) === 0) {
          bucket.age(OLD);
          const failing = rnd(3) === 0 ? (["list", "get", "delete"] as const)[rnd(3)] : null;
          if (failing) bucket.fail[failing] = true;
          vi.spyOn(console, "error").mockImplementation(() => {});
          const run = await scanWith(t, bucket, now + DAY);
          if (failing) bucket.fail[failing] = false;
          shapes.swept += run.guardSweep.deleted;
          shapes.sweepFailed += run.guardSweep.failed;
        }
      }
      if (point === steps) snap = await snapshot(subject.t);
      if (!snap) throw new Error("no restore point");
      await restore(subject.t, snap);
      const restored = await stored(subject.t);
      const text = bucket.held(guardKey(subject.t.id));
      const record = text === undefined ? null : (JSON.parse(text) as Record<string, unknown>);
      const due = await thread(subject.t, subject.artifact, { agoDays: 4000 });
      const [plan] = await g().select().from(P).where(eq(P.ownerId, subject.t.id));
      const expected =
        plan !== undefined &&
        record !== null &&
        restored.commentRetentionDays !== null &&
        record.token === restored.commentRetentionToken &&
        record.days === restored.commentRetentionDays &&
        record.from === restored.commentRetentionFrom;
      await scanWith(subject.t, bucket, now + 4000 * DAY);
      const deleted = !(await exists(subject.t, due));
      if (deleted) shapes.deletedAfterRestore += 1;
      else shapes.held += 1;
      expect({ deleted }).toEqual({ deleted: expected });
      // One clean sweep of aged records: what is left, a stored rule vouches for.
      bucket.age(OLD);
      await scanWith(subject.t, bucket, now + 4001 * DAY);
      for (const { t } of teams) expect(await vouched(bucket, t.id)).toBe(true);
    },
    30_000,
  );

  it("generated stale records, swept them and failed sweeps", () => {
    for (const [shape, count] of Object.entries(shapes)) {
      expect({ shape, reached: count > 0 }).toEqual({ shape, reached: true });
    }
  });
});
