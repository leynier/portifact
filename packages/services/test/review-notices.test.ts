// Review events and emails (decisions 0009 and 0013): the `review.requested` and
// `review.completed` webhook events and the `review_notice` job ride in the batch of the write
// that causes them, on its own condition, with no extra round trip; the job fans out into one
// email per recipient account, sent at most once per person, artifact, version and kind, and
// checked again at send time (account, opt-out, request, plan, access, owner side, mute,
// suppression, capacity). Notes and other reviewers' names never leave.
import { env } from "cloudflare:test";
import { APPROVALS, type JobMessage, WEBHOOK_LIMITS } from "@portifact/contracts";
import { globalDb, regionalDb, schema } from "@portifact/db";
import {
  checkCommentNoticeCapacity,
  checkReviewNoticeCapacity,
  emailDay,
  personalActor,
  REVIEW_NOTICE_EMAILS_PER_CYCLE,
} from "@portifact/domain";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { updateAccess } from "../src/access.ts";
import { requestAccountDeletion } from "../src/account-data.ts";
import {
  cancelApprovalReview,
  changeApprovalReview,
  recheckApprovalReviewers,
  requestApprovalReview,
  submitApprovalVerdict,
} from "../src/approval-reviews.ts";
import { RecipientSuppressedError, suppressEmail } from "../src/email.ts";
import { runJob } from "../src/outbox.ts";
import type { ReviewNotifier } from "../src/review-notices.ts";
import { createServiceToken } from "../src/service-tokens.ts";
import { transferArtifact } from "../src/transfer.ts";
import { webhookKeys } from "../src/webhook-keys.ts";
import { createWebhook, deliverWebhook, type WebhookDeps } from "../src/webhooks.ts";
import { DAY, db, grantPlan, NOW, publishSite, racing, session, user, value } from "./fixtures.ts";

type Person = { id: string; email: string };
type Notice = Parameters<ReviewNotifier["send"]>[0];

const KEY_TEXT = "review-notices-test-key-0123456789abcdef";
const NOTE = "PRIVATE NOTE: the numbers on page 3 are wrong";

/** A notifier that records what it sends, or fails the way it is told to. */
function mailbox(fail?: unknown) {
  const sent: Notice[] = [];
  const notifier: ReviewNotifier = {
    async send(notice) {
      if (fail) throw fail;
      sent.push(notice);
    },
  };
  return { sent, notifier };
}

/** An owner on Team (or the given overrides) with one restricted artifact shared with readers. */
async function setup(readers: Person[], overrides?: unknown, now = NOW) {
  const owner = await user("Owner");
  await grantPlan(owner.id, "team", { overrides });
  const published = await publishSite(owner.id, undefined, now);
  value(
    await updateAccess(db(), {
      userId: owner.id,
      artifactId: published.artifactId,
      change: { addReaders: readers.map((r) => r.email) },
      now,
    }),
  );
  return { owner, ...published };
}

async function jobs() {
  return db()
    .select()
    .from(schema.outbox)
    .where(eq(schema.outbox.topic, "review_notice"))
    .orderBy(schema.outbox.id);
}

async function jobsAbout(subjects: string[]) {
  return (await jobs()).filter((job) => subjects.includes(job.subject ?? ""));
}

/** Runs every `review_notice` job about these subjects (requests, then recipients) until none is left. */
async function drain(subjects: string[], notifier: ReviewNotifier, now = NOW + 10) {
  const outcomes: string[] = [];
  for (let round = 0; round < 4; round += 1) {
    const due = await jobs();
    const mine = due.filter(
      (job) =>
        subjects.includes(job.subject ?? "") ||
        (job.payload as { stage?: string; requestId?: string }).stage === "send",
    );
    if (mine.length === 0) break;
    for (const job of mine) {
      const message: JobMessage = { id: job.id, topic: "review_notice" };
      outcomes.push(
        await runJob(db(), env.ARTIFACTS, message, now, { reviewNotifier: notifier }).catch(
          () => "threw",
        ),
      );
    }
  }
  return outcomes;
}

async function requestIdOf(artifactId: string) {
  const [row] = await db()
    .select({ id: schema.reviewRequests.id })
    .from(schema.reviewRequests)
    .where(eq(schema.reviewRequests.artifactId, artifactId));
  return row?.id ?? "";
}

