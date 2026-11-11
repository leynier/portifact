// Expiry notices: the scheduled scan that groups due artifacts per owner into outbox jobs, and the
// job that sends one email per owner, against the real D1 schema in workerd.
import { env } from "cloudflare:test";
import { type JobMessage, LIMITS } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { NOTICE_EMAILS_PER_CYCLE } from "@portifact/domain";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { updateAccountSettings } from "../src/account-settings.ts";
import {
  emailsSentInCycle,
  isEmailSuppressed,
  RecipientSuppressedError,
  recordEmailsSent,
  suppressEmail,
} from "../src/email.ts";
import { type ExpiryNotifier, scheduleExpiryNotices } from "../src/expiry-notices.ts";
import { archiveArtifact, renewArtifact } from "../src/lifecycle.ts";
import { runMaintenance } from "../src/maintenance.ts";
import { runJob } from "../src/outbox.ts";
import { artifactRow, DAY, db, NOW, publishSite, racing, user } from "./fixtures.ts";

const HOUR = 3_600_000;
const ACTIVE = LIMITS.activeDays * DAY;

/** Publishes a site for `ownerId` that expires `left` after NOW. */
async function expiring(ownerId: string, left: number) {
  const { artifactId } = await publishSite(ownerId, undefined, NOW + left - ACTIVE);
  return artifactId;
}

/** A notifier that records what it was asked to send, or fails with `error`. */
function fakeNotifier(error?: Error) {
  const sent: Parameters<ExpiryNotifier["send"]>[0][] = [];
  const notifier: ExpiryNotifier = {
    async send(notice) {
      if (error) throw error;
      sent.push(notice);
    },
  };
  return { notifier, sent };
}

async function jobsFor(ownerId: string) {
  return db()
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.topic, "expiry_notice"), eq(schema.outbox.subject, ownerId)));
}

const message = (row: { id: number }): JobMessage => ({ id: row.id, topic: "expiry_notice" });

async function onlyJob(ownerId: string) {
  const jobs = await jobsFor(ownerId);
  expect(jobs).toHaveLength(1);
  return jobs[0] as (typeof jobs)[number];
}

beforeEach(async () => {
  // Every test starts with no notice due from earlier tests and nothing sent this cycle.
  await env.DB.exec(
    "UPDATE artifacts SET expiry_notice_for = expires_at, expiry_notice_at = NULL; DELETE FROM outbox; DELETE FROM email_counters; DELETE FROM email_suppressions",
  );
});

