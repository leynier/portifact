import { env } from "cloudflare:test";
import { AccountExport, type AnnotationTarget, FRESH_SESSION_MS } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { updateAccess } from "../src/access.ts";
import {
  exportAccount,
  processAccountDeletions,
  requestAccountDeletion,
} from "../src/account-data.ts";
import {
  createAnnotationThread,
  deleteOwnAnnotationMessage,
  eraseAuthorFromThread,
  type HumanCheck,
  replyToAnnotationThread,
  setAnnotationMode,
} from "../src/annotations.ts";
import { purgeArchived, runMaintenance } from "../src/maintenance.ts";
import { submitAbuseReport, suspendArtifact } from "../src/moderation.ts";
import { checkReadAccess } from "../src/read-access.ts";
import {
  artifactRow,
  DAY,
  db,
  MINUTE,
  NOW,
  publishSite,
  racing,
  session,
  sha256,
  user,
} from "./fixtures.ts";

const DOC: AnnotationTarget = { schema: 1, path: "index.html", anchor: { kind: "document" } };

/** An artifact of `owner` that `readers` may open, with annotations open. */
async function shared(ownerId: string, readers: { email: string }[]) {
  const published = await publishSite(ownerId);
  await updateAccess(db(), {
    ownerId,
    artifactId: published.artifactId,
    change: { mode: "restricted", addReaders: readers.map((r) => r.email.toLowerCase()) },
    now: NOW,
  });
  await setAnnotationMode(db(), {
    userId: ownerId,
    artifactId: published.artifactId,
    mode: "open",
    now: NOW,
  });
  return published;
}

/** A solved human check, so visitors' first comments go through. */
const HUMAN: HumanCheck = { token: "solved", verify: async () => "passed" };

let clock = NOW;
/** Distinct times keep message order and the per-minute rate limits apart. */
const tick = () => {
  clock += 15 * MINUTE;
  return clock;
};

async function thread(artifactId: string, versionId: string, userId: string, body: string) {
  const result = await createAnnotationThread(db(), {
    humanCheck: HUMAN,
    userId,
    artifactId,
    versionId,
    target: DOC,
    body,
    now: tick(),
  });
  if (!result.ok) throw new Error(result.code);
  return result.value;
}

async function reply(artifactId: string, threadId: string, userId: string, body: string) {
  const result = await replyToAnnotationThread(db(), {
    humanCheck: HUMAN,
    userId,
    artifactId,
    threadId,
    body,
    now: tick(),
  });
  if (!result.ok) throw new Error(result.code);
  return result.value;
}

async function messagesOf(threadId: string) {
  return db()
    .select({
      authorId: schema.annotationMessages.authorId,
      state: schema.annotationMessages.state,
      body: schema.annotationMessages.body,
    })
    .from(schema.annotationMessages)
    .where(eq(schema.annotationMessages.threadId, threadId))
    .orderBy(schema.annotationMessages.createdAt);
}

async function threadRow(threadId: string) {
  const [row] = await db()
    .select()
    .from(schema.annotationThreads)
    .where(eq(schema.annotationThreads.id, threadId));
  return row;
}

async function deletion(userId: string) {
  const [row] = await db()
    .select()
    .from(schema.accountDeletions)
    .where(eq(schema.accountDeletions.userId, userId));
  return row;
}

async function tombstone(kind: "account" | "artifact", id: string) {
  const [row] = await db().select().from(schema.tombstones).where(eq(schema.tombstones.id, id));
  return row?.kind === kind ? row : undefined;
}

/** Runs the jobs that carry a deletion forward until it finishes. */
async function finishDeletions(now: number) {
  for (let i = 0; i < 10; i += 1) {
    await purgeArchived(db(), env.ARTIFACTS, now, 500);
    const result = await processAccountDeletions(db(), env.ARTIFACTS, now, 100);
    if (result.processed === 0) return;
  }
}

