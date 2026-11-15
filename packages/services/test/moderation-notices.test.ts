// Statements of reasons and report outcomes (docs/operations.md, "Reports"): each operator
// decision is recorded in the batch of its change and emailed once to the people affected; the
// reporter learns the outcome; suppressed addresses, a full cycle and a withheld notice are
// honored, and every send is recorded.
import { env } from "cloudflare:test";
import { type JobMessage, REPORT_LIMITS } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { SIGN_IN_EMAILS_PER_CYCLE } from "@portifact/domain";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { actorOn } from "../src/actors.ts";
import { retireJournalEntry } from "../src/artifact-data.ts";
import { getArtifact } from "../src/artifacts.ts";
import { getBrandSettings, reinstateBrand, suspendBrand } from "../src/branding.ts";
import { claimVisitorId } from "../src/data-grants.ts";
import { recordEmailsSent, suppressEmail } from "../src/email.ts";
import { eraseAccountTraces, pruneGoneHistory } from "../src/history-retention.ts";
import { keyedHash } from "../src/keyed-hash.ts";
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
  accountSuspensionView,
  type DecisionStatement,
  listDecisions,
  type ModerationNotice,
  type ReportOutcomeNotice,
  sendSuspensionStatement,
  suspensionStatement,
} from "../src/moderation-notices.ts";
import { runJob } from "../src/outbox.ts";
import { createWorkspace } from "../src/workspaces.ts";
import { db, NOW, publishSite, user, value } from "./fixtures.ts";

const STATEMENT: DecisionStatement = {
  facts: "The /login page asks for bank passwords.",
  ground: "Acceptable Use Policy: phishing.",
  source: "notice",
  withhold: false,
};

function notifiers(fail: boolean | string = false) {
  const moderation: ModerationNotice[] = [];
  const outcomes: ReportOutcomeNotice[] = [];
  return {
    moderation,
    outcomes,
    deps: {
      moderationNotifier: {
        async send(notice: ModerationNotice) {
          if (fail === true || fail === notice.to) throw new Error("down");
          moderation.push(notice);
        },
      },
      reportOutcomeNotifier: {
        async send(notice: ReportOutcomeNotice) {
          if (fail) throw new Error("down");
          outcomes.push(notice);
        },
      },
    },
  };
}

async function jobsAbout(subject: string) {
  return db().select().from(schema.outbox).where(eq(schema.outbox.subject, subject));
}

async function runJobsAbout(
  subject: string,
  deps: ReturnType<typeof notifiers>["deps"],
  now = NOW,
) {
  const outcomes = [];
  for (const row of await jobsAbout(subject)) {
    outcomes.push(
      await runJob(db(), env.ARTIFACTS, { id: row.id, topic: row.topic } as JobMessage, now, deps),
    );
  }
  return outcomes;
}

async function decisionsOf(kind: "artifact" | "account" | "brand", id: string) {
  return listDecisions(db(), kind, id);
}

/** A signed-in author of the artifact's data: their journal entry, and a grant like the page's. */
async function dataAuthor(artifactId: string, name = "Writer") {
  const person = await user(name);
  const visitorId = value(await claimVisitorId(env.ARTIFACTS, person.id, artifactId, NOW));
  await db()
    .insert(schema.dataGrants)
    .values({
      id: `dg_${crypto.randomUUID()}`,
      artifactId,
      userId: person.id,
      visitorId,
      authSessionId: `s_${crypto.randomUUID()}`,
      host: `${artifactId}.portifact.dev`,
      expiresAt: NOW + 3_600_000,
      redeemedAt: NOW,
    });
  return { ...person, visitorId };
}

