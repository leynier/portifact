import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import { regionsFromEnv, schema } from "@portifact/db";
import { RecipientSuppressedError } from "@portifact/services";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import worker, { type Env, runScheduled } from "../src/index.ts";
import { expiryNotifierFromEnv, NOTICE_SENDER, noticeEmail } from "../src/notices.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 12, 9);
const db = () => regionsFromEnv(env).get("default").db;

type Sent = Parameters<SendEmail["send"]>[0];

/** A `send_email` binding that records messages, or rejects with `error`. */
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

const ARTIFACT = { id: "k7d2qm4xab", name: "Plan", expiresAt: NOW + DAY };

describe("expiry notice email", () => {
  it("links each artifact, its dashboard page and the settings with the environment's origins", () => {
    const email = noticeEmail(env, [ARTIFACT]);
    expect(email.subject).toBe("Your Portifact artifact expires soon");
    expect(email.text).toContain("https://k7d2qm4xab.portifact.dev/");
    expect(email.text).toContain("Renew: https://app.portifact.com/artifacts/k7d2qm4xab");
    expect(email.text).toContain("https://app.portifact.com/settings");
    expect(email.text).toContain("another 30 days");
    expect(email.html).toContain('href="https://app.portifact.com/artifacts/k7d2qm4xab"');
    expect(email.html).toContain('<html lang="en"');
  });

  it("is written in the owner's language, English when they chose none", () => {
    const german = noticeEmail(env, [ARTIFACT], "de");
    expect(german.html).toContain('<html lang="de"');
    expect(german.subject).not.toBe(noticeEmail(env, [ARTIFACT]).subject);
    expect(german.text).toContain("https://app.portifact.com/artifacts/k7d2qm4xab");
    expect(noticeEmail(env, [ARTIFACT], null)).toEqual(noticeEmail(env, [ARTIFACT]));
  });

  it("says how long the owner's plan keeps the archive", () => {
    expect(noticeEmail(env, [ARTIFACT]).text).toBe(noticeEmail(env, [ARTIFACT], null, 6).text);
    expect(noticeEmail(env, [ARTIFACT], null, 12).text).not.toBe(noticeEmail(env, [ARTIFACT]).text);
  });
});

describe("expiryNotifierFromEnv", () => {
  it("sends from the no-reply address to the owner", async () => {
    const { binding, sent } = fakeEmail();
    await expiryNotifierFromEnv({ ...env, EMAIL: binding }).send({
      to: "ada@example.com",
      artifacts: [ARTIFACT],
      locale: "ru",
      archiveMonths: 12,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: NOTICE_SENDER, to: "ada@example.com" });
    expect(sent[0]).toMatchObject(noticeEmail(env, [ARTIFACT], "ru", 12));
  });

  it("turns the provider's suppression refusal into RecipientSuppressedError", async () => {
    for (const error of [
      { code: "E_RECIPIENT_SUPPRESSED" },
      new Error("E_RECIPIENT_SUPPRESSED: ada@example.com"),
    ]) {
      const { binding } = fakeEmail(error);
      await expect(
        expiryNotifierFromEnv({ ...env, EMAIL: binding }).send({
          to: "ada@example.com",
          artifacts: [ARTIFACT],
          locale: null,
          archiveMonths: 6,
        }),
      ).rejects.toBeInstanceOf(RecipientSuppressedError);
    }
  });

  it("replaces any other error with one that holds no address", async () => {
    const { binding } = fakeEmail(new Error("rate limited for ada@example.com"));
    const sending = expiryNotifierFromEnv({ ...env, EMAIL: binding }).send({
      to: "ada@example.com",
      artifacts: [ARTIFACT],
      locale: null,
      archiveMonths: 6,
    });
    await expect(sending).rejects.toThrow(/^email delivery failed$/);
  });
});

describe("expiry notices end to end", () => {
  it("schedules on the run and emails the owner once from the queue", async () => {
    const ownerId = `u_${crypto.randomUUID()}`;
    const email = `${ownerId}@example.test`;
    await db()
      .insert(schema.users)
      .values({
        id: ownerId,
        name: "Ada",
        email,
        emailVerified: true,
        createdAt: new Date(NOW - 60 * DAY),
        updatedAt: new Date(NOW),
      });
    await db()
      .insert(schema.artifacts)
      .values({
        id: "n3x8vp5qwe",
        ownerId,
        type: "site",
        name: "Launch plan",
        state: "active",
        expiresAt: NOW + 2 * DAY,
      });

    expect(await runScheduled(env, NOW)).toMatchObject({ expiryNotices: 1 });
    const [job] = await db().select().from(schema.outbox).where(eq(schema.outbox.subject, ownerId));
    expect(job?.topic).toBe("expiry_notice");
    expect(job?.dispatchedAt).toBe(NOW);

    const { binding, sent } = fakeEmail();
    const testEnv: Env = { ...env, EMAIL: binding };
    for (const id of ["m0", "m1"]) {
      const batch = createMessageBatch("portifact-jobs", [
        {
          id,
          timestamp: new Date(NOW),
          attempts: 1,
          body: { id: job?.id, topic: "expiry_notice" },
        },
      ]);
      const ctx = createExecutionContext();
      await worker.queue(batch, testEnv);
      expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual([id]);
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(email);
    expect(sent[0]?.text).toContain("Launch plan");
    expect(
      await db().select().from(schema.outbox).where(eq(schema.outbox.subject, ownerId)),
    ).toEqual([]);
    expect(await runScheduled(testEnv, NOW + DAY)).toMatchObject({ expiryNotices: 0 });
  });
});
