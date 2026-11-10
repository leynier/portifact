// Review notices on the jobs Worker (decision 0013, "Emails"): the email links the viewer, the
// settings and the same signed unsubscribe link as comment notices; the notifier sends from the
// no-reply address, refuses to send without the secret and hides provider errors; and the queue
// runs a `review_notice` job end to end, once.
import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import { regionsFromEnv, schema } from "@portifact/db";
import { openUnsubscribeToken, RecipientSuppressedError } from "@portifact/services";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index.ts";
import {
  NOTICE_SENDER,
  reviewEmail,
  reviewNotifierFromEnv,
  unsubscribeUrls,
} from "../src/notices.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 12, 9);
const SECRET = "jobs-test-unsubscribe-secret";
const db = () => regionsFromEnv(env).get("default").db;

type Sent = Parameters<SendEmail["send"]>[0] & { headers?: Record<string, string> };

function fakeEmail(error?: unknown) {
  const sent: Sent[] = [];
  const binding = {
    async send(message: Sent) {
      if (error) throw error;
      sent.push(message);
      return { messageId: `m${sent.length}` };
    },
  } as unknown as SendEmail;
  return { binding, sent };
}

const notice = {
  to: "ada@example.com",
  userId: "u_ada",
  issuedAt: NOW,
  kind: "requested" as const,
  status: null,
  artifactId: "r3v13wabcd",
  name: "Launch plan",
  version: 2,
  locale: null,
};