describe("the statement of reasons", () => {
  it("is recorded with the suspension and emailed once to the account, with what the pages promise", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    value(
      await suspendArtifact(db(), {
        artifactId,
        reason: "phishing",
        reportId: "rep_1",
        statement: STATEMENT,
        now: NOW,
      }),
    );
    const [decision] = await decisionsOf("artifact", artifactId);
    expect(decision).toMatchObject({
      action: "suspend",
      reason: "phishing",
      source: "notice",
      reportId: "rep_1",
      facts: STATEMENT.facts,
      ground: STATEMENT.ground,
      notice: "pending",
      ownerId: owner.id,
    });
    const sent = notifiers();
    expect(await runJobsAbout(decision?.id ?? "", sent.deps)).toEqual(["done"]);
    expect(sent.moderation).toEqual([
      {
        to: owner.email,
        locale: null,
        action: "suspend",
        target: "artifact",
        artifactId,
        attachmentId: null,
        artifactName: "Plan",
        workspaceSlug: null,
        audience: "manager",
        reason: "phishing",
        source: "notice",
        facts: STATEMENT.facts,
        ground: STATEMENT.ground,
        decidedAt: NOW,
      },
    ]);
    const [after] = await decisionsOf("artifact", artifactId);
    expect(after).toMatchObject({ notice: "sent", recipients: 1, notifiedAt: NOW });
    expect(after?.sends).toEqual([{ decisionId: decision?.id, userId: owner.id, sentAt: NOW }]);
    // The job is gone: nobody is told twice.
    expect(await jobsAbout(decision?.id ?? "")).toEqual([]);
  });

  it("is sent at most once when two runs of its job overlap", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    value(
      await suspendArtifact(db(), { artifactId, reason: "spam", statement: STATEMENT, now: NOW }),
    );
    const [decision] = await decisionsOf("artifact", artifactId);
    const [row] = await jobsAbout(decision?.id ?? "");
    const sends: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = {
      moderationNotifier: {
        async send(notice: ModerationNotice) {
          sends.push(notice.to);
          await gate;
        },
      },
    };
    const message = { id: row?.id ?? 0, topic: "moderation_notice" } as JobMessage;
    const first = runJob(db(), env.ARTIFACTS, message, NOW, slow);
    const second = runJob(db(), env.ARTIFACTS, message, NOW, slow);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await Promise.all([first, second]);
    expect(sends).toEqual([owner.email]);
  });

  it("is shown next to the category, and not when withheld", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    value(
      await suspendArtifact(db(), {
        artifactId,
        reason: "phishing",
        statement: STATEMENT,
        now: NOW,
      }),
    );
    expect(await suspensionStatement(db(), artifactId)).toEqual({
      facts: STATEMENT.facts,
      ground: STATEMENT.ground,
      source: "notice",
      decidedAt: new Date(NOW).toISOString(),
    });
    const viewed = value(await getArtifact(db(), { userId: owner.id, artifactId }));
    expect(viewed.statement).toMatchObject({ facts: STATEMENT.facts });

    const silent = await publishSite(owner.id);
    value(
      await suspendArtifact(db(), {
        artifactId: silent.artifactId,
        reason: "child_safety",
        statement: { ...STATEMENT, withhold: true },
        now: NOW,
      }),
    );
    const [withheld] = await decisionsOf("artifact", silent.artifactId);
    expect(withheld).toMatchObject({ notice: "withheld" });
    expect(await jobsAbout(withheld?.id ?? "")).toEqual([]);
    expect(await suspensionStatement(db(), silent.artifactId)).toBeNull();
    // A suspension recorded without a statement shows none either.
    const bare = await publishSite(owner.id);
    value(await suspendArtifact(db(), { artifactId: bare.artifactId, reason: "spam", now: NOW }));
    expect(await suspensionStatement(db(), bare.artifactId)).toBeNull();
    expect(await suspensionStatement(db(), "zzzzzzzzzz")).toBeNull();
  });

  it("records nothing when the suspension changed nothing", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    value(
      await suspendArtifact(db(), { artifactId, reason: "spam", statement: STATEMENT, now: NOW }),
    );
    const again = value(
      await suspendArtifact(db(), {
        artifactId,
        reason: "spam",
        statement: STATEMENT,
        now: NOW + 1,
      }),
    );
    expect(again.changed).toBe(false);
    expect(await decisionsOf("artifact", artifactId)).toHaveLength(1);
  });

  it("goes to every admin of a workspace, skips suppressed addresses and retries only those not sent", async () => {
    const admin = await user();
    const second = await user();
    const slug = `m-${crypto.randomUUID().slice(0, 8)}`;
    const ws = value(
      await createWorkspace(db().global, { slug, name: "Team", adminUserId: admin.id, now: NOW }),
    );
    await db().global.insert(schema.workspaceMembers).values({
      workspaceId: ws.id,
      userId: second.id,
      role: "admin",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db()
      .global.insert(schema.ownerBrands)
      .values({ ownerId: ws.id, name: "Team", updatedAt: NOW });
    value(
      await suspendBrand(db(), {
        ownerId: ws.id,
        reason: "impersonation",
        statement: STATEMENT,
        now: NOW,
      }),
    );
    const [decision] = await decisionsOf("brand", ws.id);
    // A send that fails keeps the job; the admin already told is not told again.
    const [earlier, later] = [admin, second].sort((x, y) => x.id.localeCompare(y.id)) as [
      typeof admin,
      typeof admin,
    ];
    const first = notifiers(later.email);
    await expect(runJobsAbout(decision?.id ?? "", first.deps)).rejects.toThrow();
    expect(first.moderation.map((notice) => notice.to)).toEqual([earlier.email]);
    expect(first.moderation[0]).toMatchObject({ target: "brand", workspaceSlug: slug });
    await suppressEmail(db().global, { email: later.email, reason: "hard_bounce", now: NOW });
    const sent = notifiers();
    expect(await runJobsAbout(decision?.id ?? "", sent.deps)).toEqual(["done"]);
    expect(sent.moderation).toEqual([]);
    expect((await decisionsOf("brand", ws.id))[0]).toMatchObject({ notice: "sent", recipients: 1 });

    value(
      await reinstateBrand(db(), {
        ownerId: ws.id,
        statement: { facts: STATEMENT.facts, source: "review", withhold: false },
        now: NOW + 1,
      }),
    );
    const [lifted] = await decisionsOf("brand", ws.id);
    expect(lifted).toMatchObject({ action: "reinstate", ground: null, reason: null });
  });

  it("waits for the next cycle when the month's emails are spent, and records no recipient when nobody can be told", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    value(
      await suspendArtifact(db(), { artifactId, reason: "spam", statement: STATEMENT, now: NOW }),
    );
    const [decision] = await decisionsOf("artifact", artifactId);
    const later = Date.UTC(2031, 0, 15);
    await recordEmailsSent(db().global, later, SIGN_IN_EMAILS_PER_CYCLE);
    expect(await runJobsAbout(decision?.id ?? "", notifiers().deps, later)).toEqual(["pending"]);
    await suppressEmail(db().global, { email: owner.email, reason: "complaint", now: NOW });
    expect(await runJobsAbout(decision?.id ?? "", notifiers().deps, NOW)).toEqual(["done"]);
    expect((await decisionsOf("artifact", artifactId))[0]).toMatchObject({
      notice: "no_recipient",
      recipients: 0,
    });
  });

  it("covers reinstatements and accounts", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    value(
      await suspendArtifact(db(), { artifactId, reason: "spam", statement: STATEMENT, now: NOW }),
    );
    value(
      await reinstateArtifact(db(), {
        artifactId,
        statement: { facts: "Removed after review.", source: "review", withhold: false },
        now: NOW + 1,
      }),
    );
    const [lifted] = await decisionsOf("artifact", artifactId);
    expect(lifted).toMatchObject({ action: "reinstate", source: "review", ground: null });

    value(
      await suspendAccount(db(), {
        userId: owner.id,
        reason: "spam",
        statement: STATEMENT,
        now: NOW + 2,
      }),
    );
    expect((await decisionsOf("account", owner.id))[0]).toMatchObject({ action: "suspend" });
    // The account's artifacts show the account's statement.
    expect(await suspensionStatement(db(), artifactId)).toMatchObject({ facts: STATEMENT.facts });
    const sent = notifiers();
    const [accountDecision] = await decisionsOf("account", owner.id);
    await runJobsAbout(accountDecision?.id ?? "", sent.deps);
    expect(sent.moderation).toMatchObject([
      { to: owner.email, target: "account", artifactId: null },
    ]);
    value(
      await reinstateAccount(db(), {
        userId: owner.id,
        statement: { facts: "Lifted.", source: "review", withhold: false },
        now: NOW + 3,
      }),
    );
    expect((await decisionsOf("account", owner.id))[0]).toMatchObject({ action: "reinstate" });
  });
});

