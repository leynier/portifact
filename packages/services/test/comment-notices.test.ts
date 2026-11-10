// Comment notices: the activity a comment, reply or resolution marks in its own batch, the scan
// that turns it into one job per recipient, the job that sends the digest, the per-artifact mute,
// the unsubscribe link and the erasure of pending activity, against the real D1 schema in workerd.
import { env } from "cloudflare:test";
import type { AnnotationTarget, CommentNoticePayload, JobMessage } from "@portifact/contracts";
import { globalDb, regionalDb, schema } from "@portifact/db";
import { COMMENT_NOTICE_EMAILS_PER_CYCLE } from "@portifact/domain";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceAccountDeletion,
  exportAccount,
  requestAccountDeletion,
} from "../src/account-data.ts";
import { updateAccountSettings } from "../src/account-settings.ts";
import {
  createAnnotationThread,
  deleteAnnotationThread,
  type HumanCheck,
  replyToAnnotationThread,
  setAnnotationThreadState,
} from "../src/annotations.ts";
import { applyTombstones } from "../src/backups.ts";
import {
  type CommentNotifier,
  getCommentNoticeMute,
  openUnsubscribeToken,
  scheduleCommentNotices,
  sendCommentNotice,
  setCommentNoticeMute,
  signUnsubscribeToken,
  UNSUBSCRIBE_INVALID_MESSAGE,
  unsubscribeCommentNotices,
} from "../src/comment-notices.ts";
import {
  emailsSentInCycle,
  isEmailSuppressed,
  RecipientSuppressedError,
  recordEmailsSent,
  suppressEmail,
} from "../src/email.ts";
import { deleteArtifactData, runMaintenance } from "../src/maintenance.ts";
import { runJob } from "../src/outbox.ts";
import { DAY, db, grantPlan, MINUTE, NOW, racing, session, value } from "./fixtures.ts";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const HUMAN: HumanCheck = { token: "solved", verify: async () => "passed" };
const DOC: AnnotationTarget = { schema: 1, path: "index.html", anchor: { kind: "document" } };
const SECRET = "test-unsubscribe-secret";
/** When the activity of a test has settled for its digest. */
const LATER = NOW + 10 * MINUTE;

function artifactId(): string {
  let id = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(10))) id += ALPHABET[byte % 32];
  return id;
}

async function person(): Promise<{ id: string; email: string }> {
  const id = `u_${crypto.randomUUID()}`;
  const email = `${id}@example.test`;
  await db()
    .insert(schema.users)
    .values({
      id,
      name: `Name ${id.slice(2, 6)}`,
      email,
      emailVerified: true,
      createdAt: new Date(NOW - 30 * DAY),
      updatedAt: new Date(NOW),
    });
  return { id, email };
}

interface Artifact {
  id: string;
  version: string;
}

/** An active restricted site of `ownerId` with comments open and these readers. */
async function artifact(
  ownerId: string,
  readers: string[],
  options: { comments?: "owner" | "everyone"; name?: string } = {},
): Promise<Artifact> {
  const id = artifactId();
  const version = `${id}_v1`;
  await db()
    .insert(schema.artifacts)
    .values({
      id,
      ownerId,
      type: "site",
      name: options.name ?? "Plan",
      state: "active",
      annotations: "open",
      commentVisibility: options.comments ?? "everyone",
      expiresAt: NOW + 30 * DAY,
      createdAt: NOW,
      updatedAt: NOW,
    });
  await db().insert(schema.versions).values({
    id: version,
    artifactId: id,
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
      versionId: version,
      kind: "published",
      path: "index.html",
      ownerId,
      sha256: "a".repeat(64),
      size: 10,
      contentType: "text/html",
    });
  await db()
    .update(schema.artifacts)
    .set({ currentVersionId: version })
    .where(eq(schema.artifacts.id, id));
  for (const email of readers) {
    await db().insert(schema.artifactReaders).values({ artifactId: id, email });
  }
  return { id, version };
}

async function thread(a: Artifact, userId: string, now = NOW, database = db()) {
  return value(
    await createAnnotationThread(database, {
      humanCheck: HUMAN,
      userId,
      artifactId: a.id,
      versionId: a.version,
      target: DOC,
      body: "Secret words that never leave",
      now,
    }),
  ).id;
}

async function reply(a: Artifact, userId: string, threadId: string, now = NOW, database = db()) {
  value(
    await replyToAnnotationThread(database, {
      humanCheck: HUMAN,
      userId,
      artifactId: a.id,
      threadId,
      body: "More secret words",
      now,
    }),
  );
}

async function resolve(a: Artifact, userId: string, threadId: string, state: "resolved" | "open") {
  value(
    await setAnnotationThreadState(db(), {
      userId,
      artifactId: a.id,
      threadId,
      state,
      now: NOW,
    }),
  );
}

async function pending(recipientId: string) {
  return db()
    .select()
    .from(schema.commentNotices)
    .where(eq(schema.commentNotices.recipientId, recipientId))
    .orderBy(schema.commentNotices.firstAt, schema.commentNotices.threadId);
}

async function jobsFor(recipientId: string) {
  return db()
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.topic, "comment_notice"), eq(schema.outbox.subject, recipientId)));
}

async function onlyJob(recipientId: string) {
  const jobs = await jobsFor(recipientId);
  expect(jobs).toHaveLength(1);
  return jobs[0] as (typeof jobs)[number];
}

