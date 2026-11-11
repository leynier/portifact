// Plan grace (decision 0022): a plan that lapses, is removed or is lowered keeps what it kept
// for 60 days. These tests run the real services and scans over D1 and R2 and check, for each
// held kind, that day 59 still has it and day 61 does not, that reads of held data stay open and
// new work is refused, the operator's --no-grace, the audit events and a restore.
import { env } from "cloudflare:test";
import { PLAN_GRACE_DAYS } from "@portifact/contracts";
import {
  accessSchema,
  bothSides,
  createAccessDb,
  findDeliveryArtifact,
  findDeliveryOwner,
  regionsFromEnv,
  schema,
} from "@portifact/db";
import { entitlements } from "@portifact/domain";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { pruneAccessEvents, recordOpenings } from "../src/access-log.ts";
import { pinArtifact } from "../src/lifecycle.ts";
import { pruneVersions } from "../src/maintenance.ts";
import { runJob } from "../src/outbox.ts";
import {
  applyOwnerPlans,
  exportOwnerPlans,
  getOwnerPlan,
  maintainPlanGraces,
  planView,
  redateDatedPlans,
  removeOwnerPlan,
  setOwnerPlan,
  unpinLapsedPlans,
} from "../src/plans.ts";
import { compareVersions } from "../src/version-diff.ts";
import { getVersionManifest, listVersions } from "../src/versions.ts";
import { artifactRow, DAY, db, grantPlan, NOW, publishSite, user, value } from "./fixtures.ts";
import { versionRows, versions } from "./version-support.ts";

const GRACE = PLAN_GRACE_DAYS * DAY;
const access = () => createAccessDb(env.ACCESS_DB);

function grant(ownerId: string, plan: "free" | "pro" | "team", now: number, noGrace = false) {
  return setOwnerPlan(db(), {
    ownerId,
    plan,
    seats: 1,
    validUntil: null,
    overrides: null,
    grantedBy: "operator",
    note: null,
    now,
    noGrace,
  });
}

async function graceEvents(ownerId: string) {
  return (
    await db()
      .select({ kind: schema.auditEvents.kind, detail: schema.auditEvents.detail })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.ownerId, ownerId))
  )
    .filter((row) => row.kind.startsWith("plan.grace"))
    .map((row) => [row.kind, (row.detail as { reason: string }).reason]);
}

async function planRow(ownerId: string) {
  const [row] = await db()
    .select()
    .from(schema.ownerPlans)
    .where(eq(schema.ownerPlans.ownerId, ownerId));
  return row;
}

/** A Pro owner with one artifact of six versions, the last published at NOW + 5 hours. */
async function proWithVersions() {
  const owner = await user("Pro");
  value(await grant(owner.id, "pro", NOW - DAY));
  const published = await versions(owner.id, 6);
  const first = published[0] as { artifactId: string; versionId: string };
  const last = published.at(-1) as { artifactId: string; versionId: string };
  return { owner, artifactId: first.artifactId, first, last };
}