const ask = (owner: Person, artifactId: string, reviewers: string[], now = NOW) =>
  requestApprovalReview(db(), { userId: owner.id, artifactId, reviewers, now });

const judge = (who: Person, artifactId: string, verdict: "approve" | "changes", now = NOW + 1) =>
  submitApprovalVerdict(db(), { userId: who.id, artifactId, verdict, note: NOTE, now });

describe("review emails to reviewers", () => {
  it("emails each reviewer with an account once, naming nobody and holding no note", async () => {
    const [ana, ben] = [await user("Ana"), await user("Ben")];
    const nobody = "never-signed-in@example.test";
    const { owner, artifactId, versionId } = await setup([ana, ben, { id: "", email: nobody }]);
    value(await ask(owner, artifactId, [ana.email, ben.email, nobody]));
    const requestId = await requestIdOf(artifactId);
    const [event] = await jobsAbout([requestId]);
    // The event job carries IDs and a time only.
    expect(event?.payload).toEqual({
      stage: "event",
      kind: "requested",
      versionId,
      addedAt: NOW,
    });
    const box = mailbox();
    await drain([requestId], box.notifier);
    expect(box.sent.map((n) => n.to).sort()).toEqual([ana.email, ben.email].sort());
    for (const notice of box.sent) {
      expect(notice).toMatchObject({
        kind: "requested",
        status: null,
        artifactId,
        version: 1,
        locale: null,
      });
      expect(JSON.stringify(notice)).not.toContain(NOTE);
      expect(JSON.stringify(notice)).not.toContain("Ben");
    }
    // Every email is counted for the budget.
    const [count] = await db()
      .select()
      .from(schema.emailCounters)
      .where(eq(schema.emailCounters.day, emailDay(NOW + 10)));
    expect(count?.sent).toBeGreaterThanOrEqual(2);
    // Nothing is left, and running the same message again sends nothing.
    expect(await jobsAbout([requestId, ana.id, ben.id])).toEqual([]);
    expect(
      await runJob(db(), env.ARTIFACTS, { id: event?.id ?? 0, topic: "review_notice" }, NOW, {
        reviewNotifier: box.notifier,
      }),
    ).toBe("done");
    expect(box.sent).toHaveLength(2);
  });

  it("emails a reviewer added later, and never twice for the same version", async () => {
    const [ana, ben] = [await user("Ana"), await user("Ben")];
    const { owner, artifactId } = await setup([ana, ben]);
    value(await ask(owner, artifactId, [ana.email]));
    const requestId = await requestIdOf(artifactId);
    const box = mailbox();
    await drain([requestId], box.notifier);
    const add = (email: string, now: number) =>
      changeApprovalReview(db(), { userId: owner.id, artifactId, add: [email], now });
    const remove = (email: string, now: number) =>
      changeApprovalReview(db(), { userId: owner.id, artifactId, remove: [email], now });
    value(await add(ben.email, NOW + 100));
    await drain([requestId], box.notifier, NOW + 110);
    expect(box.sent.map((n) => n.to)).toEqual([ana.email, ben.email]);
    // Removed and added again on the same version: no second email.
    value(await remove(ana.email, NOW + 200));
    value(await add(ana.email, NOW + 300));
    await drain([requestId], box.notifier, NOW + 310);
    expect(box.sent.map((n) => n.to)).toEqual([ana.email, ben.email]);
    // A change that adds nobody writes no email job.
    value(
      await changeApprovalReview(db(), {
        userId: owner.id,
        artifactId,
        requiredApprovals: 1,
        now: NOW + 400,
      }),
    );
    expect(await jobsAbout([requestId])).toEqual([]);
  });

  it("sends nothing to a reviewer who opted out, is suppressed or lost access before the send", async () => {
    const [ana, ben, cy] = [await user("Ana"), await user("Ben"), await user("Cy")];
    const { owner, artifactId } = await setup([ana, ben, cy]);
    await db()
      .insert(schema.accountSettings)
      .values({ userId: ana.id, commentNotices: false, updatedAt: NOW });
    await suppressEmail(db(), { email: ben.email, reason: "hard_bounce", now: NOW });
    value(await ask(owner, artifactId, [ana.email, ben.email, cy.email]));
    value(
      await updateAccess(db(), {
        userId: owner.id,
        artifactId,
        change: { removeReaders: [cy.email] },
        now: NOW + 5,
      }),
    );
    const box = mailbox();
    await drain([await requestIdOf(artifactId)], box.notifier);
    expect(box.sent).toEqual([]);
  });

  it("writes nothing and sends nothing without comment notices in the owner's plan", async () => {
    const ana = await user("Ana");
    const { owner, artifactId } = await setup([ana], { features: { commentNotices: false } });
    value(await ask(owner, artifactId, [ana.email]));
    expect(await jobsAbout([await requestIdOf(artifactId)])).toEqual([]);
  });

  it("drops a send whose plan lapsed or whose request was cancelled meanwhile", async () => {
    const ana = await user("Ana");
    const lapsed = await setup([ana]);
    value(await ask(lapsed.owner, lapsed.artifactId, [ana.email]));
    const cancelled = await setup([ana]);
    value(await ask(cancelled.owner, cancelled.artifactId, [ana.email]));
    const subjects = [
      await requestIdOf(lapsed.artifactId),
      await requestIdOf(cancelled.artifactId),
    ];
    await grantPlan(lapsed.owner.id, "pro");
    value(
      await cancelApprovalReview(db(), {
        userId: cancelled.owner.id,
        artifactId: cancelled.artifactId,
        now: NOW + 2,
      }),
    );
    const box = mailbox();
    await drain(subjects, box.notifier);
    expect(box.sent).toEqual([]);
  });

  it("puts a failed send back and sends it on the next run, once", async () => {
    const ana = await user("Ana");
    const { owner, artifactId } = await setup([ana]);
    value(await ask(owner, artifactId, [ana.email]));
    const requestId = await requestIdOf(artifactId);
    const outcomes = await drain([requestId], mailbox(new Error("provider down")).notifier);
    expect(outcomes).toContain("threw");
    const [back] = await jobsAbout([ana.id]);
    expect(back?.payload).toMatchObject({ stage: "send", kind: "requested", requestId });
    const box = mailbox();
    await drain([ana.id], box.notifier);
    expect(box.sent.map((n) => n.to)).toEqual([ana.email]);
  });

  it("suppresses an address the provider refuses, without putting the job back", async () => {
    const ana = await user("Ana");
    const { owner, artifactId } = await setup([ana]);
    value(await ask(owner, artifactId, [ana.email]));
    await drain([await requestIdOf(artifactId)], mailbox(new RecipientSuppressedError()).notifier);
    expect(await jobsAbout([ana.id])).toEqual([]);
    const [row] = await db().select().from(schema.emailSuppressions);
    expect(row).toBeDefined();
  });

  it("stops before comment notices do when the cycle runs low", async () => {
    // The ladder: review notices stop 5,000 emails before comment notices.
    expect(checkReviewNoticeCapacity(REVIEW_NOTICE_EMAILS_PER_CYCLE - 1).ok).toBe(true);
    expect(checkReviewNoticeCapacity(REVIEW_NOTICE_EMAILS_PER_CYCLE)).toMatchObject({
      ok: false,
      code: "capacity_unavailable",
    });
    expect(checkCommentNoticeCapacity(REVIEW_NOTICE_EMAILS_PER_CYCLE).ok).toBe(true);
    const later = NOW + 70 * DAY;
    const ana = await user("Ana");
    const { owner, artifactId } = await setup([ana], undefined, later);
    value(await ask(owner, artifactId, [ana.email], later));
    await db()
      .insert(schema.emailCounters)
      .values({ day: emailDay(later), sent: REVIEW_NOTICE_EMAILS_PER_CYCLE });
    const box = mailbox();
    await drain([await requestIdOf(artifactId)], box.notifier, later + 10);
    expect(box.sent).toEqual([]);
  });

  it("closes the account's waiting emails and forgets what was sent when it is deleted", async () => {
    const ana = await user("Ana");
    const { owner, artifactId } = await setup([ana]);
    value(await ask(owner, artifactId, [ana.email]));
    const requestId = await requestIdOf(artifactId);
    const box = mailbox();
    await drain([requestId], box.notifier);
    expect(
      await db()
        .select()
        .from(schema.reviewNotices)
        .where(eq(schema.reviewNotices.recipientId, ana.id)),
    ).toHaveLength(1);
    // A send job still waiting for the account goes with it too.
    await db()
      .insert(schema.outbox)
      .values({ topic: "review_notice", payload: {}, availableAt: NOW, subject: ana.id });
    value(
      await requestAccountDeletion(db(), {
        userId: ana.id,
        sessionId: await session(ana.id),
        confirmEmail: ana.email,
        now: NOW + 20,
      }),
    );
    expect(await jobsAbout([ana.id])).toEqual([]);
    expect(
      await db()
        .select()
        .from(schema.reviewNotices)
        .where(eq(schema.reviewNotices.recipientId, ana.id)),
    ).toEqual([]);
  });
});