describe("the authors of an artifact's data", () => {
  it("tells the signed-in authors the operator named, through the journal, and nobody else", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    const byVisitor = await dataAuthor(artifactId);
    const byAccount = await dataAuthor(artifactId);
    // The owner also wrote in the page: they read the managers' email, once.
    const ownerVisitor = value(await claimVisitorId(env.ARTIFACTS, owner.id, artifactId, NOW));
    // Someone the journal does not name in this artifact, an anonymous writer's visitor ID, and a
    // visitor ID that belongs to an author of another artifact are told nothing.
    const stranger = await user();
    const elsewhere = await publishSite(owner.id);
    const other = await dataAuthor(elsewhere.artifactId);
    value(
      await suspendArtifact(db(), {
        artifactId,
        reason: "harassment",
        statement: {
          ...STATEMENT,
          dataAuthors: [
            { kind: "visitor", visitorId: byVisitor.visitorId },
            { kind: "account", userId: byAccount.id },
            { kind: "visitor", visitorId: ownerVisitor },
            { kind: "account", userId: stranger.id },
            { kind: "visitor", visitorId: `v_${"z".repeat(22)}` },
            { kind: "visitor", visitorId: other.visitorId },
          ],
        },
        now: NOW,
      }),
    );
    const [decision] = await decisionsOf("artifact", artifactId);
    expect(decision?.dataAuthors).toHaveLength(6);
    const sent = notifiers();
    expect(await runJobsAbout(decision?.id ?? "", sent.deps)).toEqual(["done"]);
    const byTo = new Map(sent.moderation.map((notice) => [notice.to, notice]));
    expect([...byTo.keys()].sort()).toEqual([owner.email, byVisitor.email, byAccount.email].sort());
    expect(byTo.get(owner.email)).toMatchObject({ audience: "manager" });
    for (const author of [byVisitor, byAccount]) {
      expect(byTo.get(author.email)).toMatchObject({
        audience: "data_author",
        target: "artifact",
        artifactId,
        workspaceSlug: null,
        facts: STATEMENT.facts,
        ground: STATEMENT.ground,
      });
    }
    const [after] = await decisionsOf("artifact", artifactId);
    expect(after).toMatchObject({ notice: "sent", recipients: 3 });
    expect(after?.sends.map((row) => row.userId).sort()).toEqual(
      [owner.id, byVisitor.id, byAccount.id].sort(),
    );
  });

  it("keeps the names through a withheld statement, tells them of the reinstatement and skips retired and suppressed authors", async () => {
    const owner = await user();
    const slug = `d-${crypto.randomUUID().slice(0, 8)}`;
    const ws = value(
      await createWorkspace(db().global, { slug, name: "Team", adminUserId: owner.id, now: NOW }),
    );
    const { artifactId } = await publishSite(owner.id);
    await db()
      .update(schema.artifacts)
      .set({ ownerId: ws.id })
      .where(eq(schema.artifacts.id, artifactId));
    const author = await dataAuthor(artifactId);
    const leaving = await dataAuthor(artifactId);
    const bounced = await dataAuthor(artifactId);
    value(
      await suspendArtifact(db(), {
        artifactId,
        reason: "private_information",
        statement: {
          ...STATEMENT,
          withhold: true,
          dataAuthors: [author, leaving, bounced].map((a) => ({
            kind: "visitor" as const,
            visitorId: a.visitorId,
          })),
        },
        now: NOW,
      }),
    );
    // Silence: nothing is sent while the statement is withheld.
    expect(await jobsAbout((await decisionsOf("artifact", artifactId))[0]?.id ?? "")).toEqual([]);
    const released = value(
      await sendSuspensionStatement(db(), {
        targetKind: "artifact",
        targetId: artifactId,
        now: NOW + 1,
      }),
    );
    await retireJournalEntry(env.ARTIFACTS, leaving.id, artifactId, NOW + 1);
    await suppressEmail(db().global, { email: bounced.email, reason: "hard_bounce", now: NOW });
    const first = notifiers();
    expect(await runJobsAbout(released.decisionId, first.deps)).toEqual(["done"]);
    expect(first.moderation.map((notice) => [notice.to, notice.audience]).sort()).toEqual(
      [
        [owner.email, "manager"],
        [author.email, "data_author"],
      ].sort(),
    );
    // A data author's email never carries the workspace, which they are not in.
    expect(first.moderation.find((n) => n.to === author.email)?.workspaceSlug).toBeNull();
    expect(first.moderation.find((n) => n.to === owner.email)?.workspaceSlug).toBe(slug);

    // The reinstatement tells the people the suspension named, without naming them again.
    value(
      await reinstateArtifact(db(), {
        artifactId,
        statement: { facts: "The page was fixed.", source: "review", withhold: false },
        now: NOW + 2,
      }),
    );
    const [lifted] = await decisionsOf("artifact", artifactId);
    expect(lifted).toMatchObject({ action: "reinstate" });
    expect(lifted?.dataAuthors).toHaveLength(3);
    const second = notifiers();
    expect(await runJobsAbout(lifted?.id ?? "", second.deps)).toEqual(["done"]);
    expect(second.moderation.map((notice) => notice.to).sort()).toEqual(
      [owner.email, author.email].sort(),
    );
    expect(second.moderation.find((n) => n.to === author.email)).toMatchObject({
      action: "reinstate",
      audience: "data_author",
    });
  });

  it("is refused for decisions about anything but an artifact, and beyond the limit", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    await expect(
      suspendAccount(db(), {
        userId: owner.id,
        reason: "spam",
        statement: { ...STATEMENT, dataAuthors: [{ kind: "account", userId: owner.id }] },
        now: NOW,
      }),
    ).rejects.toThrow("only a decision about an artifact names data authors");
    await expect(
      suspendArtifact(db(), {
        artifactId,
        reason: "spam",
        statement: {
          ...STATEMENT,
          dataAuthors: Array.from({ length: 51 }, (_, i) => ({
            kind: "visitor" as const,
            visitorId: `v_${String(i).padStart(22, "c")}`,
          })),
        },
        now: NOW,
      }),
    ).rejects.toThrow("too many data authors");
    // Neither left anything behind.
    expect(await decisionsOf("artifact", artifactId)).toEqual([]);
    expect(await decisionsOf("account", owner.id)).toEqual([]);
  });

  it("forgets an account named as an author when it is deleted, and goes with its decision", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    const author = await dataAuthor(artifactId);
    value(
      await suspendArtifact(db(), {
        artifactId,
        reason: "spam",
        statement: {
          ...STATEMENT,
          dataAuthors: [
            { kind: "account", userId: author.id },
            { kind: "visitor", visitorId: author.visitorId },
          ],
        },
        now: NOW,
      }),
    );
    await eraseAccountTraces(db(), author.id, NOW);
    const [decision] = await decisionsOf("artifact", artifactId);
    expect(decision?.dataAuthors).toEqual([{ kind: "visitor", author: author.visitorId }]);
    // Rows whose decision is gone are pruned with the decisions' history.
    await db()
      .delete(schema.moderationDecisions)
      .where(eq(schema.moderationDecisions.id, decision?.id ?? ""));
    await pruneGoneHistory(db(), NOW);
    expect(
      await db()
        .select()
        .from(schema.moderationDecisionAuthors)
        .where(eq(schema.moderationDecisionAuthors.decisionId, decision?.id ?? "")),
    ).toEqual([]);
  });
});