const message = (row: { id: number }): JobMessage => ({ id: row.id, topic: "comment_notice" });

/** A notifier that records what it was asked to send, or fails with `error`. */
function fakeNotifier(error?: Error) {
  const sent: Parameters<CommentNotifier["send"]>[0][] = [];
  const notifier: CommentNotifier = {
    async send(notice) {
      if (error) throw error;
      sent.push(notice);
    },
  };
  return { notifier, sent };
}

/** Schedules at `at` and runs the recipient's job, returning what the notifier got. */
async function deliver(recipientId: string, at = LATER) {
  await scheduleCommentNotices(db(), at);
  const jobs = await jobsFor(recipientId);
  const { notifier, sent } = fakeNotifier();
  for (const job of jobs) {
    await runJob(db(), env.ARTIFACTS, message(job), at, { commentNotifier: notifier });
  }
  return sent;
}

/** A Pro owner with a restricted artifact read by two readers. */
async function proWorld(options: { comments?: "owner" | "everyone" } = {}) {
  const owner = await person();
  const reader = await person();
  const other = await person();
  await grantPlan(owner.id, "pro");
  const a = await artifact(owner.id, [reader.email, other.email], options);
  return { owner, reader, other, a };
}

/** The `comment_notice_skipped` lines logged since the test started. */
let logged: unknown[] = [];

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  logged = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logged.push(JSON.parse(String(line)));
  });
  await env.DB.exec(
    "DELETE FROM comment_notices; DELETE FROM outbox; DELETE FROM email_counters; DELETE FROM email_suppressions",
  );
});

describe("marking activity on the write path", () => {
  it("marks nothing for an owner on the free plan", async () => {
    const owner = await person();
    const reader = await person();
    const a = await artifact(owner.id, [reader.email]);
    const id = await thread(a, reader.id);
    await reply(a, owner.id, id);
    await resolve(a, owner.id, id, "resolved");
    expect(await pending(owner.id)).toEqual([]);
    expect(await pending(reader.id)).toEqual([]);
    expect(await deliver(owner.id)).toEqual([]);
  });

  it("marks a new thread for the owner, never for its author", async () => {
    const { owner, reader, a } = await proWorld();
    const id = await thread(a, reader.id);
    expect(await pending(owner.id)).toEqual([
      {
        recipientId: owner.id,
        threadId: id,
        artifactId: a.id,
        created: 1,
        replies: 0,
        resolved: 0,
        firstAt: NOW,
      },
    ]);
    expect(await pending(reader.id)).toEqual([]);
  });

  it("marks replies and resolutions for the owner and the participants, not the actor", async () => {
    const { owner, reader, other, a } = await proWorld();
    const id = await thread(a, reader.id);
    await reply(a, other.id, id, NOW + MINUTE);
    await reply(a, other.id, id, NOW + 2 * MINUTE);
    await reply(a, owner.id, id, NOW + 3 * MINUTE);
    await resolve(a, owner.id, id, "resolved");
    // Reopening is not news.
    await resolve(a, owner.id, id, "open");

    expect(await pending(owner.id)).toMatchObject([{ created: 1, replies: 2, resolved: 0 }]);
    expect(await pending(reader.id)).toMatchObject([
      { created: 0, replies: 3, resolved: 1, firstAt: NOW + MINUTE },
    ]);
    expect(await pending(other.id)).toMatchObject([{ created: 0, replies: 1, resolved: 1 }]);
  });

  it("marks exactly the owner side and the participants other than the actor", async () => {
    const { owner, reader, other, a } = await proWorld();
    const id = await thread(a, reader.id);
    await reply(a, other.id, id);
    const recipients = async () =>
      (
        await db()
          .select({ id: schema.commentNotices.recipientId })
          .from(schema.commentNotices)
          .where(eq(schema.commentNotices.threadId, id))
      )
        .map((row) => row.id)
        .sort();
    expect(await recipients()).toEqual([owner.id, reader.id].sort());
    await db().delete(schema.commentNotices);
    await resolve(a, reader.id, id, "resolved");
    expect(await recipients()).toEqual([owner.id, other.id].sort());
  });

  it("marks nothing for the owner's own comments on their personal space", async () => {
    const { owner, reader, a } = await proWorld();
    const id = await thread(a, owner.id);
    await reply(a, owner.id, id);
    expect(await pending(owner.id)).toEqual([]);
    expect(await pending(reader.id)).toEqual([]);
  });

  it("follows the artifact owner's plan: a Team workspace's admins and editors are told", async () => {
    const admin = await person();
    const editor = await person();
    const member = await person();
    const reader = await person();
    const workspaceId = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
    await db()
      .insert(schema.workspaces)
      .values({
        id: workspaceId,
        slug: workspaceId.slice(3, 23),
        name: "Team",
        createdBy: admin.id,
        updatedAt: NOW,
      });
    for (const [userId, role] of [
      [admin.id, "admin"],
      [editor.id, "editor"],
      [member.id, "member"],
    ] as const) {
      await db()
        .insert(schema.workspaceMembers)
        .values({ workspaceId, userId, role, updatedAt: NOW });
    }
    // The editor's own Pro plan does not reach a free workspace.
    await grantPlan(editor.id, "pro");
    const a = await artifact(workspaceId, [reader.email]);
    await thread(a, reader.id);
    expect(await pending(admin.id)).toEqual([]);

    await grantPlan(workspaceId, "team");
    await thread(a, reader.id);
    expect(await pending(admin.id)).toHaveLength(1);
    expect(await pending(editor.id)).toHaveLength(1);
    expect(await pending(member.id)).toEqual([]);

    // An editor's own comment tells the other side, not themselves.
    await thread(a, editor.id);
    expect(await pending(admin.id)).toHaveLength(2);
    expect(await pending(editor.id)).toHaveLength(1);
  });

  it("marks nothing for someone who muted the artifact", async () => {
    const { owner, reader, a } = await proWorld();
    value(
      await setCommentNoticeMute(db(), {
        userId: owner.id,
        artifactId: a.id,
        muted: true,
        now: NOW,
      }),
    );
    await thread(a, reader.id);
    expect(await pending(owner.id)).toEqual([]);
  });

  it("adds no round trip to the write: the free and Pro paths make the same D1 calls", async () => {
    /** A database over a D1 binding that counts round trips and the statements of each batch. */
    function counting() {
      const calls = { roundTrips: 0, batchSizes: [] as number[] };
      const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement =>
        new Proxy(statement, {
          get(target, property, receiver) {
            const real = Reflect.get(target, property, receiver);
            if (typeof real !== "function") return real;
            if (property === "bind") {
              return (...args: unknown[]) => wrapStatement(real.apply(target, args));
            }
            if (["all", "raw", "run", "first"].includes(String(property))) {
              return (...args: unknown[]) => {
                calls.roundTrips += 1;
                return real.apply(target, args);
              };
            }
            return real.bind(target);
          },
        });
      const d1 = new Proxy(env.DB, {
        get(target, property, receiver) {
          const real = Reflect.get(target, property, receiver);
          if (property === "prepare") {
            return (query: string) => wrapStatement(target.prepare(query));
          }
          if (property === "batch") {
            return (statements: D1PreparedStatement[]) => {
              calls.roundTrips += 1;
              calls.batchSizes.push(statements.length);
              return target.batch(statements);
            };
          }
          return typeof real === "function" ? real.bind(target) : real;
        },
      });
      return { database: regionalDb(d1, globalDb(d1)), calls };
    }

    const free = await person();
    const pro = await person();
    const reader = await person();
    await grantPlan(pro.id, "pro");
    const freeArtifact = await artifact(free.id, [reader.email]);
    const proArtifact = await artifact(pro.id, [reader.email]);
    const freeThread = await thread(freeArtifact, reader.id);
    const proThread = await thread(proArtifact, reader.id);

    const onFree = counting();
    await reply(freeArtifact, free.id, freeThread, NOW, onFree.database);
    const onPro = counting();
    await reply(proArtifact, pro.id, proThread, NOW, onPro.database);

    expect(onPro.calls.roundTrips).toBe(onFree.calls.roundTrips);
    expect(onFree.calls.batchSizes).toHaveLength(1);
    // The Pro write carries exactly one more statement in its one batch: the mark.
    expect(onPro.calls.batchSizes).toEqual([(onFree.calls.batchSizes[0] ?? 0) + 1]);
    expect(await pending(reader.id)).toHaveLength(1);
  });
});

