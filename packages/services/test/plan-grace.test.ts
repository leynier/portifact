// Plan grace (decision 0022): a plan that lapses, is removed or is lowered keeps what it kept
// for 60 days. These tests run the real services and scans over D1 and R2 and check, for each
// held kind, that day 59 still has it and day 61 does not, that reads of held data stay open and
// new work is refused, the operator's --no-grace, the audit events and a restore.
import { env } from "cloudflare:test";
import { PLAN_GRACE_DAYS } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { pinArtifact } from "../src/lifecycle.ts";
import { pruneVersions } from "../src/maintenance.ts";
import {
  applyOwnerPlans,
  exportOwnerPlans,
  getOwnerPlan,
  maintainPlanGraces,
  planView,
  removeOwnerPlan,
  setOwnerPlan,
  unpinLapsedPlans,
} from "../src/plans.ts";
import { compareVersions } from "../src/version-diff.ts";
import { getVersionManifest, listVersions } from "../src/versions.ts";
import { artifactRow, DAY, db, grantPlan, NOW, user, value } from "./fixtures.ts";
import { versionRows, versions } from "./version-support.ts";

const GRACE = PLAN_GRACE_DAYS * DAY;

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
    const exported = (await exportOwnerPlans(db().global)).filter(
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
