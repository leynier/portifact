// History retention (docs/operations.md, "History retention"): lifecycle and moderation records
// of purged artifacts and deleted accounts, a deleted account's traces on other people's
// artifacts, upload and usage history and stale storage findings.

import { env } from "cloudflare:test";
import { schema } from "@portifact/db";
import {
  CLOSED_UPLOAD_RETENTION_DAYS,
  ERASED_ACCOUNT,
  HISTORY_RETENTION_DAYS,
  STALE_FINDING_DAYS,
  USAGE_EVENT_RETENTION_DAYS,
} from "@portifact/domain";
import { eq, inArray, like, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  eraseAccountTraces,
  markAccountGone,
  pruneGoneHistory,
  pruneStaleFindings,
  pruneUploadHistory,
} from "../src/history-retention.ts";
import { deleteArtifactData } from "../src/maintenance.ts";
import { DAY, db, NOW, publishSite, user } from "./fixtures.ts";

const le = schema.lifecycleEvents;
const s = schema.suspensions;
const RETAINED = HISTORY_RETENTION_DAYS * DAY;

async function events(artifactId: string) {
  return db().select({ event: le.event }).from(le).where(eq(le.artifactId, artifactId));
}

async function suspension(kind: "artifact" | "account", targetId: string, extra = {}) {
  const id = `sus_${crypto.randomUUID()}`;
  await db()
    .insert(s)
    .values({
      id,
      kind,
      targetId,
      reason: "spam",
      note: "Operator's note",
      createdAt: NOW - DAY,
      ...extra,
    });
  return id;
}

/** Purges `artifactId` at `at` the way the purge does. */
async function purge(artifactId: string, at: number) {
  await db()
    .update(schema.artifacts)
    .set({ state: "purging" })
    .where(eq(schema.artifacts.id, artifactId));
  await deleteArtifactData(db(), env.ARTIFACTS, artifactId, at);
}

/** Runs the scan until it has nothing left to delete in this test's rows. */
async function pruneAll(now: number) {
  for (let run = 0; run < 50; run++) {
    const done = await pruneGoneHistory(db(), now);
    if (done.artifacts === 0 && done.suspensions === 0) return;
  }
  throw new Error("the scan never finished");
}

describe("lifecycle and moderation records of what is gone", () => {
  it("keeps them for the retention period after the purge, then deletes them", async () => {
    const owner = await user();
    const site = await publishSite(owner.id);
    const suspended = await suspension("artifact", site.artifactId);
    const purgedAt = NOW;
    await purge(site.artifactId, purgedAt);
    const [row] = await db().select().from(s).where(eq(s.id, suspended));
    expect(row?.targetGoneAt).toBe(purgedAt);

    await pruneAll(purgedAt + RETAINED - DAY);
    expect((await events(site.artifactId)).length).toBeGreaterThan(0);
    expect(await db().select().from(s).where(eq(s.id, suspended))).toHaveLength(1);

    await pruneAll(purgedAt + RETAINED + DAY);
    expect(await events(site.artifactId)).toEqual([]);
    expect(await db().select().from(s).where(eq(s.id, suspended))).toEqual([]);
  });

  it("never deletes the history of an artifact that exists, even with an old purged event", async () => {
    const owner = await user();
    const site = await publishSite(owner.id);
    // A restore brought it back after its purge was recorded.
    await db()
      .insert(le)
      .values({
        artifactId: site.artifactId,
        actorId: null,
        channel: "system",
        event: "purged",
        at: NOW - 2 * RETAINED,
      });
    await pruneAll(NOW);
    expect((await events(site.artifactId)).map((e) => e.event)).toContain("purged");
  });

  it("walks a bounded number of purged artifacts per run and resumes past those it keeps", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const kept = await publishSite((await user()).id);
    const old = NOW - 3 * RETAINED;
    // One that must stay (it exists), first in the order, then gone ones.
    await db().insert(le).values({
      artifactId: kept.artifactId,
      actorId: null,
      channel: "system",
      event: "purged",
      at: old,
    });
    const gone = Array.from({ length: 4 }, (_, i) => `gone${tag}${i}`);
    for (const id of gone) {
      await db()
        .insert(le)
        .values([
          { artifactId: id, actorId: null, channel: "system", event: "published", at: old },
          { artifactId: id, actorId: null, channel: "system", event: "purged", at: old + 1 },
        ]);
    }
    const first = await pruneGoneHistory(db(), NOW, { artifacts: 2, rows: 500 });
    expect(first.artifacts).toBeLessThanOrEqual(2);
    await pruneAll(NOW);
    const left = await db()
      .select({ id: le.artifactId })
      .from(le)
      .where(inArray(le.artifactId, gone));
    expect(left).toEqual([]);
    expect((await events(kept.artifactId)).length).toBeGreaterThan(0);
  });

  it("starts an account's suspensions' retention when its deletion finishes", async () => {
    const person = await user();
    const id = await suspension("account", person.id);
    await db().batch([markAccountGone(db(), person.id, sql`1`, NOW)]);
    const [row] = await db().select().from(s).where(eq(s.id, id));
    expect(row?.targetGoneAt).toBe(NOW);
    await pruneAll(NOW + RETAINED + DAY);
    expect(await db().select().from(s).where(eq(s.id, id))).toEqual([]);
  });

  it("keeps suspensions of artifacts and accounts that still exist", async () => {
    const person = await user();
    const id = await suspension("account", person.id);
    await pruneAll(NOW + 10 * RETAINED);
    expect(await db().select().from(s).where(eq(s.id, id))).toHaveLength(1);
  });
});

