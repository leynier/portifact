// The maximum life of a workspace's artifacts (decision 0023): who sets it, the plan, the preview
// and the confirmation, the notice period, the cap on every write path (publish, rollback,
// renewal, restore, pin, unpin), the job and the scan with their races, caps and resumption, the
// give-back when it is lengthened or removed, the archive's trail, `apply-policies` in both
// dangerous directions, the admins' email, and the cost on the write path.
import { env } from "cloudflare:test";
import {
  DEFAULT_POLICY,
  LIMITS,
  WORKSPACE_POLICIES,
  type WorkspacePolicy,
} from "@portifact/contracts";
import { globalDb, type Regions, regionalDb, regionsFromEnv, schema } from "@portifact/db";
import { POLICY_MESSAGES, policyExpiry, policyOf } from "@portifact/domain";
import { and, eq, type SQL, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getAuditLog } from "../src/audit.ts";
import {
  archiveArtifact,
  pinArtifact,
  renewArtifact,
  restoreArtifact,
  unpinArtifact,
} from "../src/lifecycle.ts";
import { archiveExpired } from "../src/maintenance.ts";
import { cappedExpirySql, giveBackIds, overMaxLifeIds } from "../src/max-life.ts";
import { reinstateArtifact, suspendArtifact } from "../src/moderation.ts";
import { runJob } from "../src/outbox.ts";
import { unpinLapsedPlans } from "../src/plans.ts";
import { commitPublish, preparePublish } from "../src/publish.ts";
import { type RetentionNotifier, sendRetentionNotice } from "../src/retention-notices.ts";
import { createServiceToken } from "../src/service-tokens.ts";
import { transferArtifact } from "../src/transfer.ts";
import { rollbackArtifact } from "../src/versions.ts";
import {
  applyWorkspacePolicies,
  enforceWorkspacePolicies,
  enforceWorkspacePolicy,
  exportWorkspacePolicies,
  getWorkspacePolicy,
  previewWorkspacePolicy,
  STALE_CAPS_SWEEP,
  setWorkspacePolicy,
  staleCapOwners,
} from "../src/workspace-policies.ts";
import { DAY, db, grantPlan, NOW, racing, sha256, value } from "./fixtures.ts";

const hex = () => crypto.randomUUID().replaceAll("-", "");
const regions = (): Regions => regionsFromEnv(env);
const NOTICE = WORKSPACE_POLICIES.retentionNoticeDays * DAY;
const FROM = NOW + NOTICE;
const maxLife = (days: number | null, extra: Partial<WorkspacePolicy> = {}): WorkspacePolicy => ({
  ...DEFAULT_POLICY,
  ...extra,
  artifactMaxDays: days,
  artifactMaxDaysFrom: null,
});

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

async function team(plan: "enterprise" | "free" = "enterprise") {
  const id = `ws_${hex()}`;
  const slug = `r${hex().slice(0, 20)}`;
  const t = {
    id,
    slug,
    admin: await person("Admin"),
    admin2: await person("Second"),
    editor: await person("Editor"),
    member: await person("Member"),
    outsider: await person("Outsider"),
  };
  await db()
    .insert(schema.workspaces)
    .values({ id, slug, name: "Team", createdBy: t.admin.id, updatedAt: NOW });
  await db()
    .insert(schema.workspaceMembers)
    .values([
      { workspaceId: id, userId: t.admin.id, role: "admin", updatedAt: NOW },
      { workspaceId: id, userId: t.admin2.id, role: "admin", updatedAt: NOW },
      { workspaceId: id, userId: t.editor.id, role: "editor", updatedAt: NOW },
      { workspaceId: id, userId: t.member.id, role: "member", updatedAt: NOW },
    ]);
  if (plan !== "free") await grantPlan(id, plan, { seats: 10 });
  return t;
}
type Team = Awaited<ReturnType<typeof team>>;

async function publishIn(
  userId: string,
  ownerId: string,
  now = NOW,
  update?: { artifactId: string; baseVersionId: string },
) {
  const body = `<p>${crypto.randomUUID()}</p>`;
  const digest = await sha256(body);
  const prepared = value(
    await preparePublish(db(), {
      userId,
      targetOwnerId: ownerId,
      type: "site",
      name: "Plan",
      entrypoint: "index.html",
      baseVersionId: update?.baseVersionId ?? null,
      ...(update ? { artifactId: update.artifactId } : {}),
      files: [
        {
          path: "index.html",
          kind: "published" as const,
          sha256: digest,
          size: body.length,
          contentType: "text/html",
        },
      ],
      now,
    }),
  );
  await env.ARTIFACTS.put(`objects/${ownerId}/${digest}`, body);
  return value(
    await commitPublish(db(), env.ARTIFACTS, { userId, sessionId: prepared.sessionId, now }),
  );
}

/**
 * An artifact whose last publish was `agoDays` days before NOW and that was renewed since: its
 * expiry is `expiresInDays` days after NOW.
 */
async function aged(t: Team, agoDays: number, expiresInDays = 20) {
  const published = await publishIn(t.editor.id, t.id, NOW - agoDays * DAY);
  await db()
    .update(schema.artifacts)
    .set({ expiresAt: NOW + expiresInDays * DAY })
    .where(eq(schema.artifacts.id, published.artifactId));
  return published.artifactId;
}

async function row(id: string) {
  const [found] = await db().select().from(schema.artifacts).where(eq(schema.artifacts.id, id));
  if (!found) throw new Error("missing artifact");
  return found;
}

const preview = (t: Team, next: WorkspacePolicy, now = NOW, userId = t.admin.id) =>
  previewWorkspacePolicy(regions(), { userId, slug: t.slug, policy: next, now });

/** Saves as the dashboard does: the preview, then the save with what it showed. */
async function save(
  t: Team,
  next: WorkspacePolicy,
  options: { now?: number; revision?: number; userId?: string; confirm?: boolean } = {},
) {
  const now = options.now ?? NOW;
  const shown = options.confirm === false ? undefined : await preview(t, next, now, options.userId);
  return setWorkspacePolicy(regions(), {
    userId: options.userId ?? t.admin.id,
    slug: t.slug,
    policy: next,
    revision: options.revision ?? (await revision(t)),
    confirmed: shown?.ok ? shown.value : undefined,
    now,
  });
}

async function revision(t: Team) {
  const [found] = await db()
    .select({ revision: schema.workspaces.policyRevision })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, t.id));
  return found?.revision ?? 0;
}

async function stored(t: Team) {
  const [found] = await db()
    .select({ policy: schema.workspaces.policy })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, t.id));
  return policyOf(found?.policy ?? null);
}

async function jobs(topic: "workspace_policy" | "retention_notice", subject: string) {
  return db()
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.topic, topic), eq(schema.outbox.subject, subject)));
}

async function runJobs(t: Team, now = NOW) {
  for (const job of await jobs("workspace_policy", t.id)) {
    await runJob(db(), env.ARTIFACTS, { id: job.id, topic: "workspace_policy" }, now);
  }
}