describe("scheduleExpiryNotices", () => {
  it("writes one job per owner listing every artifact due, and marks each expiry", async () => {
    const ada = await user();
    const bob = await user();
    const soon = await expiring(ada.id, 2 * DAY);
    const sooner = await expiring(ada.id, HOUR);
    const later = await expiring(ada.id, 3 * DAY + 1);
    const bobs = await expiring(bob.id, 3 * DAY);

    expect(await scheduleExpiryNotices(db(), NOW)).toEqual({ owners: 2, artifacts: 3 });

    const job = await onlyJob(ada.id);
    expect(job.availableAt).toBe(NOW);
    const payload = job.payload as { artifacts: { id: string; expiresAt: number }[] };
    expect(payload.artifacts.map((entry) => entry.id).sort()).toEqual([soon, sooner].sort());
    expect(payload.artifacts).toContainEqual({ id: soon, expiresAt: NOW + 2 * DAY });
    expect((await onlyJob(bob.id)).payload).toEqual({
      artifacts: [{ id: bobs, expiresAt: NOW + 3 * DAY }],
    });
    expect(await artifactRow(soon)).toMatchObject({
      expiryNoticeFor: NOW + 2 * DAY,
      expiryNoticeAt: NOW,
    });
    expect(await artifactRow(later)).toMatchObject({ expiryNoticeFor: null, expiryNoticeAt: null });
  });

  it("never schedules the same expiry twice, also when two runs race", async () => {
    const ada = await user();
    await expiring(ada.id, DAY);
    const competing = racing(() => scheduleExpiryNotices(db(), NOW));
    await scheduleExpiryNotices(competing, NOW);
    expect(await jobsFor(ada.id)).toHaveLength(1);
    // A day later the cooldown is over, but this expiry was notified already.
    expect(await scheduleExpiryNotices(db(), NOW + DAY - HOUR)).toEqual({
      owners: 0,
      artifacts: 0,
    });
    expect(await jobsFor(ada.id)).toHaveLength(1);
  });

  it("skips artifacts that are not active or already expired", async () => {
    const ada = await user();
    const archived = await expiring(ada.id, DAY);
    expect(
      (await archiveArtifact(db(), { userId: ada.id, artifactId: archived, now: NOW })).ok,
    ).toBe(true);
    await expiring(ada.id, 0);
    expect(await scheduleExpiryNotices(db(), NOW)).toEqual({ owners: 0, artifacts: 0 });
  });

  it("schedules a new notice for the new expiry after a renewal", async () => {
    const ada = await user();
    const id = await expiring(ada.id, DAY);
    await scheduleExpiryNotices(db(), NOW);
    await db().delete(schema.outbox);
    expect((await renewArtifact(db(), { userId: ada.id, artifactId: id, now: NOW })).ok).toBe(true);
    const renewed = NOW + ACTIVE;
    expect(await scheduleExpiryNotices(db(), renewed - 3 * DAY - 1)).toEqual({
      owners: 0,
      artifacts: 0,
    });
    expect(await scheduleExpiryNotices(db(), renewed - 2 * DAY)).toEqual({
      owners: 1,
      artifacts: 1,
    });
    expect((await onlyJob(ada.id)).payload).toEqual({ artifacts: [{ id, expiresAt: renewed }] });
  });

  it("holds an owner's next notice for a day so artifacts go out together", async () => {
    const ada = await user();
    await expiring(ada.id, DAY);
    await scheduleExpiryNotices(db(), NOW);
    await db().delete(schema.outbox);
    const next = await expiring(ada.id, 3 * DAY + 2 * HOUR);
    expect(await scheduleExpiryNotices(db(), NOW + 2 * HOUR)).toEqual({ owners: 0, artifacts: 0 });
    expect(await scheduleExpiryNotices(db(), NOW + DAY - 1)).toEqual({ owners: 0, artifacts: 0 });
    expect(await scheduleExpiryNotices(db(), NOW + DAY)).toEqual({ owners: 1, artifacts: 1 });
    expect((await onlyJob(ada.id)).payload).toEqual({
      artifacts: [{ id: next, expiresAt: NOW + 3 * DAY + 2 * HOUR }],
    });
  });

  it("skips owners who turned the notices off, and includes them again when turned on", async () => {
    const ada = await user();
    await expiring(ada.id, DAY);
    await updateAccountSettings(db().global, {
      userId: ada.id,
      update: { expiryNotices: false },
      now: NOW,
    });
    expect(await scheduleExpiryNotices(db(), NOW)).toEqual({ owners: 0, artifacts: 0 });
    await updateAccountSettings(db().global, {
      userId: ada.id,
      update: { expiryNotices: true },
      now: NOW,
    });
    expect(await scheduleExpiryNotices(db(), NOW)).toEqual({ owners: 1, artifacts: 1 });
  });

  it("runs from the scheduled maintenance entry point", async () => {
    const ada = await user();
    await expiring(ada.id, DAY);
    expect(await runMaintenance(db(), env.ARTIFACTS, NOW)).toMatchObject({ expiryNotices: 1 });
    expect(await jobsFor(ada.id)).toHaveLength(1);
  });
});