describe("a deleted account's traces on other people's artifacts", () => {
  it("forgets who acted, who wrote the markers and threads others replied to, and who resolved", async () => {
    const owner = await user();
    const gone = await user();
    const site = await publishSite(owner.id);
    const threadId = `th_${crypto.randomUUID()}`;
    await db()
      .insert(schema.annotationThreads)
      .values({
        id: threadId,
        artifactId: site.artifactId,
        versionId: site.versionId,
        ownerId: owner.id,
        authorId: gone.id,
        target: JSON.stringify({ schema: 1, path: "index.html", anchor: { kind: "document" } }),
        targetBytes: 60,
        path: "index.html",
        state: "resolved",
        resolvedBy: gone.id,
        messageCount: 2,
        createdAt: NOW,
        updatedAt: NOW,
      });
    const marker = `msg_${crypto.randomUUID()}`;
    const reply = `msg_${crypto.randomUUID()}`;
    await db()
      .insert(schema.annotationMessages)
      .values([
        {
          id: marker,
          threadId,
          artifactId: site.artifactId,
          ownerId: owner.id,
          authorId: gone.id,
          body: null,
          bodyBytes: 0,
          state: "deleted",
          createdAt: NOW,
        },
        {
          id: reply,
          threadId,
          artifactId: site.artifactId,
          ownerId: owner.id,
          authorId: owner.id,
          body: "Reply",
          bodyBytes: 5,
          createdAt: NOW + 1,
        },
      ]);
    await db().insert(schema.annotationEvents).values({
      artifactId: site.artifactId,
      threadId,
      messageId: marker,
      actorId: gone.id,
      writeId: crypto.randomUUID(),
      kind: "thread_created",
      at: NOW,
    });
    await db().insert(le).values({
      artifactId: site.artifactId,
      actorId: gone.id,
      channel: "web",
      event: "renewed",
      at: NOW,
    });

    expect(await eraseAccountTraces(db(), gone.id, NOW, 1)).toEqual({ more: true });
    expect(await eraseAccountTraces(db(), gone.id, NOW)).toEqual({ more: false });

    const [thread] = await db()
      .select()
      .from(schema.annotationThreads)
      .where(eq(schema.annotationThreads.id, threadId));
    expect(thread).toMatchObject({ authorId: ERASED_ACCOUNT, resolvedBy: null });
    const messages = await db()
      .select({ id: schema.annotationMessages.id, authorId: schema.annotationMessages.authorId })
      .from(schema.annotationMessages)
      .where(eq(schema.annotationMessages.threadId, threadId));
    expect(messages).toContainEqual({ id: marker, authorId: ERASED_ACCOUNT });
    // Someone else's message keeps its author.
    expect(messages).toContainEqual({ id: reply, authorId: owner.id });
    const [event] = await db()
      .select({ actorId: schema.annotationEvents.actorId })
      .from(schema.annotationEvents)
      .where(eq(schema.annotationEvents.threadId, threadId));
    expect(event?.actorId).toBe(ERASED_ACCOUNT);
    const actors = await db()
      .select({ actorId: le.actorId })
      .from(le)
      .where(eq(le.artifactId, site.artifactId));
    expect(actors.map((row) => row.actorId)).not.toContain(gone.id);
  });
});