async function events(t: Team, kind: string) {
  return db()
    .select()
    .from(schema.auditEvents)
    .where(and(eq(schema.auditEvents.ownerId, t.id), eq(schema.auditEvents.kind, kind)));
}

const lifecycle = (userId: string, artifactId: string, now = NOW) => ({ userId, artifactId, now });

describe("who sets a maximum life, and the plan", () => {
  it("is an admin's, gated on the plan to set or shorten, never to lengthen or remove", async () => {
    const t = await team();
    for (const userId of [t.editor.id, t.member.id]) {
      expect(await save(t, maxLife(30), { userId, confirm: false })).toMatchObject({
        code: "forbidden",
      });
    }
    expect(await save(t, maxLife(30), { userId: t.outsider.id, confirm: false })).toMatchObject({
      code: "not_found",
    });
    const token = value(
      await createServiceToken(db().global, {
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
    expect(await save(t, maxLife(30), { userId: token, confirm: false })).toMatchObject({
      code: "forbidden",
    });
    value(await save(t, maxLife(30)));
    // The plan lapses: the maximum life keeps running, it can be lengthened or removed, not
    // shortened.
    await db().delete(schema.ownerPlans).where(eq(schema.ownerPlans.ownerId, t.id));
    expect(await save(t, maxLife(20))).toMatchObject({ code: "plan_required" });
    value(await save(t, maxLife(60)));
    expect((await stored(t)).artifactMaxDays).toBe(60);
    value(await save(t, maxLife(null)));
    expect(await stored(t)).toEqual(DEFAULT_POLICY);
  });

  it("is read by every member, with its effective date", async () => {
    const t = await team();
    value(await save(t, maxLife(30)));
    const shown = value(
      await getWorkspacePolicy(db().global, { userId: t.member.id, slug: t.slug, now: NOW }),
    );
    expect(shown.policy).toMatchObject({ artifactMaxDays: 30, artifactMaxDaysFrom: FROM });
  });

  it("leaves a personal space's artifacts alone", async () => {
    const owner = await person("Solo");
    const published = await publishIn(owner.id, owner.id);
    expect(published.expiresAt).toBe(NOW + LIMITS.activeDays * DAY);
  });
});

describe("the preview, the confirmation and the notice period", () => {
  it("counts what it archives, refuses until confirmed and again when it grew", async () => {
    const t = await team();
    const old = await aged(t, 60);
    const recent = await aged(t, 25);
    await publishIn(t.editor.id, t.id);
    await db()
      .update(schema.artifacts)
      .set({ pinned: true, expiresAt: null })
      .where(eq(schema.artifacts.id, recent));
    const shown = value(await preview(t, maxLife(30)));
    // `old` reached 30 days long ago: archived the day it takes effect. `recent` (pinned)
    // reaches it 5 days after the publish date, before the effective date: also then.
    expect(shown).toMatchObject({ artifactsAtStart: 2, artifactsSoon: 0, pinsLifted: 1 });
    expect(await save(t, maxLife(30), { confirm: false })).toMatchObject({
      code: "policy_refused",
    });
    // Another old artifact after the preview: the confirmation no longer holds.
    await aged(t, 90);
    const refused = await setWorkspacePolicy(regions(), {
      userId: t.admin.id,
      slug: t.slug,
      policy: maxLife(30),
      revision: 0,
      confirmed: shown,
      now: NOW,
    });
    expect(refused).toEqual({
      ok: false,
      code: "policy_refused",
      message: POLICY_MESSAGES.impactChanged,
    });
    value(await save(t, maxLife(30)));
    expect(await stored(t)).toMatchObject({ artifactMaxDays: 30, artifactMaxDaysFrom: FROM });
    expect((await row(old)).state).toBe("active");
    // Counts a longer one as nothing sooner.
    expect(value(await preview(t, maxLife(90)))).toMatchObject({
      artifactsAtStart: 0,
      artifactsSoon: 0,
      pinsLifted: 0,
    });
  });

  it("archives nothing before the effective date, and only what reached it after", async () => {
    const t = await team();
    const old = await aged(t, 60);
    const fresh = (await publishIn(t.editor.id, t.id)).artifactId;
    value(await save(t, maxLife(30)));
    await runJobs(t);
    // The deadline is set at once, never before the effective date; the fresh one keeps its own.
    expect((await row(old)).expiresAt).toBe(FROM);
    expect((await row(fresh)).expiresAt).toBe(NOW + 30 * DAY);
    for (const at of [NOW, NOW + DAY, FROM - 1]) {
      await archiveExpired(db(), at);
      expect((await row(old)).state).toBe("active");
    }
    await archiveExpired(db(), FROM);
    const archived = await row(old);
    expect(archived.state).toBe("archived");
    expect(archived.archivedAt).toBe(FROM);
    expect((await row(fresh)).state).toBe("active");
    // The trail of a manual archive, by the system, naming the policy.
    const trail = await events(t, "artifact.archived");
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ actorType: "system", artifactId: old });
    expect(trail[0]?.detail).toEqual({ policy: "artifactMaxDays" });
    // Restoring starts a new life within the maximum, and the scan leaves it alone.
    const restored = value(await restoreArtifact(db(), lifecycle(t.editor.id, old, FROM + DAY)));
    expect(restored.expiresAt).toBe(FROM + DAY + 30 * DAY);
    expect((await row(old)).lifeStartedAt).toBe(FROM + DAY);
    await enforceWorkspacePolicy(db(), t.id, FROM + DAY);
    expect((await row(old)).expiresAt).toBe(FROM + DAY + 30 * DAY);
  });

  it("writes the admins' notice once, for a new or shorter maximum only", async () => {
    const t = await team();
    value(await save(t, maxLife(30)));
    value(await save(t, maxLife(60)));
    value(await save(t, maxLife(14)));
    const notices = await jobs("retention_notice", t.id);
    expect(notices.map((job) => (job.payload as { days: number }).days)).toEqual([30, 14]);
  });
});

describe("the cap on every write path", () => {
  it("caps publishes, rollbacks, renewals and unpins, and refuses pins", async () => {
    const t = await team();
    value(await save(t, maxLife(10)));
    // Before the effective date the deadline is that date at the earliest.
    const first = await publishIn(t.editor.id, t.id);
    expect(first.expiresAt).toBe(NOW + 10 * DAY);
    const later = NOW + 20 * DAY;
    const second = await publishIn(t.editor.id, t.id, later, {
      artifactId: first.artifactId,
      baseVersionId: first.versionId,
    });
    expect(second.expiresAt).toBe(later + 10 * DAY);
    // A renewal keeps the life where it is: capped at the last publish plus 10 days.
    const renewed = value(
      await renewArtifact(db(), lifecycle(t.editor.id, first.artifactId, later + 2 * DAY)),
    );
    expect(renewed.expiresAt).toBe(later + 10 * DAY);
    // A rollback is a publish: a new life.
    const rolled = value(
      await rollbackArtifact(db(), {
        userId: t.editor.id,
        artifactId: first.artifactId,
        versionId: first.versionId,
        baseVersionId: second.versionId,
        now: later + 3 * DAY,
      }),
    );
    expect((await row(first.artifactId)).expiresAt).toBe(later + 13 * DAY);
    expect(rolled).toBeTruthy();
    expect(
      await pinArtifact(db(), lifecycle(t.editor.id, first.artifactId, later + 3 * DAY)),
    ).toEqual({
      ok: false,
      code: "policy_refused",
      message: POLICY_MESSAGES.pinUnderMaxLife(10),
    });
  });

  it("refuses a renewal past the maximum instead of archiving", async () => {
    const t = await team();
    const old = await aged(t, 60);
    value(await save(t, maxLife(30)));
    const at = FROM + DAY;
    await db()
      .update(schema.artifacts)
      .set({ expiresAt: at + DAY })
      .where(eq(schema.artifacts.id, old));
    expect(await renewArtifact(db(), lifecycle(t.editor.id, old, at))).toEqual({
      ok: false,
      code: "policy_refused",
      message: POLICY_MESSAGES.maxLifeReached(30),
    });
    expect((await row(old)).expiresAt).toBe(at + DAY);
  });

  it("unpins pinned artifacts with their deadline and the trail of an unpin", async () => {
    const t = await team();
    const pinned = (await publishIn(t.editor.id, t.id)).artifactId;
    value(await pinArtifact(db(), lifecycle(t.editor.id, pinned)));
    value(await save(t, maxLife(14)));
    const step = await enforceWorkspacePolicy(db(), t.id, NOW);
    expect(step.counts.deadlinesSet).toBe(1);
    const after = await row(pinned);
    expect(after).toMatchObject({ pinned: false, expiresAt: NOW + 14 * DAY });
    const unpinned = await events(t, "artifact.unpinned");
    expect(unpinned).toHaveLength(1);
    expect(unpinned[0]).toMatchObject({ actorType: "system" });
    expect(await events(t, "policy.enforced")).toHaveLength(1);
    // Unpinning by hand under a maximum life is capped like a renewal.
    await db()
      .update(schema.artifacts)
      .set({ pinned: true, expiresAt: null })
      .where(eq(schema.artifacts.id, pinned));
    const manual = value(await unpinArtifact(db(), lifecycle(t.editor.id, pinned, NOW + DAY)));
    expect(manual.expiresAt).toBe(NOW + 14 * DAY);
  });
});

describe("the job and the scan", () => {
  it("leaves an artifact published between the read and the write alone", async () => {
    const t = await team();
    const old = await aged(t, 60);
    value(await save(t, maxLife(30)));
    const raced = racing(async () => {
      const { versionId } = await row(old).then((found) => ({
        versionId: found.currentVersionId ?? "",
      }));
      await publishIn(t.editor.id, t.id, NOW, { artifactId: old, baseVersionId: versionId });
    });
    await enforceWorkspacePolicy(raced, t.id, NOW);
    expect((await row(old)).expiresAt).toBe(NOW + 30 * DAY);
  });

  it("stops the batch when the policy was loosened between the read and the write", async () => {
    const t = await team();
    const old = await aged(t, 60);
    value(await save(t, maxLife(30)));
    const raced = racing(async () => {
      value(await save(t, maxLife(null)));
    });
    const step = await enforceWorkspacePolicy(raced, t.id, NOW);
    expect(step.counts.deadlinesSet).toBe(0);
    expect((await row(old)).expiresAt).toBe(NOW + 20 * DAY);
  });

  it("takes at most one batch a step and resumes, and the scan finds the rest", async () => {
    const t = await team();
    const ids = [await aged(t, 60), await aged(t, 61), await aged(t, 62)];
    value(await save(t, maxLife(30)));
    expect(await enforceWorkspacePolicy(db(), t.id, NOW, 2)).toMatchObject({
      outcome: "pending",
      counts: { deadlinesSet: 2 },
    });
    expect(await enforceWorkspacePolicy(db(), t.id, NOW, 2)).toMatchObject({
      outcome: "done",
      counts: { deadlinesSet: 1 },
    });
    for (const id of ids) expect((await row(id)).expiresAt).toBe(FROM);
    // An artifact let through afterwards (a renewal that read the old policy) is caught by the
    // scan, which then records nothing more.
    await db()
      .update(schema.artifacts)
      .set({ expiresAt: NOW + 25 * DAY })
      .where(eq(schema.artifacts.id, ids[0] as string));
    const scanned = await enforceWorkspacePolicies(db(), NOW);
    expect(scanned.failed).toBe(0);
    expect((await row(ids[0] as string)).expiresAt).toBe(FROM);
  });

  it("gives back what a maximum took when it is lengthened or removed", async () => {
    const t = await team();
    const old = await aged(t, 60, 25);
    const mid = await aged(t, 10, 25);
    value(await save(t, maxLife(14)));
    await runJobs(t);
    expect((await row(old)).expiresAt).toBe(FROM);
    // Its own deadline (4 days from now) is before the effective date: that date, then.
    expect((await row(mid)).expiresAt).toBe(FROM);
    value(await save(t, maxLife(null), { now: NOW + DAY }));
    await runJobs(t, NOW + DAY);
    // The expiry their plan gave them, kept when the cap was set: no more, no less.
    expect(await row(old)).toMatchObject({ expiresAt: NOW + 25 * DAY, uncappedExpiresAt: null });
    expect(await row(mid)).toMatchObject({ expiresAt: NOW + 25 * DAY, uncappedExpiresAt: null });
    const extended = (await events(t, "policy.enforced")).map(
      (event) => (event.detail as { deadlinesExtended?: number }).deadlinesExtended,
    );
    expect(extended).toContain(2);
  });
});

describe("apply-policies after a restore", () => {
  it("removes a maximum the restore brought back when the file has none, without --allow-lifting", async () => {
    const t = await team();
    const old = await aged(t, 60);
    value(await save(t, maxLife(30, { publicAccess: "forbidden" })));
    const restoredPoint = await exportWorkspacePolicies(db().global);
    value(await save(t, maxLife(null, { publicAccess: "allowed" })));
    const file = await exportWorkspacePolicies(db().global);
    // The restore rewinds the row to the tight policy.
    const [tight] = restoredPoint.filter((item) => item.workspaceId === t.id);
    await db()
      .update(schema.workspaces)
      .set({ policy: tight?.policy ?? null })
      .where(eq(schema.workspaces.id, t.id));
    await enforceWorkspacePolicy(db(), t.id, NOW);
    expect((await row(old)).expiresAt).toBe(FROM);
    const applied = await applyWorkspacePolicies(db().global, file, NOW + DAY);
    expect(applied).toMatchObject({ ok: true });
    // The workspace's policy is all defaults now, so it is not in the file: its maximum life is
    // removed, and the access restriction waits for the operator.
    if (applied.ok) expect(applied.retentionCleared).toContain(t.id);
    expect(await stored(t)).toMatchObject({ artifactMaxDays: null, publicAccess: "forbidden" });
    await runJobs(t, NOW + DAY);
    expect((await row(old)).expiresAt).toBe(NOW + 20 * DAY);
  });

  it("applies a file's longer maximum even when the rest of the item is held back", async () => {
    const t = await team();
    value(await save(t, maxLife(14, { publicAccess: "forbidden" })));
    const file = (await exportWorkspacePolicies(db().global))
      .filter((item) => item.workspaceId === t.id)
      .map((item) => ({
        ...item,
        policy: { ...item.policy, artifactMaxDays: 90, publicAccess: "allowed" as const },
      }));
    const applied = await applyWorkspacePolicies(db().global, file, NOW);
    expect(applied).toMatchObject({ ok: true, applied: 1 });
    if (applied.ok)
      expect(applied.lifting).toEqual([{ workspaceId: t.id, fields: ["publicAccess"] }]);
    expect(await stored(t)).toMatchObject({ artifactMaxDays: 90, publicAccess: "forbidden" });
  });

  it("never starts a file's maximum earlier than the effective date it stores", async () => {
    const t = await team();
    value(await save(t, maxLife(30)));
    const file = await exportWorkspacePolicies(db().global);
    // The restore lost the policy entirely.
    await db()
      .update(schema.workspaces)
      .set({ policy: null })
      .where(eq(schema.workspaces.id, t.id));
    expect(await applyWorkspacePolicies(db().global, file, NOW + 2 * DAY)).toMatchObject({
      ok: true,
      applied: 1,
    });
    expect(await stored(t)).toMatchObject({ artifactMaxDays: 30, artifactMaxDaysFrom: FROM });
  });
});

describe("the admins' notice", () => {
  const notifier = () => {
    const sent: Parameters<RetentionNotifier["send"]>[0][] = [];
    return { sent, send: async (notice: (typeof sent)[number]) => void sent.push(notice) };
  };

  it("emails each admin once, with counts and a date, and is moot once the policy changed", async () => {
    const t = await team();
    await aged(t, 60);
    value(await save(t, maxLife(30)));
    const [job] = await jobs("retention_notice", t.id);
    if (!job) throw new Error("no notice job");
    const fake = notifier();
    expect(await sendRetentionNotice(db(), job, NOW, fake)).toBe("done");
    expect(fake.sent.map((notice) => notice.to).sort()).toEqual(
      [t.admin.email, t.admin2.email].sort(),
    );
    expect(fake.sent[0]).toMatchObject({
      days: 30,
      from: FROM,
      atStart: 1,
      soon: 0,
      workspaceSlug: t.slug,
    });
    // Claimed: a second delivery sends nothing.
    expect(await sendRetentionNotice(db(), job, NOW, fake)).toBe("done");
    expect(fake.sent).toHaveLength(2);
    // Removed before the relay: the notice is moot.
    value(await save(t, maxLife(14)));
    value(await save(t, maxLife(null)));
    const [removed] = (await jobs("retention_notice", t.id)).slice(-1);
    if (!removed) throw new Error("no notice job");
    expect(await sendRetentionNotice(db(), removed, NOW, notifier())).toBe("stale");
  });

  it("tells the admins about the maximum that binds when it was lengthened before the relay", async () => {
    const t = await team();
    value(await save(t, maxLife(14)));
    // A lengthening writes no notice of its own, and keeps the first save's effective date.
    value(await save(t, maxLife(60)));
    const notices = await jobs("retention_notice", t.id);
    expect(notices).toHaveLength(1);
    const fake = notifier();
    expect(await sendRetentionNotice(db(), notices[0] as (typeof notices)[number], NOW, fake)).toBe(
      "done",
    );
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[0]).toMatchObject({ days: 60, from: FROM });
  });

  it("goes back to the outbox when the first send fails", async () => {
    const t = await team();
    value(await save(t, maxLife(30)));
    const [job] = await jobs("retention_notice", t.id);
    if (!job) throw new Error("no notice job");
    const failing: RetentionNotifier = {
      send: async () => {
        throw new Error("down");
      },
    };
    await expect(sendRetentionNotice(db(), job, NOW, failing)).rejects.toThrow("down");
    expect(await jobs("retention_notice", t.id)).toHaveLength(1);
  });
});

