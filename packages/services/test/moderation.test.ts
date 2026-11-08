import { env } from "cloudflare:test";
import { schema } from "@portifact/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { archiveArtifact, deleteArtifact, restoreArtifact } from "../src/lifecycle.ts";
import {
  accountSuspension,
  listAbuseReports,
  reinstateAccount,
  reinstateArtifact,
  resolveAbuseReport,
  submitAbuseReport,
  suspendAccount,
  suspendArtifact,
} from "../src/moderation.ts";
import { preparePublish } from "../src/publish.ts";
import { checkReadAccess } from "../src/read-access.ts";
import { getVersionDownload } from "../src/versions.ts";
import {
  activeSlots,
  artifactRow,
  DAY,
  db,
  NOW,
  publishSite,
  racing,
  sha256,
  user,
} from "./fixtures.ts";

describe("abuse reports", () => {
  it("stores a report about an existing artifact and lists it until it is resolved", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    const stored = await submitAbuseReport(db(), {
      artifactId,
      reason: "phishing",
      details: "Fake sign-in page",
      email: "reporter@example.test",
      now: NOW,
    });
    expect(stored).toEqual({ stored: true });
    const open = (await listAbuseReports(db(), { status: "open", limit: 500 })).filter(
      (report) => report.artifactId === artifactId,
    );
    expect(open).toMatchObject([
      {
        reason: "phishing",
        details: "Fake sign-in page",
        reporterEmail: "reporter@example.test",
        status: "open",
        createdAt: NOW,
      },
    ]);
    const resolved = await resolveAbuseReport(db(), {
      reportId: open[0]?.id ?? "",
      status: "actioned",
      now: NOW + 1,
    });
    expect(resolved.ok).toBe(true);
    const after = (await listAbuseReports(db(), { limit: 500 })).find(
      (report) => report.id === open[0]?.id,
    );
    expect(after).toMatchObject({ status: "actioned", resolvedAt: NOW + 1 });
  });

  it("drops reports about unknown, deleted or missing artifacts without telling", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    await deleteArtifact(db(), env.ARTIFACTS, { ownerId: owner.id, artifactId, now: NOW });
    for (const id of [artifactId, "zzzzzzzzzz", null]) {
      expect(
        await submitAbuseReport(db(), {
          artifactId: id,
          reason: "spam",
          details: undefined,
          email: "",
          now: NOW,
        }),
      ).toEqual({ stored: false });
    }
    const stored = await db()
      .select()
      .from(schema.abuseReports)
      .where(eq(schema.abuseReports.artifactId, artifactId));
    expect(stored).toEqual([]);
  });

  it("stores no email or details when they are left out", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    await submitAbuseReport(db(), {
      artifactId,
      reason: "other",
      details: undefined,
      email: "",
      now: NOW,
    });
    const [row] = await db()
      .select()
      .from(schema.abuseReports)
      .where(eq(schema.abuseReports.artifactId, artifactId));
    expect(row).toMatchObject({ reporterEmail: null, details: null });
  });

  it("answers not_found when resolving a report that does not exist", async () => {
    expect(
      await resolveAbuseReport(db(), { reportId: "rep_missing", status: "dismissed", now: NOW }),
    ).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("suspending an artifact", () => {
  it("stops it being readable, frees its slot and shows the reason, then reinstates it", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    expect(await activeSlots(owner.id)).toBe(1);
    expect((await checkReadAccess(db(), { artifactId, userId: owner.id, now: NOW })).ok).toBe(true);

    const suspended = await suspendArtifact(db(), {
      artifactId,
      reason: "malware",
      note: "private operator note",
      reportId: "rep_1",
      now: NOW + 1,
    });
    expect(suspended).toMatchObject({ ok: true, value: { changed: true } });
    expect(await artifactRow(artifactId)).toMatchObject({
      state: "suspended",
      suspensionReason: "malware",
    });
    expect(await activeSlots(owner.id)).toBe(0);
    expect(
      await checkReadAccess(db(), { artifactId, userId: owner.id, now: NOW + 2 }),
    ).toMatchObject({
      ok: false,
      code: "not_found",
    });
    const [row] = await db()
      .select()
      .from(schema.suspensions)
      .where(eq(schema.suspensions.targetId, artifactId));
    expect(row).toMatchObject({
      kind: "artifact",
      reason: "malware",
      previousState: "active",
      reportId: "rep_1",
      note: "private operator note",
      liftedAt: null,
    });

    const reinstated = await reinstateArtifact(db(), { artifactId, now: NOW + 3 });
    expect(reinstated).toEqual({ ok: true, value: { state: "active", changed: true } });
    expect(await artifactRow(artifactId)).toMatchObject({
      state: "active",
      suspensionReason: null,
    });
    expect(await activeSlots(owner.id)).toBe(1);
    expect((await checkReadAccess(db(), { artifactId, userId: owner.id, now: NOW + 4 })).ok).toBe(
      true,
    );
    const events = await db()
      .select({ event: schema.lifecycleEvents.event })
      .from(schema.lifecycleEvents)
      .where(eq(schema.lifecycleEvents.artifactId, artifactId));
    expect(events.map((e) => e.event)).toEqual(expect.arrayContaining(["suspended", "reinstated"]));
  });

  it("is idempotent: suspending twice keeps one open suspension", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    const first = await suspendArtifact(db(), { artifactId, reason: "spam", now: NOW });
    const second = await suspendArtifact(db(), { artifactId, reason: "spam", now: NOW + 1 });
    expect(second).toEqual({
      ok: true,
      value: { suspensionId: first.ok ? first.value.suspensionId : "", changed: false },
    });
    const rows = await db()
      .select()
      .from(schema.suspensions)
      .where(eq(schema.suspensions.targetId, artifactId));
    expect(rows).toHaveLength(1);
    expect(await activeSlots(owner.id)).toBe(0);
  });

  it("applies exactly one of two concurrent suspensions", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    const lost = await suspendArtifact(
      racing(() => suspendArtifact(db(), { artifactId, reason: "phishing", now: NOW })),
      { artifactId, reason: "spam", now: NOW + 1 },
    );
    expect(lost.ok).toBe(true);
    const rows = await db()
      .select()
      .from(schema.suspensions)
      .where(eq(schema.suspensions.targetId, artifactId));
    expect(rows.map((row) => row.reason)).toEqual(["phishing"]);
    expect(await artifactRow(artifactId)).toMatchObject({ suspensionReason: "phishing" });
    expect(await activeSlots(owner.id)).toBe(0);
  });

  it("does not suspend when the artifact changed after it was read", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    const lost = await suspendArtifact(
      racing(() => archiveArtifact(db(), { ownerId: owner.id, artifactId, now: NOW })),
      { artifactId, reason: "spam", now: NOW + 1 },
    );
    expect(lost).toMatchObject({ ok: false, code: "version_conflict" });
    expect(await artifactRow(artifactId)).toMatchObject({ state: "archived" });
  });

  it("keeps an archived artifact archived when reinstated, with its purge date", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    await archiveArtifact(db(), { ownerId: owner.id, artifactId, now: NOW });
    const archived = await artifactRow(artifactId);
    await suspendArtifact(db(), { artifactId, reason: "copyright", now: NOW + 1 });
    expect(await activeSlots(owner.id)).toBe(0);
    // The owner cannot restore a suspended artifact.
    expect(
      await restoreArtifact(db(), { ownerId: owner.id, artifactId, now: NOW + 2 }),
    ).toMatchObject({ ok: false });
    const reinstated = await reinstateArtifact(db(), { artifactId, now: NOW + 3 });
    expect(reinstated).toEqual({ ok: true, value: { state: "archived", changed: true } });
    expect(await artifactRow(artifactId)).toMatchObject({
      state: "archived",
      archivedAt: archived?.archivedAt,
      purgeAt: archived?.purgeAt,
    });
    expect(await activeSlots(owner.id)).toBe(0);
  });

  it("reinstates to the archive when the account has no free active slot", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    await suspendArtifact(db(), { artifactId, reason: "spam", now: NOW });
    await db()
      .update(schema.accountUsage)
      .set({ activeArtifacts: 50 })
      .where(eq(schema.accountUsage.ownerId, owner.id));
    const reinstated = await reinstateArtifact(db(), { artifactId, now: NOW + 1 });
    expect(reinstated).toEqual({ ok: true, value: { state: "archived", changed: true } });
    const row = await artifactRow(artifactId);
    expect(row).toMatchObject({ state: "archived", archivedAt: NOW + 1 });
    expect(row?.purgeAt).toBeGreaterThan(NOW + 150 * DAY);
    expect(await activeSlots(owner.id)).toBe(50);
  });

  it("refuses artifacts that cannot be suspended or reinstated", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    expect(
      await suspendArtifact(db(), { artifactId: "zzzzzzzzzz", reason: "spam", now: NOW }),
    ).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await reinstateArtifact(db(), { artifactId: "zzzzzzzzzz", now: NOW })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    // Reinstating an artifact that is not suspended changes nothing.
    expect(await reinstateArtifact(db(), { artifactId, now: NOW })).toEqual({
      ok: true,
      value: { state: "active", changed: false },
    });
    await db()
      .update(schema.artifacts)
      .set({ state: "purging" })
      .where(eq(schema.artifacts.id, artifactId));
    expect(await suspendArtifact(db(), { artifactId, reason: "spam", now: NOW })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(await reinstateArtifact(db(), { artifactId, now: NOW })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
  });

  it("applies exactly one of two concurrent reinstatements", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    await suspendArtifact(db(), { artifactId, reason: "spam", now: NOW });
    const lost = await reinstateArtifact(
      racing(() => reinstateArtifact(db(), { artifactId, now: NOW + 1 })),
      { artifactId, now: NOW + 2 },
    );
    expect(lost).toMatchObject({ ok: false, code: "version_conflict" });
    expect(await activeSlots(owner.id)).toBe(1);
    const events = await db()
      .select()
      .from(schema.lifecycleEvents)
      .where(
        and(
          eq(schema.lifecycleEvents.artifactId, artifactId),
          eq(schema.lifecycleEvents.event, "reinstated"),
        ),
      );
    expect(events).toHaveLength(1);
  });

  it("lets the owner delete a suspended artifact but not download it as a reader", async () => {
    const owner = await user();
    const reader = await user();
    const { artifactId, versionId } = await publishSite(owner.id);
    await suspendArtifact(db(), { artifactId, reason: "malware", now: NOW });
    const download = await getVersionDownload(db(), {
      userId: reader.id,
      artifactId,
      versionId,
      kind: "published",
      now: NOW,
    });
    expect(download).toMatchObject({ ok: false, code: "not_found" });
    const deleted = await deleteArtifact(db(), env.ARTIFACTS, {
      ownerId: owner.id,
      artifactId,
      now: NOW,
    });
    expect(deleted).toMatchObject({ ok: true, value: { state: "deleted" } });
    expect(await activeSlots(owner.id)).toBe(0);
  });
});