describe("who is asked by email", () => {
  /** An owner on Team whose artifact is open to every signed-in person, with `readers` listed. */
  async function openArtifact(readers: Person[]) {
    const made = await setup(readers);
    value(
      await updateAccess(db(), {
        userId: made.owner.id,
        artifactId: made.artifactId,
        change: { mode: "authenticated" },
        now: NOW,
      }),
    );
    return made;
  }

  it("emails only people the artifact already has a relationship with, never anyone signed in", async () => {
    const [ana, stranger] = [await user("Ana"), await user("Stranger")];
    const { owner, artifactId } = await openArtifact([ana]);
    // Both can open it and be named; only the listed reader is told by email.
    value(await ask(owner, artifactId, [ana.email, stranger.email]));
    const box = mailbox();
    await drain([await requestIdOf(artifactId)], box.notifier);
    expect(box.sent.map((n) => n.to)).toEqual([ana.email]);
  });

  it("stops the email when the relationship ends before the send", async () => {
    const ana = await user("Ana");
    const { owner, artifactId } = await openArtifact([ana]);
    value(await ask(owner, artifactId, [ana.email]));
    // Still able to open the artifact (it is open to everyone signed in), but no longer listed.
    value(
      await updateAccess(db(), {
        userId: owner.id,
        artifactId,
        change: { removeReaders: [ana.email] },
        now: NOW + 5,
      }),
    );
    const box = mailbox();
    await drain([await requestIdOf(artifactId)], box.notifier);
    expect(box.sent).toEqual([]);
  });

  it("sends no request email when a service token asks, and still tells the people", async () => {
    const [admin, editor, member] = [
      await user("Admin"),
      await user("Editor"),
      await user("Member"),
    ];
    const id = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
    const slug = `t${id.slice(3, 22)}`;
    await db()
      .insert(schema.workspaces)
      .values({ id, slug, name: "Team", createdBy: admin.id, updatedAt: NOW });
    await db()
      .insert(schema.workspaceMembers)
      .values([
        { workspaceId: id, userId: admin.id, role: "admin", updatedAt: NOW },
        { workspaceId: id, userId: editor.id, role: "editor", updatedAt: NOW },
        { workspaceId: id, userId: member.id, role: "member", updatedAt: NOW },
      ]);
    await grantPlan(id, "team", { seats: 5 });
    const prepared = await publishSite(editor.id);
    value(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: editor.id,
        artifactId: prepared.artifactId,
        workspace: slug,
        now: NOW,
      }),
    );
    value(
      await updateAccess(db(), {
        userId: admin.id,
        artifactId: prepared.artifactId,
        change: { mode: "workspace" },
        now: NOW,
      }),
    );
    const token = value(
      await createServiceToken(db().global, {
        userId: admin.id,
        slug,
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
    value(
      await requestApprovalReview(db(), {
        userId: token,
        artifactId: prepared.artifactId,
        reviewers: [member.email],
        now: NOW,
      }),
    );
    const requestId = await requestIdOf(prepared.artifactId);
    expect(await jobsAbout([requestId])).toEqual([]);
    // A person's verdict still tells the people who manage it; the token is never a recipient.
    value(await judge(member, prepared.artifactId, "approve"));
    const box = mailbox();
    await drain([requestId], box.notifier, NOW + 20);
    expect(box.sent.map((n) => n.to).sort()).toEqual([admin.email, editor.email].sort());
  });

  it("caps the review emails one person receives a day, whoever sends them", async () => {
    const ana = await user("Ana");
    const { owner, artifactId } = await setup([ana]);
    await db().run(
      sql`insert into rate_limits (key, window_start, count) values (${`approvals:notices:${ana.id}`}, ${NOW}, ${APPROVALS.noticesPerRecipientPerDay.max})`,
    );
    value(await ask(owner, artifactId, [ana.email]));
    const box = mailbox();
    await drain([await requestIdOf(artifactId)], box.notifier);
    expect(box.sent).toEqual([]);
    // Dropped, not retried, and nothing is left claimed.
    expect(await jobsAbout([ana.id])).toEqual([]);
    expect(
      await db()
        .select()
        .from(schema.reviewNotices)
        .where(eq(schema.reviewNotices.recipientId, ana.id)),
    ).toEqual([]);
  });

  it("gives the count back when a send fails", async () => {
    const ana = await user("Ana");
    const { owner, artifactId } = await setup([ana]);
    value(await ask(owner, artifactId, [ana.email]));
    await drain([await requestIdOf(artifactId)], mailbox(new Error("provider down")).notifier);
    const [row] = await db().all<{ count: number }>(
      sql`select count from rate_limits where key = ${`approvals:notices:${ana.id}`}`,
    );
    expect(row?.count ?? 0).toBe(0);
  });
});

describe("review emails to the owner side", () => {
  it("tells the owner side once per version, never the reviewer who decided it", async () => {
    const [ana, ben] = [await user("Ana"), await user("Ben")];
    const { owner, artifactId } = await setup([ana, ben]);
    value(
      await requestApprovalReview(db(), {
        userId: owner.id,
        artifactId,
        reviewers: [ana.email, ben.email],
        requiredApprovals: 1,
        now: NOW,
      }),
    );
    const requestId = await requestIdOf(artifactId);
    const box = mailbox();
    await drain([requestId], box.notifier);
    box.sent.length = 0;
    value(await judge(ana, artifactId, "approve"));
    await drain([requestId], box.notifier, NOW + 20);
    expect(box.sent).toEqual([
      expect.objectContaining({ to: owner.email, kind: "completed", status: "approved" }),
    ]);
    expect(JSON.stringify(box.sent)).not.toContain(NOTE);
    // A second approval keeps it approved: nothing new is told.
    value(await judge(ben, artifactId, "approve", NOW + 30));
    // Back to pending and approved again on the same version: still one email.
    value(
      await changeApprovalReview(db(), {
        userId: owner.id,
        artifactId,
        requiredApprovals: 2,
        now: NOW + 40,
      }),
    );
    value(
      await changeApprovalReview(db(), {
        userId: owner.id,
        artifactId,
        requiredApprovals: 1,
        now: NOW + 50,
      }),
    );
    await drain([requestId], box.notifier, NOW + 60);
    expect(box.sent).toHaveLength(1);
  });

  it("tells a workspace's admins and editors, not its members or the reviewer who decided", async () => {
    const [admin, editor, member, ana] = [
      await user("Admin"),
      await user("Editor"),
      await user("Member"),
      await user("Ana"),
    ];
    const id = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
    await db()
      .insert(schema.workspaces)
      .values({
        id,
        slug: `t${id.slice(3, 22)}`,
        name: "Team",
        createdBy: admin.id,
        updatedAt: NOW,
      });
    await db()
      .insert(schema.workspaceMembers)
      .values([
        { workspaceId: id, userId: admin.id, role: "admin", updatedAt: NOW },
        { workspaceId: id, userId: editor.id, role: "editor", updatedAt: NOW },
        { workspaceId: id, userId: member.id, role: "member", updatedAt: NOW },
      ]);
    await grantPlan(id, "team", { seats: 5 });
    const prepared = await publishSite(editor.id);
    // Move it into the workspace like a publish there would.
    const published = { artifactId: prepared.artifactId };
    value(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: editor.id,
        artifactId: prepared.artifactId,
        workspace: `t${id.slice(3, 22)}`,
        now: NOW,
      }),
    );
    value(
      await updateAccess(db(), {
        userId: admin.id,
        artifactId: published.artifactId,
        change: { addReaders: [ana.email] },
        now: NOW,
      }),
    );
    value(
      await requestApprovalReview(db(), {
        userId: editor.id,
        artifactId: published.artifactId,
        reviewers: [ana.email, editor.email],
        requiredApprovals: 1,
        now: NOW,
      }),
    );
    const requestId = await requestIdOf(published.artifactId);
    const box = mailbox();
    await drain([requestId], box.notifier);
    box.sent.length = 0;
    // The editor's own verdict makes it final: the editor is not told about their own act.
    value(await judge(editor, published.artifactId, "changes"));
    await drain([requestId], box.notifier, NOW + 20);
    expect(box.sent.map((n) => [n.to, n.status])).toEqual([[admin.email, "changes_requested"]]);
  });

  it("tells the owner side when a scan or an access change makes the status final", async () => {
    const [ana, ben] = [await user("Ana"), await user("Ben")];
    const { owner, artifactId } = await setup([ana, ben]);
    value(await ask(owner, artifactId, [ana.email, ben.email]));
    value(await judge(ana, artifactId, "approve"));
    const requestId = await requestIdOf(artifactId);
    const box = mailbox();
    await drain([requestId], box.notifier);
    box.sent.length = 0;
    // Ben stops counting with the removal: Ana's approval is now every counting reviewer's.
    value(
      await updateAccess(db(), {
        userId: owner.id,
        artifactId,
        change: { removeReaders: [ben.email] },
        now: NOW + 30,
      }),
    );
    await drain([requestId], box.notifier, NOW + 40);
    expect(box.sent.map((n) => [n.to, n.status])).toEqual([[owner.email, "approved"]]);
    // The scan finds nothing new to tell.
    await recheckApprovalReviewers(db(), NOW + 50);
    await drain([requestId], box.notifier, NOW + 60);
    expect(box.sent).toHaveLength(1);
  });

  it("writes nothing when a verdict loses its race with a cancel", async () => {
    const ana = await user("Ana");
    const { owner, artifactId } = await setup([ana]);
    value(await ask(owner, artifactId, [ana.email]));
    const requestId = await requestIdOf(artifactId);
    await drain([requestId], mailbox().notifier);
    const raced = racing(() =>
      cancelApprovalReview(db(), { userId: owner.id, artifactId, now: NOW }),
    );
    const result = await submitApprovalVerdict(raced, {
      userId: ana.id,
      artifactId,
      verdict: "approve",
      now: NOW + 1,
    });
    expect(result.ok).toBe(false);
    expect(await jobsAbout([requestId])).toEqual([]);
  });
});