describe("review notice email", () => {
  it("links the viewer, the settings and the unsubscribe page, with one-click headers", () => {
    const email = reviewEmail(env, notice, "cn1.a.1.b");
    const urls = unsubscribeUrls(env.APP_ORIGIN, "cn1.a.1.b");
    expect(email.text).toContain("Review it: https://app.portifact.com/view/r3v13wabcd");
    expect(email.text).toContain("Launch plan (version 2)");
    expect(email.text).toContain(urls.page);
    expect(email.headers).toEqual({
      "List-Unsubscribe": `<${urls.oneClick}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    const done = reviewEmail(
      env,
      { ...notice, kind: "completed", status: "changes_requested", locale: "fr" },
      "t",
    );
    expect(done.subject).toBe("Des modifications ont été demandées sur Portifact");
    expect(done.html).toContain('<html lang="fr"');
    // A completed notice without a status reads as approved.
    expect(reviewEmail(env, { ...notice, kind: "completed" }, "t").subject).toBe(
      "A version was approved on Portifact",
    );
  });
});

describe("reviewNotifierFromEnv", () => {
  it("sends from the no-reply address with a link signed for the recipient", async () => {
    const { binding, sent } = fakeEmail();
    await reviewNotifierFromEnv({ ...env, EMAIL: binding, UNSUBSCRIBE_SECRET: SECRET }).send(
      notice,
    );
    expect(sent[0]).toMatchObject({ from: NOTICE_SENDER, to: "ada@example.com" });
    const header = sent[0]?.headers?.["List-Unsubscribe"] ?? "";
    const token = decodeURIComponent(new URL(header.slice(1, -1)).searchParams.get("token") ?? "");
    expect(await openUnsubscribeToken(SECRET, token)).toEqual({ userId: "u_ada", issuedAt: NOW });
  });

  it("sends nothing without the secret, and hides provider errors", async () => {
    const { binding, sent } = fakeEmail();
    await expect(
      reviewNotifierFromEnv({ ...env, EMAIL: binding, UNSUBSCRIBE_SECRET: undefined }).send(notice),
    ).rejects.toThrow("review notices need UNSUBSCRIBE_SECRET");
    expect(sent).toEqual([]);
    const refused = fakeEmail({ code: "E_RECIPIENT_SUPPRESSED" });
    await expect(
      reviewNotifierFromEnv({ ...env, EMAIL: refused.binding, UNSUBSCRIBE_SECRET: SECRET }).send(
        notice,
      ),
    ).rejects.toBeInstanceOf(RecipientSuppressedError);
    const failing = fakeEmail(new Error("rate limited for ada@example.com"));
    await expect(
      reviewNotifierFromEnv({ ...env, EMAIL: failing.binding, UNSUBSCRIBE_SECRET: SECRET }).send(
        notice,
      ),
    ).rejects.toThrow(/^email delivery failed$/);
  });
});

describe("review notices end to end", () => {
  it("fans a request out and emails the reviewer once from the queue", async () => {
    const ownerId = `u_${crypto.randomUUID()}`;
    const reviewerId = `u_${crypto.randomUUID()}`;
    for (const id of [ownerId, reviewerId]) {
      await db()
        .insert(schema.users)
        .values({
          id,
          name: "Someone",
          email: `${id}@example.test`,
          emailVerified: true,
          createdAt: new Date(NOW - 60 * DAY),
          updatedAt: new Date(NOW),
        });
    }
    await db()
      .insert(schema.ownerPlans)
      .values({ ownerId, plan: "team", seats: 1, grantedBy: "test", updatedAt: NOW });
    await db()
      .insert(schema.artifacts)
      .values({
        id: "r3v13wabcd",
        ownerId,
        type: "site",
        name: "Launch plan",
        state: "active",
        annotations: "open",
        accessMode: "authenticated",
        expiresAt: NOW + 20 * DAY,
      });
    await db().insert(schema.versions).values({
      id: "r3v13wabcd_v1",
      artifactId: "r3v13wabcd",
      number: 1,
      authorId: ownerId,
      state: "committed",
      entrypoint: "index.html",
      publishedBytes: 10,
      committedAt: NOW,
    });
    await db()
      .update(schema.artifacts)
      .set({ currentVersionId: "r3v13wabcd_v1" })
      .where(eq(schema.artifacts.id, "r3v13wabcd"));
    await db().insert(schema.reviewRequests).values({
      id: "ar_jobs",
      artifactId: "r3v13wabcd",
      versionId: "r3v13wabcd_v1",
      requestedBy: ownerId,
      createdAt: NOW,
      updatedAt: NOW,
      checkedAt: NOW,
    });
    // A listed reader: someone with a standing relationship to the artifact is told by email.
    await db()
      .insert(schema.artifactReaders)
      .values({ artifactId: "r3v13wabcd", email: `${reviewerId}@example.test` });
    await db()
      .insert(schema.reviewReviewers)
      .values({ requestId: "ar_jobs", email: `${reviewerId}@example.test`, addedAt: NOW });
    await db()
      .insert(schema.outbox)
      .values({
        topic: "review_notice",
        payload: { stage: "event", kind: "requested", versionId: "r3v13wabcd_v1", addedAt: NOW },
        availableAt: NOW,
        subject: "ar_jobs",
      });

    const { binding, sent } = fakeEmail();
    const testEnv: Env = { ...env, EMAIL: binding, UNSUBSCRIBE_SECRET: SECRET };
    const run = async (id: number, messageId: string) => {
      const batch = createMessageBatch("portifact-jobs", [
        {
          id: messageId,
          timestamp: new Date(NOW),
          attempts: 1,
          body: { id, topic: "review_notice" },
        },
      ]);
      const ctx = createExecutionContext();
      await worker.queue(batch, testEnv);
      expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual([messageId]);
    };
    const [event] = await db()
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.topic, "review_notice"), eq(schema.outbox.subject, "ar_jobs")));
    await run(event?.id ?? 0, "e0");
    const [send] = await db()
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.topic, "review_notice"), eq(schema.outbox.subject, reviewerId)));
    expect(send?.payload).toMatchObject({ stage: "send", kind: "requested", requestId: "ar_jobs" });
    // The same message twice sends one email.
    await run(send?.id ?? 0, "s0");
    await run(send?.id ?? 0, "s1");
    expect(sent.map((m) => m.to)).toEqual([`${reviewerId}@example.test`]);
    expect(sent[0]?.text).toContain("https://app.portifact.com/view/r3v13wabcd");
  });
});
