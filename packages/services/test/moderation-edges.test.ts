// The edges of statements of reasons, report outcomes and legal holds: races, missing rows,
// refused sends and the paths that end a job early. The main behaviour is in
// moderation-notices.test.ts and legal-holds.test.ts.
import { env } from "cloudflare:test";
import type { JobMessage } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { RecipientSuppressedError, recordEmailsSent } from "../src/email.ts";
import {
  applyLegalHolds,
  heldSql,
  holdIdentities,
  placeLegalHold,
  releaseLegalHold,
  runHoldRelease,
  updateHoldRelease,
} from "../src/legal-holds.ts";
import {
  listAbuseReports,
  reinstateAccount,
  reinstateArtifact,
  resolveAbuseReport,
  submitAbuseReport,
  suspendAccount,
  suspendArtifact,
} from "../src/moderation.ts";
import {
  type DecisionStatement,
  type ModerationNotice,
  sendSuspensionStatement,
} from "../src/moderation-notices.ts";
import { runJob } from "../src/outbox.ts";
import { DAY, db, NOW, publishSite, racing, user, value } from "./fixtures.ts";

const STATEMENT: DecisionStatement = {
  facts: "Facts.",
  ground: "Ground.",
  source: "review",
  withhold: false,
};

async function runAbout(subject: string, deps: Parameters<typeof runJob>[4], now = NOW) {
  const rows = await db().select().from(schema.outbox).where(eq(schema.outbox.subject, subject));
  const outcomes = [];
  for (const row of rows) {
    outcomes.push(
      await runJob(db(), env.ARTIFACTS, { id: row.id, topic: row.topic } as JobMessage, now, deps),
    );
  }
  return outcomes;
}

describe("legal hold edges", () => {
  it("answers held for a given ID, and places a hold once when two race", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    value(await suspendArtifact(db(), { artifactId, reason: "spam", now: NOW }));
    // A suspension without a stored category holds as `other`.
    await db()
      .update(schema.artifacts)
      .set({ suspensionReason: null })
      .where(eq(schema.artifacts.id, artifactId));
    const place = () =>
      placeLegalHold(db(), { artifactId, ground: "Authority", releaseAt: null, now: NOW });
    const [a, b] = await Promise.all([place(), place()]);
    expect([value(a).changed, value(b).changed].sort()).toEqual([false, true]);
    expect(value(a).hold.reason).toBe("other");
    const [row] = await db().all<{ held: number }>(
      sql`select ${heldSql(sql`${artifactId}`)} as held`,
    );
    expect(row?.held).toBe(1);
  });

  it("answers a conflict when the artifact is reinstated between the check and the hold", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    value(await suspendArtifact(db(), { artifactId, reason: "spam", now: NOW }));
    const raced = racing(() => reinstateArtifact(db(), { artifactId, now: NOW }));
    expect(
      await placeLegalHold(raced, { artifactId, ground: "Authority", releaseAt: null, now: NOW }),
    ).toMatchObject({ ok: false, code: "version_conflict" });
  });

  it("moves a release date only forward and only on an open hold", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    expect(
      await updateHoldRelease(db(), { artifactId, releaseAt: NOW - 1, now: NOW }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    expect(
      await updateHoldRelease(db(), { artifactId, releaseAt: NOW + DAY, now: NOW }),
    ).toMatchObject({ ok: false, code: "not_found" });
  });

  it("keeps a token creator without an email, and a hold on an artifact with no creator", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    await db()
      .update(schema.artifacts)
      .set({ createdBy: "st_token" })
      .where(eq(schema.artifacts.id, artifactId));
    value(await suspendArtifact(db(), { artifactId, reason: "spam", now: NOW }));
    value(
      await placeLegalHold(db(), { artifactId, ground: "Authority", releaseAt: null, now: NOW }),
    );
    expect(await holdIdentities(db(), artifactId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "creator", actorId: "st_token", email: null }),
      ]),
    );
    const other = await publishSite(owner.id);
    await db()
      .update(schema.artifacts)
      .set({ createdBy: null })
      .where(eq(schema.artifacts.id, other.artifactId));
    value(await suspendArtifact(db(), { artifactId: other.artifactId, reason: "spam", now: NOW }));
    value(
      await placeLegalHold(db(), {
        artifactId: other.artifactId,
        ground: "Authority",
        releaseAt: null,
        now: NOW,
      }),
    );
    expect(
      (await holdIdentities(db(), other.artifactId)).some((row) => row.role === "creator"),
    ).toBe(false);
  });

  it("runs a release job that has nothing to do, or whose artifact is held again", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    expect(await runHoldRelease(db(), undefined, artifactId, NOW)).toBe("done");
    value(await suspendArtifact(db(), { artifactId, reason: "spam", now: NOW }));
    value(
      await placeLegalHold(db(), { artifactId, ground: "Authority", releaseAt: null, now: NOW }),
    );
    expect(await runHoldRelease(db(), undefined, artifactId, NOW)).toBe("done");
    await releaseLegalHold(db(), { artifactId, now: NOW });
  });

  it("reports a hold whose artifact cannot be suspended again, and keeps another open hold", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    await db()
      .update(schema.artifacts)
      .set({ state: "draft" })
      .where(eq(schema.artifacts.id, artifactId));
    const line = {
      legalHold: {
        id: `hold_${"3".repeat(32)}`,
        artifactId,
        ownerId: owner.id,
        ownerEmail: null,
        reason: "spam",
        ground: "Authority",
        createdAt: NOW,
        releaseAt: null,
        releasedAt: null,
      },
    };
    expect((await applyLegalHolds({ all: () => [{ db: db() }] }, [line], NOW)).missing).toEqual([
      artifactId,
    ]);
    const held = await publishSite(owner.id);
    value(await suspendArtifact(db(), { artifactId: held.artifactId, reason: "spam", now: NOW }));
    value(
      await placeLegalHold(db(), {
        artifactId: held.artifactId,
        ground: "Now",
        releaseAt: null,
        now: NOW,
      }),
    );
    const other = {
      legalHold: { ...line.legalHold, id: `hold_${"4".repeat(32)}`, artifactId: held.artifactId },
    };
    expect(await applyLegalHolds({ all: () => [{ db: db() }] }, [other], NOW)).toMatchObject({
      restored: 1,
      missing: [],
    });
    const holds = await db()
      .select()
      .from(schema.legalHolds)
      .where(eq(schema.legalHolds.artifactId, held.artifactId));
    expect(holds.map((h) => h.ground)).toEqual(["Now"]);
  });
});