describe("exporting the account", () => {
  it("lists the account, its artifacts with versions and threads, and its comments elsewhere", async () => {
    const owner = await user("Owner");
    const reader = await user("Reader");
    const other = await user("Other owner");
    const mine = await shared(owner.id, [reader]);
    const theirs = await shared(other.id, [owner]);
    const onMine = await thread(mine.artifactId, mine.versionId, reader.id, "Reader on mine");
    await reply(mine.artifactId, onMine.id, owner.id, "Owner answers");
    const onTheirs = await thread(theirs.artifactId, theirs.versionId, other.id, "Their note");
    await reply(theirs.artifactId, onTheirs.id, owner.id, "Owner elsewhere");

    const exported = await exportAccount(db(), { userId: owner.id, now: NOW });
    if (!exported.ok) throw new Error(exported.code);
    const data = AccountExport.parse(exported.value);
    expect(data.notice).toContain("untrusted");
    expect(data.account).toMatchObject({ id: owner.id, email: owner.email, name: "Owner" });
    expect(data.artifacts).toHaveLength(1);
    const artifact = data.artifacts[0];
    expect(artifact).toMatchObject({
      id: mine.artifactId,
      accessMode: "restricted",
      readers: [reader.email],
      annotations: "open",
      suspension: null,
    });
    expect(artifact?.versions).toMatchObject([
      {
        id: mine.versionId,
        current: true,
        download: `/api/v1/artifacts/${mine.artifactId}/versions/${mine.versionId}/download`,
        files: [{ kind: "published", path: "index.html" }],
      },
    ]);
    expect(artifact?.threads[0]?.messages.map((m) => [m.authorName, m.body, m.own])).toEqual([
      ["Reader", "Reader on mine", false],
      ["Owner", "Owner answers", true],
    ]);
    // Elsewhere: only the account's own words, never other people's messages or emails.
    expect(data.commentsElsewhere).toHaveLength(1);
    expect(data.commentsElsewhere[0]?.messages.map((m) => m.body)).toEqual(["Owner elsewhere"]);
    expect(JSON.stringify(data)).not.toContain(other.email);
  });

  it("shows why an artifact is suspended", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    await suspendArtifact(db(), { artifactId, reason: "phishing", note: "secret", now: NOW });
    const exported = await exportAccount(db(), { userId: owner.id, now: NOW });
    expect(exported.ok && exported.value.artifacts[0]?.suspension).toEqual({ reason: "phishing" });
    expect(JSON.stringify(exported)).not.toContain("secret");
  });

  it("refuses an account that does not exist", async () => {
    expect(await exportAccount(db(), { userId: "u_missing", now: NOW })).toMatchObject({
      ok: false,
      code: "unauthenticated",
    });
  });
});