describe("cost on the write path", () => {
  function recording() {
    let calls = 0;
    const d1 = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (query: string) => {
            const statement = target.prepare(query);
            return new Proxy(statement, {
              get(inner, key) {
                const real = Reflect.get(inner, key, inner);
                if (typeof real !== "function") return real;
                if (["all", "raw", "run", "first"].includes(String(key))) {
                  return (...args: unknown[]) => {
                    calls += 1;
                    return real.apply(inner, args);
                  };
                }
                return real.bind(inner);
              },
            });
          };
        }
        if (property === "batch") {
          return (statements: D1PreparedStatement[]) => {
            calls += 1;
            return target.batch(statements);
          };
        }
        const real = Reflect.get(target, property, target);
        return typeof real === "function" ? real.bind(target) : real;
      },
    });
    return { database: regionalDb(d1, globalDb(d1)), calls: () => calls };
  }

  it("adds no D1 call to a commit or a renewal under a maximum life", async () => {
    const counts: number[][] = [];
    for (const next of [DEFAULT_POLICY, maxLife(10)]) {
      const t = await team();
      if (next !== DEFAULT_POLICY) value(await save(t, next));
      const artifactId = (await publishIn(t.editor.id, t.id)).artifactId;
      const renewing = recording();
      value(await renewArtifact(renewing.database, lifecycle(t.editor.id, artifactId, NOW + DAY)));
      const archiving = recording();
      value(
        await archiveArtifact(archiving.database, lifecycle(t.editor.id, artifactId, NOW + DAY)),
      );
      counts.push([renewing.calls(), archiving.calls()]);
    }
    expect(counts[1]).toEqual(counts[0]);
  });
});

