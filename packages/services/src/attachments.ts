// Comment attachments (decision 0028): starting an upload, reading one file, the prune of uploads
// nobody attached and the operator's removal. Attaching happens in the comment's own write
// (./attachment-writes.ts); deleting bytes happens only through the `delete_objects` job the
// rows' delete trigger writes, whatever deleted the row.
//
// Who may read a file is exactly who may read its message's body: the annotations `read`
// authorization, the thread through `findThread` (comment scope and the version a reader sees)
// and `messageBodyVisible`. Anything else answers like a missing file.
import { ATTACHMENT_LIMITS, type AttachmentType, type AttachmentView } from "@portifact/contracts";
import { bothSides, type Db, hitRateLimit, type RegionalDb, schema } from "@portifact/db";
import {
  attachmentKey,
  checkAnnotationCapacity,
  fail,
  messageBodyVisible,
  ok,
  type Result,
} from "@portifact/domain";
import { and, asc, eq, sql } from "drizzle-orm";
import { type AnnotationActor, annotationParts } from "./annotations.ts";
import { platformProtection } from "./budget.ts";
import { isHeld, notHeldSql } from "./legal-holds.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const missingAttachment = () => fail<never>("not_found", "Attachment not found.");

export interface PreparedAttachmentUpload {
  id: string;
  /** The R2 key to presign; never sent to the client as such. */
  key: string;
  name: string;
  size: number;
  sha256: string;
  expiresAt: number;
}

/**
 * Starts one upload: the caller must be able to start a thread on the artifact (the same checks
 * as a new comment), new comments must not be paused, and the person and the artifact must be
 * under their daily counts. The pending row is written only while the person holds fewer than
 * `pendingPerPerson` live uploads and the artifact still takes comments from them.
 */
export async function prepareAttachment(
  db: RegionalDb,
  input: AnnotationActor & { name: string; size: number; sha256: string },
): Promise<Result<PreparedAttachmentUpload>> {
  const parts = annotationParts;
  const authorized = await parts.authorize(db, input, "participate");
  if (!authorized.ok) return authorized;
  const loaded = authorized.value;
  const capacity = checkAnnotationCapacity(
    (await platformProtection(db.global, input.now)).actions,
  );
  if (!capacity.ok) return capacity;
  if (input.size > ATTACHMENT_LIMITS.fileMaxBytes) {
    return fail("invalid_input", "A file can be at most 10 MB.");
  }
  // Counted before the row is written, so a refused attempt counts too (per person, per artifact).
  for (const [key, max] of [
    [`attachments:user:${input.userId}`, ATTACHMENT_LIMITS.uploadsPerPersonPerDay],
    [`attachments:artifact:${input.artifactId}`, ATTACHMENT_LIMITS.uploadsPerArtifactPerDay],
  ] as const) {
    const hit = await hitRateLimit(db.global.$client, key, DAY_MS, input.now);
    if (hit.count > max) {
      return fail("rate_limited", "Too many files attached today. Try again tomorrow.");
    }
  }
  const ca = schema.commentAttachments;
  const id = crypto.randomUUID();
  const expiresAt = input.now + ATTACHMENT_LIMITS.pendingTtlMs;
  const a = loaded.artifact;
  const guard = sql`${parts.artifactGuard(loaded, "participate", input.now)} and (select count(*) from ${ca} where ${ca.uploadedBy} = ${input.userId} and ${ca.state} = 'pending' and ${ca.expiresAt} > ${input.now}) < ${ATTACHMENT_LIMITS.pendingPerPerson}`;
  // Columns in schema order: id, artifact, owner, thread, message, uploader, name, size, sha256,
  // type, state, created, expires, attached.
  const inserted = await db
    .insert(ca)
    .select(
      sql`select ${id}, ${a.id}, ${a.ownerId}, null, null, ${input.userId}, ${input.name}, ${input.size}, ${input.sha256}, null, 'pending', ${input.now}, ${expiresAt}, null where ${guard}`,
    )
    .returning({ id: ca.id });
  if (inserted.length === 0) {
    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(ca)
      .where(
        and(
          eq(ca.uploadedBy, input.userId),
          eq(ca.state, "pending"),
          sql`${ca.expiresAt} > ${input.now}`,
        ),
      );
    if (Number(row?.count ?? 0) >= ATTACHMENT_LIMITS.pendingPerPerson) {
      return fail(
        "rate_limited",
        "Too many files are waiting for a comment. Post or discard them first.",
      );
    }
    return fail("version_conflict", "The artifact changed meanwhile. Reload and try again.");
  }
  return ok({
    id,
    key: attachmentKey(a.id, id),
    name: input.name,
    size: input.size,
    sha256: input.sha256,
    expiresAt,
  });
}

export interface AttachmentFile {
  view: AttachmentView;
  key: string;
  contentType: AttachmentType;
}

/**
 * One attached file the caller may read now, for its download link: answered only to whoever
 * sees its message's body, exactly as every read path shows it.
 */