describe("scheduleCommentNotices", () => {
  it("waits ten minutes after the oldest activity, then writes one job with every thread", async () => {
    const { owner, reader, a } = await proWorld();
    const b = await artifact(owner.id, [reader.email], { name: "Second" });
    const first = await thread(a, reader.id);
    await reply(a, reader.id, first, NOW + MINUTE);
    const second = await thread(b, reader.id, NOW + 5 * MINUTE);

    expect(await scheduleCommentNotices(db(), LATER - 1)).toEqual({ recipients: 0, optedOut: 0 });
    expect(await jobsFor(owner.id)).toEqual([]);

    expect(await scheduleCommentNotices(db(), LATER)).toEqual({ recipients: 1, optedOut: 0 });
    const job = await onlyJob(owner.id);
    const payload = job.payload as CommentNoticePayload;
    expect(payload.threads).toEqual([
      { artifactId: a.id, threadId: first, created: 1, replies: 1, resolved: 0 },
      { artifactId: b.id, threadId: second, created: 1, replies: 0, resolved: 0 },
    ]);
    expect(JSON.stringify(payload)).not.toContain("secret");
    expect(await pending(owner.id)).toEqual([]);
  });

  it("schedules each activity once, also when two runs race", async () => {
    const { owner, reader, a } = await proWorld();
    await thread(a, reader.id);
    const competing = racing(() => scheduleCommentNotices(db(), LATER));
    await scheduleCommentNotices(competing, LATER);
    expect(await jobsFor(owner.id)).toHaveLength(1);
  });

  it("never schedules a second job while one is waiting", async () => {
    const { owner, reader, a } = await proWorld();
    await thread(a, reader.id);
    await scheduleCommentNotices(db(), LATER);
    await thread(a, reader.id, LATER);
    expect(await scheduleCommentNotices(db(), LATER + 20 * MINUTE)).toEqual({
      recipients: 0,
      optedOut: 0,
    });
    expect(await jobsFor(owner.id)).toHaveLength(1);
    expect(await pending(owner.id)).toHaveLength(1);
  });

  it("keeps digests ten minutes apart when one job cannot take everything", async () => {
    const { owner, reader, a } = await proWorld();
    // Past the payload's cap of 200 threads, written straight into the table.
    const threads = Array.from({ length: 201 }, (_, i) => `t${String(i).padStart(3, "0")}`);
    for (const threadId of threads) {
      await db()
        .insert(schema.annotationThreads)
        .values({
          id: threadId + a.id,
          artifactId: a.id,
          versionId: a.version,
          ownerId: owner.id,
          authorId: reader.id,
          target: JSON.stringify(DOC),
          targetBytes: 10,
          path: "index.html",
          updatedAt: NOW,
        });
    }
    for (let i = 0; i < threads.length; i += 10) {
      await db()
        .insert(schema.commentNotices)
        .values(
          threads.slice(i, i + 10).map((threadId) => ({
            recipientId: owner.id,
            threadId: threadId + a.id,
            artifactId: a.id,
            created: 1,
            firstAt: NOW,
          })),
        );
    }
    await scheduleCommentNotices(db(), LATER);
    expect(((await onlyJob(owner.id)).payload as CommentNoticePayload).threads).toHaveLength(200);
    expect(await pending(owner.id)).toMatchObject([{ firstAt: LATER }]);
  });

  it("drops the activity of someone who turned the notices off", async () => {
    const { owner, reader, a } = await proWorld();
    value(
      await updateAccountSettings(db().global, {
        userId: owner.id,
        update: { commentNotices: false },
        now: NOW,
      }),
    );
    await thread(a, reader.id);
    expect(await scheduleCommentNotices(db(), LATER)).toEqual({ recipients: 0, optedOut: 1 });
    expect(await pending(owner.id)).toEqual([]);
    expect(await jobsFor(owner.id)).toEqual([]);
  });

  it("runs with the maintenance scans", async () => {
    const { reader, a } = await proWorld();
    await thread(a, reader.id);
    expect(await runMaintenance(db(), env.ARTIFACTS, LATER)).toMatchObject({ commentNotices: 1 });
  });
});