describe("review webhook events", () => {
  const keys = () => webhookKeys({ current: KEY_TEXT });

  async function hook(ownerId: string) {
    return value(
      await createWebhook(db(), {
        service: { enabled: true },
        via: "dashboard",
        actor: personalActor(ownerId),
        webhook: {
          url: "https://hooks.example.com/in",
          format: "generic",
          events: ["review.requested", "review.completed"],
        },
        keys: await keys(),
        now: NOW,
      }),
    ).webhook;
  }

  async function deliver(webhookId: string, now: number) {
    const sent: string[] = [];
    const deps: WebhookDeps = {
      keys: await keys(),
      fetch: async (_url, init) => {
        sent.push(String(init.body));
        return new Response("ok");
      },
      appOrigin: "https://app.portifact.test",
      contentDomain: "portifact.test",
      enabled: true,
    };
    const rows = await db()
      .select()
      .from(schema.outbox)
      .where(
        and(eq(schema.outbox.topic, "webhook_delivery"), eq(schema.outbox.subject, webhookId)),
      );
    for (const row of rows) await deliverWebhook(db(), row, now, deps);
    return sent.map((body) => JSON.parse(body) as { events: Record<string, unknown>[] });
  }

  it("records a request and a final status with the version and counts, never names or notes", async () => {
    const [ana, ben] = [await user("Ana"), await user("Ben")];
    const { owner, artifactId } = await setup([ana, ben]);
    const webhook = await hook(owner.id);
    value(await ask(owner, artifactId, [ana.email, ben.email]));
    value(await judge(ana, artifactId, "approve"));
    // Still pending: no completed event yet.
    value(await judge(ben, artifactId, "changes", NOW + 2));
    const [delivery] = await deliver(webhook.id, NOW + WEBHOOK_LIMITS.coalesceMs + 1);
    const events = delivery?.events ?? [];
    expect(events.map((e) => [e.type, e.version, e.review, e.count])).toEqual([
      [
        "review.requested",
        1,
        { status: "pending", reviewers: 2, required: 2, approvals: 0, changesRequested: 0 },
        1,
      ],
      [
        "review.completed",
        1,
        {
          status: "changes_requested",
          reviewers: 2,
          required: 2,
          approvals: 1,
          changesRequested: 1,
        },
        1,
      ],
    ]);
    // The requester on the owner side may be named; a reviewer never is.
    expect(events[0]?.actor).toEqual({ name: "Owner" });
    expect(events[1]?.actor).toBeNull();
    const text = JSON.stringify(delivery);
    for (const secret of [NOTE, ana.email, ben.email, "Ana", "Ben"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("records nothing without the feature in the owner's plan", async () => {
    const ana = await user("Ana");
    const { owner, artifactId } = await setup([ana]);
    const webhook = await hook(owner.id);
    await grantPlan(owner.id, "team", { overrides: { features: { webhooks: false } } });
    value(await ask(owner, artifactId, [ana.email]));
    value(await judge(ana, artifactId, "approve"));
    expect(
      await db()
        .select()
        .from(schema.webhookEvents)
        .where(eq(schema.webhookEvents.webhookId, webhook.id)),
    ).toEqual([]);
  });
});

/** The recording proxy of test/audit.test.ts: every D1 round trip, with its statements. */
function recording() {
  const trips: string[][] = [];
  const queries = new WeakMap<object, string>();
  const wrap = (statement: D1PreparedStatement, query: string): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property, receiver) {
        const real = Reflect.get(target, property, receiver);
        if (typeof real !== "function") return real;
        if (property === "bind") {
          return (...args: unknown[]) => wrap(real.apply(target, args), query);
        }
        if (["all", "raw", "run", "first"].includes(String(property))) {
          return (...args: unknown[]) => {
            trips.push([query]);
            return real.apply(target, args);
          };
        }
        return real.bind(target);
      },
    });
    queries.set(wrapped, query);
    return wrapped;
  };
  const d1 = new Proxy(env.DB, {
    get(target, property, receiver) {
      const real = Reflect.get(target, property, receiver);
      if (property === "prepare") return (query: string) => wrap(target.prepare(query), query);
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => {
          trips.push(statements.map((s) => queries.get(s) ?? "?"));
          // biome-ignore lint/suspicious/noExplicitAny: the proxies stand in for D1 statements
          return target.batch(statements as any);
        };
      }
      return typeof real === "function" ? real.bind(target) : real;
    },
  });
  return { database: regionalDb(d1, globalDb(d1)), trips };
}