describe("the expiry_notice job", () => {
  async function scheduled(left: number[] = [2 * DAY, DAY]) {
    const owner = await user();
    const ids = [];
    for (const time of left) ids.push(await expiring(owner.id, time));
    await scheduleExpiryNotices(db(), NOW);
    return { owner, ids, job: await onlyJob(owner.id) };
  }

  it("sends one email with the artifacts soonest first, counts it and closes the job", async () => {
    const { owner, ids, job } = await scheduled();
    const { notifier, sent } = fakeNotifier();
    expect(await runJob(db(), env.ARTIFACTS, message(job), NOW + HOUR, { notifier })).toBe("done");
    expect(sent).toEqual([
      {
        to: owner.email,
        artifacts: [
          { id: ids[1], name: "Plan", expiresAt: NOW + DAY },
          { id: ids[0], name: "Plan", expiresAt: NOW + 2 * DAY },
        ],
        locale: null,
        archiveMonths: 6,
        space: null,
      },
    ]);
    expect(await emailsSentInCycle(db().global, NOW + HOUR)).toBe(1);
    expect(await jobsFor(owner.id)).toHaveLength(0);
  });

  it("sends once when the message is delivered again or twice at the same time", async () => {
    const { job } = await scheduled();
    const { notifier, sent } = fakeNotifier();
    const outcomes = await Promise.all([
      runJob(db(), env.ARTIFACTS, message(job), NOW, { notifier }),
      runJob(db(), env.ARTIFACTS, message(job), NOW, { notifier }),
    ]);
    expect(outcomes).toEqual(["done", "done"]);
    expect(await runJob(db(), env.ARTIFACTS, message(job), NOW, { notifier })).toBe("done");
    expect(sent).toHaveLength(1);
    expect(await emailsSentInCycle(db().global, NOW)).toBe(1);
  });

  it("leaves out artifacts renewed or archived since, and sends nothing when none is left", async () => {
    const { owner, ids, job } = await scheduled();
    await renewArtifact(db(), { userId: owner.id, artifactId: ids[0] as string, now: NOW });
    const { notifier, sent } = fakeNotifier();
    expect(await runJob(db(), env.ARTIFACTS, message(job), NOW, { notifier })).toBe("done");
    expect(sent[0]?.artifacts.map((artifact) => artifact.id)).toEqual([ids[1]]);

    const other = await scheduled([DAY]);
    await archiveArtifact(db(), {
      userId: other.owner.id,
      artifactId: other.ids[0] as string,
      now: NOW,
    });
    expect(await runJob(db(), env.ARTIFACTS, message(other.job), NOW, { notifier })).toBe("stale");
    expect(sent).toHaveLength(1);
  });

  it("sends nothing for artifacts that expired while the job waited", async () => {
    const { job } = await scheduled([HOUR]);
    const { notifier, sent } = fakeNotifier();
    expect(await runJob(db(), env.ARTIFACTS, message(job), NOW + HOUR, { notifier })).toBe("stale");
    expect(sent).toHaveLength(0);
  });

  it("passes on the owner's language, as chosen when the job runs", async () => {
    const { owner, job } = await scheduled();
    await updateAccountSettings(db().global, {
      userId: owner.id,
      update: { locale: "ja" },
      now: NOW,
    });
    const { notifier, sent } = fakeNotifier();
    expect(await runJob(db(), env.ARTIFACTS, message(job), NOW, { notifier })).toBe("done");
    expect(sent.map((notice) => notice.locale)).toEqual(["ja"]);
  });

  it("respects an opt-out made after the notice was scheduled", async () => {
    const { owner, job } = await scheduled();
    await updateAccountSettings(db().global, {
      userId: owner.id,
      update: { expiryNotices: false },
      now: NOW,
    });
    const { notifier, sent } = fakeNotifier();
    expect(await runJob(db(), env.ARTIFACTS, message(job), NOW, { notifier })).toBe("stale");
    expect(sent).toHaveLength(0);
    expect(await jobsFor(owner.id)).toHaveLength(0);
  });

  it("sends nothing to an account that is gone", async () => {
    const { owner, job } = await scheduled();
    await db().delete(schema.users).where(eq(schema.users.id, owner.id));
    const { notifier, sent } = fakeNotifier();
    expect(await runJob(db(), env.ARTIFACTS, message(job), NOW, { notifier })).toBe("stale");
    expect(sent).toHaveLength(0);
  });

  it("skips a suppressed address without counting an email", async () => {
    const { owner, job } = await scheduled();
    await suppressEmail(db().global, { email: owner.email, reason: "hard_bounce", now: NOW });
    const { notifier, sent } = fakeNotifier();
    expect(await runJob(db(), env.ARTIFACTS, message(job), NOW, { notifier })).toBe("stale");
    expect(sent).toHaveLength(0);
    expect(await emailsSentInCycle(db().global, NOW)).toBe(0);
  });

  it("records the provider's suppression when it refuses the address", async () => {
    const { owner, job } = await scheduled();
    const { notifier } = fakeNotifier(new RecipientSuppressedError());
    expect(await runJob(db(), env.ARTIFACTS, message(job), NOW, { notifier })).toBe("stale");
    expect(await isEmailSuppressed(db().global, owner.email, NOW)).toBe(true);
    expect(await emailsSentInCycle(db().global, NOW)).toBe(0);
    expect(await jobsFor(owner.id)).toHaveLength(0);
  });

  it("stops when the cycle's notice emails are spent, keeping the sign-in reserve", async () => {
    const { job } = await scheduled();
    await recordEmailsSent(db().global, NOW, NOTICE_EMAILS_PER_CYCLE);
    const { notifier, sent } = fakeNotifier();
    expect(await runJob(db(), env.ARTIFACTS, message(job), NOW, { notifier })).toBe("stale");
    expect(sent).toHaveLength(0);
    expect(await emailsSentInCycle(db().global, NOW)).toBe(NOTICE_EMAILS_PER_CYCLE);
  });

  it("puts the job back when the send fails, and the next delivery sends it", async () => {
    const { owner, ids, job } = await scheduled();
    const failing = fakeNotifier(new Error("email delivery failed"));
    await expect(
      runJob(db(), env.ARTIFACTS, message(job), NOW, { notifier: failing.notifier }),
    ).rejects.toThrow("email delivery failed");
    // The retried message finds its row gone; the job is back as a new row for the next relay.
    const { notifier, sent } = fakeNotifier();
    expect(await runJob(db(), env.ARTIFACTS, message(job), NOW, { notifier })).toBe("done");
    expect(sent).toHaveLength(0);
    const back = await onlyJob(owner.id);
    expect(back.id).not.toBe(job.id);
    expect(back.payload).toEqual(job.payload);
    expect(await scheduleExpiryNotices(db(), NOW + DAY)).toEqual({ owners: 0, artifacts: 0 });
    expect(await runJob(db(), env.ARTIFACTS, message(back), NOW, { notifier })).toBe("done");
    expect(sent[0]?.artifacts.map((artifact) => artifact.id)).toEqual([ids[1], ids[0]]);
    expect(await emailsSentInCycle(db().global, NOW)).toBe(1);
  });

  it("needs the notifier, and keeps the job when it is missing", async () => {
    const { owner, job } = await scheduled();
    await expect(runJob(db(), env.ARTIFACTS, message(job), NOW)).rejects.toThrow(
      "expiry_notice needs the notifier",
    );
    expect(await jobsFor(owner.id)).toHaveLength(1);
  });

  it("drops a job whose payload is malformed without sending", async () => {
    const owner = await user();
    const [row] = await db()
      .insert(schema.outbox)
      .values({
        topic: "expiry_notice",
        payload: { artifacts: [] },
        availableAt: NOW,
        createdAt: NOW,
        subject: owner.id,
      })
      .returning();
    const { notifier, sent } = fakeNotifier();
    expect(
      await runJob(db(), env.ARTIFACTS, message(row as { id: number }), NOW, { notifier }),
    ).toBe("stale");
    expect(sent).toHaveLength(0);
    expect(await jobsFor(owner.id)).toHaveLength(0);
  });
});
