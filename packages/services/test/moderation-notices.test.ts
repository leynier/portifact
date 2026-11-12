// Statements of reasons and report outcomes (docs/operations.md, "Reports"): each operator
// decision is recorded in the batch of its change and emailed once to the people affected; the
// reporter learns the outcome; suppressed addresses, a full cycle and a withheld notice are
// honored, and every send is recorded.
import { env } from "cloudflare:test";
import type { JobMessage } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { SIGN_IN_EMAILS_PER_CYCLE } from "@portifact/domain";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getArtifact } from "../src/artifacts.ts";
import { reinstateBrand, suspendBrand } from "../src/branding.ts";
import { recordEmailsSent, suppressEmail } from "../src/email.ts";
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
  listDecisions,
  type ModerationNotice,
  type ReportOutcomeNotice,
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
        artifactName: "Plan",
        workspaceSlug: null,
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
        reported: `https://${artifactId}.portifact.dev/page`,
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

  it("marks the outcome undeliverable when the reporter's email is gone or suppressed", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    for (const email of ["gone@example.test", "bounced@example.test"]) {
      await submitAbuseReport(db(), {
        artifactId,
        reason: "spam",
        details: undefined,
        email,
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