describe("requesting the deletion", () => {
  it("needs the account's email typed again and a recent sign-in", async () => {
    const owner = await user();
    const fresh = await session(owner.id, NOW - FRESH_SESSION_MS);
    const stale = await session(owner.id, NOW - FRESH_SESSION_MS - 1);
    expect(
      await requestAccountDeletion(db(), {
        userId: owner.id,
        sessionId: fresh,
        confirmEmail: "someone-else@example.test",
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    expect(
      await requestAccountDeletion(db(), {
        userId: owner.id,
        sessionId: stale,
        confirmEmail: owner.email,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "reauthentication_required" });
    expect(await deletion(owner.id)).toBeUndefined();
    const done = await requestAccountDeletion(db(), {
      userId: owner.id,
      sessionId: fresh,
      confirmEmail: ` ${owner.email.toUpperCase()} `,
      now: NOW,
    });
    expect(done).toEqual({ ok: true, value: { deleted: true } });
  });

  it("refuses a session that belongs to someone else", async () => {
    const owner = await user();
    const attacker = await user();
    const theirs = await session(attacker.id);
    expect(
      await requestAccountDeletion(db(), {
        userId: owner.id,
        sessionId: theirs,
        confirmEmail: owner.email,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "unauthenticated" });
    const [still] = await db().select().from(schema.users).where(eq(schema.users.id, owner.id));
    expect(still).toBeDefined();
  });

  it("removes the user, its sessions and identities and stops serving its artifacts at once", async () => {
    const owner = await user();
    const reader = await user();
    const sessionId = await session(owner.id);
    await db()
      .insert(schema.accounts)
      .values({
        id: `acc_${owner.id}`,
        accountId: "github-123",
        providerId: "github",
        userId: owner.id,
        createdAt: new Date(NOW),
        updatedAt: new Date(NOW),
      });
    const active = await shared(owner.id, [reader]);
    const archived = await publishSite(owner.id);
    await db()
      .update(schema.artifacts)
      .set({ state: "archived", archivedAt: NOW, purgeAt: NOW + 180 * DAY })
      .where(eq(schema.artifacts.id, archived.artifactId));
    await submitAbuseReport(db(), {
      artifactId: active.artifactId,
      reason: "other",
      details: undefined,
      email: owner.email,
      now: NOW,
    });

    const result = await requestAccountDeletion(db(), {
      userId: owner.id,
      sessionId,
      confirmEmail: owner.email,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    expect(await db().select().from(schema.users).where(eq(schema.users.id, owner.id))).toEqual([]);
    expect(
      await db().select().from(schema.sessions).where(eq(schema.sessions.userId, owner.id)),
    ).toEqual([]);
    expect(
      await db().select().from(schema.accounts).where(eq(schema.accounts.userId, owner.id)),
    ).toEqual([]);
    for (const id of [active.artifactId, archived.artifactId]) {
      expect(await artifactRow(id)).toMatchObject({ state: "purging" });
    }
    expect(
      await checkReadAccess(db(), { artifactId: active.artifactId, userId: reader.id, now: NOW }),
    ).toMatchObject({ ok: false, code: "not_found" });
    const reports = await db()
      .select({ email: schema.abuseReports.reporterEmail })
      .from(schema.abuseReports)
      .where(eq(schema.abuseReports.artifactId, active.artifactId));
    expect(reports).toEqual([{ email: null }]);
    expect(await deletion(owner.id)).toMatchObject({ requestedAt: NOW });
  });

  it("is idempotent: a second request after the first changes nothing", async () => {
    const owner = await user();
    const sessionId = await session(owner.id);
    await publishSite(owner.id);
    const input = { userId: owner.id, sessionId, confirmEmail: owner.email, now: NOW };
    const lost = await requestAccountDeletion(
      racing(() => requestAccountDeletion(db(), input)),
      { ...input, now: NOW + 1 },
    );
    // The racing request read the user before the first one deleted it, and its batch then
    // finds nothing left to change.
    expect(lost.ok).toBe(true);
    expect(await deletion(owner.id)).toMatchObject({ requestedAt: NOW });
    expect(await requestAccountDeletion(db(), input)).toMatchObject({
      ok: false,
      code: "unauthenticated",
    });
  });
});

describe("finishing the deletion", () => {
  it("purges every artifact and its storage, and leaves tombstones for the account and the IDs", async () => {
    const owner = await user();
    const sessionId = await session(owner.id);
    const first = await publishSite(owner.id, { "index.html": "<p>one</p>", "a.css": "body{}" });
    const second = await publishSite(owner.id, { "index.html": "<p>two</p>" });
    await suspendArtifact(db(), { artifactId: second.artifactId, reason: "spam", now: NOW });
    await requestAccountDeletion(db(), {
      userId: owner.id,
      sessionId,
      confirmEmail: owner.email,
      now: NOW,
    });

    // Without the purge, the account cannot finish.
    await processAccountDeletions(db(), env.ARTIFACTS, NOW + 1, 100);
    expect(await deletion(owner.id)).toBeDefined();
    expect(await tombstone("account", owner.id)).toBeUndefined();

    await finishDeletions(NOW + 2);
    for (const id of [first.artifactId, second.artifactId]) {
      expect(await artifactRow(id)).toBeUndefined();
      expect(await tombstone("artifact", id)).toBeDefined();
    }
    expect(await tombstone("account", owner.id)).toBeDefined();
    expect(await deletion(owner.id)).toBeUndefined();
    const keys = (await env.ARTIFACTS.list({ prefix: `objects/${owner.id}/` })).objects;
    expect(keys).toEqual([]);
    for (const table of [schema.objects, schema.accountUsage]) {
      expect(await db().select().from(table).where(eq(table.ownerId, owner.id))).toEqual([]);
    }
    expect(
      await db().select().from(schema.usageEvents).where(eq(schema.usageEvents.ownerId, owner.id)),
    ).toEqual([]);
    expect(
      await db()
        .select()
        .from(schema.uploadSessions)
        .where(eq(schema.uploadSessions.ownerId, owner.id)),
    ).toEqual([]);
  });

  it("erases the account's comments elsewhere: markers where others replied, gone otherwise", async () => {
    const leaving = await user("Leaving");
    const owner = await user("Owner");
    const reader = await user("Reader");
    const theirs = await shared(owner.id, [leaving, reader]);
    const at = (threadId: string, userId: string, body: string) =>
      reply(theirs.artifactId, threadId, userId, body);

    // Only the leaving account wrote: the thread disappears.
    const alone = await thread(theirs.artifactId, theirs.versionId, leaving.id, "Alone");
    await at(alone.id, leaving.id, "Still alone");
    // Started by the leaving account and answered: its first message stays as a marker, the
    // trailing one with no reply after it disappears.
    const answered = await thread(theirs.artifactId, theirs.versionId, leaving.id, "Question");
    await at(answered.id, reader.id, "Answer");
    await at(answered.id, leaving.id, "Thanks");
    // Someone else's thread with one reply from the leaving account at the end: it disappears.
    const others = await thread(theirs.artifactId, theirs.versionId, reader.id, "Reader topic");
    await at(others.id, leaving.id, "Me too");
    // A message the account already deleted, then answered: stays a marker, untouched.
    const marked = await thread(theirs.artifactId, theirs.versionId, reader.id, "Topic");
    const mine = await at(marked.id, leaving.id, "Deleted earlier");
    await at(marked.id, owner.id, "Owner reply");
    const myMessage = mine.messages.find((m) => m.body === "Deleted earlier")?.id ?? "";
    await deleteOwnAnnotationMessage(db(), {
      userId: leaving.id,
      artifactId: theirs.artifactId,
      messageId: myMessage,
      now: tick(),
    });
    const markedBefore = await threadRow(marked.id);

    const requested = await requestAccountDeletion(db(), {
      userId: leaving.id,
      sessionId: await session(leaving.id, clock),
      confirmEmail: leaving.email,
      now: clock,
    });
    expect(requested.ok).toBe(true);
    await finishDeletions(tick());

    expect(await threadRow(alone.id)).toBeUndefined();
    expect(await messagesOf(answered.id)).toEqual([
      { authorId: leaving.id, state: "deleted", body: null },
      { authorId: reader.id, state: "visible", body: "Answer" },
    ]);
    expect(await threadRow(answered.id)).toMatchObject({ messageCount: 2 });
    expect(await messagesOf(others.id)).toEqual([
      { authorId: reader.id, state: "visible", body: "Reader topic" },
    ]);
    expect(await threadRow(others.id)).toMatchObject({ messageCount: 1 });
    expect(await threadRow(marked.id)).toMatchObject({ revision: markedBefore?.revision });
    expect(await tombstone("account", leaving.id)).toBeDefined();
    // The owner's artifact is untouched and still counts the remaining messages.
    expect(await artifactRow(theirs.artifactId)).toMatchObject({ state: "active" });
    const [usage] = await db()
      .select()
      .from(schema.annotationUsage)
      .where(eq(schema.annotationUsage.ownerId, owner.id));
    // Answer, Reader topic, Topic and Owner reply; markers do not count.
    expect(usage?.messages).toBe(4);
    // Each change left an event so open viewers refresh.
    const events = await db()
      .select({ kind: schema.annotationEvents.kind })
      .from(schema.annotationEvents)
      .where(inArray(schema.annotationEvents.threadId, [alone.id, answered.id, others.id]));
    expect(events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["thread_deleted", "message_deleted"]),
    );
  });

  it("does not erase a thread whose replies changed after it was read", async () => {
    const leaving = await user();
    const owner = await user();
    const theirs = await shared(owner.id, [leaving]);
    const started = await thread(theirs.artifactId, theirs.versionId, leaving.id, "Alone");
    // The owner replies between the read and the batch: the claim fails, nothing is deleted.
    const changed = await eraseAuthorFromThread(
      racing(() => reply(theirs.artifactId, started.id, owner.id, "Late reply")),
      { authorId: leaving.id, threadId: started.id, now: tick() },
    );
    expect(changed).toBe(false);
    expect((await messagesOf(started.id)).map((m) => m.body)).toEqual(["Alone", "Late reply"]);
    // The next run sees the reply and keeps a marker.
    expect(
      await eraseAuthorFromThread(db(), {
        authorId: leaving.id,
        threadId: started.id,
        now: tick(),
      }),
    ).toBe(true);
    expect((await messagesOf(started.id)).map((m) => m.state)).toEqual(["deleted", "visible"]);
    expect(
      await eraseAuthorFromThread(db(), {
        authorId: leaving.id,
        threadId: started.id,
        now: tick(),
      }),
    ).toBe(false);
    expect(
      await eraseAuthorFromThread(db(), {
        authorId: leaving.id,
        threadId: "th_missing",
        now: tick(),
      }),
    ).toBe(false);
  });

  it("claims an artifact created by an upload that was in flight during the request", async () => {
    const owner = await user();
    const sessionId = await session(owner.id);
    await requestAccountDeletion(db(), {
      userId: owner.id,
      sessionId,
      confirmEmail: owner.email,
      now: NOW,
    });
    // A publish that was authorized before the deletion commits afterwards.
    const late = await publishSite(owner.id, { "index.html": "<p>late</p>" }, NOW + 1);
    await finishDeletions(NOW + 2);
    expect(await artifactRow(late.artifactId)).toBeUndefined();
    expect(await tombstone("artifact", late.artifactId)).toBeDefined();
    expect(await tombstone("account", owner.id)).toBeDefined();
  });

  it("runs as part of the scheduled maintenance and leaves other accounts alone", async () => {
    const owner = await user();
    const other = await user();
    const sessionId = await session(owner.id);
    const mine = await publishSite(owner.id);
    const theirs = await publishSite(other.id);
    await requestAccountDeletion(db(), {
      userId: owner.id,
      sessionId,
      confirmEmail: owner.email,
      now: NOW,
    });
    await runMaintenance(db(), env.ARTIFACTS, NOW + 1);
    const result = await runMaintenance(db(), env.ARTIFACTS, NOW + 2);
    expect(result.accountDeletions).toBeGreaterThanOrEqual(0);
    await finishDeletions(NOW + 3);
    expect(await artifactRow(mine.artifactId)).toBeUndefined();
    expect(await artifactRow(theirs.artifactId)).toMatchObject({ state: "active" });
    const body = "<p>theirs-again</p>";
    expect(await env.ARTIFACTS.head(`objects/${other.id}/${await sha256(body)}`)).toBeNull();
  });
});

describe("artifact IDs", () => {
  it("are never reused after a purge", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    await db()
      .insert(schema.tombstones)
      .values({ kind: "artifact", id: "tombstone1", deletedAt: NOW });
    const insert = db().insert(schema.artifacts).values({
      id: "tombstone1",
      ownerId: owner.id,
      type: "site",
      name: "Reused",
    });
    await expect(insert).rejects.toSatisfy((error: unknown) => {
      for (let e: unknown = error; e instanceof Error; e = e.cause) {
        if (e.message.includes("artifact_id_tombstoned")) return true;
      }
      return false;
    });
    expect(artifactId).not.toBe("tombstone1");
  });
});
