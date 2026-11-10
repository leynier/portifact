// Analytics per artifact (premium plan P8, decision 0007): the view counters delivery writes in
// batches, the owner side's read, retention by plan through each row's expiry, the prune and the
// erasure that purges write.
import { env } from "cloudflare:test";
import { planRequiredMessage } from "@portifact/contracts";
import { accessSchema, createAccessDb, schema } from "@portifact/db";
import { and, asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { eraseAccessEvents, pruneAccessEvents, recordOpenings } from "../src/access-log.ts";
import {
  ANALYTICS_ROW_BATCH,
  applyOwnerRetention,
  getArtifactStats,
  recordViews,
  type ViewDelta,
} from "../src/analytics.ts";
import { deleteArtifact } from "../src/lifecycle.ts";
import { runJob } from "../src/outbox.ts";
import { applyOwnerPlans, removeOwnerPlan, setOwnerPlan } from "../src/plans.ts";
import { commitPublish, preparePublish } from "../src/publish.ts";
import { DAY, db, grantPlan, MINUTE, NOW, publishSite, sha256, user, value } from "./fixtures.ts";

const access = () => createAccessDb(env.ACCESS_DB);
const TODAY = NOW - (NOW % DAY);
const date = (day: number) => new Date(day).toISOString().slice(0, 10);

const viewsOf = (artifactId: string) =>
  access()
    .select()
    .from(accessSchema.artifactViews)
    .where(eq(accessSchema.artifactViews.artifactId, artifactId))
    .orderBy(asc(accessSchema.artifactViews.day));

const openingsOf = (artifactId: string) =>
  access()
    .select()
    .from(accessSchema.accessEvents)
    .where(eq(accessSchema.accessEvents.artifactId, artifactId))
    .orderBy(asc(accessSchema.accessEvents.openedAt));

function delta(artifactId: string, ownerId: string, overrides: Partial<ViewDelta> = {}): ViewDelta {
  return {
    artifactId,
    ownerId,
    day: TODAY,
    anonymous: 1,
    signedIn: {},
    expiresAt: TODAY + 366 * DAY,
    ...overrides,
  };
}

const stats = (userId: string, artifactId: string, extra: object = {}) =>
  getArtifactStats(db(), access(), { userId, artifactId, now: NOW, ...extra });

async function setAccessMode(artifactId: string, accessMode: "public" | "authenticated") {
  await db()
    .update(schema.artifacts)
    .set({ accessMode })
    .where(eq(schema.artifacts.id, artifactId));
}

/** A workspace with an admin, an editor and a member, and an artifact the editor published. */
async function team() {
  const id = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
  const [admin, editor, member, outsider] = [
    await user(),
    await user(),
    await user(),
    await user(),
  ];
  await db()
    .insert(schema.workspaces)
    .values({ id, slug: id.slice(3, 23), name: "Team", createdBy: admin.id, updatedAt: NOW });
  await db()
    .insert(schema.workspaceMembers)
    .values([
      { workspaceId: id, userId: admin.id, role: "admin", updatedAt: NOW },
      { workspaceId: id, userId: editor.id, role: "editor", updatedAt: NOW },
      { workspaceId: id, userId: member.id, role: "member", updatedAt: NOW },
    ]);
  const body = `<p>${crypto.randomUUID()}</p>`;
  const prepared = value(
    await preparePublish(db(), {
      userId: editor.id,
      targetOwnerId: id,
      type: "site",
      name: "Plan",
      entrypoint: "index.html",
      baseVersionId: null,
      files: [
        {
          path: "index.html",
          kind: "published",
          sha256: await sha256(body),
          size: body.length,
          contentType: "text/html",
        },
      ],
      now: NOW,
    }),
  );
  await env.ARTIFACTS.put(`objects/${id}/${await sha256(body)}`, body);
  const { artifactId } = value(
    await commitPublish(db(), env.ARTIFACTS, {
      userId: editor.id,
      sessionId: prepared.sessionId,
      now: NOW,
    }),
  );
  return { id, admin, editor, member, outsider, artifactId };
}

describe("recording views", () => {
  it("adds batches up per artifact and day, from concurrent isolates exactly", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    // Eight isolates flush at once, each with views of today and yesterday.
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        recordViews(db().global, access(), [
          delta(artifactId, owner.id, { anonymous: 10 + i, signedIn: { [`u_${i}`]: 2 } }),
          delta(artifactId, owner.id, { day: TODAY - DAY, anonymous: 1 }),
        ]),
      ),
    );
    const rows = await viewsOf(artifactId);
    expect(rows.map((row) => [row.day, row.views, row.signedInViews])).toEqual([
      [TODAY - DAY, 8, 0],
      [TODAY, 8 * 10 + 28 + 16, 16],
    ]);
    // A retried batch adds again, and the first expiry stays.
    await recordViews(db().global, access(), [
      delta(artifactId, owner.id, { day: TODAY - DAY, expiresAt: 1 }),
    ]);
    const [yesterday] = await viewsOf(artifactId);
    expect(yesterday).toMatchObject({ views: 9, expiresAt: TODAY + 366 * DAY, ownerId: owner.id });
  });

  it("drops the views of the owner side and writes nothing for a delta without views", async () => {
    const t = await team();
    const written = await recordViews(db().global, access(), [
      delta(t.artifactId, t.id, {
        anonymous: 0,
        signedIn: { [t.admin.id]: 3, [t.editor.id]: 2, [t.member.id]: 1, [t.outsider.id]: 4 },
      }),
      delta(t.artifactId, t.id, { day: TODAY - DAY, anonymous: 0, signedIn: { [t.admin.id]: 1 } }),
    ]);
    expect(written).toBe(1);
    expect((await viewsOf(t.artifactId)).map((row) => [row.views, row.signedInViews])).toEqual([
      [5, 5],
    ]);
    // In a personal space the owner's own views are dropped too.
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    expect(
      await recordViews(db().global, access(), [
        delta(artifactId, owner.id, { anonymous: 0, signedIn: { [owner.id]: 4 } }),
      ]),
    ).toBe(0);
    expect(await viewsOf(artifactId)).toEqual([]);
  });

  it("writes in chunks of at most 200 statements", async () => {
    const owner = await user();
    const deltas = Array.from({ length: 201 }, (_, i) =>
      delta(`chunk${String(i).padStart(5, "0")}`, owner.id),
    );
    let batches = 0;
    const counting = new Proxy(access(), {
      get(target, property, receiver) {
        if (property === "batch") batches += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(await recordViews(db().global, counting, deltas)).toBe(201);
    expect(batches).toBe(2);
  });

  it("refuses more signed-in views than views in the database", async () => {
    await expect(
      env.ACCESS_DB.prepare(
        "insert into artifact_views (artifact_id, day, owner_id, views, signed_in_views, expires_at) values ('checkcheck', 0, 'o', 1, 2, 0)",
      ).run(),
    ).rejects.toThrow(/CHECK/);
  });
});

describe("reading an artifact's analytics", () => {
  it("returns every day of the range, zeros included, with distinct visitors for restricted", async () => {
    const owner = await user();
    const [a, b] = [await user(), await user()];
    const { artifactId } = await publishSite(owner.id);
    await grantPlan(owner.id, "pro");
    await recordViews(db().global, access(), [
      delta(artifactId, owner.id, { anonymous: 3, signedIn: { [a.id]: 2 } }),
      delta(artifactId, owner.id, { day: TODAY - 2 * DAY, anonymous: 4 }),
      // Before the range asked for.
      delta(artifactId, owner.id, { day: TODAY - 3 * DAY, anonymous: 7 }),
    ]);
    await recordOpenings(db(), access(), [
      { artifactId, userId: a.id, at: NOW - MINUTE },
      { artifactId, userId: b.id, at: NOW - MINUTE },
      { artifactId, userId: a.id, at: NOW - 2 * DAY },
      { artifactId, userId: a.id, at: NOW - 2 * DAY + 60 * MINUTE },
    ]);
    const result = await stats(owner.id, artifactId, { from: date(TODAY - 2 * DAY) });
    expect(result).toEqual({
      ok: true,
      value: {
        artifactId,
        from: date(TODAY - 2 * DAY),
        to: date(TODAY),
        days: [
          { date: date(TODAY - 2 * DAY), views: 4, signedInViews: 0, visitors: 1 },
          { date: date(TODAY - DAY), views: 0, signedInViews: 0, visitors: 0 },
          { date: date(TODAY), views: 5, signedInViews: 2, visitors: 2 },
        ],
        totals: { views: 9, signedInViews: 2, visitors: 2 },
        retentionDays: 365,
      },
    });
    // The default is the last 30 days, today included.
    const recent = value(await stats(owner.id, artifactId));
    expect(recent.days).toHaveLength(30);
    expect(recent.from).toBe(date(TODAY - 29 * DAY));
    expect(recent.totals.views).toBe(16);
  });

  it("shows no visitors for public and authenticated artifacts, even with old openings", async () => {
    const owner = await user();
    const reader = await user();
    const { artifactId } = await publishSite(owner.id);
    await grantPlan(owner.id, "pro");
    await recordOpenings(db(), access(), [{ artifactId, userId: reader.id, at: NOW }]);
    await recordViews(db().global, access(), [delta(artifactId, owner.id)]);
    for (const mode of ["public", "authenticated"] as const) {
      await setAccessMode(artifactId, mode);
      const read = value(await stats(owner.id, artifactId));
      expect(read.totals).toEqual({ views: 1, signedInViews: 0, visitors: null });
      expect(read.days.every((day) => day.visitors === null)).toBe(true);
    }
  });

  it("never shows rows past their expiry, even before the prune", async () => {
    const owner = await user();
    const reader = await user();
    const { artifactId } = await publishSite(owner.id);
    await grantPlan(owner.id, "pro");
    await recordViews(db().global, access(), [delta(artifactId, owner.id, { expiresAt: NOW - 1 })]);
    await access()
      .insert(accessSchema.accessEvents)
      .values({
        artifactId,
        windowStart: NOW - (NOW % (30 * MINUTE)),
        userId: reader.id,
        ownerId: owner.id,
        email: reader.email,
        openedAt: NOW,
        expiresAt: NOW - 1,
      });
    expect(value(await stats(owner.id, artifactId)).totals).toEqual({
      views: 0,
      signedInViews: 0,
      visitors: 0,
    });
  });

  it("answers anyone but the owner, a missing and a purging artifact like a missing one", async () => {
    const owner = await user();
    const stranger = await user();
    const { artifactId } = await publishSite(owner.id);
    await grantPlan(owner.id, "pro");
    await grantPlan(stranger.id, "pro");
    const missing = { ok: false, code: "not_found", message: "Artifact not found." };
    expect(await stats(stranger.id, artifactId)).toEqual(missing);
    expect(await stats(owner.id, "zzzzzzzzzz")).toEqual(missing);
    await db()
      .update(schema.artifacts)
      .set({ state: "purging" })
      .where(eq(schema.artifacts.id, artifactId));
    expect(await stats(owner.id, artifactId)).toEqual(missing);
    await db()
      .update(schema.artifacts)
      .set({ state: "deleted" })
      .where(eq(schema.artifacts.id, artifactId));
    expect(await stats(owner.id, artifactId)).toEqual(missing);
  });

  it("is refused on free with plan_required, after authorization", async () => {
    const owner = await user();
    const stranger = await user();
    const { artifactId } = await publishSite(owner.id);
    expect(await stats(owner.id, artifactId)).toEqual({
      ok: false,
      code: "plan_required",
      message: planRequiredMessage("analytics"),
    });
    // A stranger still learns nothing, not even that the owner is on free.
    expect(await stats(stranger.id, artifactId)).toMatchObject({ code: "not_found" });
    await grantPlan(owner.id, "pro", { validUntil: NOW });
    expect(await stats(owner.id, artifactId)).toMatchObject({ code: "plan_required" });
    await grantPlan(owner.id, "pro");
    expect((await stats(owner.id, artifactId)).ok).toBe(true);
  });

  it("follows the workspace's plan and the caller's role", async () => {
    const t = await team();
    await grantPlan(t.editor.id, "pro");
    expect(await stats(t.editor.id, t.artifactId)).toMatchObject({ code: "plan_required" });
    await grantPlan(t.id, "team");
    expect((await stats(t.admin.id, t.artifactId)).ok).toBe(true);
    expect((await stats(t.editor.id, t.artifactId)).ok).toBe(true);
    expect(await stats(t.member.id, t.artifactId)).toMatchObject({ code: "forbidden" });
    expect(await stats(t.outsider.id, t.artifactId)).toEqual(
      await stats(t.outsider.id, "zzzzzzzzzz"),
    );
  });

  it("clamps the range to today and to what the plan keeps, and refuses bad ranges", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    await grantPlan(owner.id, "pro");
    const old = value(
      await stats(owner.id, artifactId, { from: date(TODAY - 366 * DAY), to: date(TODAY - DAY) }),
    );
    expect([old.from, old.to, old.days.length]).toEqual([
      date(TODAY - 365 * DAY),
      date(TODAY - DAY),
      365,
    ]);
    const ahead = value(
      await stats(owner.id, artifactId, { from: date(TODAY - DAY), to: date(TODAY + 5 * DAY) }),
    );
    expect([ahead.from, ahead.to]).toEqual([date(TODAY - DAY), date(TODAY)]);
    await grantPlan(owner.id, "free");
    await grantPlan(owner.id, "pro", { overrides: { limits: { accessLogRetentionDays: 7 } } });
    const short = value(await stats(owner.id, artifactId));
    expect([short.from, short.days.length, short.retentionDays]).toEqual([
      date(TODAY - 7 * DAY),
      8,
      7,
    ]);
    for (const [from, to, message] of [
      [date(TODAY), date(TODAY - DAY), "The range ends before it starts."],
      [date(TODAY - 366 * DAY), date(TODAY), "The range is longer than 366 days."],
      [
        date(TODAY + DAY),
        date(TODAY + 2 * DAY),
        "The range has no day in the last 7 days your plan keeps.",
      ],
    ] as const) {
      expect(await stats(owner.id, artifactId, { from, to })).toEqual({
        ok: false,
        code: "invalid_input",
        message,
      });
    }
  });
});