describe("upload and usage history and storage findings", () => {
  it("prunes old usage events and closed uploads nothing needs, and keeps the rest", async () => {
    const owner = await user();
    const old = NOW - (USAGE_EVENT_RETENTION_DAYS + 1) * DAY;
    await db()
      .insert(schema.usageEvents)
      .values([
        { ownerId: owner.id, kind: "publish", amount: 1, at: old },
        { ownerId: owner.id, kind: "publish", amount: 1, at: NOW - DAY },
      ]);
    const expired = NOW - (CLOSED_UPLOAD_RETENTION_DAYS + 1) * DAY;
    const session = (
      id: string,
      state: "committed" | "failed" | "uploading",
      versionId: string,
    ) => ({
      id,
      ownerId: owner.id,
      artifactId: "a",
      versionId,
      state,
      expiresAt: expired,
      createdAt: expired - DAY,
    });
    const site = await publishSite(owner.id);
    const tag = crypto.randomUUID();
    await db()
      .insert(schema.uploadSessions)
      .values([
        session(`${tag}-committed`, "committed", site.versionId),
        session(`${tag}-failed-gone`, "failed", `${tag}-no-version`),
        session(`${tag}-failed-kept`, "failed", site.versionId),
        session(`${tag}-open`, "uploading", `${tag}-v`),
        session(`${tag}-multipart`, "committed", site.versionId),
      ]);
    // A closed session whose multipart upload the `abort_multipart` job has not aborted yet.
    await db()
      .insert(schema.multipartUploads)
      .values({
        sessionId: `${tag}-multipart`,
        sha256: "b".repeat(64),
        ownerId: owner.id,
        r2Key: `uploads/${tag}`,
        uploadId: "upload",
        partSize: 5,
        partCount: 2,
      });
    for (let run = 0; run < 20; run++) {
      const done = await pruneUploadHistory(db(), NOW);
      if (done.usageEvents === 0 && done.uploads === 0) break;
    }
    const usage = await db()
      .select({ at: schema.usageEvents.at })
      .from(schema.usageEvents)
      .where(eq(schema.usageEvents.ownerId, owner.id));
    // The publish's own events (at NOW) stay too.
    expect(usage.map((row) => row.at)).not.toContain(old);
    expect(usage.map((row) => row.at)).toContain(NOW - DAY);
    const uploads = await db()
      .select({ id: schema.uploadSessions.id })
      .from(schema.uploadSessions)
      .where(like(schema.uploadSessions.id, `${tag}%`));
    expect(uploads.map((row) => row.id).sort()).toEqual([
      `${tag}-failed-kept`,
      `${tag}-multipart`,
      `${tag}-open`,
    ]);
  });

  it("prunes storage findings no pass has seen for a long time", async () => {
    const tag = crypto.randomUUID();
    const stale = NOW - (STALE_FINDING_DAYS + 1) * DAY;
    await db()
      .insert(schema.storageFindings)
      .values([
        {
          kind: "orphan",
          r2Key: `objects/${tag}/old`,
          detail: null,
          firstSeenAt: stale,
          lastSeenAt: stale,
        },
        {
          kind: "orphan",
          r2Key: `objects/${tag}/new`,
          detail: null,
          firstSeenAt: stale,
          lastSeenAt: NOW,
        },
      ]);
    while ((await pruneStaleFindings(db(), NOW)) > 0) {}
    const left = await db()
      .select({ key: schema.storageFindings.r2Key })
      .from(schema.storageFindings)
      .where(like(schema.storageFindings.r2Key, `objects/${tag}/%`));
    expect(left).toEqual([{ key: `objects/${tag}/new` }]);
  });
});