describe("any sequence of saves (review of PR 214, finding 1)", () => {
  /** An artifact last published 400 days ago, renewed to expire 25 days after NOW. */
  const steps = async (t: Team, chain: [number, number | null][]) => {
    for (const [day, days] of chain) {
      value(await save(t, maxLife(days), { now: NOW + day * DAY }));
      await runJobs(t, NOW + day * DAY);
    }
  };

  it("set, shorten, remove: no cap survives the removal", async () => {
    const t = await team();
    const old = await aged(t, 400, 25);
    await steps(t, [[0, 90]]);
    expect((await row(old)).expiresAt).toBe(FROM);
    // Shortening never puts a deadline before its own effective date.
    await steps(t, [[3, 30]]);
    expect((await row(old)).expiresAt).toBe(NOW + 3 * DAY + NOTICE);
    await steps(t, [[4, null]]);
    const after = await row(old);
    expect(after.expiresAt).toBe(NOW + 25 * DAY);
    expect(after.uncappedExpiresAt).toBeNull();
    await archiveExpired(db(), FROM + DAY);
    expect((await row(old)).state).toBe("active");
  });

  it("set, shorten, lengthen: never before the current policy's effective date", async () => {
    const t = await team();
    const old = await aged(t, 400, 25);
    await steps(t, [
      [0, 90],
      [3, 30],
      [4, 60],
    ]);
    const current = await stored(t);
    expect(current.artifactMaxDaysFrom).toBe(NOW + 3 * DAY + NOTICE);
    expect((await row(old)).expiresAt).toBe(current.artifactMaxDaysFrom);
    await archiveExpired(db(), FROM + DAY);
    expect((await row(old)).state).toBe("active");
  });

  it("set, shorten, shorten, remove: the plan's expiry comes back", async () => {
    const t = await team();
    const old = await aged(t, 400, 25);
    await steps(t, [
      [0, 90],
      [3, 30],
      [5, 14],
    ]);
    expect((await row(old)).expiresAt).toBe(NOW + 5 * DAY + NOTICE);
    await steps(t, [[6, null]]);
    expect((await row(old)).expiresAt).toBe(NOW + 25 * DAY);
  });

  it("gives the time back through the scan too, whatever job ran", async () => {
    const t = await team();
    const old = await aged(t, 400, 25);
    await steps(t, [[0, 90]]);
    // Lengthened, and the save's job lost: the scan alone brings it back in line.
    value(await save(t, maxLife(120), { now: NOW + DAY }));
    await db().delete(schema.outbox).where(eq(schema.outbox.subject, t.id));
    await enforceWorkspacePolicies(db(), NOW + DAY);
    expect((await row(old)).expiresAt).toBe(FROM);
    // A shortening whose job is lost: the scan raises the old cap to the new effective date.
    value(await save(t, maxLife(30), { now: NOW + 2 * DAY }));
    await db().delete(schema.outbox).where(eq(schema.outbox.subject, t.id));
    await enforceWorkspacePolicies(db(), NOW + 2 * DAY);
    expect((await row(old)).expiresAt).toBe(NOW + 2 * DAY + NOTICE);
  });
});