describe("suspending an account", () => {
  it("suspends its artifacts and publishing, and reinstates exactly those", async () => {
    const owner = await user();
    const active = await publishSite(owner.id);
    const archived = await publishSite(owner.id);
    const alone = await publishSite(owner.id);
    await archiveArtifact(db(), { ownerId: owner.id, artifactId: archived.artifactId, now: NOW });
    await suspendArtifact(db(), { artifactId: alone.artifactId, reason: "spam", now: NOW });

    const suspended = await suspendAccount(db(), {
      userId: owner.id,
      reason: "phishing",
      now: NOW + 1,
    });
    expect(suspended).toMatchObject({ ok: true, value: { changed: true, artifacts: 2 } });
    expect(await accountSuspension(db(), owner.id)).toMatchObject({ reason: "phishing" });
    for (const id of [active.artifactId, archived.artifactId]) {
      expect(await artifactRow(id)).toMatchObject({
        state: "suspended",
        suspensionReason: "phishing",
      });
    }
    expect(await artifactRow(alone.artifactId)).toMatchObject({ suspensionReason: "spam" });
    expect(await activeSlots(owner.id)).toBe(0);

    const body = "<p>new</p>";
    const prepare = await preparePublish(db(), {
      ownerId: owner.id,
      type: "site",
      name: "New",
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
      now: NOW + 2,
    });
    expect(prepare).toMatchObject({ ok: false, code: "forbidden" });

    // A child cannot be reinstated on its own while the account stays suspended.
    expect(
      await reinstateArtifact(db(), { artifactId: active.artifactId, now: NOW + 3 }),
    ).toMatchObject({
      ok: false,
      code: "invalid_input",
    });

    const again = await suspendAccount(db(), { userId: owner.id, reason: "spam", now: NOW + 4 });
    expect(again).toMatchObject({ ok: true, value: { changed: false, artifacts: 0 } });

    const reinstated = await reinstateAccount(db(), { userId: owner.id, now: NOW + 5 });
    expect(reinstated).toEqual({ ok: true, value: { artifacts: 2, changed: true } });
    expect(await accountSuspension(db(), owner.id)).toBeUndefined();
    expect(await artifactRow(active.artifactId)).toMatchObject({ state: "active" });
    expect(await artifactRow(archived.artifactId)).toMatchObject({ state: "archived" });
    expect(await artifactRow(alone.artifactId)).toMatchObject({ state: "suspended" });
    expect(await activeSlots(owner.id)).toBe(1);
    expect(await reinstateAccount(db(), { userId: owner.id, now: NOW + 6 })).toEqual({
      ok: true,
      value: { artifacts: 0, changed: false },
    });
  });

  it("does not touch other accounts", async () => {
    const owner = await user();
    const other = await user();
    const mine = await publishSite(owner.id);
    const theirs = await publishSite(other.id);
    await suspendAccount(db(), { userId: owner.id, reason: "spam", now: NOW });
    expect(await artifactRow(mine.artifactId)).toMatchObject({ state: "suspended" });
    expect(await artifactRow(theirs.artifactId)).toMatchObject({ state: "active" });
    expect(await activeSlots(other.id)).toBe(1);
  });

  it("answers not_found for an unknown account", async () => {
    expect(
      await suspendAccount(db(), { userId: "u_missing", reason: "spam", now: NOW }),
    ).toMatchObject({ ok: false, code: "not_found" });
  });
});