describe("the statement shown for a brand and an account", () => {
  it("shows a suspended brand's reason and statement on its settings, and not once withheld or lifted", async () => {
    const owner = await user();
    await db()
      .insert(schema.ownerBrands)
      .values({ ownerId: owner.id, name: "Mine", updatedAt: NOW });
    const actor = value(await actorOn(db().global, owner.id, owner.id));
    if (!actor) throw new Error("no actor");
    expect(value(await getBrandSettings(db(), { actor, now: NOW }))).toMatchObject({
      suspended: false,
      reason: null,
      statement: null,
    });
    value(
      await suspendBrand(db(), {
        ownerId: owner.id,
        reason: "impersonation",
        statement: STATEMENT,
        now: NOW,
      }),
    );
    expect(value(await getBrandSettings(db(), { actor, now: NOW }))).toMatchObject({
      suspended: true,
      reason: "impersonation",
      statement: { facts: STATEMENT.facts, ground: STATEMENT.ground, source: "notice" },
    });
    value(
      await reinstateBrand(db(), {
        ownerId: owner.id,
        statement: { facts: "Back.", source: "review", withhold: false },
        now: NOW + 1,
      }),
    );
    value(
      await suspendBrand(db(), {
        ownerId: owner.id,
        reason: "spam",
        statement: { ...STATEMENT, withhold: true },
        now: NOW + 2,
      }),
    );
    expect(value(await getBrandSettings(db(), { actor, now: NOW + 2 }))).toMatchObject({
      suspended: true,
      reason: "spam",
      statement: null,
    });
  });

  it("shows a suspended account its reason and statement, and nothing otherwise", async () => {
    const owner = await user();
    expect(await accountSuspensionView(db(), owner.id)).toEqual({
      suspended: false,
      reason: null,
      statement: null,
    });
    value(
      await suspendAccount(db(), {
        userId: owner.id,
        reason: "malware",
        statement: STATEMENT,
        now: NOW,
      }),
    );
    expect(await accountSuspensionView(db(), owner.id)).toEqual({
      suspended: true,
      reason: "malware",
      statement: {
        facts: STATEMENT.facts,
        ground: STATEMENT.ground,
        source: "notice",
        decidedAt: new Date(NOW).toISOString(),
      },
    });
    value(await reinstateAccount(db(), { userId: owner.id, now: NOW + 1 }));
    expect((await accountSuspensionView(db(), owner.id)).suspended).toBe(false);
  });
});

