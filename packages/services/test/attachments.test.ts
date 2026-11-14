// Comment attachments (decision 0028): uploads, attaching in the comment's own batch, who reads a
// file, deletion by triggers, the prune, the operator's removal and the restore.
import { env } from "cloudflare:test";
import { type AnnotationTarget, ATTACHMENT_LIMITS } from "@portifact/contracts";
import { type RegionalDb, regionsFromEnv, schema } from "@portifact/db";
import { attachmentKey } from "@portifact/domain";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  advanceAccountDeletion,
  exportAccount,
  requestAccountDeletion,
} from "../src/account-data.ts";
import {
  createAnnotationThread,
  deleteOwnAnnotationMessage,
  getAnnotationThread,
  type HumanCheck,
  moderateAnnotationMessage,
  replyToAnnotationThread,
} from "../src/annotations.ts";
import {
  getAttachmentFile,
  listArtifactAttachments,
  prepareAttachment,
  pruneAttachmentUploads,
  reinstateAttachment,
  removeAttachment,
  withholdAttachment,
} from "../src/attachments.ts";
import { applyTombstones, exportTombstones, reconcileStorage } from "../src/backups.ts";
import { runJob } from "../src/outbox.ts";
import { session } from "./fixtures.ts";

const db = (): RegionalDb => regionsFromEnv(env).get("default").db;
const NOW = Date.UTC(2026, 10, 14, 12);
const DAY = 86_400_000;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const HUMAN: HumanCheck = { token: "solved", verify: async () => "passed" };
const DOC: AnnotationTarget = { schema: 1, path: "index.html", anchor: { kind: "document" } };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const HTML = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
const BINARY_HTML = new Uint8Array([...HTML, 0, 0xff]);
const STATEMENT = {
  facts: "A rights holder's notice says the image copies their photo.",
  ground: "Copyright infringement under the Acceptable Use Policy.",
  source: "notice" as const,
  withhold: false,
};