describe("artifacts that come under a maximum late (review of PR 214, finding 2)", () => {
  const LATER = NOW + 10 * DAY;

  async function inEffect(days: number) {
    const t = await team();
    value(await save(t, maxLife(days)));
    await runJobs(t);
    return t;
  }

  it("starts a new life when an artifact moves in, and the scan leaves it", async () => {
    const t = await inEffect(30);
    const mine = await publishIn(t.editor.id, t.editor.id, LATER - 200 * DAY);
    await db()
      .update(schema.artifacts)
      .set({ expiresAt: LATER + 25 * DAY })
      .where(eq(schema.artifacts.id, mine.artifactId));
    const moved = value(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: t.editor.id,
        artifactId: mine.artifactId,
        workspace: t.slug,
        now: LATER,
      }),
    );
    // Its own expiry is within the maximum counted from the move: kept.
    expect(moved).toMatchObject({
      ownerId: t.id,
      expiresAt: LATER + 25 * DAY,
      lifeStartedAt: LATER,
    });
    await enforceWorkspacePolicies(db(), LATER);
    await archiveExpired(db(), LATER + 15 * 60_000);
    expect(await row(mine.artifactId)).toMatchObject({
      state: "active",
      expiresAt: LATER + 25 * DAY,
    });
  });

  it("unpins a pinned artifact that moves in, with its deadline from the move", async () => {
    const t = await inEffect(14);
    const mine = await publishIn(t.editor.id, t.editor.id, LATER - 200 * DAY);
    await db()
      .update(schema.artifacts)
      .set({ pinned: true, expiresAt: null })
      .where(eq(schema.artifacts.id, mine.artifactId));
    const moved = value(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: t.editor.id,
        artifactId: mine.artifactId,
        workspace: t.slug,
        now: LATER,
      }),
    );
    expect(moved).toMatchObject({ pinned: false, expiresAt: LATER + 14 * DAY });
    await enforceWorkspacePolicies(db(), LATER);
    expect((await row(mine.artifactId)).expiresAt).toBe(LATER + 14 * DAY);
  });

  it("never writes an expiry before now for an active artifact the scan catches late", async () => {
    const t = await inEffect(30);
    // As `unpinLapsedPlans` or a reinstatement leaves it: active, 30 days from now, last
    // published long ago.
    const late = await aged(t, 400, 0);
    await db()
      .update(schema.artifacts)
      .set({ expiresAt: LATER + 30 * DAY, uncappedExpiresAt: null })
      .where(eq(schema.artifacts.id, late));
    await enforceWorkspacePolicies(db(), LATER);
    expect((await row(late)).expiresAt).toBe(LATER);
    await archiveExpired(db(), LATER + 15 * 60_000);
    expect(await row(late)).toMatchObject({ state: "archived", archivedAt: LATER });
  });

  it("does the same after a reinstatement from a suspension", async () => {
    const t = await inEffect(30);
    const late = await aged(t, 400, 25);
    value(await suspendArtifact(db(), { artifactId: late, reason: "spam", now: NOW }));
    await enforceWorkspacePolicies(db(), NOW);
    value(await reinstateArtifact(db(), { artifactId: late, now: LATER }));
    await enforceWorkspacePolicies(db(), LATER);
    const after = await row(late);
    expect(after.state).toBe("active");
    expect(after.expiresAt).toBeGreaterThanOrEqual(LATER);
  });

  it("does the same after unpinLapsedPlans", async () => {
    const t = await inEffect(30);
    const late = await aged(t, 400, 0);
    await db()
      .update(schema.artifacts)
      .set({ pinned: true, expiresAt: null })
      .where(eq(schema.artifacts.id, late));
    // The plan ended long ago (past its grace): pins lapse, the policy keeps running.
    await db()
      .update(schema.ownerPlans)
      .set({ validUntil: NOW - 100 * DAY, grace: null })
      .where(eq(schema.ownerPlans.ownerId, t.id));
    await unpinLapsedPlans(db(), LATER);
    expect((await row(late)).pinned).toBe(false);
    await enforceWorkspacePolicies(db(), LATER);
    expect((await row(late)).expiresAt).toBe(LATER);
  });
});

