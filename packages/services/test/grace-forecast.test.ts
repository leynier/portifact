// What a running plan grace will let go (decision 0022, second delivery): per kind, counts and the
// first date, for the space's "Download your data" page and `portifact export --dry-run`.
import { env } from "cloudflare:test";
import { GRACE_FORECAST_LIMITS, PLAN_GRACE_DAYS } from "@portifact/contracts";
import { accessSchema, createAccessDb, schema } from "@portifact/db";
import { type Actor, personalActor } from "@portifact/domain";
import { count, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { pruneAccessEvents, recordOpenings } from "../src/access-log.ts";
import { applyOwnerRetention } from "../src/analytics.ts";
import { getGraceForecast } from "../src/grace-forecast.ts";
import { pruneVersions } from "../src/maintenance.ts";
import { removeOwnerPlan, setOwnerPlan } from "../src/plans.ts";
import { DAY, db, NOW, publishSite, user, value } from "./fixtures.ts";
import { versions } from "./version-support.ts";

const GRACE = PLAN_GRACE_DAYS * DAY;
const access = () => createAccessDb(env.ACCESS_DB);
const forecast = (actor: Actor, now = NOW) => getGraceForecast(db(), access(), { actor, now });

function grant(ownerId: string, plan: "free" | "pro", now: number) {
  return setOwnerPlan(db(), {
    ownerId,
    plan,
    seats: 1,
    validUntil: null,
    overrides: null,
    grantedBy: "operator",
    note: null,
    now,
  });
}

describe("the grace forecast", () => {
  it("is empty without a grace", async () => {
    const owner = await user();
    const result = value(await forecast(personalActor(owner.id)));
    expect(result.owner.grace ?? null).toBeNull();
    expect(result.kinds).toEqual([]);
  });

  it("counts what a removed Pro plan lets go, per kind, from the hold's end", async () => {
    const owner = await user("Pro");
    const reader = await user("Reader");
    value(await grant(owner.id, "pro", NOW - 2 * DAY));
    // Six versions an hour apart: Pro keeps them all; free keeps two for seven days.
    await versions(owner.id, 6, { now: NOW - DAY });
    const pinned = await publishSite(owner.id);
    await db()
      .update(schema.artifacts)
      .set({ pinned: true, expiresAt: null })
      .where(eq(schema.artifacts.id, pinned.artifactId));
    await recordOpenings(db(), access(), [
      { artifactId: pinned.artifactId, userId: reader.id, at: NOW - 40 * DAY },
    ]);
    await access()
      .insert(accessSchema.artifactViews)
      .values({
        artifactId: pinned.artifactId,
        day: NOW - 40 * DAY,
        ownerId: owner.id,
        views: 3,
        signedInViews: 0,
        expiresAt: NOW + 400 * DAY,
      });
    value(await removeOwnerPlan(db(), { ownerId: owner.id, now: NOW }));
    // The access log job dates rows to the grace's end.
    await applyOwnerRetention(db(), access(), owner.id, NOW);

    const result = value(await forecast(personalActor(owner.id)));
    const end = new Date(NOW + GRACE).getTime();
    expect(result.owner.grace?.until).toBe(end);
    const byKind = Object.fromEntries(result.kinds.map((k) => [k.kind, k]));
    // Five previous versions are retained; free keeps none of them sixty days from now.
    expect(byKind.versions).toEqual({ kind: "versions", count: 5, from: end });
    expect(byKind.accessLog).toEqual({ kind: "accessLog", count: 1, from: end });
    expect(byKind.analytics).toEqual({ kind: "analytics", count: 1, from: end });
    expect(byKind.pins).toEqual({ kind: "pins", count: 1, from: end });
    // Audit retention is 90 days on every plan: nothing to let go.
    expect(byKind.auditEvents).toBeUndefined();
    // After the grace, nothing is forecast.
    expect(value(await forecast(personalActor(owner.id), NOW + GRACE)).kinds).toEqual([]);
  });

  it("is read by a workspace's admins, editors and service tokens, never by members or outsiders", async () => {
    const admin = await user("Admin");
    const id = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
    await db()
      .global.insert(schema.workspaces)
      .values({ id, slug: id.slice(3, 23), name: "Team", createdBy: admin.id, updatedAt: NOW });
    const base = { userId: admin.id, ownerId: id, region: "default" as const };
    for (const role of ["admin", "editor"] as const) {
      expect((await forecast({ ...base, role })).ok).toBe(true);
    }
    expect(await forecast({ ...base, role: "member" })).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    const token: Actor = {
      ...base,
      userId: `st_${"0".repeat(32)}`,
      role: "editor",
      token: {
        scopes: ["artifacts:read"],
        restriction: { kind: "none" },
        createdAt: NOW,
        label: "CI",
      },
    };
    expect((await forecast(token)).ok).toBe(true);
  });

  it("counts exactly what the scans delete when the clock passes the grace's end", async () => {
    const owner = await user("Pro");
    const reader = await user("Reader");
    value(await grant(owner.id, "pro", NOW - 100 * DAY));
    await versions(owner.id, 6, { now: NOW - 50 * DAY });
    await versions(owner.id, 4, { now: NOW - 2 * DAY });
    const site = await publishSite(owner.id);
    await recordOpenings(db(), access(), [
      { artifactId: site.artifactId, userId: reader.id, at: NOW - 40 * DAY },
      { artifactId: site.artifactId, userId: reader.id, at: NOW - 200 * DAY },
    ]);
    value(await removeOwnerPlan(db(), { ownerId: owner.id, now: NOW }));
    await applyOwnerRetention(db(), access(), owner.id, NOW);
    const byKind = Object.fromEntries(
      value(await forecast(personalActor(owner.id))).kinds.map((k) => [k.kind, k.count]),
    );
    const countVersions = async () => {
      const [row] = await db()
        .select({ n: count() })
        .from(schema.versions)
        .innerJoin(schema.artifacts, eq(schema.artifacts.id, schema.versions.artifactId))
        .where(eq(schema.artifacts.ownerId, owner.id));
      return Number(row?.n ?? 0);
    };
    const countOpenings = async () => {
      const e = accessSchema.accessEvents;
      const [row] = await access().select({ n: count() }).from(e).where(eq(e.ownerId, owner.id));
      return Number(row?.n ?? 0);
    };
    // What goes on its own before the step (the held plan's own retention) is not the step's.
    const end = NOW + GRACE;
    for (let i = 0; i < 5; i += 1) await pruneVersions(db(), env.ARTIFACTS, end - 1);
    await pruneAccessEvents(access(), end - 1);
    const versionsBefore = await countVersions();
    const openingsBefore = await countOpenings();
    const at = end + 1;
    for (let i = 0; i < 5; i += 1) await pruneVersions(db(), env.ARTIFACTS, at);
    await pruneAccessEvents(access(), at);
    expect(byKind.versions).toBe(versionsBefore - (await countVersions()));
    expect(byKind.accessLog ?? 0).toBe(openingsBefore - (await countOpenings()));
  });

  it("forecasts nothing for an unreadable grace, which deletes nothing", async () => {
    const owner = await user("Pro");
    value(await grant(owner.id, "pro", NOW - 100 * DAY));
    await versions(owner.id, 6, { now: NOW - 50 * DAY });
    value(await removeOwnerPlan(db(), { ownerId: owner.id, now: NOW }));
    await db()
      .global.update(schema.ownerPlans)
      .set({ grace: "{not json" })
      .where(eq(schema.ownerPlans.ownerId, owner.id));
    const result = value(await forecast(personalActor(owner.id)));
    expect(result.owner.grace?.unreadable).toBe(true);
    expect(result.kinds).toEqual([]);
  });

  it("is rate limited per person, after authorization", async () => {
    const owner = await user();
    for (let i = 0; i < GRACE_FORECAST_LIMITS.perActorPerMinute; i += 1) {
      expect((await forecast(personalActor(owner.id))).ok).toBe(true);
    }
    expect(await forecast(personalActor(owner.id))).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
    // Another person is not affected, and a minute later it answers again.
    expect((await forecast(personalActor((await user()).id))).ok).toBe(true);
    expect((await forecast(personalActor(owner.id), NOW + 61_000)).ok).toBe(true);
    // Someone with no role is refused before anything is counted.
    const stranger = await user();
    const outside = { ...personalActor(stranger.id), role: "member" as const };
    for (let i = 0; i < GRACE_FORECAST_LIMITS.perActorPerMinute + 1; i += 1) {
      expect(await forecast(outside)).toMatchObject({ code: "forbidden" });
    }
  });
});