describe("previous versions", () => {
  it("a lowered plan keeps them 60 days, readable and comparable, then the prune takes them", async () => {
    const { owner, artifactId, first, last } = await proWithVersions();
    const dropped = NOW + DAY;
    value(await grant(owner.id, "free", dropped));

    const day59 = dropped + 59 * DAY;
    const listed = value(
      await listVersions(db(), { userId: owner.id, artifactId, now: day59, limit: 100 }),
    );
    // Free keeps two previous versions for seven days; the grace keeps Pro's 50 for 90.
    expect(listed.items.map((item) => item.number)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(listed.versionDiff).toBe(true);
    expect(
      (
        await getVersionManifest(db(), {
          userId: owner.id,
          artifactId,
          versionId: first.versionId,
          now: day59,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await compareVersions(db(), {
          userId: owner.id,
          artifactId,
          fromVersionId: first.versionId,
          toVersionId: last.versionId,
          now: day59,
          limit: 10,
        })
      ).ok,
    ).toBe(true);
    await pruneVersions(db(), env.ARTIFACTS, day59);
    expect(await versionRows(artifactId)).toEqual([1, 2, 3, 4, 5, 6]);

    const day61 = dropped + 61 * DAY;
    expect(
      await compareVersions(db(), {
        userId: owner.id,
        artifactId,
        fromVersionId: first.versionId,
        toVersionId: last.versionId,
        now: day61,
        limit: 10,
      }),
    ).toMatchObject({ ok: false, code: "plan_required" });
    expect(
      await getVersionManifest(db(), {
        userId: owner.id,
        artifactId,
        versionId: first.versionId,
        now: day61,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
    await pruneVersions(db(), env.ARTIFACTS, day61);
    expect(await versionRows(artifactId)).toEqual([6]);
  });

  it("--no-grace prunes at once, as a lapse did before graces", async () => {
    const { owner, artifactId } = await proWithVersions();
    value(await removeOwnerPlan(db(), { ownerId: owner.id, now: NOW + DAY, noGrace: true }));
    expect(await planRow(owner.id)).toBeUndefined();
    await pruneVersions(db(), env.ARTIFACTS, NOW + 9 * DAY);
    expect(await versionRows(artifactId)).toEqual([6]);
    expect(await graceEvents(owner.id)).toEqual([]);
  });
});

describe("pins", () => {
  it("stay pinned for the grace while new pins are refused, then lapse with an expiry", async () => {
    const owner = await user("Pinner");
    value(await grant(owner.id, "pro", NOW - DAY));
    const pinned = await versions(owner.id, 1);
    const other = await versions(owner.id, 1);
    const pinnedId = (pinned[0] as { artifactId: string }).artifactId;
    const otherId = (other[0] as { artifactId: string }).artifactId;
    value(await pinArtifact(db(), { userId: owner.id, artifactId: pinnedId, now: NOW }));
    const dropped = NOW + DAY;
    value(await removeOwnerPlan(db(), { ownerId: owner.id, now: dropped }));

    expect(
      await pinArtifact(db(), { userId: owner.id, artifactId: otherId, now: dropped + DAY }),
    ).toMatchObject({ ok: false, code: "plan_required" });
    await unpinLapsedPlans(db(), dropped + 59 * DAY);
    expect(await artifactRow(pinnedId)).toMatchObject({ pinned: true, expiresAt: null });

    const day61 = dropped + 61 * DAY;
    await unpinLapsedPlans(db(), day61);
    expect(await artifactRow(pinnedId)).toMatchObject({
      pinned: false,
      expiresAt: day61 + 30 * DAY,
    });
  });
});

describe("the plan row and its events", () => {
  it("records a lowering's start, a renewal's end, and keeps the usage body's grace", async () => {
    const owner = await user();
    value(await grant(owner.id, "team", NOW));
    const lowered = value(await grant(owner.id, "pro", NOW + DAY));
    expect(planView(lowered.entitlements).grace).toMatchObject({
      plan: "team",
      until: new Date(NOW + DAY + GRACE).toISOString(),
    });
    // Retrying the same grant changes nothing and records nothing more.
    value(await grant(owner.id, "pro", NOW + DAY + 1));
    expect(await graceEvents(owner.id)).toEqual([["plan.grace_started", "lowered"]]);
    const renewed = value(await grant(owner.id, "team", NOW + 2 * DAY));
    expect(renewed.entitlements.grace ?? null).toBeNull();
    expect((await planRow(owner.id))?.grace).toBeNull();
    expect(
      (await graceEvents(owner.id)).map(([kind, reason]) => `${kind}:${reason}`).sort(),
    ).toEqual(["plan.grace_ended:renewed", "plan.grace_started:lowered"]);
  });

  it("the operator's --no-grace on a grant ends every hold and records it", async () => {
    const owner = await user();
    value(await grant(owner.id, "team", NOW));
    value(await grant(owner.id, "free", NOW + DAY));
    const ended = value(await grant(owner.id, "free", NOW + 2 * DAY, true));
    expect(ended.entitlements.grace ?? null).toBeNull();
    expect((await graceEvents(owner.id)).map((e) => e.join(":")).sort()).toEqual([
      "plan.grace_ended:operator",
      "plan.grace_started:lowered",
    ]);
  });

  it("the scan stores a natural expiry once and ends it once, then a removed row goes", async () => {
    const expiring = await user();
    await grantPlan(expiring.id, "pro", { validUntil: NOW - DAY });
    const removed = await user();
    value(await grant(removed.id, "pro", NOW - 2 * DAY));
    value(await removeOwnerPlan(db(), { ownerId: removed.id, now: NOW - DAY }));

    await maintainPlanGraces(db().global, NOW);
    await maintainPlanGraces(db().global, NOW + 1);
    expect(await graceEvents(expiring.id)).toEqual([["plan.grace_started", "expired"]]);
    // The stored hold reads exactly as the row's own did.
    const state = await getOwnerPlan(db(), expiring.id, NOW);
    expect(state.entitlements.grace?.until).toBe(NOW - DAY + GRACE);

    const after = NOW - DAY + GRACE;
    await maintainPlanGraces(db().global, after);
    await maintainPlanGraces(db().global, after + 1);
    expect((await graceEvents(expiring.id)).map((e) => e.join(":")).sort()).toEqual([
      "plan.grace_ended:expired",
      "plan.grace_started:expired",
    ]);
    expect((await planRow(expiring.id))?.grace).toBeNull();
    // The expired plan's row stays, as it always did; the removed one's goes with its hold.
    expect(await planRow(expiring.id)).toMatchObject({ plan: "pro", validUntil: NOW - DAY });
    expect(await planRow(removed.id)).toBeUndefined();
    expect((await graceEvents(removed.id)).map((e) => e.join(":")).sort()).toEqual([
      "plan.grace_ended:expired",
      "plan.grace_started:removed",
    ]);
  });

  it("export-plans and apply-plans carry a grace across a restore without restarting it", async () => {
    const owner = await user();
    value(await grant(owner.id, "team", NOW - 10 * DAY));
    value(await removeOwnerPlan(db(), { ownerId: owner.id, now: NOW - 5 * DAY }));
    const exported = (await exportOwnerPlans(db().global, NOW)).filter(
      (plan) => plan.ownerId === owner.id,
    );
    expect(exported[0]?.grace).toHaveLength(1);
    // The restore rewinds the row to the plan before the removal.
    await db()
      .global.update(schema.ownerPlans)
      .set({ plan: "team", grace: null })
      .where(eq(schema.ownerPlans.ownerId, owner.id));
    const result = await applyOwnerPlans(regionsFromEnv(env), exported, NOW);
    expect(result).toMatchObject({ applied: 1 });
    const state = await getOwnerPlan(db(), owner.id, NOW);
    expect(state.entitlements.plan).toBe("free");
    expect(state.entitlements.grace?.until).toBe(NOW - 5 * DAY + GRACE);
    // A plan whose grace has ended is skipped, as an ended plan always was.
    const ended = await applyOwnerPlans(regionsFromEnv(env), exported, NOW + 56 * DAY);
    expect(ended).toMatchObject({ applied: 0, skipped: 1 });
  });
});

describe("the grace scan writes only on the exact row it read", () => {
  /** A database whose first batch (the scan's page) lets `between` run before the next call. */
  function pausedAfterFirstBatch(between: () => Promise<unknown>) {
    const global = db().global;
    let fired = false;
    return new Proxy(global, {
      get(target, prop, receiver) {
        if (prop !== "batch") return Reflect.get(target, prop, receiver);
        return async (items: Parameters<typeof global.batch>[0]) => {
          const out = await target.batch(items);
          if (!fired) {
            fired = true;
            await between();
          }
          return out;
        };
      },
    }) as typeof global;
  }

  it.each([
    ["overrides", { overrides: { features: { pin: true } } }],
    ["seats", { seats: 3 }],
    ["note", { note: "kept on purpose" }],
  ] as const)(
    "keeps a free row the operator re-granted with other %s while the scan ran",
    async (_, change) => {
      const owner = await user("Race");
      value(await grant(owner.id, "pro", NOW));
      const removedAt = NOW + DAY;
      value(await removeOwnerPlan(db(), { ownerId: owner.id, now: removedAt }));
      const end = removedAt + GRACE;
      const raced = pausedAfterFirstBatch(async () =>
        value(
          await setOwnerPlan(db(), {
            ownerId: owner.id,
            plan: "free",
            seats: 1,
            validUntil: null,
            overrides: null,
            grantedBy: "op",
            note: null,
            now: end - 1,
            ...change,
          }),
        ),
      );
      await maintainPlanGraces(raced, end + 1);
      // The re-grant stands, its hold untouched by the stale batch; the next run ends it.
      const kept = await planRow(owner.id);
      expect(kept).toMatchObject({ plan: "free", ...change });
      expect(kept?.grace).not.toBeNull();
      expect((await graceEvents(owner.id)).filter(([kind]) => kind === "plan.grace_ended")).toEqual(
        [],
      );
      // The next run ends the hold; a row that grants something stays, and a free row that only
      // carries a note goes as a removed plan's does (a note grants nothing).
      await maintainPlanGraces(db().global, end + 2);
      if ("note" in change) expect(await planRow(owner.id)).toBeUndefined();
      else expect(await planRow(owner.id)).toMatchObject({ plan: "free", ...change, grace: null });
    },
  );
});

describe("every hold gets one start and one end, whoever stores it first", () => {
  async function counts(ownerId: string) {
    const events = await graceEvents(ownerId);
    return {
      started: events.filter(([kind]) => kind === "plan.grace_started").length,
      ended: events.filter(([kind]) => kind === "plan.grace_ended").length,
    };
  }

  it.each([
    ["the scan first", async () => {}],
    [
      "remove-plan first",
      async (ownerId: string) => value(await removeOwnerPlan(db(), { ownerId, now: NOW })),
    ],
    ["a lowering first", async (ownerId: string) => value(await grant(ownerId, "pro", NOW))],
    [
      "--no-grace first",
      async (ownerId: string) =>
        value(await removeOwnerPlan(db(), { ownerId, now: NOW, noGrace: true })),
    ],
    [
      "two scans first",
      async () => {
        await maintainPlanGraces(db().global, NOW);
        await maintainPlanGraces(db().global, NOW + 1);
      },
    ],
  ])("%s", async (_, first) => {
    const owner = await user("Lapsed");
    // A Team plan that ended yesterday, its hold not stored yet.
    await grantPlan(owner.id, "team", { validUntil: NOW - DAY });
    await first(owner.id);
    await maintainPlanGraces(db().global, NOW + 2);
    await maintainPlanGraces(db().global, NOW + 3);
    // Past every hold's end (a lowering's own hold ends 60 days after NOW).
    await maintainPlanGraces(db().global, NOW + GRACE + 1);
    await maintainPlanGraces(db().global, NOW + GRACE + 2);
    const { started, ended } = await counts(owner.id);
    expect(started).toBe(ended);
    const expiry = (await graceEvents(owner.id)).filter(([, reason]) => reason === "expired");
    expect(expiry.filter(([kind]) => kind === "plan.grace_started")).toHaveLength(1);
  });
});

describe("an unreadable grace", () => {
  it("holds conservatively, is never rewritten or deleted by the scan, and is logged by owner", async () => {
    const owner = await user();
    await grantPlan(owner.id, "free");
    await db()
      .global.update(schema.ownerPlans)
      .set({ grace: "{not json" })
      .where(eq(schema.ownerPlans.ownerId, owner.id));
    const state = await getOwnerPlan(db(), owner.id, NOW);
    expect(state.entitlements.grace?.unreadable).toBe(true);
    expect(state.entitlements.limits.retainedPreviousVersions).toBe(10_000);
    // The usage body's view never throws for it.
    expect(planView(state.entitlements).grace?.until).toBe(new Date(NOW + GRACE).toISOString());
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await maintainPlanGraces(db().global, NOW);
      const lines = errors.mock.calls.map(([line]) => String(line));
      expect(lines).toContain(
        JSON.stringify({ event: "plan_grace_unreadable", ownerId: owner.id }),
      );
    } finally {
      errors.mockRestore();
    }
    expect((await planRow(owner.id))?.grace).toBe("{not json");
    // The operator's next change stores a readable conservative hold, recorded as started.
    value(await grant(owner.id, "free", NOW + DAY));
    expect(await graceEvents(owner.id)).toEqual([["plan.grace_started", "unreadable"]]);
    expect((await getOwnerPlan(db(), owner.id, NOW + DAY)).entitlements.grace?.unreadable).toBe(
      false,
    );
  });

  it.each(["{not json", "[1]", '"text"'])(
    "%s never throws in the delivery lookup, in either layout, and reads as holding",
    async (grace) => {
      const owner = await user();
      const { artifactId } = await publishSite(owner.id);
      await grantPlan(owner.id, "pro", { overrides: { features: { pin: true } } });
      await db()
        .global.update(schema.ownerPlans)
        .set({ grace })
        .where(eq(schema.ownerPlans.ownerId, owner.id));
      const both = bothSides(db());
      if (!both) throw new Error("The tests' default region shares the global database");
      // One database: the plan joined into the artifact's lookup.
      const joined = await findDeliveryArtifact(both, artifactId, NOW, undefined, {
        withPlan: true,
      });
      // A separate regional database: the plan read with the owner's allowlist.
      const separate = await findDeliveryOwner(db().global, owner.id);
      for (const plan of [joined?.plan, separate.plan]) {
        expect(plan?.grace).toBe(grace);
        const owned = entitlements(plan ?? null, NOW);
        expect(owned.plan).toBe("pro");
        expect(owned.grace?.unreadable).toBe(true);
        expect(owned.limits.retainedPreviousVersions).toBe(10_000);
      }
    },
  );

  it("is exported as the conservative hold, so a restore keeps holding", async () => {
    const owner = await user();
    await grantPlan(owner.id, "free");
    await db()
      .global.update(schema.ownerPlans)
      .set({ grace: "[1]" })
      .where(eq(schema.ownerPlans.ownerId, owner.id));
    const [exported] = (await exportOwnerPlans(db().global, NOW)).filter(
      (plan) => plan.ownerId === owner.id,
    );
    expect(exported?.grace).toMatchObject([{ reason: "unreadable", until: NOW + GRACE }]);
  });
});

describe("restores", () => {
  it("apply-plans puts back a removed plan's kept free row exactly, end to end", async () => {
    const owner = await user();
    value(await grant(owner.id, "team", NOW - 20 * DAY));
    // An older copy, taken before the removal.
    const older = (await exportOwnerPlans(db().global, NOW - 15 * DAY)).filter(
      (plan) => plan.ownerId === owner.id,
    );
    value(await removeOwnerPlan(db(), { ownerId: owner.id, now: NOW - 10 * DAY }));
    const before = await planRow(owner.id);
    const exported = (await exportOwnerPlans(db().global, NOW)).filter(
      (plan) => plan.ownerId === owner.id,
    );
    expect(exported).toMatchObject([{ plan: "free", validUntil: null, overrides: null }]);
    // The restore rewinds to the older copy (Team, no grace), then apply-plans runs.
    await db()
      .global.update(schema.ownerPlans)
      .set({ plan: older[0]?.plan ?? "team", grace: null })
      .where(eq(schema.ownerPlans.ownerId, owner.id));
    expect(await applyOwnerPlans(regionsFromEnv(env), exported, NOW)).toMatchObject({
      applied: 1,
    });
    const after = await planRow(owner.id);
    expect({ plan: after?.plan, grace: after?.grace }).toEqual({
      plan: before?.plan,
      grace: before?.grace,
    });
    expect((await getOwnerPlan(db(), owner.id, NOW)).entitlements.grace?.until).toBe(
      NOW - 10 * DAY + GRACE,
    );
    // Its last hold ends, and the scan removes the row as if nothing had been restored.
    await maintainPlanGraces(db().global, NOW - 10 * DAY + GRACE);
    expect(await planRow(owner.id)).toBeUndefined();
  });
});

describe("rows dated by the previous release", () => {
  it("are re-dated once after deploy, so a plan's access log survives into its grace", async () => {
    const owner = await user("Dated");
    const reader = await user("Reader");
    const { artifactId } = await publishSite(owner.id);
    const end = NOW + 10 * DAY;
    await grantPlan(owner.id, "pro", { validUntil: end });
    await recordOpenings(db(), access(), [{ artifactId, userId: reader.id, at: NOW - DAY }]);
    // The previous release capped the row at the plan's end.
    await access()
      .update(accessSchema.accessEvents)
      .set({ expiresAt: end })
      .where(eq(accessSchema.accessEvents.artifactId, artifactId));
    await db()
      .delete(schema.maintenanceCursors)
      .where(eq(schema.maintenanceCursors.name, "plan_grace_redate:default"));

    expect((await redateDatedPlans(db(), NOW)).scheduled).toBeGreaterThanOrEqual(1);
    const jobs = await db()
      .select({ id: schema.outbox.id })
      .from(schema.outbox)
      .where(eq(schema.outbox.subject, owner.id));
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    for (const job of jobs) {
      await runJob(db(), env.ARTIFACTS, { id: job.id, topic: "owner_retention" }, NOW, {
        access: access(),
      });
    }
    await pruneAccessEvents(access(), end + DAY);
    const [row] = await access()
      .select({ expiresAt: accessSchema.accessEvents.expiresAt })
      .from(accessSchema.accessEvents)
      .where(eq(accessSchema.accessEvents.artifactId, artifactId));
    expect(row?.expiresAt).toBe(end + GRACE);
    // Done for good: later runs schedule nothing.
    expect(await redateDatedPlans(db(), NOW + DAY)).toEqual({ scheduled: 0 });
  });
});
