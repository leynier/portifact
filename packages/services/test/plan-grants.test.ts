// Granting plans (premium plan section 3, F1 and F2): the operator's grant writes the plan row
// and the limit columns together, the maintenance scan keeps the columns in line, and a lower
// plan never deletes anything or blocks reading, exporting, deleting, reducing access, renewing
// or rolling back; it only refuses new work above its limits.
import { env } from "cloudflare:test";
import { LIMITS, PLANS } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { personalActor } from "@portifact/domain";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { updateAccess } from "../src/access.ts";
import { exportAccount } from "../src/account-data.ts";
import { getArtifact, listArtifacts } from "../src/artifacts.ts";
import {
  archiveArtifact,
  deleteArtifact,
  renewArtifact,
  restoreArtifact,
} from "../src/lifecycle.ts";
import {
  alignPlanLimits,
  getOwnerPlan,
  removeOwnerPlan,
  type SetOwnerPlanInput,
  setOwnerPlan,
} from "../src/plans.ts";
import { type ManifestEntry, type PrepareInput, preparePublish } from "../src/publish.ts";
import { listVersions, rollbackArtifact } from "../src/versions.ts";
import { DAY, db, NOW, publishSite, racing, sha256, user, value } from "./fixtures.ts";

function grant(ownerId: string, overrides: Partial<SetOwnerPlanInput> = {}) {
  return setOwnerPlan(db(), {
    ownerId,
    plan: "pro",
    seats: 1,
    validUntil: null,
    overrides: null,
    grantedBy: "operator",
    note: null,
    now: NOW,
    ...overrides,
  });
}

async function columns(ownerId: string) {
  const [account] = await db()
    .select({
      activeLimit: schema.accountUsage.activeLimit,
      bytesLimit: schema.accountUsage.bytesLimit,
    })
    .from(schema.accountUsage)
    .where(eq(schema.accountUsage.ownerId, ownerId));
  const [annotations] = await db()
    .select({
      messagesLimit: schema.annotationUsage.messagesLimit,
      bytesLimit: schema.annotationUsage.bytesLimit,
    })
    .from(schema.annotationUsage)
    .where(eq(schema.annotationUsage.ownerId, ownerId));
  return { account, annotations };
}

const planColumns = (limits: {
  activeArtifacts: number;
  accountBytes: number;
  annotationMessages: number;
  annotationBytes: number;
}) => ({
  account: { activeLimit: limits.activeArtifacts, bytesLimit: limits.accountBytes },
  annotations: { messagesLimit: limits.annotationMessages, bytesLimit: limits.annotationBytes },
});

async function setUsage(
  ownerId: string,
  values: Partial<typeof schema.accountUsage.$inferInsert>,
): Promise<void> {
  await db()
    .update(schema.accountUsage)
    .set(values)
    .where(eq(schema.accountUsage.ownerId, ownerId));
}

async function site(body: string): Promise<ManifestEntry[]> {
  return [
    {
      path: "index.html",
      kind: "published",
      sha256: await sha256(body),
      size: body.length,
      contentType: "text/html",
    },
  ];
}

const prepareInput = (ownerId: string, files: ManifestEntry[]): PrepareInput => ({
  userId: ownerId,
  type: "site",
  name: "Race",
  entrypoint: "index.html",
  baseVersionId: null,
  files,
  now: NOW,
});

