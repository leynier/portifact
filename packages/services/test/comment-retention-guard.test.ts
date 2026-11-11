// Comment retention's restore guard (decision 0023, "Restores"): agreement between the token in
// the stored policy (D1, rewound by a restore) and the workspace's guard record in its region's
// R2 bucket (never rewound). This file has its own storage. It checks every writer's order and
// what each failure leaves, that nothing about another workspace, another region or the
// operator's commands can make a restored rule agree, what `apply-policies` does without writing
// R2, and the whole matrix as a property with a real rewind of the rows a global restore rewinds.
import { env } from "cloudflare:test";
import { DEFAULT_POLICY } from "@portifact/contracts";
import { type Regions, regionsFromEnv, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  deleteGuardRecord,
  enforceCommentRetention,
  guardAgreement,
  guardKey,
} from "../src/comment-retention.ts";
import { sendCommentRetentionNotice } from "../src/comment-retention-notices.ts";
import { releaseGuardForPlan, removeOwnerPlan } from "../src/plans.ts";
import {
  applyWorkspacePolicies,
  exportWorkspacePolicies,
  getWorkspacePolicy,
} from "../src/workspace-policies.ts";
import { deleteWorkspace } from "../src/workspaces.ts";
import {
  exists,
  FROM,
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
import { DAY, grantPlan, NOW, value } from "./fixtures.ts";
import { raceGlobalBeforeFirstWrite } from "./race.ts";

const g = () => regions().global;
const W = schema.workspaces;
const P = schema.ownerPlans;
const O = schema.outbox;
type Bucket = ReturnType<typeof memoryBucket>;

/** Regions whose buckets are in-memory ones, so a test can make R2 fail or count its reads. */
function via(def: Bucket, eu: Bucket = memoryBucket()): Regions {
  return regionsFromEnv({ ...env, ARTIFACTS: def, ARTIFACTS_EU: eu });
}

/** The same regions with a global database whose first write throws: a D1 batch that fails. */
function d1Fails(regionsWith: Regions): Regions {
  const failing = raceGlobalBeforeFirstWrite(async () => {
    throw new Error("d1 refused");
  });
  return { ...regionsWith, global: failing } as Regions;
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

/** The restore: the workspace's row, its plan row and its global outbox rows go back; R2 stays. */
async function restore(t: Team, snap: Snapshot) {
  await g()
    .update(W)
    .set({ policy: snap.ws?.policy ?? null, policyRevision: snap.ws?.policyRevision ?? 0 })
    .where(eq(W.id, t.id));
  await g().delete(P).where(eq(P.ownerId, t.id));
  if (snap.plan) await g().insert(P).values(snap.plan);
  await g().delete(O).where(eq(O.subject, t.id));
  for (const row of snap.outbox) await g().insert(O).values(row);
}

const tokenOf = async (t: Team) => (await stored(t)).commentRetentionToken;
const recordOf = (bucket: Bucket, t: Team) => {
  const text = bucket.held(guardKey(t.id));
  return text === undefined ? null : (JSON.parse(text) as { token: string }).token;
};
const scanWith = (t: Team, bucket: Bucket | R2Bucket, now: number) =>
  enforceCommentRetention(home(t), bucket as R2Bucket, now, t.region);

/** A team with a 90-day rule in force (saved through `regionsWith`) and an old thread. */
async function ruled(regionsWith: Regions, region: "default" | "eu" = "default") {
  const t = await team(region);
  const artifact = await publishIn(t.editor.id, t.id, region);
  value(await save(t, retention(90), { via: regionsWith }));
  const old = await thread(t, artifact, { agoDays: 400 });
  return { t, artifact, old };
}

const survives = async (t: Team, id: string, now: number, bucket: Bucket) => {
  const run = await scanWith(t, bucket, now);
  return { threads: run.threads, survives: await exists(t, id) };
};

describe("nothing outside a workspace can make its restored rule agree (the reviewer's four)", () => {
  it("another workspace's removal after the restore", async () => {
    const bucket = memoryBucket();
    const r = via(bucket);
    const { t, old } = await ruled(r);
    const other = await ruled(r);
    const snap = await snapshot(t);
    value(await save(t, retention(null), { now: FROM + DAY, via: r }));
    await restore(t, snap);
    expect((await scanWith(t, bucket, FROM + 2 * DAY)).paused).toBe(true);
    value(await save(other.t, retention(null), { now: FROM + 3 * DAY, via: r }));
    expect(await survives(t, old, FROM + 4 * DAY, bucket)).toEqual({ threads: 0, survives: true });
  });

  it("a lapse the paused scan records for another workspace", async () => {
    const bucket = memoryBucket();
    const r = via(bucket);
    const { t, old } = await ruled(r);
    const other = await ruled(r);
    const snap = await snapshot(t);
    value(await save(t, retention(null), { now: FROM + DAY, via: r }));
    await restore(t, snap);
    await g().delete(P).where(eq(P.ownerId, other.t.id));
    const lapse = await scanWith(t, bucket, FROM + 2 * DAY);
    expect(lapse).toMatchObject({ paused: true, suspended: 1 });
    expect(await survives(t, old, FROM + 3 * DAY, bucket)).toEqual({ threads: 0, survives: true });
  });

  it("a deleting run in the other region", async () => {
    const bucket = memoryBucket();
    const euBucket = memoryBucket();
    const r = via(bucket, euBucket);
    const { t, old } = await ruled(r);
    const eu = await ruled(r, "eu");
    const snap = await snapshot(t);
    value(await save(t, retention(null), { now: FROM + DAY, via: r }));
    await restore(t, snap);
    expect((await scanWith(eu.t, euBucket, FROM + 3 * DAY)).threads).toBeGreaterThan(0);
    expect(await survives(t, old, FROM + 4 * DAY, bucket)).toEqual({ threads: 0, survives: true });
  });

  it("the operator's remove-plan for another workspace before apply-policies", async () => {
    const bucket = memoryBucket();
    const r = via(bucket);
    const { t, old } = await ruled(r);
    const other = await ruled(r);
    const snap = await snapshot(t);
    value(await save(t, retention(null), { now: FROM + DAY, via: r }));
    await restore(t, snap);
    expect(await releaseGuardForPlan(g(), bucket, other.t.id, null, FROM + 2 * DAY)).toBe(
      "released",
    );
    value(await removeOwnerPlan(home(other.t), { ownerId: other.t.id, now: FROM + 2 * DAY }));
    expect(await survives(t, old, FROM + 3 * DAY, bucket)).toEqual({ threads: 0, survives: true });
  });
});

describe("each writer's order, and what each failure leaves", () => {
  it("a new rule: D1 then R2; R2 refusing leaves it saved but not in force; saving again fixes it", async () => {
    const bucket = memoryBucket();
    const r = via(bucket);
    const t = await team();
    const artifact = await publishIn(t.editor.id, t.id);
    const old = await thread(t, artifact, { agoDays: 400 });
    bucket.fail.put = true;
    const saved = value(await save(t, retention(90), { via: r }));
    expect(saved.commentRetentionInForce).toBe(false);
    expect((await stored(t)).commentRetentionDays).toBe(90);
    bucket.fail.put = false;
    expect((await scanWith(t, bucket, FROM + DAY)).threads).toBe(0);
    expect(await exists(t, old)).toBe(true);
    // Saved again, unchanged: a new rule, with a new notice period and a token R2 holds.
    const again = value(await save(t, retention(90), { via: r, now: NOW + DAY }));
    expect(again.commentRetentionInForce).toBe(true);
    expect((await stored(t)).commentRetentionFrom).toBe(FROM + DAY);
    expect(recordOf(bucket, t)).toBe(await tokenOf(t));
    expect((await scanWith(t, bucket, FROM + 2 * DAY)).threads).toBe(1);
  });

  it("a shorter rule whose R2 write fails stops deleting, the old one included", async () => {
    const bucket = memoryBucket();
    const r = via(bucket);
    const { t, old } = await ruled(r);
    bucket.fail.put = true;
    value(await save(t, retention(60), { via: r, now: NOW + DAY }));
    bucket.fail.put = false;
    expect(await survives(t, old, FROM + 100 * DAY, bucket)).toEqual({
      threads: 0,
      survives: true,
    });
  });

  it("a longer rule or a removal: R2 first, and R2 refusing saves nothing", async () => {
    const bucket = memoryBucket();
    const r = via(bucket);
    const { t } = await ruled(r);
    const before = await tokenOf(t);
    bucket.fail.put = true;
    for (const next of [retention(180), retention(null)]) {
      const refused = await save(t, next, { via: r, now: NOW + DAY });
      expect(refused).toMatchObject({ ok: false, code: "capacity_unavailable" });
    }
    bucket.fail.put = false;
    expect(await tokenOf(t)).toBe(before);
    expect(recordOf(bucket, t)).toBe(before);
  });

  it("a longer rule or a removal whose D1 batch then fails leaves the stores disagreeing", async () => {
    for (const next of [retention(180), retention(null)]) {
      const bucket = memoryBucket();
      const r = via(bucket);
      const { t, old } = await ruled(r);
      await expect(save(t, next, { via: d1Fails(r), now: NOW + DAY })).rejects.toThrow();
      expect((await stored(t)).commentRetentionDays).toBe(90);
      expect(recordOf(bucket, t)).not.toBe(await tokenOf(t));
      expect(await survives(t, old, FROM + 200 * DAY, bucket)).toEqual({
        threads: 0,
        survives: true,
      });
    }
  });

  it("a lapse the scan records deletes the record first, and waits when R2 refuses", async () => {
    const bucket = memoryBucket();
    const r = via(bucket);
    const { t, old } = await ruled(r);
    await g().delete(P).where(eq(P.ownerId, t.id));
    bucket.fail.delete = true;
    expect((await scanWith(t, bucket, FROM + DAY)).suspended).toBe(0);
    expect((await stored(t)).commentRetentionDays).toBe(90);
    bucket.fail.delete = false;
    const snap = await snapshot(t);
    expect((await scanWith(t, bucket, FROM + 2 * DAY)).suspended).toBe(1);
    expect(recordOf(bucket, t)).toBeNull();
    await restore(t, snap);
    await grantPlan(t.id, "enterprise", { seats: 10 });
    expect(await survives(t, old, FROM + 3 * DAY, bucket)).toEqual({ threads: 0, survives: true });
  });

  it("the operator's plan change deletes the record first, and says when it cannot", async () => {
    const bucket = memoryBucket();
    const r = via(bucket);
    const { t } = await ruled(r);
    const keeps = { plan: "enterprise" as const, seats: 10, validUntil: null, overrides: null };
    const lowers = { plan: "team" as const, seats: 10, validUntil: null, overrides: null };
    expect(await releaseGuardForPlan(g(), bucket, t.id, keeps, NOW)).toBe("none");
    expect(recordOf(bucket, t)).not.toBeNull();
    bucket.fail.delete = true;
    expect(await releaseGuardForPlan(g(), bucket, t.id, lowers, NOW)).toBe("kept");
    expect(await releaseGuardForPlan(g(), undefined, t.id, null, NOW)).toBe("kept");
    bucket.fail.delete = false;
    expect(await releaseGuardForPlan(g(), bucket, t.id, lowers, NOW)).toBe("released");
    expect(recordOf(bucket, t)).toBeNull();
    // A personal space is never read.
    expect(await releaseGuardForPlan(g(), bucket, t.admin.id, null, NOW)).toBe("none");
  });

  it("deleting a workspace deletes its record", async () => {
    const bucket = memoryBucket();
    const r = via(bucket);
    const { t } = await ruled(r);
    value(await deleteWorkspace(r, { workspaceId: t.id, now: NOW }));
    expect(recordOf(bucket, t)).toBeNull();
  });

  it("the scan never writes the record, and reads it only for a workspace with threads due", async () => {
    let writes = 0;
    const inner = memoryBucket();
    const r = via(inner);
    const t = await team();
    const artifact = await publishIn(t.editor.id, t.id);
    value(await save(t, retention(90), { via: r }));
    const counting = new Proxy(inner, {
      get(target, prop) {
        if (prop === "put" || prop === "delete") writes += 1;
        return Reflect.get(target, prop, target);
      },
    }) as Bucket;
    const key = guardKey(t.id);
    const before = inner.reads(key);
    await scanWith(t, counting, FROM + DAY);
    expect(inner.reads(key)).toBe(before);
    await thread(t, artifact, { agoDays: 400 });
    await scanWith(t, counting, FROM + 2 * DAY);
    expect(inner.reads(key)).toBe(before + 1);
    expect(writes).toBe(0);
  });

  it("holds back on every answer but agreement", async () => {
    const t = await team();
    expect(await guardAgreement(undefined, t.id, "x")).toBe("unavailable");
    const bucket = memoryBucket();
    expect(await guardAgreement(bucket, t.id, "x")).toBe("missing");
    await bucket.put(guardKey(t.id), "{not json");
    expect(await guardAgreement(bucket, t.id, "x")).toBe("unreadable");
    await bucket.put(guardKey(t.id), JSON.stringify({ other: 1 }));
    expect(await guardAgreement(bucket, t.id, "x")).toBe("unreadable");
    await bucket.put(guardKey(t.id), JSON.stringify({ token: "y" }));
    expect(await guardAgreement(bucket, t.id, "x")).toBe("different");
    expect(await guardAgreement(bucket, t.id, null)).toBe("different");
    expect(await guardAgreement(bucket, t.id, "y")).toBe("agrees");
    bucket.fail.get = true;
    expect(await guardAgreement(bucket, t.id, "y")).toBe("unavailable");
    expect(await deleteGuardRecord(undefined, t.id)).toBe(false);
  });

  it("tells the Policies page whether the rule is in force, reading R2 only while one is set", async () => {
    const bucket = memoryBucket();
    const r = via(bucket);
    const t = await team();
    const page = () =>
      getWorkspacePolicy(g(), {
        userId: t.admin.id,
        slug: t.slug,
        now: NOW,
        bucketOf: () => bucket,
      });
    const reads = bucket.reads(guardKey(t.id));
    expect(value(await page()).commentRetentionInForce).toBeNull();
    expect(bucket.reads(guardKey(t.id))).toBe(reads);
    value(await save(t, retention(90), { via: r }));
    expect(value(await page()).commentRetentionInForce).toBe(true);
    await bucket.delete(guardKey(t.id));
    expect(value(await page()).commentRetentionInForce).toBe(false);
    expect(value(await page()).policy.commentRetentionToken).toBeNull();
  });
});

describe("the notices", () => {
  it("never announce a rule that is not in force", async () => {
    const bucket = memoryBucket();
    const r = via(bucket);
    const { t } = await ruled(r);
    const [job] = await g().select().from(O).where(eq(O.subject, t.id));
    if (!job) throw new Error("no notice");
    const sent: unknown[] = [];
    const notifier = { send: async (notice: unknown) => void sent.push(notice) };
    await bucket.delete(guardKey(t.id));
    expect(
      await sendCommentRetentionNotice(home(t), job, NOW, notifier, undefined, async () => bucket),
    ).toBe("stale");
    expect(sent).toEqual([]);
  });

  it("announce one in force", async () => {
    const bucket = memoryBucket();
    const r = via(bucket);
    const { t } = await ruled(r);
    const [job] = await g().select().from(O).where(eq(O.subject, t.id));
    if (!job) throw new Error("no notice");
    const sent: unknown[] = [];
    const notifier = { send: async (notice: unknown) => void sent.push(notice) };
    expect(
      await sendCommentRetentionNotice(home(t), job, NOW, notifier, undefined, async () => bucket),
    ).toBe("done");
    expect(sent.length).toBeGreaterThan(0);
  });
});

describe("apply-policies writes no record", () => {
  it("resumes where the exported token is R2's, and stays paused where it is not", async () => {
    const bucket = memoryBucket();
    const r = via(bucket);
    const same = await ruled(r);
    const changed = await ruled(r);
    const missing = await ruled(r);
    const before = await Promise.all([same, changed, missing].map(({ t }) => snapshot(t)));
    const exported = (await exportWorkspacePolicies(g())).filter((item) =>
      [same.t.id, changed.t.id].includes(item.workspaceId),
    );
    // After the export an admin lengthens one rule; then the restore.
    value(await save(changed.t, retention(120), { via: r, now: NOW + DAY }));
    for (const [k, one] of [same, changed, missing].entries()) {
      await restore(one.t, before[k] as Snapshot);
    }
    let writes = 0;
    const watched = new Proxy(bucket, {
      get(target, prop) {
        if (prop === "put" || prop === "delete") writes += 1;
        return Reflect.get(target, prop, target);
      },
    }) as Bucket;
    expect(await applyWorkspacePolicies(g(), exported, NOW + 2 * DAY)).toMatchObject({ ok: true });
    expect(writes).toBe(0);
    for (const one of [same, changed, missing]) await scanWith(one.t, watched, FROM + 3 * DAY);
    expect(await exists(same.t, same.old)).toBe(false);
    expect(await exists(changed.t, changed.old)).toBe(true);
    expect(await exists(missing.t, missing.old)).toBe(true);
  });

  it("an export taken after the restore holds the restored token: still paused", async () => {
    const bucket = memoryBucket();
    const r = via(bucket);
    const { t, old } = await ruled(r);
    const snap = await snapshot(t);
    value(await save(t, retention(30), { via: r, now: NOW + DAY }));
    await restore(t, snap);
    const late = (await exportWorkspacePolicies(g())).filter((item) => item.workspaceId === t.id);
    expect(await applyWorkspacePolicies(g(), late, NOW + 2 * DAY)).toMatchObject({ ok: true });
    expect(await survives(t, old, FROM + 3 * DAY, bucket)).toEqual({ threads: 0, survives: true });
  });

  it("still applies a file's removal held back for an unusable provider, without touching R2", async () => {
    const bucket = memoryBucket();
    const r = via(bucket);
    const { t, old } = await ruled(r);
    await g()
      .update(W)
      .set({
        policy: {
          ...DEFAULT_POLICY,
          ssoRequired: true,
          commentRetentionDays: 90,
          commentRetentionFrom: FROM,
          commentRetentionToken: await tokenOf(t),
        } as never,
      })
      .where(eq(W.id, t.id));
    const result = await applyWorkspacePolicies(
      g(),
      [{ workspaceId: t.id, policy: { ...DEFAULT_POLICY, ssoRequired: true } }],
      NOW + DAY,
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.ssoUnusable).toEqual([t.id]);
    expect((await stored(t)).commentRetentionDays).toBeNull();
    expect(recordOf(bucket, t)).not.toBeNull();
    await scanWith(t, bucket, FROM + 2 * DAY);
    expect(await exists(t, old)).toBe(true);
  });
});

describe("the guard, as a property", () => {
  /**
   * The matrix: seeded histories of saves (set, shorten, lengthen, remove), lapses the scan
   * records and the operator's plan removals, each with an outcome (R2 answers; R2 refuses; R2
   * answers and the D1 batch then fails), scans in between or not; then a restore of the global
   * database to a random earlier point (the workspace's row with its token, its plan row and its
   * outbox rows) and one scan with threads due. The model tracks the token R2 holds: the scan
   * deletes exactly when the restored rule is set, its plan includes `policies` and its token is
   * that one. Counters require each shape over the cases; both database layouts.
   */
  const shapes = {
    restoredBeforeRemoval: 0,
    restoredBeforeLonger: 0,
    restoredBeforeReset: 0,
    restoredAfterLast: 0,
    r2Refused: 0,
    d1FailedAfterR2: 0,
    lapses: 0,
    operatorRemovals: 0,
    deletedAfterRestore: 0,
    heldAfterRestore: 0,
  };
  const CASES = [
    3, 17, 404, 2026, 7, 99, 1234, 31337, 5, 11, 23, 42, 101, 777, 8080, 65535,
  ].flatMap((seed) => (["default", "eu"] as const).map((region) => [seed, region] as const));

  it.each(CASES)(
    "deletes after a restore exactly when the restored rule is the one R2 holds, seed %i, %s",
    async (initial, region) => {
      let seed = initial;
      const rnd = (n: number) => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return Math.floor(seed / 65536) % n;
      };
      const bucket = memoryBucket();
      const r = via(bucket, bucket);
      const t = await team(region);
      const artifact = await publishIn(t.editor.id, t.id, region);
      // Every history starts from a rule in force, so lengthenings and removals are common.
      value(await save(t, retention(90), { via: r }));
      let r2: string | null = recordOf(bucket, t);
      let now = NOW;
      const steps = 4 + rnd(4);
      // The restore point: before any step, or after the last one (a restore that loses nothing).
      const point = rnd(steps + 1);
      let snap: Snapshot | null = null;
      const after: string[] = [];
      for (let step = 0; step < steps; step += 1) {
        if (step === point) snap = await snapshot(t);
        now += (1 + rnd(4)) * DAY;
        const current = (await stored(t)).commentRetentionDays;
        const outcome = rnd(3);
        // 0 set, 1 shorten, 2 and 3 lengthen, 4 remove, 5 a lapse, 6 the operator's plan removal.
        const pick = rnd(7);
        const kind = pick === 3 ? 2 : pick === 4 ? 3 : pick === 5 ? 4 : pick === 6 ? 5 : pick;
        if (kind <= 3) {
          const days =
            kind === 0
              ? 90
              : kind === 1
                ? current === null
                  ? 90
                  : Math.max(30, current - 30)
                : kind === 2
                  ? current === null
                    ? 120
                    : current + 30
                  : null;
          const loosening = current !== null && (days === null || days > current);
          if (outcome === 1) {
            bucket.fail.put = true;
            shapes.r2Refused += 1;
          }
          const d1 = outcome === 2 && loosening;
          if (d1) shapes.d1FailedAfterR2 += 1;
          const result = await save(t, retention(days), { via: d1 ? d1Fails(r) : r, now }).catch(
            () => null,
          );
          bucket.fail.put = false;
          if (step >= point && result?.ok) {
            after.push(
              days === null ? "removal" : current !== null && days > current ? "longer" : "reset",
            );
          }
        } else if (kind === 4) {
          await g().delete(P).where(eq(P.ownerId, t.id));
          if (outcome === 1) bucket.fail.delete = true;
          const run = await scanWith(t, bucket, now);
          bucket.fail.delete = false;
          if (run.suspended > 0) {
            shapes.lapses += 1;
            if (step >= point) after.push("removal");
          }
          await grantPlan(t.id, "enterprise", { seats: 10 });
        } else {
          if (outcome === 1) bucket.fail.delete = true;
          const guard = await releaseGuardForPlan(g(), bucket, t.id, null, now);
          bucket.fail.delete = false;
          if (guard === "released") {
            shapes.operatorRemovals += 1;
            await g().delete(P).where(eq(P.ownerId, t.id));
            await scanWith(t, bucket, now);
            await grantPlan(t.id, "enterprise", { seats: 10 });
            if (step >= point) after.push("removal");
          }
        }
        r2 = recordOf(bucket, t);
        if (rnd(2) === 0) await scanWith(t, bucket, now);
      }
      if (point === steps) snap = await snapshot(t);
      if (!snap) throw new Error("no restore point");
      await restore(t, snap);
      const restored = await stored(t);
      const [plan] = await g().select().from(P).where(eq(P.ownerId, t.id));
      if (after.includes("removal")) shapes.restoredBeforeRemoval += 1;
      if (after.includes("longer")) shapes.restoredBeforeLonger += 1;
      if (after.includes("reset")) shapes.restoredBeforeReset += 1;
      if (after.length === 0) shapes.restoredAfterLast += 1;
      const due = [
        await thread(t, artifact, { agoDays: 2000 }),
        await thread(t, artifact, { agoDays: 2000 }),
      ];
      const expected =
        plan !== undefined &&
        restored.commentRetentionDays !== null &&
        restored.commentRetentionToken !== null &&
        restored.commentRetentionToken === r2;
      await scanWith(t, bucket, now + 2000 * DAY);
      const deleted = (await Promise.all(due.map((id) => exists(t, id)))).filter((x) => !x).length;
      if (deleted > 0) shapes.deletedAfterRestore += 1;
      else shapes.heldAfterRestore += 1;
      expect({ deleted: deleted > 0 }).toEqual({ deleted: expected });
      // The scan never wrote the record.
      expect(recordOf(bucket, t)).toBe(r2);
    },
    20_000,
  );

  it("reached every shape over the cases", () => {
    for (const [shape, count] of Object.entries(shapes)) {
      expect({ shape, reached: count > 0 }).toEqual({ shape, reached: true });
    }
  });
});