describe("sending a statement once silence ends", () => {
  it("sends the withheld statement of an open suspension once, with the same recipients and rules", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    value(
      await suspendArtifact(db(), {
        artifactId,
        reason: "child_safety",
        statement: { ...STATEMENT, withhold: true },
        now: NOW,
      }),
    );
    expect(await suspensionStatement(db(), artifactId)).toBeNull();
    const sent = value(
      await sendSuspensionStatement(db(), {
        targetKind: "artifact",
        targetId: artifactId,
        now: NOW + 1,
      }),
    );
    expect(sent.recorded).toBe(false);
    expect(await suspensionStatement(db(), artifactId)).toMatchObject({ facts: STATEMENT.facts });
    const mail = notifiers();
    await runJobsAbout(sent.decisionId, mail.deps);
    expect(mail.moderation.map((notice) => notice.to)).toEqual([owner.email]);
    // Nothing withheld is left: a second call refuses, and sends nothing.
    expect(
      await sendSuspensionStatement(db(), {
        targetKind: "artifact",
        targetId: artifactId,
        now: NOW + 2,
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("records and sends a new statement for an open suspension, and refuses one that is not open", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    value(await suspendArtifact(db(), { artifactId, reason: "spam", now: NOW }));
    const recorded = value(
      await sendSuspensionStatement(db(), {
        targetKind: "artifact",
        targetId: artifactId,
        statement: { facts: "Later facts.", ground: "AUP: spam.", source: "review" },
        now: NOW + 1,
      }),
    );
    expect(recorded.recorded).toBe(true);
    expect(await suspensionStatement(db(), artifactId)).toMatchObject({ facts: "Later facts." });
    expect(await jobsAbout(recorded.decisionId)).toHaveLength(1);
    const other = await publishSite(owner.id);
    expect(
      await sendSuspensionStatement(db(), {
        targetKind: "artifact",
        targetId: other.artifactId,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    // An account and a brand work the same way.
    value(
      await suspendAccount(db(), {
        userId: owner.id,
        reason: "spam",
        statement: { ...STATEMENT, withhold: true },
        now: NOW + 2,
      }),
    );
    expect(
      value(
        await sendSuspensionStatement(db(), {
          targetKind: "account",
          targetId: owner.id,
          now: NOW + 3,
        }),
      ).recorded,
    ).toBe(false);
    await db().insert(schema.ownerBrands).values({ ownerId: owner.id, name: "B", updatedAt: NOW });
    value(
      await suspendBrand(db(), {
        ownerId: owner.id,
        reason: "spam",
        statement: { ...STATEMENT, withhold: true },
        now: NOW + 4,
      }),
    );
    expect(
      value(
        await sendSuspensionStatement(db(), {
          targetKind: "brand",
          targetId: owner.id,
          now: NOW + 5,
        }),
      ).recorded,
    ).toBe(false);
    expect(
      await sendSuspensionStatement(db(), { targetKind: "brand", targetId: "u_none", now: NOW }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
  });
});

describe("the jobs", () => {
  it("wait where the sender is missing, and end when the decision or report is gone or done", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    value(
      await suspendArtifact(db(), { artifactId, reason: "spam", statement: STATEMENT, now: NOW }),
    );
    const [decision] = await decisionsOf("artifact", artifactId);
    await expect(runJobsAbout(decision?.id ?? "", {} as never)).rejects.toThrow(
      "moderation_notice needs the moderation notifier",
    );
    await submitAbuseReport(db(), {
      artifactId,
      reason: "spam",
      details: undefined,
      email: "someone@example.test",
      emailKey: `k-${crypto.randomUUID()}`,
      now: NOW,
    });
    const [report] = (await listAbuseReports(db().global, { status: "open", limit: 500 })).filter(
      (r) => r.artifactId === artifactId,
    );
    value(
      await resolveAbuseReport(db().global, {
        reportId: report?.id ?? "",
        status: "dismissed",
        now: NOW,
      }),
    );
    await expect(runJobsAbout(report?.id ?? "", {} as never)).rejects.toThrow(
      "report_outcome needs the report notifier",
    );
    // A job whose decision is already told, or whose report is not pending, does nothing.
    const sent = notifiers();
    await runJobsAbout(decision?.id ?? "", sent.deps);
    await db()
      .insert(schema.outbox)
      .values([
        {
          topic: "moderation_notice",
          payload: {},
          availableAt: NOW,
          createdAt: NOW,
          subject: decision?.id ?? "",
        },
        {
          topic: "report_outcome",
          payload: {},
          availableAt: NOW,
          createdAt: NOW,
          subject: "rep_none",
        },
      ]);
    expect(await runJobsAbout(decision?.id ?? "", sent.deps)).toEqual(["stale"]);
    expect(await runJobsAbout("rep_none", sent.deps)).toEqual(["stale"]);
    expect(sent.moderation).toHaveLength(1);
  });
});

describe("reports and their outcome", () => {
  it("keeps the full notice, never the name of a report about minors", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    for (const reason of ["phishing", "child_safety"] as const) {
      await submitAbuseReport(db(), {
        artifactId,
        reason,
        details: "Explained",
        email: "reporter@example.test",
        emailKey: `k-${crypto.randomUUID()}`,
        address: `https://${artifactId}.portifact.dev/Login?x=1`,
        name: "Ada Lovelace",
        confirmed: true,
        locale: "es",
        now: NOW,
      });
    }
    const reports = (await listAbuseReports(db().global, { limit: 500 })).filter(
      (report) => report.artifactId === artifactId,
    );
    expect(reports.find((r) => r.reason === "phishing")).toMatchObject({
      address: `https://${artifactId}.portifact.dev/Login?x=1`,
      reporterName: "Ada Lovelace",
      confirmed: true,
      locale: "es",
    });
    expect(reports.find((r) => r.reason === "child_safety")).toMatchObject({ reporterName: null });
  });

  it("tells the reporter the outcome once, in their language, and nobody when withheld or without an email", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    const submit = (email: string | undefined) =>
      submitAbuseReport(db(), {
        artifactId,
        reason: "spam",
        details: undefined,
        email,
        emailKey: `k-${crypto.randomUUID()}`,
        address: `https://${artifactId}.portifact.dev/page`,
        locale: "de",
        now: NOW,
      });
    await submit("one@example.test");
    await submit("two@example.test");
    await submit(undefined);
    const reports = (await listAbuseReports(db().global, { status: "open", limit: 500 })).filter(
      (report) => report.artifactId === artifactId,
    );
    const [first, second, anonymous] = [
      reports.find((r) => r.reporterEmail === "one@example.test"),
      reports.find((r) => r.reporterEmail === "two@example.test"),
      reports.find((r) => r.reporterEmail === null),
    ];
    expect(
      value(
        await resolveAbuseReport(db().global, {
          reportId: first?.id ?? "",
          status: "dismissed",
          now: NOW + 1,
        }),
      ),
    ).toMatchObject({ notice: "pending" });
    expect(
      value(
        await resolveAbuseReport(db().global, {
          reportId: second?.id ?? "",
          status: "actioned",
          withhold: true,
          now: NOW + 1,
        }),
      ),
    ).toMatchObject({ notice: "withheld" });
    expect(await jobsAbout(second?.id ?? "")).toEqual([]);
    expect(
      value(
        await resolveAbuseReport(db().global, {
          reportId: anonymous?.id ?? "",
          status: "actioned",
          now: NOW + 1,
        }),
      ),
    ).toMatchObject({ notice: "none" });
    // Changing a resolved report tells nobody again.
    expect(
      value(
        await resolveAbuseReport(db().global, {
          reportId: first?.id ?? "",
          status: "actioned",
          now: NOW + 2,
        }),
      ),
    ).toMatchObject({ notice: "unchanged" });

    const sent = notifiers();
    expect(await runJobsAbout(first?.id ?? "", sent.deps, NOW + 3)).toEqual(["done"]);
    expect(sent.outcomes).toEqual([
      {
        to: "one@example.test",
        locale: "de",
        outcome: "actioned",
        artifactId,
        reportedAt: NOW,
      },
    ]);
    const after = (await listAbuseReports(db().global, { limit: 500 })).find(
      (r) => r.id === first?.id,
    );
    expect(after).toMatchObject({ outcomeNotice: "sent", outcomeNotifiedAt: NOW + 3 });
    expect(
      await resolveAbuseReport(db().global, {
        reportId: "rep_missing",
        status: "actioned",
        now: NOW,
      }),
    ).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("emails one address at most the daily limit of outcomes, counted like the other email limits", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    const email = `target-${crypto.randomUUID()}@example.test`;
    const emailKey = await keyedHash("test-secret-long-enough", email);
    const ids: string[] = [];
    for (let i = 0; i <= REPORT_LIMITS.outcomeEmailsPerRecipient.max; i += 1) {
      await submitAbuseReport(db(), {
        artifactId,
        reason: "spam",
        details: `report ${i}`,
        email,
        emailKey,
        address: `https://${artifactId}.portifact.dev/a?n=${i}`,
        now: NOW + i,
      });
    }
    const reports = (await listAbuseReports(db().global, { status: "open", limit: 500 })).filter(
      (report) => report.reporterEmail === email,
    );
    for (const report of reports) {
      ids.push(report.id);
      value(
        await resolveAbuseReport(db().global, {
          reportId: report.id,
          status: "dismissed",
          now: NOW,
        }),
      );
    }
    const sent = notifiers();
    for (const id of ids) await runJobsAbout(id, sent.deps, NOW + 10);
    expect(sent.outcomes).toHaveLength(REPORT_LIMITS.outcomeEmailsPerRecipient.max);
    // Only the origin: never the path or anything the reporter typed.
    expect(sent.outcomes.every((notice) => notice.artifactId === artifactId)).toBe(true);
    expect(JSON.stringify(sent.outcomes)).not.toContain("?n=");
    const states = (await listAbuseReports(db().global, { limit: 500 }))
      .filter((report) => report.reporterEmail === email)
      .map((report) => report.outcomeNotice)
      .sort();
    expect(states.filter((state) => state === "sent")).toHaveLength(
      REPORT_LIMITS.outcomeEmailsPerRecipient.max,
    );
    expect(states.filter((state) => state === "undeliverable")).toHaveLength(1);
    // Counted under the keyed hash the sign-in limits use, never a plain hash of the address.
    const plain = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email))),
    ]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const keys = (
      await env.DB.prepare("select key from rate_limits where key like 'report-outcome:%'").all<{
        key: string;
      }>()
    ).results.map((row) => row.key);
    expect(keys).toContain(`report-outcome:${emailKey}`);
    expect(keys.some((key) => key.includes(plain))).toBe(false);
  });

  it("emails the outcome once when two runs overlap, and gives the claim back when a send fails", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    const email = `twice-${crypto.randomUUID()}@example.test`;
    await submitAbuseReport(db(), {
      artifactId,
      reason: "spam",
      details: undefined,
      email,
      emailKey: `k-${crypto.randomUUID()}`,
      now: NOW,
    });
    const [report] = (await listAbuseReports(db().global, { status: "open", limit: 500 })).filter(
      (r) => r.reporterEmail === email,
    );
    value(
      await resolveAbuseReport(db().global, {
        reportId: report?.id ?? "",
        status: "actioned",
        now: NOW,
      }),
    );
    await expect(runJobsAbout(report?.id ?? "", notifiers(true).deps)).rejects.toThrow();
    // The failed send gave its place in the address's daily count back.
    const counted = await env.DB.prepare("select count from rate_limits where key = ?")
      .bind(`report-outcome:${report?.reporterEmailKey}`)
      .first<{ count: number }>();
    expect(counted?.count ?? 0).toBe(0);
    const [row] = await jobsAbout(report?.id ?? "");
    const sends: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = {
      reportOutcomeNotifier: {
        async send(notice: ReportOutcomeNotice) {
          sends.push(notice.to);
          await gate;
        },
      },
    };
    const message = { id: row?.id ?? 0, topic: "report_outcome" } as JobMessage;
    const runs = [
      runJob(db(), env.ARTIFACTS, message, NOW, slow),
      runJob(db(), env.ARTIFACTS, message, NOW, slow),
    ];
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await Promise.all(runs);
    expect(sends).toEqual([email]);
  });

  it("marks the outcome undeliverable when the reporter's email is gone or suppressed", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    for (const email of ["gone@example.test", "bounced@example.test"]) {
      await submitAbuseReport(db(), {
        artifactId,
        reason: "spam",
        details: undefined,
        email,
        emailKey: `k-${crypto.randomUUID()}`,
        now: NOW,
      });
    }
    const reports = (await listAbuseReports(db().global, { status: "open", limit: 500 })).filter(
      (report) => report.artifactId === artifactId,
    );
    for (const report of reports) {
      value(
        await resolveAbuseReport(db().global, {
          reportId: report.id,
          status: "dismissed",
          now: NOW,
        }),
      );
    }
    const gone = reports.find((r) => r.reporterEmail === "gone@example.test");
    await db()
      .global.update(schema.abuseReports)
      .set({ reporterEmail: null })
      .where(eq(schema.abuseReports.id, gone?.id ?? ""));
    await suppressEmail(db().global, {
      email: "bounced@example.test",
      reason: "hard_bounce",
      now: NOW,
    });
    const sent = notifiers();
    for (const report of reports) await runJobsAbout(report.id, sent.deps);
    expect(sent.outcomes).toEqual([]);
    const after = (await listAbuseReports(db().global, { limit: 500 })).filter(
      (report) => report.artifactId === artifactId,
    );
    expect(after.map((report) => report.outcomeNotice)).toEqual(["undeliverable", "undeliverable"]);
  });
});