describe("sendCommentNotice", () => {
  it("emails one digest of counts per artifact, in the recipient's language", async () => {
    const { owner, reader, other, a } = await proWorld();
    const b = await artifact(owner.id, [reader.email], { name: "Second" });
    value(
      await updateAccountSettings(db().global, {
        userId: owner.id,
        update: { locale: "es" },
        now: NOW,
      }),
    );
    const id = await thread(a, reader.id);
    await reply(a, other.id, id);
    await reply(a, reader.id, id);
    await reply(a, other.id, id);
    await thread(b, reader.id);
    // The owner's own resolution is not news for the owner.
    await resolve(b, owner.id, await thread(b, reader.id), "resolved");

    const sent = await deliver(owner.id);
    expect(sent).toEqual([
      {
        to: owner.email,
        userId: owner.id,
        issuedAt: LATER,
        locale: "es",
        more: 0,
        artifacts: [
          { artifactId: a.id, name: "Plan", newThreads: 1, newReplies: 3, resolvedThreads: 0 },
          { artifactId: b.id, name: "Second", newThreads: 2, newReplies: 0, resolvedThreads: 0 },
        ],
      },
    ]);
    expect(await jobsFor(owner.id)).toEqual([]);
    expect(await emailsSentInCycle(db(), LATER)).toBe(1);
  });

  it("is sent once when the job is delivered twice", async () => {
    const { owner, reader, a } = await proWorld();
    await thread(a, reader.id);
    await scheduleCommentNotices(db(), LATER);
    const job = await onlyJob(owner.id);
    const { notifier, sent } = fakeNotifier();
    expect(
      await runJob(db(), env.ARTIFACTS, message(job), LATER, { commentNotifier: notifier }),
    ).toBe("done");
    expect(
      await runJob(db(), env.ARTIFACTS, message(job), LATER, { commentNotifier: notifier }),
    ).toBe("done");
    expect(sent).toHaveLength(1);
  });

  it("puts the job back when the send fails, and sends it next time", async () => {
    const { owner, reader, a } = await proWorld();
    await thread(a, reader.id);
    await scheduleCommentNotices(db(), LATER);
    const job = await onlyJob(owner.id);
    const failing = fakeNotifier(new Error("email delivery failed"));
    await expect(
      runJob(db(), env.ARTIFACTS, message(job), LATER, { commentNotifier: failing.notifier }),
    ).rejects.toThrow("email delivery failed");
    const back = await onlyJob(owner.id);
    expect(back.payload).toEqual(job.payload);
    expect(await emailsSentInCycle(db(), LATER)).toBe(0);

    const { notifier, sent } = fakeNotifier();
    await runJob(db(), env.ARTIFACTS, message(back), LATER, { commentNotifier: notifier });
    expect(sent).toHaveLength(1);
  });

  it("needs the notifier", async () => {
    const { owner, reader, a } = await proWorld();
    await thread(a, reader.id);
    await scheduleCommentNotices(db(), LATER);
    await expect(
      runJob(db(), env.ARTIFACTS, message(await onlyJob(owner.id)), LATER),
    ).rejects.toThrow("comment_notice needs the comment notifier");
  });

  it("skips a suppressed address", async () => {
    const { owner, reader, a } = await proWorld();
    await suppressEmail(db(), { email: owner.email, reason: "hard_bounce", now: NOW });
    await thread(a, reader.id);
    expect(await deliver(owner.id)).toEqual([]);
    expect(await emailsSentInCycle(db(), LATER)).toBe(0);
    expect(logged).toEqual([{ event: "comment_notice_skipped", reason: "suppressed", threads: 1 }]);
  });

  it("records an address the provider refuses and drops the job", async () => {
    const { owner, reader, a } = await proWorld();
    await thread(a, reader.id);
    await scheduleCommentNotices(db(), LATER);
    const refusing = fakeNotifier(new RecipientSuppressedError());
    expect(
      await runJob(db(), env.ARTIFACTS, message(await onlyJob(owner.id)), LATER, {
        commentNotifier: refusing.notifier,
      }),
    ).toBe("stale");
    expect(await isEmailSuppressed(db(), owner.email, LATER)).toBe(true);
    expect(await jobsFor(owner.id)).toEqual([]);
    expect(logged).toEqual([{ event: "comment_notice_skipped", reason: "suppressed", threads: 1 }]);
  });

  it("skips someone who turned the notices off after the scan", async () => {
    const { owner, reader, a } = await proWorld();
    await thread(a, reader.id);
    await scheduleCommentNotices(db(), LATER);
    value(
      await updateAccountSettings(db().global, {
        userId: owner.id,
        update: { commentNotices: false },
        now: LATER,
      }),
    );
    const { notifier, sent } = fakeNotifier();
    expect(
      await runJob(db(), env.ARTIFACTS, message(await onlyJob(owner.id)), LATER, {
        commentNotifier: notifier,
      }),
    ).toBe("stale");
    expect(sent).toEqual([]);
    expect(logged).toEqual([{ event: "comment_notice_skipped", reason: "opted_out", threads: 1 }]);
  });

  it("skips an artifact muted after the scan, and an owner whose plan ended", async () => {
    const { owner, reader, a } = await proWorld();
    await thread(a, reader.id);
    await scheduleCommentNotices(db(), LATER);
    value(
      await setCommentNoticeMute(db(), {
        userId: owner.id,
        artifactId: a.id,
        muted: true,
        now: NOW,
      }),
    );
    const { notifier, sent } = fakeNotifier();
    await runJob(db(), env.ARTIFACTS, message(await onlyJob(owner.id)), LATER, {
      commentNotifier: notifier,
    });
    expect(sent).toEqual([]);

    value(
      await setCommentNoticeMute(db(), {
        userId: owner.id,
        artifactId: a.id,
        muted: false,
        now: NOW,
      }),
    );
    await thread(a, reader.id);
    await scheduleCommentNotices(db(), LATER);
    await grantPlan(owner.id, "free");
    await runJob(db(), env.ARTIFACTS, message(await onlyJob(owner.id)), LATER, {
      commentNotifier: notifier,
    });
    expect(sent).toEqual([]);
  });

  it("stops when the cycle's comment notice capacity is spent", async () => {
    const { owner, reader, a } = await proWorld();
    await thread(a, reader.id);
    await recordEmailsSent(db(), LATER, COMMENT_NOTICE_EMAILS_PER_CYCLE);
    expect(await deliver(owner.id)).toEqual([]);
    expect(await emailsSentInCycle(db(), LATER)).toBe(COMMENT_NOTICE_EMAILS_PER_CYCLE);
    expect(logged).toEqual([{ event: "comment_notice_skipped", reason: "capacity", threads: 1 }]);
  });

  it("skips an account deleted after the scan", async () => {
    const { owner, reader, a } = await proWorld();
    await thread(a, reader.id);
    await scheduleCommentNotices(db(), LATER);
    const job = await onlyJob(owner.id);
    await db().delete(schema.users).where(eq(schema.users.id, owner.id));
    const { notifier, sent } = fakeNotifier();
    expect(
      await runJob(db(), env.ARTIFACTS, message(job), LATER, { commentNotifier: notifier }),
    ).toBe("stale");
    expect(sent).toEqual([]);
    expect(logged).toEqual([{ event: "comment_notice_skipped", reason: "no_account", threads: 1 }]);
  });

  it("does nothing for a row another delivery already claimed", async () => {
    const { owner, reader, a } = await proWorld();
    await thread(a, reader.id);
    await scheduleCommentNotices(db(), LATER);
    const job = await onlyJob(owner.id);
    const { notifier, sent } = fakeNotifier();
    expect(await sendCommentNotice(db(), job, LATER, notifier)).toBe("done");
    expect(await sendCommentNotice(db(), job, LATER, notifier)).toBe("done");
    expect(sent).toHaveLength(1);
  });

  it("drops a job whose payload is not one, sending nothing", async () => {
    const { owner } = await proWorld();
    const [job] = await db()
      .insert(schema.outbox)
      .values({
        topic: "comment_notice",
        payload: { threads: [{ body: "never" }] },
        availableAt: LATER,
        subject: owner.id,
      })
      .returning();
    if (!job) throw new Error("the job was not written");
    const { notifier, sent } = fakeNotifier();
    expect(await sendCommentNotice(db(), job, LATER, notifier)).toBe("stale");
    expect(sent).toEqual([]);
    expect(logged).toEqual([
      { event: "comment_notice_skipped", reason: "nothing_visible", threads: 0 },
    ]);
  });

  it("lists twenty artifacts at most and counts the rest", async () => {
    const { owner, reader } = await proWorld();
    for (let i = 0; i < 21; i += 1) {
      const extra = await artifact(owner.id, [reader.email], { name: `Doc ${i}` });
      // A minute apart, under the per-author write rate.
      const id = await thread(extra, reader.id, NOW + i * MINUTE);
      // The first artifact is the most active, so it is the one listed first.
      if (i === 0) await reply(extra, reader.id, id, NOW + 1);
    }
    const [notice] = await deliver(owner.id, NOW + 40 * MINUTE);
    expect(notice?.artifacts).toHaveLength(20);
    expect(notice?.more).toBe(1);
    expect(notice?.artifacts[0]).toMatchObject({ name: "Doc 0", newThreads: 1, newReplies: 1 });
  });
});