export async function getAttachmentFile(
  db: RegionalDb,
  input: AnnotationActor & { attachmentId: string },
): Promise<Result<AttachmentFile>> {
  const parts = annotationParts;
  const authorized = await parts.authorize(db, input, "read");
  if (!authorized.ok) return authorized;
  const loaded = authorized.value;
  const ca = schema.commentAttachments;
  const [row] = await db
    .select()
    .from(ca)
    .where(
      and(
        eq(ca.id, input.attachmentId),
        eq(ca.artifactId, loaded.artifact.id),
        eq(ca.state, "attached"),
      ),
    )
    .limit(1);
  if (!row || row.threadId === null || row.messageId === null || row.contentType === null) {
    return missingAttachment();
  }
  const thread = await parts.findThread(db, loaded, row.threadId);
  if (!thread) return missingAttachment();
  const [message] = await db
    .select({
      state: schema.annotationMessages.state,
      authorId: schema.annotationMessages.authorId,
    })
    .from(schema.annotationMessages)
    .where(eq(schema.annotationMessages.id, row.messageId))
    .limit(1);
  if (!message || !messageBodyVisible(loaded.role, input.userId, message)) {
    return missingAttachment();
  }
  return ok({
    view: {
      id: row.id,
      name: row.name,
      contentType: row.contentType,
      size: row.size,
      sha256: row.sha256,
    },
    key: attachmentKey(row.artifactId, row.id),
    contentType: row.contentType,
  });
}

/**
 * Deletes uploads nobody attached within their hour, oldest first, at most `limit` per run, never
 * on an artifact a legal hold keeps. Their bytes go by the delete trigger's job.
 */
export async function pruneAttachmentUploads(
  db: RegionalDb,
  now: number,
  limit = 200,
): Promise<number> {
  const ca = schema.commentAttachments;
  const deleted = await db
    .delete(ca)
    .where(
      sql`${ca.id} in (select ${ca.id} from ${ca} where ${ca.state} = 'pending' and ${ca.expiresAt} <= ${now} and ${notHeldSql(sql`${ca.artifactId}`)} order by ${ca.expiresAt} limit ${limit})`,
    )
    .returning({ id: ca.id });
  return deleted.length;
}

/** A person's pending uploads, deleted with their account (`uploaded_by` has no foreign key). */
export function deletePendingUploadsOf(db: Db, userId: string) {
  const ca = schema.commentAttachments;
  return db.delete(ca).where(and(eq(ca.uploadedBy, userId), eq(ca.state, "pending")));
}

/** An artifact's files as the operator lists them: metadata only, never bytes or links. */
export async function listArtifactAttachments(db: RegionalDb, artifactId: string) {
  const ca = schema.commentAttachments;
  return db
    .select({
      id: ca.id,
      state: ca.state,
      name: ca.name,
      contentType: ca.contentType,
      size: ca.size,
      sha256: ca.sha256,
      threadId: ca.threadId,
      messageId: ca.messageId,
      createdAt: ca.createdAt,
    })
    .from(ca)
    .where(eq(ca.artifactId, artifactId))
    .orderBy(asc(ca.createdAt), asc(ca.id));
}

/**
 * The operator removes one file (illegal content that is not the owner's to judge): the row goes
 * with a `comment_attachment` tombstone, so a restore deletes it again, and the artifact's
 * operational trail records it. Refused while a legal hold keeps the artifact.
 */
export async function removeAttachment(
  db: RegionalDb,
  input: { artifactId: string; attachmentId: string; now: number },
): Promise<Result<{ artifactId: string }>> {
  const ca = schema.commentAttachments;
  const [row] = await db
    .select({ artifactId: ca.artifactId })
    .from(ca)
    .where(and(eq(ca.id, input.attachmentId), eq(ca.artifactId, input.artifactId)))
    .limit(1);
  if (!row) return missingAttachment();
  if (await isHeld(db, row.artifactId)) {
    return fail("forbidden", "A legal hold keeps this artifact; release it first.");
  }
  const tombstone = (x: Db) =>
    x
      .insert(schema.tombstones)
      .values({ kind: "comment_attachment", id: input.attachmentId, deletedAt: input.now })
      .onConflictDoNothing();
  const regional = (x: RegionalDb | NonNullable<ReturnType<typeof bothSides>>) =>
    [
      x.insert(schema.lifecycleEvents).values({
        artifactId: row.artifactId,
        actorId: null,
        channel: "system",
        event: "attachment_removed",
        details: { attachmentId: input.attachmentId },
        at: input.now,
      }),
      x.delete(ca).where(eq(ca.id, input.attachmentId)),
    ] as const;
  const both = bothSides(db);
  if (both) {
    await both.batch([tombstone(both), ...regional(both)]);
  } else {
    // Global first, then the region: the tombstone outlives a failure in between.
    await tombstone(db.global);
    await db.batch([...regional(db)]);
  }
  return ok({ artifactId: row.artifactId });
}