describe("the SQL twin (review of PR 214, P1)", () => {
  it("cappedExpirySql equals policyExpiry on the row's life start, 400 cases on D1", async () => {
    const t = await team();
    const p = await publishIn(t.editor.id, t.id, NOW);
    const art = await row(p.artifactId);
    let seed = 42;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const pick = (max: number) => [0, 1, DAY, max, rnd(max), rnd(max) * 1000][rnd(6)] as number;
    const mismatches: unknown[] = [];
    for (let i = 0; i < 400; i++) {
      const commit = NOW - pick(4000) * DAY + pick(DAY);
      const restored = rnd(3) === 0 ? null : NOW - pick(4000) * DAY;
      const days = rnd(4) === 0 ? null : 7 + rnd(3644);
      const from = rnd(3) === 0 ? null : NOW + (rnd(2) ? 1 : -1) * pick(4000) * DAY;
      const plan = NOW + pick(4000) * DAY;
      const now = NOW + (rnd(2) ? 1 : -1) * pick(400) * DAY;
      const committedNull = rnd(4) === 0;
      await db()
        .update(schema.versions)
        .set({ committedAt: committedNull ? null : commit, createdAt: commit })
        .where(eq(schema.versions.id, art.currentVersionId as string));
      await db()
        .update(schema.artifacts)
        .set({ lifeStartedAt: restored })
        .where(eq(schema.artifacts.id, art.id));
      const policy = { ...maxLife(days), artifactMaxDaysFrom: days === null ? null : from };
      const [r] = await db().all<{ v: number }>(
        sql`select ${cappedExpirySql(policy, plan, now)} as v from ${schema.artifacts} where ${schema.artifacts.id} = ${art.id}`,
      );
      const js = policyExpiry(policy, plan, Math.max(commit, restored ?? 0), now);
      if (Number(r?.v) !== js) mismatches.push({ commit, restored, days, from, plan, now, js });
    }
    expect(mismatches.slice(0, 3)).toEqual([]);
  });
});

describe("stale caps after a removal or a racing write (review of PR 214, second pass)", () => {
  it("R-A: a renewal racing a removal is given back by the scan", async () => {
    const t = await team();
    // Expires before the maximum takes effect: the job does not cap it.
    const old = await aged(t, 400, 3);
    value(await save(t, maxLife(90)));
    await runJobs(t);
    const at = NOW + DAY;
    const raced = racing(async () => {
      value(await save(t, maxLife(null), { now: at }));
      await runJobs(t, at);
    });
    value(await renewArtifact(raced, lifecycle(t.editor.id, old, at)));
    await enforceWorkspacePolicies(db(), at + 60_000);
    expect(await row(old)).toMatchObject({ expiresAt: at + 30 * DAY, uncappedExpiresAt: null });
  });

  it("R-A, the other way: a renewal that read no maximum just before one was set is capped", async () => {
    const t = await team();
    const old = await aged(t, 400, 3);
    const raced = racing(async () => {
      value(await save(t, maxLife(30)));
      await runJobs(t);
    });
    value(await renewArtifact(raced, lifecycle(t.editor.id, old)));
    expect((await row(old)).expiresAt).toBe(NOW + 30 * DAY);
    await enforceWorkspacePolicies(db(), NOW + 60_000);
    expect(await row(old)).toMatchObject({ expiresAt: FROM, uncappedExpiresAt: NOW + 30 * DAY });
  });

  it("R-B: a removal while an artifact is suspended does not survive its reinstatement", async () => {
    const t = await team();
    const old = await aged(t, 400, 25);
    value(await save(t, maxLife(90)));
    await runJobs(t);
    expect((await row(old)).expiresAt).toBe(FROM);
    value(await suspendArtifact(db(), { artifactId: old, reason: "spam", now: NOW + DAY }));
    value(await save(t, maxLife(null), { now: NOW + 2 * DAY }));
    await runJobs(t, NOW + 2 * DAY);
    value(await reinstateArtifact(db(), { artifactId: old, now: NOW + 3 * DAY }));
    await enforceWorkspacePolicies(db(), NOW + 3 * DAY);
    expect(await row(old)).toMatchObject({ expiresAt: NOW + 25 * DAY, uncappedExpiresAt: null });
    await archiveExpired(db(), FROM + 60_000);
    expect((await row(old)).state).toBe("active");
  });

  it("R-B before any scan: the expiry run gives a stale cap back instead of archiving by a removed rule", async () => {
    const t = await team();
    const old = await aged(t, 400, 25);
    value(await save(t, maxLife(90)));
    await runJobs(t);
    value(await suspendArtifact(db(), { artifactId: old, reason: "spam", now: NOW + DAY }));
    value(await save(t, maxLife(null), { now: NOW + 2 * DAY }));
    await runJobs(t, NOW + 2 * DAY);
    value(await reinstateArtifact(db(), { artifactId: old, now: NOW + 3 * DAY }));
    // No scan between: the expiry run reaches the stale cap first.
    await archiveExpired(db(), FROM + 60_000);
    expect(await row(old)).toMatchObject({
      state: "active",
      expiresAt: NOW + 25 * DAY,
      uncappedExpiresAt: null,
    });
    expect(await events(t, "artifact.archived")).toEqual([]);
  });

  it("an archive is credited to the policy only while the workspace has a maximum", async () => {
    const t = await team();
    const old = await aged(t, 400, 25);
    value(await save(t, maxLife(90)));
    await runJobs(t);
    // The plan's own expiry passes while the removal's job is lost: a plain expiry, not the policy.
    value(await save(t, maxLife(null), { now: NOW + DAY }));
    await db().delete(schema.outbox).where(eq(schema.outbox.subject, t.id));
    await db()
      .update(schema.artifacts)
      .set({ uncappedExpiresAt: NOW + 5 * DAY })
      .where(eq(schema.artifacts.id, old));
    await archiveExpired(db(), FROM + 60_000);
    expect((await row(old)).state).toBe("archived");
    expect(await events(t, "artifact.archived")).toEqual([]);
  });

  it("R-C: a removal whose job is lost is given back by the scan", async () => {
    const t = await team();
    const old = await aged(t, 400, 25);
    value(await save(t, maxLife(90)));
    await runJobs(t);
    value(await save(t, maxLife(null), { now: NOW + DAY }));
    await db().delete(schema.outbox).where(eq(schema.outbox.subject, t.id));
    await enforceWorkspacePolicies(db(), NOW + DAY);
    expect(await row(old)).toMatchObject({ expiresAt: NOW + 25 * DAY, uncappedExpiresAt: null });
  });

  it("R-D: a transfer racing a removal in the target is given back by the scan", async () => {
    const t = await team();
    value(await save(t, maxLife(30)));
    await runJobs(t);
    const LATER = NOW + 10 * DAY;
    const mine = await publishIn(t.editor.id, t.editor.id, LATER - DAY);
    await db()
      .update(schema.artifacts)
      .set({ expiresAt: LATER + 300 * DAY })
      .where(eq(schema.artifacts.id, mine.artifactId));
    const raced = racing(async () => {
      value(await save(t, maxLife(null), { now: LATER }));
      await runJobs(t, LATER);
    });
    value(
      await transferArtifact(raced, env.ARTIFACTS, {
        userId: t.editor.id,
        artifactId: mine.artifactId,
        workspace: t.slug,
        now: LATER,
      }),
    );
    await enforceWorkspacePolicies(db(), LATER + 60_000);
    expect((await row(mine.artifactId)).expiresAt).toBe(LATER + 300 * DAY);
  });

  it("gives back a stale cap in a personal space", async () => {
    const owner = await person("Solo");
    const published = await publishIn(owner.id, owner.id);
    await db()
      .update(schema.artifacts)
      .set({ expiresAt: NOW + 5 * DAY, uncappedExpiresAt: NOW + 30 * DAY })
      .where(eq(schema.artifacts.id, published.artifactId));
    await enforceWorkspacePolicies(db(), NOW);
    expect(await row(published.artifactId)).toMatchObject({
      expiresAt: NOW + 30 * DAY,
      uncappedExpiresAt: null,
    });
  });

  it("leaves the trail of an unpin when a move into a workspace unpins", async () => {
    const t = await team();
    value(await save(t, maxLife(14)));
    await runJobs(t);
    const mine = await publishIn(t.editor.id, t.editor.id);
    await db()
      .update(schema.artifacts)
      .set({ pinned: true, expiresAt: null })
      .where(eq(schema.artifacts.id, mine.artifactId));
    value(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: t.editor.id,
        artifactId: mine.artifactId,
        workspace: t.slug,
        now: NOW,
      }),
    );
    const unpinned = await events(t, "artifact.unpinned");
    expect(unpinned).toHaveLength(1);
    expect(unpinned[0]).toMatchObject({
      actorType: "system",
      detail: { policy: "artifactMaxDays" },
    });
    const trail = await db()
      .select()
      .from(schema.lifecycleEvents)
      .where(
        and(
          eq(schema.lifecycleEvents.artifactId, mine.artifactId),
          eq(schema.lifecycleEvents.event, "unpinned"),
        ),
      );
    expect(trail).toHaveLength(1);
  });
});