describe("visibility when the notice is sent", () => {
  it("tells a reader nothing about another reader's thread they cannot see", async () => {
    const { reader, other, a } = await proWorld();
    const id = await thread(a, reader.id);
    await reply(a, other.id, id);
    await reply(a, reader.id, id);
    // The owner narrows comment visibility before the digest: the other reader only sees their own.
    await db()
      .update(schema.artifacts)
      .set({ commentVisibility: "owner" })
      .where(eq(schema.artifacts.id, a.id));
    expect(await pending(other.id)).toHaveLength(1);
    expect(await deliver(other.id)).toEqual([]);
  });

  it("gives the owner and the author their digests while the other reader's is dropped", async () => {
    const { owner, reader, other, a } = await proWorld();
    const id = await thread(a, reader.id);
    await reply(a, other.id, id);
    await db()
      .update(schema.artifacts)
      .set({ commentVisibility: "owner" })
      .where(eq(schema.artifacts.id, a.id));
    await scheduleCommentNotices(db(), LATER);
    const { notifier, sent } = fakeNotifier();
    for (const recipient of [owner.id, reader.id]) {
      for (const job of await jobsFor(recipient)) {
        await runJob(db(), env.ARTIFACTS, message(job), LATER, { commentNotifier: notifier });
      }
    }
    expect(sent.map((notice) => notice.userId).sort()).toEqual([owner.id, reader.id].sort());
  });

  it("tells a reader who lost access nothing", async () => {
    const { reader, other, a } = await proWorld();
    const id = await thread(a, reader.id);
    await reply(a, other.id, id);
    await db()
      .delete(schema.artifactReaders)
      .where(
        and(
          eq(schema.artifactReaders.artifactId, a.id),
          eq(schema.artifactReaders.email, reader.email),
        ),
      );
    expect(await deliver(reader.id)).toEqual([]);
  });

  it("follows the per-reader exceptions both ways", async () => {
    // Owner-only visibility, but the other reader's exception shows them every thread.
    const shown = await proWorld({ comments: "owner" });
    const id = await thread(shown.a, shown.reader.id);
    await db()
      .update(schema.artifactReaders)
      .set({ commentVisibility: "all" })
      .where(eq(schema.artifactReaders.email, shown.other.email));
    await reply(shown.a, shown.other.id, id);
    await reply(shown.a, shown.reader.id, id);
    expect(await deliver(shown.other.id)).toHaveLength(1);

    // Everyone's visibility, but the other reader's exception limits them to their own threads.
    const hidden = await proWorld({ comments: "everyone" });
    const hiddenId = await thread(hidden.a, hidden.reader.id);
    await reply(hidden.a, hidden.other.id, hiddenId);
    await db()
      .update(schema.artifactReaders)
      .set({ commentVisibility: "own" })
      .where(eq(schema.artifactReaders.email, hidden.other.email));
    await reply(hidden.a, hidden.reader.id, hiddenId);
    expect(await deliver(hidden.other.id)).toEqual([]);
  });
});