describe("statement and outcome edges", () => {
  it("refuses a statement for a suspension whose artifact is gone, and one that is lifted meanwhile", async () => {
    await db()
      .insert(schema.suspensions)
      .values({
        id: `sus_${crypto.randomUUID().replaceAll("-", "")}`,
        kind: "artifact",
        targetId: "zzzzzzzzzz",
        reason: "spam",
        createdAt: NOW,
      });
    expect(
      await sendSuspensionStatement(db(), {
        targetKind: "artifact",
        targetId: "zzzzzzzzzz",
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    value(
      await suspendArtifact(db(), {
        artifactId,
        reason: "spam",
        statement: { ...STATEMENT, withhold: true },
        now: NOW,
      }),
    );
    const lift = () => reinstateArtifact(db(), { artifactId, now: NOW });
    expect(
      await sendSuspensionStatement(racing(lift), {
        targetKind: "artifact",
        targetId: artifactId,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "version_conflict" });
    value(await suspendArtifact(db(), { artifactId, reason: "spam", now: NOW + 1 }));
    expect(
      await sendSuspensionStatement(
        racing(() => reinstateArtifact(db(), { artifactId, now: NOW + 1 })),
        {
          targetKind: "artifact",
          targetId: artifactId,
          statement: { facts: "F", ground: "G", source: "review" },
          now: NOW + 1,
        },
      ),
    ).toMatchObject({ ok: false, code: "version_conflict" });
  });

  it("skips a recipient whose account is gone and one the provider refuses", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    value(
      await suspendArtifact(db(), { artifactId, reason: "spam", statement: STATEMENT, now: NOW }),
    );
    const refused = {
      moderationNotifier: {
        async send(_notice: ModerationNotice) {
          throw new RecipientSuppressedError();
        },
      },
    };
    const decisions = await db()
      .select()
      .from(schema.moderationDecisions)
      .where(eq(schema.moderationDecisions.targetId, artifactId));
    expect(await runAbout(decisions[0]?.id ?? "", refused)).toEqual(["done"]);
    const [after] = await db()
      .select()
      .from(schema.moderationDecisions)
      .where(eq(schema.moderationDecisions.targetId, artifactId));
    expect(after?.notice).toBe("no_recipient");

    const gone = await user();
    const theirs = await publishSite(gone.id);
    value(
      await suspendArtifact(db(), {
        artifactId: theirs.artifactId,
        reason: "spam",
        statement: STATEMENT,
        now: NOW,
      }),
    );
    await db().global.delete(schema.users).where(eq(schema.users.id, gone.id));
    const [decision] = await db()
      .select()
      .from(schema.moderationDecisions)
      .where(eq(schema.moderationDecisions.targetId, theirs.artifactId));
    expect(
      await runAbout(decision?.id ?? "", { moderationNotifier: { send: async () => {} } }),
    ).toEqual(["done"]);
  });

  it("ends an outcome job for a report still open, waits on a full cycle and marks a refused address", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    const email = `edge-${crypto.randomUUID()}@example.test`;
    await submitAbuseReport(db(), {
      artifactId,
      reason: "spam",
      details: undefined,
      email,
      now: NOW,
    });
    const [report] = (await listAbuseReports(db().global, { status: "open", limit: 500 })).filter(
      (r) => r.reporterEmail === email,
    );
    const id = report?.id ?? "";
    await db()
      .global.update(schema.abuseReports)
      .set({ outcomeNotice: "pending" })
      .where(eq(schema.abuseReports.id, id));
    await db().insert(schema.outbox).values({
      topic: "report_outcome",
      payload: {},
      availableAt: NOW,
      createdAt: NOW,
      subject: id,
    });
    expect(await runAbout(id, { reportOutcomeNotifier: { send: async () => {} } })).toEqual([
      "stale",
    ]);
    await db()
      .global.update(schema.abuseReports)
      .set({ status: "open", outcomeNotice: null })
      .where(eq(schema.abuseReports.id, id));
    value(await resolveAbuseReport(db().global, { reportId: id, status: "dismissed", now: NOW }));
    const later = Date.UTC(2032, 0, 15);
    await recordEmailsSent(db().global, later, 1_000_000);
    expect(await runAbout(id, { reportOutcomeNotifier: { send: async () => {} } }, later)).toEqual([
      "pending",
    ]);
    const refused = {
      reportOutcomeNotifier: {
        async send() {
          throw new RecipientSuppressedError();
        },
      },
    };
    expect(await runAbout(id, refused)).toEqual(["done"]);
    const [after] = (await listAbuseReports(db().global, { limit: 500 })).filter(
      (r) => r.id === id,
    );
    expect(after).toMatchObject({ outcomeNotice: "undeliverable", outcomeNotifiedAt: null });
  });
});

describe("suspension edges", () => {
  it("keeps one suspension when two race, for an artifact and an account", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    const twice = await Promise.all([
      suspendArtifact(db(), { artifactId, reason: "spam", statement: STATEMENT, now: NOW }),
      suspendArtifact(db(), { artifactId, reason: "spam", statement: STATEMENT, now: NOW }),
    ]);
    expect(twice.map((r) => value(r).changed).sort()).toEqual([false, true]);
    const decisions = await db()
      .select()
      .from(schema.moderationDecisions)
      .where(eq(schema.moderationDecisions.targetId, artifactId));
    expect(decisions).toHaveLength(1);
    const account = await user();
    const accounts = await Promise.all([
      suspendAccount(db(), { userId: account.id, reason: "spam", now: NOW }),
      suspendAccount(db(), { userId: account.id, reason: "spam", now: NOW }),
    ]);
    expect(accounts.map((r) => value(r).changed).sort()).toEqual([false, true]);
  });

  it("reinstates to the archive when the account has no free active slot, with its statement", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    value(await suspendArtifact(db(), { artifactId, reason: "spam", now: NOW }));
    // Another artifact fills the only slot the account has.
    await publishSite(owner.id);
    await db()
      .update(schema.accountUsage)
      .set({ activeLimit: 1 })
      .where(eq(schema.accountUsage.ownerId, owner.id));
    expect(
      value(
        await reinstateArtifact(db(), {
          artifactId,
          statement: { facts: "Back.", source: "review", withhold: false },
          now: NOW + 1,
        }),
      ),
    ).toEqual({ state: "archived", changed: true });
    // A second suspension of an account already suspended in another request keeps one.
    const account = await user();
    value(await suspendAccount(db(), { userId: account.id, reason: "spam", now: NOW }));
    expect(
      value(await suspendAccount(db(), { userId: account.id, reason: "spam", now: NOW + 1 })),
    ).toMatchObject({
      changed: false,
    });
  });

  it("refuses reinstating an artifact alone while its account is suspended, then brings it back with the account", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    value(await suspendAccount(db(), { userId: owner.id, reason: "spam", now: NOW }));
    expect(await reinstateArtifact(db(), { artifactId, now: NOW + 1 })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(value(await reinstateAccount(db(), { userId: owner.id, now: NOW + 2 }))).toMatchObject({
      artifacts: 1,
    });
  });
});