describe("granting a plan", () => {
  it.each(["free", "pro", "team", "enterprise"] as const)(
    "grants %s with its limit columns to an owner without usage rows yet",
    async (plan) => {
      const owner = await user();
      const granted = await grant(owner.id, { plan, note: "pilot" });
      expect(granted).toMatchObject({ ok: true });
      if (!granted.ok) return;
      expect(granted.value.row).toMatchObject({
        plan,
        seats: 1,
        grantedBy: "operator",
        note: "pilot",
      });
      expect(granted.value.entitlements.limits).toEqual(PLANS[plan].limits);
      expect(await columns(owner.id)).toEqual(planColumns(PLANS[plan].limits));
    },
  );

  it("multiplies per-seat limits and applies overrides as totals", async () => {
    const owner = await user();
    await grant(owner.id, { plan: "team", seats: 3 });
    expect(await columns(owner.id)).toEqual({
      account: { activeLimit: 2_000, bytesLimit: 90_000_000_000 },
      annotations: { messagesLimit: 75_000, bytesLimit: 300_000_000 },
    });
    await grant(owner.id, {
      plan: "enterprise",
      seats: 2,
      overrides: { limits: { activeArtifacts: 5_000, annotationBytes: 1_000_000_000 } },
    });
    expect(await columns(owner.id)).toEqual({
      account: { activeLimit: 5_000, bytesLimit: 60_000_000_000 },
      annotations: { messagesLimit: 50_000, bytesLimit: 1_000_000_000 },
    });
  });

  it("changes a plan and keeps every usage row and counter", async () => {
    const owner = await user();
    const published = await publishSite(owner.id);
    await grant(owner.id, { plan: "team" });
    await grant(owner.id, { plan: "pro", validUntil: NOW + DAY, note: "downgraded" });
    const state = await getOwnerPlan(db(), owner.id, NOW);
    expect(state.row).toMatchObject({ plan: "pro", validUntil: NOW + DAY, note: "downgraded" });
    expect(state.account).toMatchObject({ activeArtifacts: 1, activeLimit: 500 });
    expect(
      value(await getArtifact(db(), { userId: owner.id, artifactId: published.artifactId })).id,
    ).toBe(published.artifactId);
  });

  it("is the same state when retried", async () => {
    const owner = await user();
    await grant(owner.id);
    const first = await getOwnerPlan(db(), owner.id, NOW);
    await grant(owner.id);
    expect(await getOwnerPlan(db(), owner.id, NOW)).toEqual(first);
  });

  it("keeps the plan's limits when a publish or the annotation triggers meet the rows later", async () => {
    const owner = await user();
    await grant(owner.id);
    await publishSite(owner.id);
    // What the annotation triggers run before counting a comment (0007, 0027).
    await env.DB.prepare(
      "INSERT OR IGNORE INTO annotation_usage (owner_id, messages, bytes) VALUES (?, 0, 0)",
    )
      .bind(owner.id)
      .run();
    expect(await columns(owner.id)).toEqual(planColumns(PLANS.pro.limits));
  });

  it("refuses bad input and accounts that do not exist or are being deleted", async () => {
    const owner = await user();
    const bad: [Partial<SetOwnerPlanInput>, string][] = [
      [{ plan: "gold" as "pro" }, "Unknown plan: gold."],
      [{ seats: 0 }, "Seats must be a whole number from 1 to 10000."],
      [{ seats: 1.5 }, "Seats must be a whole number from 1 to 10000."],
      [{ validUntil: NOW }, "The plan must end in the future."],
      [{ grantedBy: " " }, "Say who grants the plan."],
      [{ note: "x".repeat(501) }, "The note can be at most 500 characters."],
      [{ overrides: { limits: { activeArtifacts: -1 } } }, "The overrides are not valid."],
    ];
    for (const [input, message] of bad) {
      expect(await grant(owner.id, input)).toEqual({ ok: false, code: "invalid_input", message });
    }
    expect(await grant("u_missing")).toEqual({
      ok: false,
      code: "not_found",
      message: "Account or workspace not found.",
    });
    const leaving = await user();
    await db().insert(schema.accountDeletions).values({ userId: leaving.id, requestedAt: NOW });
    expect(await grant(leaving.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await getOwnerPlan(db(), owner.id, NOW)).toMatchObject({ row: null, account: null });
    expect((await getOwnerPlan(db(), leaving.id, NOW)).row).toBeNull();
  });

  it("removes a plan, back to free columns but never below usage", async () => {
    const owner = await user();
    await grant(owner.id);
    await setUsage(owner.id, { activeArtifacts: 70 });
    const removed = await removeOwnerPlan(db(), { ownerId: owner.id, now: NOW });
    expect(removed).toMatchObject({ ok: true, value: { removed: true } });
    expect(await columns(owner.id)).toEqual({
      account: { activeLimit: 70, bytesLimit: LIMITS.accountBytes },
      annotations: { messagesLimit: 5_000, bytesLimit: 50_000_000 },
    });
    expect(await removeOwnerPlan(db(), { ownerId: owner.id, now: NOW })).toMatchObject({
      ok: true,
      value: { removed: false },
    });
  });
});

describe("the database at a Pro limit", () => {
  it("lets only one of two uploads that both passed the check take the last Pro slot", async () => {
    const owner = await user();
    await grant(owner.id);
    await publishSite(owner.id);
    await setUsage(owner.id, { activeArtifacts: PLANS.pro.limits.activeArtifacts - 1 });
    let rival: Awaited<ReturnType<typeof preparePublish>> | undefined;
    const lost = await preparePublish(
      racing(async () => {
        rival = await preparePublish(db(), prepareInput(owner.id, await site("<p>b</p>")));
      }),
      prepareInput(owner.id, await site("<p>a</p>")),
    );
    expect(rival).toMatchObject({ ok: true });
    expect(lost).toMatchObject({ ok: false, code: "quota_exceeded" });
    expect((await getOwnerPlan(db(), owner.id, NOW)).account).toMatchObject({
      activeArtifacts: PLANS.pro.limits.activeArtifacts,
      activeLimit: PLANS.pro.limits.activeArtifacts,
    });
  });

  it("lets only one of two uploads that both passed the check take the last Pro bytes", async () => {
    const owner = await user();
    await grant(owner.id);
    await publishSite(owner.id);
    await setUsage(owner.id, { storedBytes: PLANS.pro.limits.accountBytes - 1_000 });
    let rival: Awaited<ReturnType<typeof preparePublish>> | undefined;
    const lost = await preparePublish(
      racing(async () => {
        rival = await preparePublish(db(), prepareInput(owner.id, await site("y".repeat(600))));
      }),
      prepareInput(owner.id, await site("x".repeat(600))),
    );
    expect(rival).toMatchObject({ ok: true });
    expect(lost).toMatchObject({ ok: false, code: "quota_exceeded" });
    expect((await getOwnerPlan(db(), owner.id, NOW)).account).toMatchObject({
      storedBytes: PLANS.pro.limits.accountBytes - 1_000,
      reservedBytes: 600,
    });
  });
});

describe("a lower plan", () => {
  it("refuses only new work above its limits and keeps everything else working", async () => {
    const owner = await user();
    await grant(owner.id, { overrides: { limits: { activeArtifacts: 3 } } });
    const one = await publishSite(owner.id, { "index.html": "<p>one</p>" });
    const two = await publishSite(owner.id, { "index.html": "<p>two</p>" });
    const v2 = await publishSite(owner.id, { "index.html": "<p>two, again</p>" }, NOW, two);
    await publishSite(owner.id, { "index.html": "<p>three</p>" });
    // Down to one active artifact: the column stays at the three in use.
    await grant(owner.id, { overrides: { limits: { activeArtifacts: 1 } } });
    expect((await columns(owner.id)).account?.activeLimit).toBe(3);

    expect(await preparePublish(db(), prepareInput(owner.id, await site("<p>four</p>")))).toEqual({
      ok: false,
      code: "quota_exceeded",
      message: "You already have 1 active artifacts.",
    });
    // Reads, listing and the export.
    expect((await getArtifact(db(), { userId: owner.id, artifactId: one.artifactId })).ok).toBe(
      true,
    );
    expect(
      value(await listArtifacts(db(), { actor: personalActor(owner.id), limit: 10, now: NOW }))
        .items,
    ).toHaveLength(3);
    expect(
      await listVersions(db(), {
        userId: owner.id,
        artifactId: two.artifactId,
        now: NOW,
        limit: 10,
      }),
    ).toMatchObject({ ok: true });
    const exported = await exportAccount(db(), { userId: owner.id, now: NOW });
    expect(exported.ok && exported.value.artifacts).toHaveLength(3);
    // Renewal, rollback and access reduction.
    expect(
      await renewArtifact(db(), { userId: owner.id, artifactId: one.artifactId, now: NOW + DAY }),
    ).toMatchObject({ ok: true });
    expect(
      await rollbackArtifact(db(), {
        userId: owner.id,
        artifactId: two.artifactId,
        versionId: two.versionId,
        baseVersionId: v2.versionId,
        now: NOW + DAY,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await updateAccess(db(), {
        userId: owner.id,
        artifactId: one.artifactId,
        change: { mode: "restricted" },
        now: NOW + DAY,
      }),
    ).toMatchObject({ ok: true });
    // Archiving frees a slot, but restoring needs one under the new limit.
    expect(
      await archiveArtifact(db(), {
        userId: owner.id,
        artifactId: one.artifactId,
        now: NOW + DAY,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await restoreArtifact(db(), {
        userId: owner.id,
        artifactId: one.artifactId,
        now: NOW + DAY,
      }),
    ).toEqual({
      ok: false,
      code: "quota_exceeded",
      message: "You already have 1 active artifacts.",
    });
    // Deletion.
    expect(
      await deleteArtifact(db(), env.ARTIFACTS, {
        userId: owner.id,
        artifactId: one.artifactId,
        now: NOW + DAY,
      }),
    ).toMatchObject({ ok: true });
  });

  it("rolls back to a version above its per-artifact size, and refuses a new one", async () => {
    const owner = await user();
    await grant(owner.id, { overrides: { limits: { artifactBytes: 100 } } });
    const big = { "index.html": `<p>${"x".repeat(40)}</p>` };
    const v1 = await publishSite(owner.id, big);
    const v2 = await publishSite(owner.id, { "index.html": "<p>s</p>" }, NOW, v1);
    await grant(owner.id, { overrides: { limits: { artifactBytes: 10 } } });
    expect(
      await preparePublish(db(), {
        ...prepareInput(owner.id, await site(`<p>${"y".repeat(40)}</p>`)),
        artifactId: v1.artifactId,
        baseVersionId: v2.versionId,
      }),
    ).toEqual({
      ok: false,
      code: "quota_exceeded",
      message: "An artifact version can be at most 10 bytes.",
    });
    expect(
      await rollbackArtifact(db(), {
        userId: owner.id,
        artifactId: v1.artifactId,
        versionId: v1.versionId,
        baseVersionId: v2.versionId,
        now: NOW + DAY,
      }),
    ).toMatchObject({ ok: true });
  });

  it("names the plan's storage when an update would add bytes above it", async () => {
    const owner = await user();
    await grant(owner.id);
    const base = await publishSite(owner.id);
    await setUsage(owner.id, { storedBytes: 3_000_000_000 });
    await removeOwnerPlan(db(), { ownerId: owner.id, now: NOW });
    expect((await columns(owner.id)).account?.bytesLimit).toBe(3_000_000_000);
    expect(
      await preparePublish(db(), {
        ...prepareInput(owner.id, await site("<p>more</p>")),
        artifactId: base.artifactId,
        baseVersionId: base.versionId,
      }),
    ).toEqual({
      ok: false,
      code: "quota_exceeded",
      message: "This would exceed your 2.5 GB of storage.",
    });
  });
});

describe("aligning the limit columns", () => {
  it("does nothing when every owner is in line, with or without a plan", async () => {
    const free = await user();
    await publishSite(free.id);
    const pro = await user();
    await grant(pro.id);
    await alignPlanLimits(db(), NOW);
    expect(await alignPlanLimits(db(), NOW)).toEqual({ processed: 0 });
    expect(await columns(pro.id)).toEqual(planColumns(PLANS.pro.limits));
    expect((await columns(free.id)).account).toEqual({
      activeLimit: LIMITS.activeArtifacts,
      bytesLimit: LIMITS.accountBytes,
    });
  });

  it("lowers the columns when the plan expires, never below usage, then as usage falls", async () => {
    const owner = await user();
    await grant(owner.id, { validUntil: NOW + DAY });
    await publishSite(owner.id);
    await setUsage(owner.id, { activeArtifacts: 60 });
    await alignPlanLimits(db(), NOW);
    expect((await columns(owner.id)).account?.activeLimit).toBe(500);

    await alignPlanLimits(db(), NOW + DAY);
    expect(await columns(owner.id)).toEqual({
      account: { activeLimit: 60, bytesLimit: LIMITS.accountBytes },
      annotations: { messagesLimit: 5_000, bytesLimit: 50_000_000 },
    });
    expect(await alignPlanLimits(db(), NOW + DAY)).toEqual({ processed: 0 });

    await setUsage(owner.id, { activeArtifacts: 40 });
    await alignPlanLimits(db(), NOW + DAY);
    expect((await columns(owner.id)).account?.activeLimit).toBe(LIMITS.activeArtifacts);
    expect(await alignPlanLimits(db(), NOW + DAY)).toEqual({ processed: 0 });
  });

  it("lowers an owner whose plan row went away, and raises one whose rows lag behind", async () => {
    const gone = await user();
    await grant(gone.id);
    await db().delete(schema.ownerPlans).where(eq(schema.ownerPlans.ownerId, gone.id));
    const lagging = await user();
    await grant(lagging.id);
    await db().delete(schema.annotationUsage).where(eq(schema.annotationUsage.ownerId, lagging.id));
    await setUsage(lagging.id, { activeLimit: LIMITS.activeArtifacts });
    await alignPlanLimits(db(), NOW);
    expect(await columns(gone.id)).toEqual(planColumns(PLANS.free.limits));
    expect(await columns(lagging.id)).toEqual(planColumns(PLANS.pro.limits));
  });

  it("never overwrites a grant that lands while it runs", async () => {
    const owner = await user();
    await grant(owner.id, { validUntil: NOW + DAY });
    const later = NOW + DAY;
    await alignPlanLimits(
      racing(() =>
        setOwnerPlan(db(), {
          ownerId: owner.id,
          plan: "team",
          seats: 1,
          validUntil: null,
          overrides: null,
          grantedBy: "operator",
          note: null,
          now: later,
        }),
      ),
      later,
    );
    expect(await columns(owner.id)).toEqual(planColumns(PLANS.team.limits));
  });

  it("writes at most its batch of owners per run", async () => {
    const owners = [await user(), await user(), await user()];
    for (const owner of owners) {
      await grant(owner.id, { validUntil: NOW + DAY });
    }
    const first = await alignPlanLimits(db(), NOW + DAY, 2);
    expect(first.processed).toBe(2);
    const rest = await alignPlanLimits(db(), NOW + DAY, 2);
    expect(rest.processed).toBeGreaterThanOrEqual(1);
    for (const owner of owners) {
      expect(await columns(owner.id)).toEqual(planColumns(PLANS.free.limits));
    }
  });
});