describe("the per-artifact mute", () => {
  it("is part of the account export, with the preference", async () => {
    const { owner, a } = await proWorld();
    value(
      await setCommentNoticeMute(db(), {
        userId: owner.id,
        artifactId: a.id,
        muted: true,
        now: NOW,
      }),
    );
    const exported = value(await exportAccount(db(), { userId: owner.id, now: NOW }));
    expect(exported.account.commentNoticeMutes).toEqual([a.id]);
    expect(exported.account.settings.commentNotices).toBe(true);
  });

  it("reads and changes the caller's mute, and drops what was pending", async () => {
    const { owner, reader, a } = await proWorld();
    expect(
      await getCommentNoticeMute(db(), { userId: reader.id, artifactId: a.id, now: NOW }),
    ).toEqual({
      ok: true,
      value: { available: true, muted: false },
    });
    await thread(a, reader.id);
    expect(
      await setCommentNoticeMute(db(), {
        userId: owner.id,
        artifactId: a.id,
        muted: true,
        now: NOW,
      }),
    ).toEqual({ ok: true, value: { available: true, muted: true } });
    expect(await pending(owner.id)).toEqual([]);
    // Saving the same choice twice changes nothing.
    value(
      await setCommentNoticeMute(db(), {
        userId: owner.id,
        artifactId: a.id,
        muted: true,
        now: NOW,
      }),
    );
    expect(
      value(await getCommentNoticeMute(db(), { userId: owner.id, artifactId: a.id, now: NOW })),
    ).toEqual({ available: true, muted: true });
    expect(
      value(
        await setCommentNoticeMute(db(), {
          userId: owner.id,
          artifactId: a.id,
          muted: false,
          now: NOW,
        }),
      ),
    ).toEqual({ available: true, muted: false });
  });

  it("says when the owner's plan has no comment notices", async () => {
    const owner = await person();
    const a = await artifact(owner.id, []);
    expect(
      value(await getCommentNoticeMute(db(), { userId: owner.id, artifactId: a.id, now: NOW })),
    ).toEqual({ available: false, muted: false });
  });

  it("answers like a missing artifact to someone who cannot read its comments", async () => {
    const { a } = await proWorld();
    const stranger = await person();
    for (const result of [
      await getCommentNoticeMute(db(), { userId: stranger.id, artifactId: a.id, now: NOW }),
      await setCommentNoticeMute(db(), {
        userId: stranger.id,
        artifactId: a.id,
        muted: true,
        now: NOW,
      }),
      await getCommentNoticeMute(db(), { userId: stranger.id, artifactId: "missing", now: NOW }),
    ]) {
      expect(result).toMatchObject({ ok: false, code: "not_found" });
    }
  });
});