describe("the invariant after one maintenance run, for any interleaving (review of PR 214)", () => {
  /**
   * Seeded sequences of saves (with their job run or lost), suspensions, reinstatements, moves
   * out and back in, and renewals, each at a later moment. The model keeps what the policy cannot
   * see: each artifact's plan expiry and life start. Every third sequence ends with a removal
   * whose job is lost, and every third other one also lets the stale cap pass before the run, so
   * both fixes are reached: the sweep (a live stale cap) and the expiry run (a passed one). After
   * one maintenance run with no pending job (the expiry run, then the scan), every active artifact
   * still live must be at `min(plan expiry, current deadline)` (the plan's without a maximum) with
   * the plan's expiry kept exactly when that is earlier; one that is not live must be due by its
   * plan or the current maximum; and none may have been archived by that run while its owner's
   * current policy gives it a later expiry. Counters fail the test if the sequences never reach
   * either kind of stale cap, so it cannot pass by missing them.
   */
  const SEEDS = [7, 2, 99, 1234];
  it.each(SEEDS)("holds for seed %i", async (initial) => {
    let seed = initial;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      // The high bits: an LCG's low bits cycle with a short period.
      return Math.floor(seed / 65536) % n;
    };
    const failures: unknown[] = [];
    const seen = { lost: 0, checked: 0, staleLive: 0, stalePast: 0 };
    for (let sequence = 0; sequence < 9; sequence += 1) {
      const t = await team();
      let now = NOW;
      const model = new Map<string, { plan: number; lifeStart: number }>();
      for (let i = 0; i < 3; i += 1) {
        const ago = [400, 60, 5][i] as number;
        // A plan's expiry far enough out that a stale cap, not the plan, is what would end it.
        const id = await aged(t, ago, 120);
        model.set(id, { plan: NOW + 120 * DAY, lifeStart: NOW - ago * DAY });
      }
      const ids = [...model.keys()];
      const saveAt = async (days: number | null, lose: boolean) => {
        const saved = await save(t, maxLife(days), { now });
        if (saved.ok && !lose) await runJobs(t, now);
        else if (saved.ok) seen.lost += 1;
        await db().delete(schema.outbox).where(eq(schema.outbox.subject, t.id));
      };
      // Every third sequence starts from a maximum in effect, so its caps exist to go stale.
      if (sequence % 3 !== 2) await saveAt([14, 30, 90][rnd(3)] as number, false);
      for (let step = 0; step < 7; step += 1) {
        now += (1 + rnd(4)) * DAY;
        const id = ids[rnd(ids.length)] as string;
        const entry = model.get(id) as { plan: number; lifeStart: number };
        const current = await row(id);
        switch (rnd(6)) {
          case 0:
          case 1:
            await saveAt([null, 14, 30, 90][rnd(4)] as number | null, rnd(3) === 0);
            break;
          case 2:
            if (current.state === "active") {
              await suspendArtifact(db(), { artifactId: id, reason: "spam", now });
            } else if (current.state === "suspended") {
              await reinstateArtifact(db(), { artifactId: id, now });
            }
            break;
          case 3: {
            const out = current.ownerId === t.id;
            const moved = await transferArtifact(db(), env.ARTIFACTS, {
              userId: t.admin.id,
              artifactId: id,
              workspace: out ? null : t.slug,
              now,
            });
            if (moved.ok && moved.value.state === "active") {
              entry.lifeStart = now;
              // A cap the source set is given back on the way out; on the way in the plan's
              // expiry is the one the row held or kept.
              entry.plan = current.uncappedExpiresAt ?? current.expiresAt ?? entry.plan;
            }
            break;
          }
          default: {
            const userId = current.ownerId === t.id ? t.editor.id : t.admin.id;
            const renewed = await renewArtifact(db(), lifecycle(userId, id, now));
            if (renewed.ok) entry.plan = now + 30 * DAY;
          }
        }
      }
      if (sequence % 3 !== 2) {
        // Bring every artifact back under the workspace (reinstated, moved back in), then a
        // maximum the job applies, then removed with its job lost: only the maintenance run can
        // give those caps back.
        now += DAY;
        for (const id of ids) {
          const current = await row(id);
          if (current.state === "suspended") {
            await reinstateArtifact(db(), { artifactId: id, now });
          }
          if (current.ownerId !== t.id) {
            const moved = await transferArtifact(db(), env.ARTIFACTS, {
              userId: t.admin.id,
              artifactId: id,
              workspace: t.slug,
              now,
            });
            const entry = model.get(id) as { plan: number; lifeStart: number };
            if (moved.ok && moved.value.state === "active") {
              entry.lifeStart = now;
              entry.plan = current.uncappedExpiresAt ?? current.expiresAt ?? entry.plan;
            }
          }
        }
        await saveAt(14, false);
        now += DAY;
        await saveAt(null, true);
        if (sequence % 3 === 1) {
          // Let the earliest stale cap pass first: the expiry run reaches it before the scan.
          const capped = (await Promise.all(ids.map(row))).filter(
            (one) =>
              one.state === "active" &&
              one.uncappedExpiresAt !== null &&
              one.expiresAt !== null &&
              one.expiresAt > now,
          );
          const earliest = Math.min(...capped.map((one) => one.expiresAt as number));
          if (Number.isFinite(earliest)) now = earliest + 60_000;
        }
      }
      // What the run will meet, observed just before it.
      const policy = await stored(t);
      const before = new Map<string, Awaited<ReturnType<typeof row>>>();
      for (const id of ids) {
        const found = await row(id);
        before.set(id, found);
        if (found.state !== "active" || found.uncappedExpiresAt === null) continue;
        const ownedMaximum = found.ownerId === t.id && policy.artifactMaxDays !== null;
        if (ownedMaximum) continue;
        if (found.expiresAt !== null && found.expiresAt > now) seen.staleLive += 1;
        else if (found.uncappedExpiresAt > now) seen.stalePast += 1;
      }
      // One maintenance run with nothing pending, in its order: the expiry run, then the scan.
      await archiveExpired(db(), now);
      await enforceWorkspacePolicies(db(), now);
      for (const id of ids) {
        const found = await row(id);
        const entry = model.get(id) as { plan: number; lifeStart: number };
        const owned = found.ownerId === t.id ? policy : undefined;
        const expected = policyExpiry(owned, entry.plan, entry.lifeStart, now);
        if (found.state === "archived" && before.get(id)?.state === "active") {
          // Archived by this run: only by a rule the owner has now.
          if (expected > now) failures.push({ sequence, id, archivedBy: "stale cap", expected });
          continue;
        }
        if (found.state !== "active") continue;
        seen.checked += 1;
        const live = found.expiresAt !== null && found.expiresAt > now;
        if (live) {
          const ok =
            found.expiresAt === expected &&
            found.uncappedExpiresAt === (expected < entry.plan ? entry.plan : null);
          if (!ok) failures.push({ sequence, id, found, expected, plan: entry.plan, policy });
        } else if (expected > now) {
          failures.push({ sequence, id, due: found.expiresAt, expected, policy });
        }
      }
    }
    expect(seen.lost).toBeGreaterThan(3);
    expect(seen.checked).toBeGreaterThan(10);
    // Both fixes are reached, whatever the seed.
    expect(seen.staleLive).toBeGreaterThan(0);
    expect(seen.stalePast).toBeGreaterThan(0);
    expect(failures.slice(0, 3)).toEqual([]);
  });
});