function artifactId(): string {
  let id = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(10))) id += ALPHABET[byte % 32];
  return id;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function user(): Promise<{ id: string; email: string }> {
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

interface World {
  id: string;
  owner: string;
  reader: string;
  ownerEmail: string;
  readerEmail: string;
  other: string;
  stranger: string;
  version: string;
}

/** A restricted artifact with two readers; comments visible to the owner only by default. */
async function world(): Promise<World> {
  const owner = await user();
  const reader = await user();
  const other = await user();
  const stranger = await user();
  const id = artifactId();
  await db()
    .insert(schema.artifacts)
    .values({
      id,
      ownerId: owner.id,
      type: "site",
      name: "Plan",
      state: "active",
      annotations: "open",
      commentVisibility: "owner",
      expiresAt: NOW + 30 * DAY,
      createdAt: NOW,
      updatedAt: NOW,
    });
  const version = `${id}_v1`;
  await db().insert(schema.versions).values({
    id: version,
    artifactId: id,
    number: 1,
    authorId: owner.id,
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
      ownerId: owner.id,
      sha256: "a".repeat(64),
      size: 10,
      contentType: "text/html",
    });
  await db()
    .update(schema.artifacts)
    .set({ currentVersionId: version })
    .where(eq(schema.artifacts.id, id));
  await db()
    .insert(schema.artifactReaders)
    .values([
      { artifactId: id, email: reader.email },
      { artifactId: id, email: other.email },
    ]);
  return {
    id,
    owner: owner.id,
    reader: reader.id,
    ownerEmail: owner.email,
    readerEmail: reader.email,
    other: other.id,
    stranger: stranger.id,
    version,
  };
}

/** Prepares an upload and sends its bytes to R2 as the presigned PUT would. */
async function uploaded(w: World, userId: string, bytes: Uint8Array = PNG, name = "shot.png") {
  const prepared = await prepareAttachment(db(), {
    userId,
    artifactId: w.id,
    name,
    size: bytes.length,
    sha256: await sha256(bytes),
    now: NOW,
  });
  if (!prepared.ok) throw new Error(`prepare failed: ${prepared.code}`);
  await env.ARTIFACTS.put(prepared.value.key, bytes, { sha256: await sha256(bytes) });
  return prepared.value;
}

function start(w: World, userId: string, ids: string[], now = NOW) {
  return createAnnotationThread(db(), {
    humanCheck: HUMAN,
    userId,
    artifactId: w.id,
    versionId: w.version,
    target: DOC,
    body: "See the screenshot",
    now,
    attachments: { ids, bucket: env.ARTIFACTS },
  });
}

async function ownerBytes(owner: string) {
  const [row] = await db()
    .select({ bytes: schema.annotationUsage.bytes })
    .from(schema.annotationUsage)
    .where(eq(schema.annotationUsage.ownerId, owner));
  return row?.bytes ?? 0;
}

async function rowOf(id: string) {
  const [row] = await db()
    .select()
    .from(schema.commentAttachments)
    .where(eq(schema.commentAttachments.id, id));
  return row;
}

async function hold(w: World) {
  await db()
    .update(schema.artifacts)
    .set({ state: "suspended", suspensionReason: "malware" })
    .where(eq(schema.artifacts.id, w.id));
  await db().insert(schema.legalHolds).values({
    id: crypto.randomUUID(),
    artifactId: w.id,
    ownerId: w.owner,
    reason: "malware",
    ground: "test",
  });
}

describe("comment attachments", () => {
  beforeEach(async () => {
    await db().global.delete(schema.rateLimits);
  });

  it("attaches checked files to a new thread and counts them in the owner's comment storage", async () => {
    const w = await world();
    const file = await uploaded(w, w.reader);
    expect(file.key).toBe(attachmentKey(w.id, file.id));
    const thread = await start(w, w.reader, [file.id]);
    expect(thread.ok).toBe(true);
    if (!thread.ok) return;
    expect(thread.value.messages[0]?.attachments).toEqual([
      {
        id: file.id,
        name: "shot.png",
        contentType: "image/png",
        size: PNG.length,
        sha256: file.sha256,
      },
    ]);
    expect(await rowOf(file.id)).toMatchObject({
      state: "attached",
      contentType: "image/png",
      expiresAt: null,
    });
    // The body, the target and the file.
    const [message] = await db()
      .select({ bodyBytes: schema.annotationMessages.bodyBytes })
      .from(schema.annotationMessages)
      .where(eq(schema.annotationMessages.threadId, thread.value.id));
    const [row] = await db()
      .select({ targetBytes: schema.annotationThreads.targetBytes })
      .from(schema.annotationThreads)
      .where(eq(schema.annotationThreads.id, thread.value.id));
    expect(await ownerBytes(w.owner)).toBe(
      (message?.bodyBytes ?? 0) + (row?.targetBytes ?? 0) + PNG.length,
    );
    const read = await getAttachmentFile(db(), {
      userId: w.owner,
      artifactId: w.id,
      attachmentId: file.id,
      now: NOW,
    });
    expect(read).toMatchObject({ ok: true, value: { contentType: "image/png", key: file.key } });
  });

  it("attaches files to a reply too, text judged from the whole file", async () => {
    const w = await world();
    const thread = await createAnnotationThread(db(), {
      humanCheck: HUMAN,
      userId: w.owner,
      artifactId: w.id,
      versionId: w.version,
      target: DOC,
      body: "Start",
      now: NOW,
    });
    if (!thread.ok) throw new Error("thread");
    const file = await uploaded(w, w.reader, new TextEncoder().encode("log line\n"), "log");
    const reply = await replyToAnnotationThread(db(), {
      humanCheck: HUMAN,
      userId: w.reader,
      artifactId: w.id,
      threadId: thread.value.id,
      body: "Here is the log",
      now: NOW,
      attachments: { ids: [file.id], bucket: env.ARTIFACTS },
    });
    expect(reply.ok && reply.value.messages[1]?.attachments?.[0]?.contentType).toBe("text/plain");
  });

  it("judges the bytes: a file that is not an allowed type writes nothing", async () => {
    const w = await world();
    const file = await uploaded(w, w.reader, BINARY_HTML, "page.png");
    expect(await start(w, w.reader, [file.id])).toMatchObject({ ok: false, code: "invalid_input" });
    expect((await rowOf(file.id))?.state).toBe("pending");
    const threads = await db()
      .select()
      .from(schema.annotationThreads)
      .where(eq(schema.annotationThreads.artifactId, w.id));
    expect(threads).toHaveLength(0);
  });

  it("refuses files whose bytes were never sent or differ from the upload", async () => {
    const w = await world();
    const prepared = await prepareAttachment(db(), {
      userId: w.reader,
      artifactId: w.id,
      name: "shot.png",
      size: PNG.length,
      sha256: await sha256(PNG),
      now: NOW,
    });
    if (!prepared.ok) throw new Error("prepare");
    expect(await start(w, w.reader, [prepared.value.id])).toMatchObject({ code: "invalid_input" });
    await env.ARTIFACTS.put(prepared.value.key, new Uint8Array([...PNG.slice(0, -1), 9]));
    expect(await start(w, w.reader, [prepared.value.id])).toMatchObject({ code: "invalid_input" });
  });

  it("never attaches someone else's upload, an expired one or one of another artifact", async () => {
    const w = await world();
    const theirs = await uploaded(w, w.other);
    expect(await start(w, w.reader, [theirs.id])).toMatchObject({ code: "invalid_input" });
    const late = await uploaded(w, w.reader);
    expect(
      await start(w, w.reader, [late.id], NOW + ATTACHMENT_LIMITS.pendingTtlMs + 1),
    ).toMatchObject({ code: "invalid_input" });
    const elsewhere = await world();
    await db()
      .insert(schema.artifactReaders)
      .values({ artifactId: elsewhere.id, email: w.readerEmail });
    const foreign = await uploaded(elsewhere, w.reader);
    expect(await start(w, w.reader, [foreign.id])).toMatchObject({ code: "invalid_input" });
  });

  it("refuses attaching past the owner's comment storage", async () => {
    const w = await world();
    const file = await uploaded(w, w.reader);
    await db()
      .insert(schema.annotationUsage)
      .values({ ownerId: w.owner, messages: 0, bytes: 0, bytesLimit: 60 })
      .onConflictDoUpdate({ target: schema.annotationUsage.ownerId, set: { bytesLimit: 60 } });
    expect(await start(w, w.reader, [file.id])).toMatchObject({
      ok: false,
      code: "quota_exceeded",
    });
    expect((await rowOf(file.id))?.state).toBe("pending");
  });

  it("lets only people who can comment start uploads, within their caps", async () => {
    const w = await world();
    const input = {
      artifactId: w.id,
      name: "shot.png",
      size: PNG.length,
      sha256: await sha256(PNG),
      now: NOW,
    };
    expect(await prepareAttachment(db(), { ...input, userId: w.stranger })).toMatchObject({
      code: "not_found",
    });
    expect(
      await prepareAttachment(db(), {
        ...input,
        userId: w.reader,
        size: ATTACHMENT_LIMITS.fileMaxBytes + 1,
      }),
    ).toMatchObject({ code: "invalid_input" });
    for (let i = 0; i < ATTACHMENT_LIMITS.pendingPerPerson; i++) {
      expect((await prepareAttachment(db(), { ...input, userId: w.reader })).ok).toBe(true);
    }
    expect(await prepareAttachment(db(), { ...input, userId: w.reader })).toMatchObject({
      code: "rate_limited",
    });
    // A locked artifact takes no new comments from readers, so no uploads either.
    await db()
      .update(schema.artifacts)
      .set({ annotations: "locked" })
      .where(eq(schema.artifacts.id, w.id));
    expect(await prepareAttachment(db(), { ...input, userId: w.other })).toMatchObject({
      ok: false,
      code: "forbidden",
    });
  });

  it("counts uploads per person per day", async () => {
    const w = await world();
    const input = {
      userId: w.reader,
      artifactId: w.id,
      name: "shot.png",
      size: PNG.length,
      sha256: await sha256(PNG),
    };
    for (let i = 0; i < ATTACHMENT_LIMITS.uploadsPerPersonPerDay; i++) {
      // Each an hour apart in the window's first day would expire; here only the counter matters.
      const at = NOW + i;
      await db()
        .delete(schema.commentAttachments)
        .where(eq(schema.commentAttachments.uploadedBy, w.reader));
      expect((await prepareAttachment(db(), { ...input, now: at })).ok).toBe(true);
    }
    expect(await prepareAttachment(db(), { ...input, now: NOW + 1_000 })).toMatchObject({
      code: "rate_limited",
    });
  });

  it("shows a file exactly to whoever sees its message's body", async () => {
    const w = await world();
    const file = await uploaded(w, w.reader);
    const thread = await start(w, w.reader, [file.id]);
    if (!thread.ok) throw new Error("thread");
    const read = (userId: string) =>
      getAttachmentFile(db(), { userId, artifactId: w.id, attachmentId: file.id, now: NOW });
    // Visible to the owner only by default: another reader sees neither the thread nor the file.
    expect((await read(w.reader)).ok).toBe(true);
    expect((await read(w.owner)).ok).toBe(true);
    expect(await read(w.other)).toMatchObject({ ok: false, code: "not_found" });
    expect(await read(w.stranger)).toMatchObject({ ok: false, code: "not_found" });
    await db()
      .update(schema.artifacts)
      .set({ commentVisibility: "everyone" })
      .where(eq(schema.artifacts.id, w.id));
    expect((await read(w.other)).ok).toBe(true);
    // Hidden by the owner: the author and the owner still see it, nobody else.
    const hidden = await moderateAnnotationMessage(db(), {
      userId: w.owner,
      artifactId: w.id,
      messageId: thread.value.messages[0]?.id ?? "",
      action: "hide",
      now: NOW,
    });
    expect(hidden.ok).toBe(true);
    expect(await read(w.other)).toMatchObject({ code: "not_found" });
    const seen = await getAnnotationThread(db(), {
      userId: w.other,
      artifactId: w.id,
      threadId: thread.value.id,
      now: NOW,
    });
    expect(seen.ok && seen.value.messages[0]?.attachments).toBeUndefined();
    expect((await read(w.reader)).ok).toBe(true);
    expect((await read(w.owner)).ok).toBe(true);
    // Held: the owner side reads nothing, with the hold's refusal.
    await hold(w);
    expect(await read(w.owner)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await read(w.reader)).toMatchObject({ ok: false });
  });

  it("deletes a file with its message, and the job deletes its bytes", async () => {
    const w = await world();
    const file = await uploaded(w, w.reader);
    const thread = await start(w, w.reader, [file.id]);
    if (!thread.ok) throw new Error("thread");
    const before = await ownerBytes(w.owner);
    const deleted = await deleteOwnAnnotationMessage(db(), {
      userId: w.reader,
      artifactId: w.id,
      messageId: thread.value.messages[0]?.id ?? "",
      now: NOW,
    });
    expect(deleted.ok).toBe(true);
    expect(await rowOf(file.id)).toBeUndefined();
    expect(await ownerBytes(w.owner)).toBeLessThanOrEqual(before - PNG.length);
    const jobs = await db()
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.topic, "delete_objects"), eq(schema.outbox.subject, w.owner)));
    const job = jobs.find((row) => (row.payload as { keys: string[] }).keys.includes(file.key));
    expect(job).toBeDefined();
    expect(await env.ARTIFACTS.head(file.key)).not.toBeNull();
    await runJob(db(), env.ARTIFACTS, { id: job?.id ?? 0, topic: "delete_objects" }, NOW);
    expect(await env.ARTIFACTS.head(file.key)).toBeNull();
  });

  it("keeps the bytes of a file a row still names when a deletion job runs", async () => {
    const w = await world();
    const file = await uploaded(w, w.reader);
    const [job] = await db()
      .insert(schema.outbox)
      .values({
        topic: "delete_objects",
        payload: { keys: [file.key] },
        availableAt: NOW,
        createdAt: NOW,
      })
      .returning({ id: schema.outbox.id });
    await runJob(db(), env.ARTIFACTS, { id: job?.id ?? 0, topic: "delete_objects" }, NOW);
    expect(await env.ARTIFACTS.head(file.key)).not.toBeNull();
  });

  it("prunes uploads nobody attached within their hour, never on a held artifact", async () => {
    const w = await world();
    const loose = await uploaded(w, w.reader);
    const held = await world();
    const kept = await uploaded(held, held.reader);
    await hold(held);
    expect(await pruneAttachmentUploads(db(), NOW + ATTACHMENT_LIMITS.pendingTtlMs - 1)).toBe(0);
    await pruneAttachmentUploads(db(), NOW + ATTACHMENT_LIMITS.pendingTtlMs);
    expect(await rowOf(loose.id)).toBeUndefined();
    expect(await rowOf(kept.id)).toBeDefined();
  });

  it("lets the operator withhold a file at once, tell its people, reinstate it, and remove it for good only after the counter-notice wait", async () => {
    const w = await world();
    const file = await uploaded(w, w.reader);
    const thread = await start(w, w.reader, [file.id]);
    if (!thread.ok) throw new Error("thread");
    const ref = { artifactId: w.id, attachmentId: file.id };
    // Nothing is deleted before the file was withheld and its wait is over.
    expect(await removeAttachment(db(), { ...ref, now: NOW })).toMatchObject({
      code: "invalid_input",
    });
    const withheld = await withholdAttachment(db(), {
      ...ref,
      reason: "copyright",
      statement: STATEMENT,
      now: NOW,
    });
    expect(withheld.ok).toBe(true);
    if (!withheld.ok) return;
    expect(
      await withholdAttachment(db(), {
        ...ref,
        reason: "copyright",
        statement: STATEMENT,
        now: NOW,
      }),
    ).toMatchObject({ code: "invalid_input" });
    // From that moment nobody views or downloads it, the owner included; it stays stored.
    for (const userId of [w.owner, w.reader]) {
      expect(
        await getAttachmentFile(db(), {
          userId,
          artifactId: w.id,
          attachmentId: file.id,
          now: NOW,
        }),
      ).toMatchObject({ code: "not_found" });
    }
    const seen = await getAnnotationThread(db(), {
      userId: w.owner,
      artifactId: w.id,
      threadId: thread.value.id,
      now: NOW,
    });
    expect(seen.ok && seen.value.messages[0]?.attachments).toBeUndefined();
    expect(await env.ARTIFACTS.head(file.key)).not.toBeNull();
    expect(await rowOf(file.id)).toMatchObject({ withheldReason: "copyright" });
    const [listed] = await listArtifactAttachments(db(), w.id);
    expect(listed).toMatchObject({ id: file.id, withheldAt: NOW, withheldReason: "copyright" });

    // The statement of reasons goes to the person who attached it and to the owner.
    const sent: { to: string; target: string; attachmentId: string | null }[] = [];
    const notifier = {
      async send(notice: { to: string; target: string; attachmentId: string | null }) {
        sent.push({ to: notice.to, target: notice.target, attachmentId: notice.attachmentId });
      },
    };
    const [job] = await db()
      .select()
      .from(schema.outbox)
      .where(
        and(
          eq(schema.outbox.topic, "moderation_notice"),
          eq(schema.outbox.subject, withheld.value.decisionId),
        ),
      );
    expect(job).toBeDefined();
    expect(
      await runJob(db(), env.ARTIFACTS, { id: job?.id ?? 0, topic: "moderation_notice" }, NOW, {
        moderationNotifier: notifier,
      }),
    ).toBe("done");
    expect(sent.map((notice) => notice.to).sort()).toEqual([w.ownerEmail, w.readerEmail].sort());
    expect(
      sent.every((notice) => notice.target === "attachment" && notice.attachmentId === file.id),
    ).toBe(true);

    // A review or counter-notice that stands gives it back, with a statement too.
    const back = await reinstateAttachment(db(), { ...ref, statement: STATEMENT, now: NOW + DAY });
    expect(back.ok).toBe(true);
    expect(
      (
        await getAttachmentFile(db(), {
          userId: w.reader,
          artifactId: w.id,
          attachmentId: file.id,
          now: NOW,
        })
      ).ok,
    ).toBe(true);
    expect(
      await reinstateAttachment(db(), { ...ref, statement: STATEMENT, now: NOW }),
    ).toMatchObject({ code: "invalid_input" });

    // Withheld again: removal waits for the counter-notice period, then deletes for good.
    await withholdAttachment(db(), {
      ...ref,
      reason: "copyright",
      statement: STATEMENT,
      now: NOW + 2 * DAY,
    });
    const restoredRow = await rowOf(file.id);
    if (!restoredRow) throw new Error("row");
    const due = NOW + 2 * DAY + ATTACHMENT_LIMITS.removalWaitMs;
    expect(await removeAttachment(db(), { ...ref, now: due - 1 })).toMatchObject({
      code: "invalid_input",
    });
    expect(await removeAttachment(db(), { ...ref, now: due })).toEqual({
      ok: true,
      value: { artifactId: w.id },
    });
    expect(await rowOf(file.id)).toBeUndefined();
    const trail = await db()
      .select({ event: schema.lifecycleEvents.event })
      .from(schema.lifecycleEvents)
      .where(eq(schema.lifecycleEvents.artifactId, w.id));
    expect(trail.map((row) => row.event)).toEqual(
      expect.arrayContaining([
        "attachment_withheld",
        "attachment_reinstated",
        "attachment_removed",
      ]),
    );
    const markers = await exportTombstones(regionsFromEnv(env));
    expect(markers).toContainEqual({ kind: "comment_attachment", id: file.id, deletedAt: due });
    // A restore brings the row back; re-applying the markers deletes it again.
    await db().insert(schema.commentAttachments).values(restoredRow);
    await applyTombstones(regionsFromEnv(env), markers, due + 1);
    expect(await rowOf(file.id)).toBeUndefined();
    expect(await removeAttachment(db(), { ...ref, now: due })).toMatchObject({ code: "not_found" });
  });

  it("withholds a held artifact's file but never removes it while the hold lasts", async () => {
    const held = await world();
    const file = await uploaded(held, held.reader);
    const thread = await start(held, held.reader, [file.id]);
    if (!thread.ok) throw new Error("thread");
    await hold(held);
    const ref = { artifactId: held.id, attachmentId: file.id };
    expect(
      (
        await withholdAttachment(db(), {
          ...ref,
          reason: "malware",
          statement: STATEMENT,
          now: NOW,
        })
      ).ok,
    ).toBe(true);
    expect(
      await removeAttachment(db(), { ...ref, now: NOW + ATTACHMENT_LIMITS.removalWaitMs }),
    ).toMatchObject({ code: "forbidden" });
    expect(await rowOf(file.id)).toBeDefined();
  });

  it("deletes an account's pending uploads with the account, and its attached files with its messages", async () => {
    const w = await world();
    const pending = await uploaded(w, w.reader);
    const attached = await uploaded(w, w.reader);
    expect((await start(w, w.reader, [attached.id])).ok).toBe(true);
    const [reader] = await db()
      .global.select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, w.reader));
    // A session signed in just now, as deletion needs.
    const deleted = await requestAccountDeletion(regionsFromEnv(env), {
      userId: w.reader,
      sessionId: await session(w.reader, NOW),
      confirmEmail: reader?.email ?? "",
      now: NOW,
    });
    expect(deleted.ok).toBe(true);
    expect(await rowOf(pending.id)).toBeUndefined();
    for (let run = 0; run < 5; run++) {
      await advanceAccountDeletion(regionsFromEnv(env), w.reader, NOW);
    }
    expect(await rowOf(attached.id)).toBeUndefined();
  });

  it("refuses a file whose stored size differs from its upload", async () => {
    const w = await world();
    const prepared = await prepareAttachment(db(), {
      userId: w.reader,
      artifactId: w.id,
      name: "shot.png",
      size: PNG.length,
      sha256: await sha256(PNG),
      now: NOW,
    });
    if (!prepared.ok) throw new Error("prepare");
    await env.ARTIFACTS.put(prepared.value.key, new Uint8Array([...PNG, 1]));
    expect(await start(w, w.reader, [prepared.value.id])).toMatchObject({ code: "invalid_input" });
  });

  it("counts uploads per artifact per day, from everyone together", async () => {
    const w = await world();
    // The artifact's counter already at its limit, from other people's uploads today.
    await db()
      .global.$client.prepare("insert into rate_limits (key, window_start, count) values (?, ?, ?)")
      .bind(`attachments:artifact:${w.id}`, NOW, ATTACHMENT_LIMITS.uploadsPerArtifactPerDay)
      .run();
    expect(
      await prepareAttachment(db(), {
        userId: w.reader,
        artifactId: w.id,
        name: "shot.png",
        size: PNG.length,
        sha256: await sha256(PNG),
        now: NOW,
      }),
    ).toMatchObject({ code: "rate_limited" });
  });

  it("removes a file of a region with its own database: the tombstone first, then the region", async () => {
    const eu = regionsFromEnv(env).get("eu").db;
    const owner = await user();
    const id = artifactId();
    await eu.insert(schema.artifacts).values({
      id,
      ownerId: owner.id,
      type: "site",
      name: "Plan",
      state: "active",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await eu.insert(schema.annotationThreads).values({
      id: "th_eu",
      artifactId: id,
      versionId: "v",
      ownerId: owner.id,
      authorId: owner.id,
      target: "{}",
      targetBytes: 2,
      path: "index.html",
      updatedAt: NOW,
    });
    await eu.insert(schema.annotationMessages).values({
      id: "m_eu",
      threadId: "th_eu",
      artifactId: id,
      ownerId: owner.id,
      authorId: owner.id,
      body: "x",
      bodyBytes: 1,
    });
    await eu.insert(schema.commentAttachments).values({
      id: "att_eu",
      artifactId: id,
      ownerId: owner.id,
      uploadedBy: owner.id,
      name: "a.png",
      size: 10,
      sha256: "a".repeat(64),
      state: "pending",
      expiresAt: NOW + 60_000,
    });
    // Attached as the comment's batch would (the usage trigger counts it), then withheld.
    await eu
      .update(schema.commentAttachments)
      .set({
        state: "attached",
        threadId: "th_eu",
        messageId: "m_eu",
        contentType: "image/png",
        expiresAt: null,
        attachedAt: NOW,
        withheldAt: NOW,
        withheldReason: "malware",
      })
      .where(eq(schema.commentAttachments.id, "att_eu"));
    expect(
      await removeAttachment(eu, {
        artifactId: id,
        attachmentId: "att_eu",
        now: NOW + ATTACHMENT_LIMITS.removalWaitMs,
      }),
    ).toEqual({ ok: true, value: { artifactId: id } });
    expect(
      await eu
        .select()
        .from(schema.commentAttachments)
        .where(eq(schema.commentAttachments.id, "att_eu")),
    ).toEqual([]);
    const [marker] = await eu.global
      .select()
      .from(schema.tombstones)
      .where(eq(schema.tombstones.id, "att_eu"));
    expect(marker?.kind).toBe("comment_attachment");
  });

  it("lists a person's files with their messages in the account export, on their artifacts and elsewhere", async () => {
    const w = await world();
    const file = await uploaded(w, w.reader);
    expect((await start(w, w.reader, [file.id])).ok).toBe(true);
    const metadata = {
      id: file.id,
      name: "shot.png",
      contentType: "image/png",
      size: PNG.length,
      sha256: file.sha256,
    };
    const reader = await exportAccount(db(), { userId: w.reader, now: NOW });
    if (!reader.ok) throw new Error("export");
    expect(reader.value.commentsElsewhere[0]?.messages[0]?.attachments).toEqual([metadata]);
    const owner = await exportAccount(db(), { userId: w.owner, now: NOW });
    if (!owner.ok) throw new Error("export");
    const onTheirs = owner.value.artifacts.find((artifact) => artifact.id === w.id);
    expect(onTheirs?.threads[0]?.messages[0]?.attachments).toEqual([metadata]);
  });

  it("reports attachment bytes without a row as orphans", async () => {
    const key = attachmentKey(artifactId(), crypto.randomUUID());
    await env.ARTIFACTS.put(key, PNG);
    await db().delete(schema.maintenanceCursors);
    const result = await reconcileStorage(db(), env.ARTIFACTS, Date.now() + 2 * DAY, 50, 1000);
    expect(result.orphans).toBeGreaterThanOrEqual(1);
    const findings = await db()
      .select()
      .from(schema.storageFindings)
      .where(eq(schema.storageFindings.r2Key, key));
    expect(findings.map((finding) => finding.kind)).toEqual(["orphan"]);
    await env.ARTIFACTS.delete(key);
  });
});