describe("cost on the review write paths", () => {
  it("adds no round trip: the events ride in the batch of the request, change and verdict", async () => {
    const measure = async (overrides?: unknown) => {
      const [ana, ben] = [await user("Ana"), await user("Ben")];
      const { owner, artifactId } = await setup([ana, ben], overrides);
      if (!overrides) await hook(owner.id);
      const counts: number[] = [];
      const batches: string[] = [];
      for (const run of [
        (d: ReturnType<typeof db>) =>
          requestApprovalReview(d, {
            userId: owner.id,
            artifactId,
            reviewers: [ana.email],
            now: NOW,
          }),
        (d: ReturnType<typeof db>) =>
          changeApprovalReview(d, { userId: owner.id, artifactId, add: [ben.email], now: NOW + 1 }),
        (d: ReturnType<typeof db>) =>
          submitApprovalVerdict(d, {
            userId: ana.id,
            artifactId,
            verdict: "changes",
            now: NOW + 2,
          }),
      ]) {
        const { database, trips } = recording();
        value((await run(database)) as { ok: true; value: unknown });
        counts.push(trips.length);
        batches.push(...trips.filter((trip) => trip.length > 1).map((trip) => trip.join("\n")));
      }
      return { counts, batches };
    };
    async function hook(ownerId: string) {
      await createWebhook(db(), {
        service: { enabled: true },
        via: "dashboard",
        actor: personalActor(ownerId),
        webhook: {
          url: "https://hooks.example.com/in",
          format: "generic",
          events: ["review.requested", "review.completed"],
        },
        keys: await webhookKeys({ current: KEY_TEXT }),
        now: NOW,
      });
    }
    const on = await measure();
    const off = await measure({ features: { commentNotices: false, webhooks: false } });
    expect(on.counts).toEqual(off.counts);
    // With both on, the email job and the webhook statements are in the write's own batches.
    const written = on.batches.join("\n");
    expect(written).toContain('"outbox"');
    expect(written).toContain('"webhook_events"');
    expect(off.batches.join("\n")).not.toContain('"webhook_events"');
  });
});
