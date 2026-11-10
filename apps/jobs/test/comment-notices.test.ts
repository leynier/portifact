import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import { regionsFromEnv, schema } from "@portifact/db";
import {
  createAnnotationThread,
  openUnsubscribeToken,
  RecipientSuppressedError,
} from "@portifact/services";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import worker, { type Env, runScheduled } from "../src/index.ts";
import {
  commentEmail,
  commentNotifierFromEnv,
  NOTICE_SENDER,
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

const ACTIVITY = {
  artifactId: "k7d2qm4xab",
  name: "Plan",
  newThreads: 1,
  newReplies: 2,
  resolvedThreads: 0,
};

const notice = {
  to: "ada@example.com",
  userId: "u_ada",
  issuedAt: NOW,
  artifacts: [ACTIVITY],
  more: 0,
  locale: null,
};

describe("comment notice email", () => {
  it("links the viewer, the settings and the unsubscribe page, with one-click headers", () => {
    const email = commentEmail(env, { artifacts: [ACTIVITY], more: 0, locale: null }, "cn1.a.1.b");
    const urls = unsubscribeUrls(env.APP_ORIGIN, "cn1.a.1.b");
    expect(urls).toEqual({
      page: "https://app.portifact.com/unsubscribe?token=cn1.a.1.b",
      oneClick: "https://app.portifact.com/api/v1/notices/unsubscribe?token=cn1.a.1.b",
    });
    expect(email.text).toContain("Open comments: https://app.portifact.com/view/k7d2qm4xab");
    expect(email.text).toContain("https://app.portifact.com/settings");
    expect(email.text).toContain(urls.page);
    expect(email.headers).toEqual({
      "List-Unsubscribe": `<${urls.oneClick}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    const german = commentEmail(env, { artifacts: [ACTIVITY], more: 0, locale: "de" }, "t.o.k.n");
    expect(german.html).toContain('<html lang="de"');
  });
});

describe("commentNotifierFromEnv", () => {
  it("sends from the no-reply address with a link signed for the recipient", async () => {
    const { binding, sent } = fakeEmail();
    await commentNotifierFromEnv({ ...env, EMAIL: binding, UNSUBSCRIBE_SECRET: SECRET }).send(
      notice,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: NOTICE_SENDER, to: "ada@example.com" });
    const header = sent[0]?.headers?.["List-Unsubscribe"] ?? "";
    const token = decodeURIComponent(new URL(header.slice(1, -1)).searchParams.get("token") ?? "");
    expect(await openUnsubscribeToken(SECRET, token)).toEqual({ userId: "u_ada", issuedAt: NOW });
    expect(sent[0]?.text).toContain(encodeURIComponent(token));
  });

  it("sends nothing without the secret", async () => {
    const { binding, sent } = fakeEmail();
    await expect(
      commentNotifierFromEnv({ ...env, EMAIL: binding, UNSUBSCRIBE_SECRET: undefined }).send(
        notice,
      ),
    ).rejects.toThrow("comment notices need UNSUBSCRIBE_SECRET");
    expect(sent).toEqual([]);
  });

  it("turns a suppression refusal into RecipientSuppressedError and hides other errors", async () => {
    const refused = fakeEmail({ code: "E_RECIPIENT_SUPPRESSED" });
    await expect(
      commentNotifierFromEnv({ ...env, EMAIL: refused.binding, UNSUBSCRIBE_SECRET: SECRET }).send(
        notice,
      ),
    ).rejects.toBeInstanceOf(RecipientSuppressedError);
    const failing = fakeEmail(new Error("rate limited for ada@example.com"));
    await expect(
      commentNotifierFromEnv({ ...env, EMAIL: failing.binding, UNSUBSCRIBE_SECRET: SECRET }).send(
        notice,
      ),
    ).rejects.toThrow(/^email delivery failed$/);
  });
});

describe("comment notices end to end", () => {
  it("schedules on the run and emails the owner once from the queue", async () => {
    const ownerId = `u_${crypto.randomUUID()}`;
    const readerId = `u_${crypto.randomUUID()}`;
    for (const id of [ownerId, readerId]) {
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
      .values({ ownerId, plan: "pro", seats: 1, grantedBy: "test", updatedAt: NOW });
    await db()
      .insert(schema.artifacts)
      .values({
        id: "c0mm3nt5ab",
        ownerId,
        type: "site",
        name: "Launch plan",
        state: "active",
        annotations: "open",
        accessMode: "authenticated",
        expiresAt: NOW + 20 * DAY,
      });
    await db().insert(schema.versions).values({
      id: "c0mm3nt5ab_v1",
      artifactId: "c0mm3nt5ab",
      number: 1,
      authorId: ownerId,
      state: "committed",
      entrypoint: "index.html",
      publishedBytes: 10,
      committedAt: NOW,
    });
    await db()
      .insert(schema.versionFiles)
      .values({
        versionId: "c0mm3nt5ab_v1",
        kind: "published",
        path: "index.html",
        ownerId,
        sha256: "b".repeat(64),
        size: 10,
        contentType: "text/html",
      });
    await db()
      .update(schema.artifacts)
      .set({ currentVersionId: "c0mm3nt5ab_v1" })
      .where(eq(schema.artifacts.id, "c0mm3nt5ab"));
    const created = await createAnnotationThread(db(), {
      userId: readerId,
      artifactId: "c0mm3nt5ab",
      versionId: "c0mm3nt5ab_v1",
      target: { schema: 1, path: "index.html", anchor: { kind: "document" } },
      body: "Never in an email",
      humanCheck: { token: "solved", verify: async () => "passed" },
      now: NOW,
    });
    expect(created.ok).toBe(true);

    const later = NOW + 15 * 60_000;
    expect(await runScheduled(env, later)).toMatchObject({ commentNotices: 1 });
    const [job] = await db().select().from(schema.outbox).where(eq(schema.outbox.subject, ownerId));
    expect(job?.topic).toBe("comment_notice");

    const { binding, sent } = fakeEmail();
    const testEnv: Env = { ...env, EMAIL: binding, UNSUBSCRIBE_SECRET: SECRET };
    for (const id of ["m0", "m1"]) {
      const batch = createMessageBatch("portifact-jobs", [
        {
          id,
          timestamp: new Date(later),
          attempts: 1,
          body: { id: job?.id, topic: "comment_notice" },
        },
      ]);
      const ctx = createExecutionContext();
      await worker.queue(batch, testEnv);
      expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual([id]);
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(`${ownerId}@example.test`);
    expect(sent[0]?.text).toContain("Launch plan");
    expect(sent[0]?.text).toContain("1 new thread");
    expect(`${sent[0]?.text}${sent[0]?.html}`).not.toContain("Never in an email");
  });
});