describe("retention by plan", () => {
  it("keeps openings a year on a paid plan and 30 days on free", async () => {
    const paid = await user();
    const free = await user();
    const reader = await user();
    const { artifactId: paidArtifact } = await publishSite(paid.id);
    const { artifactId: freeArtifact } = await publishSite(free.id);
    await grantPlan(paid.id, "pro");
    await recordOpenings(db(), access(), [
      { artifactId: paidArtifact, userId: reader.id, at: NOW },
      { artifactId: freeArtifact, userId: reader.id, at: NOW },
    ]);
    expect((await openingsOf(paidArtifact))[0]?.expiresAt).toBe(NOW + 365 * DAY);
    expect((await openingsOf(freeArtifact))[0]?.expiresAt).toBe(NOW + 30 * DAY);
  });

  it("never keeps past a plan's end more than the free plan would", async () => {
    const owner = await user();
    const reader = await user();
    const { artifactId } = await publishSite(owner.id);
    await grantPlan(owner.id, "pro", { validUntil: NOW + 90 * DAY });
    await recordOpenings(db(), access(), [{ artifactId, userId: reader.id, at: NOW }]);
    expect((await openingsOf(artifactId))[0]?.expiresAt).toBe(NOW + 90 * DAY);
  });

  it("a downgrade shortens what is kept and the prune deletes it; an upgrade extends the rest", async () => {
    const owner = await user();
    const reader = await user();
    const { artifactId } = await publishSite(owner.id);
    value(
      await setOwnerPlan(db(), {
        ownerId: owner.id,
        plan: "pro",
        seats: 1,
        validUntil: null,
        overrides: null,
        grantedBy: "op",
        note: null,
        now: NOW - 200 * DAY,
      }),
    );
    await recordOpenings(db(), access(), [
      { artifactId, userId: reader.id, at: NOW - 100 * DAY },
      { artifactId, userId: reader.id, at: NOW - 10 * DAY },
    ]);
    await recordViews(db().global, access(), [
      delta(artifactId, owner.id, { day: TODAY - 100 * DAY, expiresAt: TODAY + 266 * DAY }),
      delta(artifactId, owner.id, { day: TODAY - 10 * DAY, expiresAt: TODAY + 356 * DAY }),
    ]);

    value(await removeOwnerPlan(db(), { ownerId: owner.id, now: NOW }));
    const jobs = await retentionJobs(owner.id);
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    // Nothing is deleted on the spot: the job moves the expiries and the normal prune deletes.
    expect(await openingsOf(artifactId)).toHaveLength(2);
    for (const job of jobs) {
      expect(
        await runJob(db(), env.ARTIFACTS, { id: job.id, topic: "owner_retention" }, NOW, {
          access: access(),
        }),
      ).toBe("done");
    }
    expect((await openingsOf(artifactId)).map((row) => row.expiresAt)).toEqual([
      NOW - 70 * DAY,
      NOW + 20 * DAY,
    ]);
    expect((await viewsOf(artifactId)).map((row) => row.expiresAt)).toEqual([
      TODAY - 69 * DAY,
      TODAY + 21 * DAY,
    ]);
    await pruneAccessEvents(access(), NOW);
    expect((await openingsOf(artifactId)).map((row) => row.openedAt)).toEqual([NOW - 10 * DAY]);
    expect((await viewsOf(artifactId)).map((row) => row.day)).toEqual([TODAY - 10 * DAY]);

    await grantPlan(owner.id, "pro");
    expect(await applyOwnerRetention(db(), access(), owner.id, NOW)).toBe("done");
    expect((await openingsOf(artifactId))[0]?.expiresAt).toBe(NOW + 355 * DAY);
    expect((await viewsOf(artifactId))[0]?.expiresAt).toBe(TODAY + 356 * DAY);
    // Running it again changes nothing.
    expect(await applyOwnerRetention(db(), access(), owner.id, NOW)).toBe("done");
  });

  it("caps moved expiries at a plan's end, never under the free retention", async () => {
    const owner = await user();
    const reader = await user();
    const { artifactId } = await publishSite(owner.id);
    await recordOpenings(db(), access(), [
      { artifactId, userId: reader.id, at: NOW - 100 * DAY },
      { artifactId, userId: reader.id, at: NOW - 10 * DAY },
    ]);
    await recordViews(db().global, access(), [
      delta(artifactId, owner.id, { day: TODAY - 10 * DAY, expiresAt: TODAY + 21 * DAY }),
    ]);
    await grantPlan(owner.id, "pro", { validUntil: NOW + 90 * DAY });
    expect(await applyOwnerRetention(db(), access(), owner.id, NOW)).toBe("done");
    expect((await openingsOf(artifactId)).map((row) => row.expiresAt)).toEqual([
      NOW + 90 * DAY,
      NOW + 90 * DAY,
    ]);
    expect((await viewsOf(artifactId))[0]?.expiresAt).toBe(NOW + 90 * DAY);
    // A plan ending soon still keeps the free 30 days from each row's start.
    await grantPlan(owner.id, "pro", { validUntil: NOW + DAY });
    expect(await applyOwnerRetention(db(), access(), owner.id, NOW)).toBe("done");
    expect((await openingsOf(artifactId)).map((row) => row.expiresAt)).toEqual([
      NOW + DAY,
      NOW + 20 * DAY,
    ]);
    expect((await viewsOf(artifactId))[0]?.expiresAt).toBe(TODAY + 21 * DAY);
  });

  it("works in bounded statements, leaves other owners alone and resumes", async () => {
    const owner = await user();
    const other = await user();
    const rows = (ownerId: string, prefix: string, count: number) =>
      env.ACCESS_DB.prepare(
        `with recursive n(i) as (select 1 union all select i + 1 from n where i < ?)
         insert into artifact_views (artifact_id, day, owner_id, views, signed_in_views, expires_at)
         select ? || i, ?, ?, 1, 0, ? from n`,
      )
        .bind(count, prefix, TODAY, ownerId, TODAY + 366 * DAY)
        .run();
    await rows(owner.id, "bnd", ANALYTICS_ROW_BATCH + 1);
    await rows(other.id, "oth", 1);
    expect(await applyOwnerRetention(db(), access(), owner.id, NOW, 1)).toBe("pending");
    expect(await applyOwnerRetention(db(), access(), owner.id, NOW, 1)).toBe("done");
    const [kept] = await access()
      .select()
      .from(accessSchema.artifactViews)
      .where(eq(accessSchema.artifactViews.ownerId, other.id));
    expect(kept?.expiresAt).toBe(TODAY + 366 * DAY);
    const shortened = await access()
      .select()
      .from(accessSchema.artifactViews)
      .where(
        and(
          eq(accessSchema.artifactViews.ownerId, owner.id),
          eq(accessSchema.artifactViews.expiresAt, TODAY + 31 * DAY),
        ),
      );
    expect(shortened).toHaveLength(ANALYTICS_ROW_BATCH + 1);
  });

  it("grants after a restore write the retention jobs again (apply-plans)", async () => {
    const owner = await user();
    const before = (await retentionJobs(owner.id)).length;
    const applied = await applyOwnerPlans(
      db(),
      [
        {
          ownerId: owner.id,
          plan: "pro",
          seats: 1,
          validUntil: null,
          overrides: null,
          grantedBy: "op",
          note: null,
        },
      ],
      NOW,
    );
    expect(applied).toMatchObject({ applied: 1 });
    expect((await retentionJobs(owner.id)).length).toBe(before + 1);
  });

  it("prunes view rows past their expiry in bounded statements", async () => {
    const owner = await user();
    await env.ACCESS_DB.prepare(
      `with recursive n(i) as (select 1 union all select i + 1 from n where i < ?)
       insert into artifact_views (artifact_id, day, owner_id, views, signed_in_views, expires_at)
       select 'prn' || i, ?, ?, 1, 0, ? from n`,
    )
      .bind(ANALYTICS_ROW_BATCH + 1, TODAY, owner.id, NOW - 1)
      .run();
    await recordViews(db().global, access(), [delta("prnkeep000", owner.id, { expiresAt: NOW })]);
    expect(await pruneAccessEvents(access(), NOW, 1)).toBeGreaterThanOrEqual(ANALYTICS_ROW_BATCH);
    await pruneAccessEvents(access(), NOW);
    const left = await access()
      .select({ id: accessSchema.artifactViews.artifactId })
      .from(accessSchema.artifactViews)
      .where(eq(accessSchema.artifactViews.ownerId, owner.id));
    expect(left).toEqual([{ id: "prnkeep000" }]);
  });
});

