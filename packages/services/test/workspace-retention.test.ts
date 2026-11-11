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
import { POLICY_MESSAGES, policyOf } from "@portifact/domain";
import { and, eq } from "drizzle-orm";
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
import { runJob } from "../src/outbox.ts";
import { commitPublish, preparePublish } from "../src/publish.ts";
import { type RetentionNotifier, sendRetentionNotice } from "../src/retention-notices.ts";
import { createServiceToken } from "../src/service-tokens.ts";
import { rollbackArtifact } from "../src/versions.ts";
import {
  applyWorkspacePolicies,
  enforceWorkspacePolicies,
  enforceWorkspacePolicy,
  exportWorkspacePolicies,
  getWorkspacePolicy,
  previewWorkspacePolicy,
  setWorkspacePolicy,
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
    expect((await row(old)).restoredAt).toBe(FROM + DAY);
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
    // Never earlier than it was, at most what a renewal gives.
    expect((await row(old)).expiresAt).toBe(NOW + DAY + 30 * DAY);
    expect((await row(mid)).expiresAt).toBe(NOW + DAY + 30 * DAY);
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
    expect((await row(old)).expiresAt).toBe(NOW + DAY + 30 * DAY);
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
    value(await save(t, maxLife(14)));
    value(await save(t, maxLife(60)));
    const [later] = (await jobs("retention_notice", t.id)).slice(-1);
    if (!later) throw new Error("no notice job");
    expect(await sendRetentionNotice(db(), later, NOW, notifier())).toBe("stale");
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