describe("the unsubscribe link", () => {
  async function settingsOf(userId: string) {
    const [row] = await db()
      .select()
      .from(schema.accountSettings)
      .where(eq(schema.accountSettings.userId, userId));
    return row;
  }

  it("opens tokens of any user ID length, without padding, and nothing else", async () => {
    for (const userId of ["u", "us", "use", "user-with-a-longer-id"]) {
      const token = await signUnsubscribeToken(SECRET, userId, NOW);
      expect(token).not.toContain("=");
      expect(await openUnsubscribeToken(SECRET, token)).toEqual({ userId, issuedAt: NOW });
    }
    const token = await signUnsubscribeToken(SECRET, "u_1", NOW);
    for (const bad of [`${token}.x`, token.replace(/^cn1/, "cn0"), `${token.slice(0, -4)}@@@@`]) {
      expect(await openUnsubscribeToken(SECRET, bad)).toBeUndefined();
    }
  });

  it("signs the user and the time, and opens only with the same secret", async () => {
    const token = await signUnsubscribeToken(SECRET, "user-1", NOW);
    expect(await openUnsubscribeToken(SECRET, token)).toEqual({ userId: "user-1", issuedAt: NOW });
    expect(await openUnsubscribeToken("another-secret", token)).toBeUndefined();
    expect(token).toMatch(/^cn1\.[A-Za-z0-9_-]+\.\d+\.[A-Za-z0-9_-]+$/);
  });

  it("turns comment notices off and nothing else", async () => {
    const someone = await person();
    value(
      await updateAccountSettings(db().global, {
        userId: someone.id,
        update: { expiryNotices: false, defaultBar: false },
        now: NOW,
      }),
    );
    const token = await signUnsubscribeToken(SECRET, someone.id, NOW);
    expect(
      await unsubscribeCommentNotices(db().global, { token, secret: SECRET, now: NOW + MINUTE }),
    ).toEqual({ ok: true, value: { unsubscribed: true } });
    expect(await settingsOf(someone.id)).toMatchObject({
      commentNotices: false,
      commentNoticesChangedAt: NOW + MINUTE,
      expiryNotices: false,
      defaultBar: false,
    });
  });

  it("creates the settings row of an account that never saved settings", async () => {
    const someone = await person();
    const token = await signUnsubscribeToken(SECRET, someone.id, NOW);
    value(await unsubscribeCommentNotices(db().global, { token, secret: SECRET, now: NOW }));
    expect(await settingsOf(someone.id)).toMatchObject({
      commentNotices: false,
      expiryNotices: true,
      defaultAccessMode: "restricted",
    });
  });

  it("refuses a tampered or expired link", async () => {
    const someone = await person();
    const token = await signUnsubscribeToken(SECRET, someone.id, NOW);
    const [version, user, issued, signature] = token.split(".");
    const forged = [
      `${version}.${btoa("someone-else").replaceAll("=", "")}.${issued}.${signature}`,
      `${version}.${user}.${Number(issued) + 1}.${signature}`,
      // Two different endings, so one of them always changes the signature.
      `${version}.${user}.${issued}.${signature?.slice(0, -2)}${signature?.endsWith("AA") ? "BB" : "AA"}`,
      `cn2.${user}.${issued}.${signature}`,
      `${token}.extra`,
      "cn1.@@.1.x",
    ];
    for (const bad of forged) {
      expect(
        await unsubscribeCommentNotices(db().global, { token: bad, secret: SECRET, now: NOW }),
      ).toEqual({ ok: false, code: "invalid_input", message: UNSUBSCRIBE_INVALID_MESSAGE });
    }
    expect(
      await unsubscribeCommentNotices(db().global, {
        token,
        secret: SECRET,
        now: NOW + 60 * DAY + 1,
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await settingsOf(someone.id)).toBeUndefined();
  });

  it("can be used again while the notices stay off, never after they were turned back on", async () => {
    const someone = await person();
    const token = await signUnsubscribeToken(SECRET, someone.id, NOW);
    value(await unsubscribeCommentNotices(db().global, { token, secret: SECRET, now: NOW + 1 }));
    // A second click, or a mail client's one-click POST after the page's.
    expect(
      await unsubscribeCommentNotices(db().global, { token, secret: SECRET, now: NOW + 2 }),
    ).toEqual({ ok: true, value: { unsubscribed: true } });
    expect((await settingsOf(someone.id))?.commentNoticesChangedAt).toBe(NOW + 1);

    value(
      await updateAccountSettings(db().global, {
        userId: someone.id,
        update: { commentNotices: true },
        now: NOW + 3,
      }),
    );
    expect(
      await unsubscribeCommentNotices(db().global, { token, secret: SECRET, now: NOW + 4 }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    expect((await settingsOf(someone.id))?.commentNotices).toBe(true);
    // A link from a later email works again.
    const later = await signUnsubscribeToken(SECRET, someone.id, NOW + 5);
    value(
      await unsubscribeCommentNotices(db().global, { token: later, secret: SECRET, now: NOW + 6 }),
    );
    expect((await settingsOf(someone.id))?.commentNotices).toBe(false);
  });

  it("answers the same for an account that no longer exists", async () => {
    const token = await signUnsubscribeToken(SECRET, "u_gone", NOW);
    expect(
      await unsubscribeCommentNotices(db().global, { token, secret: SECRET, now: NOW }),
    ).toEqual({ ok: true, value: { unsubscribed: true } });
  });

  it("keeps saving other settings from moving the time the preference changed", async () => {
    const someone = await person();
    value(
      await updateAccountSettings(db().global, {
        userId: someone.id,
        update: { defaultBar: false },
        now: NOW,
      }),
    );
    expect((await settingsOf(someone.id))?.commentNoticesChangedAt).toBeNull();
    const token = await signUnsubscribeToken(SECRET, someone.id, NOW - MINUTE);
    value(
      await updateAccountSettings(db().global, {
        userId: someone.id,
        update: { defaultBar: true, commentNotices: true },
        now: NOW + MINUTE,
      }),
    );
    value(
      await unsubscribeCommentNotices(db().global, {
        token,
        secret: SECRET,
        now: NOW + 2 * MINUTE,
      }),
    );
  });
});

/** Runs an account deletion to its end, as the job's redeliveries do. */
async function finishDeletion(userId: string, now: number) {
  let state = "pending";
  for (let round = 0; round < 10 && state === "pending"; round += 1) {
    state = await advanceAccountDeletion(db(), env.ARTIFACTS, userId, now);
  }
  return state;
}

describe("erasure of pending activity", () => {
  it("goes with a purged artifact and a deleted thread", async () => {
    const { owner, reader, a } = await proWorld();
    const kept = await thread(a, reader.id);
    const removed = await thread(a, reader.id);
    value(
      await setCommentNoticeMute(db(), {
        userId: reader.id,
        artifactId: a.id,
        muted: true,
        now: NOW,
      }),
    );
    value(
      await deleteAnnotationThread(db(), {
        userId: owner.id,
        artifactId: a.id,
        threadId: removed,
        now: NOW,
      }),
    );
    expect((await pending(owner.id)).map((row) => row.threadId)).toEqual([kept]);

    await db()
      .update(schema.artifacts)
      .set({ state: "purging" })
      .where(eq(schema.artifacts.id, a.id));
    await deleteArtifactData(db(), env.ARTIFACTS, a.id, NOW);
    expect(await pending(owner.id)).toEqual([]);
    expect(
      await db()
        .select()
        .from(schema.commentNoticeMutes)
        .where(eq(schema.commentNoticeMutes.artifactId, a.id)),
    ).toEqual([]);
  });

  it("goes with the recipient's account, also when a restore brings it back", async () => {
    const { reader, other, a } = await proWorld();
    const id = await thread(a, reader.id);
    await reply(a, other.id, id);
    const leaving = reader;
    value(
      await setCommentNoticeMute(db(), {
        userId: leaving.id,
        artifactId: a.id,
        muted: true,
        now: NOW,
      }),
    );
    await db()
      .insert(schema.commentNotices)
      .values({ recipientId: leaving.id, threadId: id, artifactId: a.id, replies: 1, firstAt: NOW })
      .onConflictDoNothing();
    await scheduleCommentNotices(db(), LATER);
    expect(await jobsFor(leaving.id)).toHaveLength(1);
    const snapshot = {
      pending: await pending(leaving.id),
      mutes: await db()
        .select()
        .from(schema.commentNoticeMutes)
        .where(eq(schema.commentNoticeMutes.userId, leaving.id)),
    };

    value(
      await requestAccountDeletion(db(), {
        userId: leaving.id,
        sessionId: await session(leaving.id),
        confirmEmail: leaving.email,
        now: NOW,
      }),
    );
    expect(await jobsFor(leaving.id)).toEqual([]);
    const mutes = () =>
      db()
        .select()
        .from(schema.commentNoticeMutes)
        .where(eq(schema.commentNoticeMutes.userId, leaving.id));
    expect(await mutes()).toEqual([]);
    expect(await finishDeletion(leaving.id, NOW)).toBe("finished");

    // A restore from before the deletion brings the user and their rows back; re-applying the
    // tombstones runs the deletion again, which erases them.
    await db()
      .insert(schema.users)
      .values({
        id: leaving.id,
        name: "Back",
        email: leaving.email,
        emailVerified: true,
        createdAt: new Date(NOW - DAY),
        updatedAt: new Date(NOW),
      });
    await db().insert(schema.commentNotices).values({
      recipientId: leaving.id,
      threadId: id,
      artifactId: a.id,
      replies: 1,
      firstAt: NOW,
    });
    if (snapshot.mutes.length > 0)
      await db().insert(schema.commentNoticeMutes).values(snapshot.mutes);
    await applyTombstones(db(), [{ kind: "account", id: leaving.id, deletedAt: NOW }], NOW + DAY);
    expect(await finishDeletion(leaving.id, NOW + DAY)).toBe("finished");
    expect(await pending(leaving.id)).toEqual([]);
    expect(await mutes()).toEqual([]);
  });
});