describe("moving out an artifact past its cap (found by the property test)", () => {
  it("keeps the plan's expiry it held, and the expiry run gives it back", async () => {
    const t = await team();
    const old = await aged(t, 400, 25);
    value(await save(t, maxLife(90)));
    await runJobs(t);
    // Past its cap (FROM), not yet archived, then moved to a space with no maximum.
    const at = FROM + DAY;
    value(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: t.admin.id,
        artifactId: old,
        workspace: null,
        now: at,
      }),
    );
    expect(await row(old)).toMatchObject({ expiresAt: FROM, uncappedExpiresAt: NOW + 25 * DAY });
    await archiveExpired(db(), at + 60_000);
    expect(await row(old)).toMatchObject({
      state: "active",
      expiresAt: NOW + 25 * DAY,
      uncappedExpiresAt: null,
    });
  });
});

describe("query plans without table statistics (review of PR 214, third pass)", () => {
  // workerd's D1 has no `sqlite_stat1`, and production D1 cannot be assumed to have it either:
  // the planner must reach the partial index of capped rows from the statements alone.
  async function plan(query: { toSQL(): { sql: string; params: unknown[] } }) {
    const { sql: text, params } = query.toSQL();
    const { results } = await env.DB.prepare(`explain query plan ${text}`)
      .bind(...params)
      .all<{ detail: string }>();
    return results.map((row) => row.detail).join("\n");
  }
  // A selection as the statements embed it: `select ... where id in (<it>)`.
  const raw = (fragment: SQL) =>
    db()
      .select({ id: schema.artifacts.id })
      .from(schema.artifacts)
      .where(sql`${schema.artifacts.id} in (${fragment})`);

  it("the sweep reads only capped rows, in both layouts", async () => {
    for (const shared of [true, false]) {
      const found = await plan(staleCapOwners(db(), NOW, ["ws_a"], shared));
      expect(found, String(shared)).toContain(
        "SEARCH artifacts USING INDEX artifacts_capped_owner_idx (owner_id>?)",
      );
      expect(found, String(shared)).not.toContain("artifacts_state_purge_idx");
      expect(found, String(shared)).not.toContain("TEMP B-TREE FOR DISTINCT");
    }
  });

  it("the give-back reads one owner's capped rows, the cap one owner's active rows", async () => {
    const policy = maxLife(30);
    for (const owned of [undefined, { ...policy, artifactMaxDaysFrom: NOW }]) {
      expect(await plan(raw(giveBackIds("ws_a", owned, NOW, 50)))).toContain(
        "SEARCH artifacts USING INDEX artifacts_capped_owner_idx (owner_id=?)",
      );
    }
    expect(await plan(raw(overMaxLifeIds("ws_a", { days: 30, from: NOW }, NOW, 50)))).toContain(
      "SEARCH artifacts USING INDEX artifacts_owner_state_idx (owner_id=? AND state=?)",
    );
  });
});

describe("the sweep's bounds (review of PR 214, third pass)", () => {
  /** Active artifacts of `ownerId` with a stale cap, written directly (no publish limits). */
  async function staleIn(ownerId: string, count: number) {
    const ids = Array.from({ length: count }, () => hex().slice(0, 10));
    await db()
      .insert(schema.accountUsage)
      .values({ ownerId, activeLimit: 1_000, monthStartedAt: NOW, updatedAt: NOW })
      .onConflictDoUpdate({ target: schema.accountUsage.ownerId, set: { activeLimit: 1_000 } });
    // Five rows a statement: well under D1's 100 bound parameters.
    for (let i = 0; i < ids.length; i += 5) {
      await db()
        .insert(schema.artifacts)
        .values(
          ids.slice(i, i + 5).map((id) => ({
            id,
            ownerId,
            type: "site" as const,
            name: "Stale",
            state: "active" as const,
            expiresAt: NOW + 3 * DAY,
            uncappedExpiresAt: NOW + 20 * DAY,
          })),
        );
    }
    return ids;
  }

  it("never holds the owners after a large one back, and finishes the large one on later passes", async () => {
    // A large owner first by ID, then small ones after it: owners with no policy.
    const run = hex().slice(0, 8);
    const large = await staleIn(`u_${run}_0`, 60);
    const smalls: string[] = [];
    for (let i = 1; i <= 3; i += 1) smalls.push(...(await staleIn(`u_${run}_${i}`, 2)));
    await enforceWorkspacePolicies(db(), NOW);
    // One run: the large owner got one batch, and every small owner after it its time back.
    for (const id of smalls) expect((await row(id)).expiresAt, id).toBe(NOW + 20 * DAY);
    const done = async () =>
      (await Promise.all(large.map(row))).filter((one) => one.expiresAt === NOW + 20 * DAY).length;
    expect(await done()).toBe(WORKSPACE_POLICIES.enforceBatch);
    // The next pass finishes it.
    for (let run = 0; run < 3 && (await done()) < large.length; run += 1) {
      await enforceWorkspacePolicies(db(), NOW);
    }
    expect(await done()).toBe(large.length);
  });
});