describe("erasure", () => {
  it("purging an artifact erases its view counters through the erase job", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    const { artifactId: other } = await publishSite(owner.id);
    await recordViews(db().global, access(), [delta(artifactId, owner.id), delta(other, owner.id)]);
    await deleteArtifact(db(), env.ARTIFACTS, { userId: owner.id, artifactId, now: NOW });
    const [job] = await db()
      .select()
      .from(schema.outbox)
      .where(
        and(eq(schema.outbox.topic, "erase_access_events"), eq(schema.outbox.subject, artifactId)),
      );
    expect(
      await runJob(db(), env.ARTIFACTS, { id: job?.id ?? 0, topic: "erase_access_events" }, NOW, {
        access: access(),
      }),
    ).toBe("done");
    expect(await viewsOf(artifactId)).toEqual([]);
    expect(await viewsOf(other)).toHaveLength(1);
  });

  it("erases long series in bounded rounds and a user's erasure leaves counters alone", async () => {
    const owner = await user();
    await env.ACCESS_DB.prepare(
      `with recursive n(i) as (select 1 union all select i + 1 from n where i < ?)
       insert into artifact_views (artifact_id, day, owner_id, views, signed_in_views, expires_at)
       select 'eraselong0', i, ?, 1, 0, ? from n`,
    )
      .bind(ANALYTICS_ROW_BATCH + 1, owner.id, NOW + DAY)
      .run();
    expect(await eraseAccessEvents(access(), "user", owner.id)).toBe("done");
    expect(await viewsOf("eraselong0")).toHaveLength(ANALYTICS_ROW_BATCH + 1);
    expect(await eraseAccessEvents(access(), "artifact", "eraselong0", 1)).toBe("pending");
    expect(await eraseAccessEvents(access(), "artifact", "eraselong0", 1)).toBe("done");
    expect(await viewsOf("eraselong0")).toEqual([]);
  });
});

async function retentionJobs(ownerId: string) {
  return db()
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.topic, "owner_retention"), eq(schema.outbox.subject, ownerId)));
}
