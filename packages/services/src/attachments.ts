// Comment attachments (decision 0029): starting an upload, reading one file, the prune of uploads
// nobody attached and the operator's removal. Attaching happens in the comment's own write
// (./attachment-writes.ts); deleting bytes happens only through the `delete_objects` job the
// rows' delete trigger writes, whatever deleted the row.
//
// Who may read a file is exactly who may read its message's body: the annotations `read`
// authorization, the thread through `findThread` (comment scope and the version a reader sees)
// and `messageBodyVisible`. Anything else answers like a missing file.
import {
  type AbuseReason,
  ATTACHMENT_LIMITS,
  type AttachmentType,
  type AttachmentView,
} from "@portifact/contracts";
import { bothSides, type Db, hitRateLimit, type RegionalDb, schema } from "@portifact/db";
import {
  attachmentKey,
  checkAnnotationCapacity,
  fail,
  messageBodyVisible,
  ok,
  type Result,
} from "@portifact/domain";
import { and, asc, eq, isNull, type SQL, sql } from "drizzle-orm";
import { type AnnotationActor, annotationParts } from "./annotations.ts";
import { platformProtection } from "./budget.ts";
import { isHeld, notHeldSql } from "./legal-holds.ts";
import { type DecisionStatement, decisionStatements, newDecisionId } from "./moderation-notices.ts";

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
  // type, state, created, expires, attached, withheld at, withheld reason.
  const inserted = await db
    .insert(ca)
    .select(
      sql`select ${id}, ${a.id}, ${a.ownerId}, null, null, ${input.userId}, ${input.name}, ${input.size}, ${input.sha256}, null, 'pending', ${input.now}, ${expiresAt}, null, null, null where ${guard}`,
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
        // A file the operator withholds is read by nobody until reinstated.
        isNull(ca.withheldAt),
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

/**
 * A person's pending uploads, deleted with their account (`uploaded_by` has no foreign key),
 * except on an artifact a legal hold keeps: those stay until the hold is released and the prune
 * takes them.
 */
export function deletePendingUploadsOf(db: Db, userId: string) {
  const ca = schema.commentAttachments;
  return db
    .delete(ca)
    .where(
      and(eq(ca.uploadedBy, userId), eq(ca.state, "pending"), notHeldSql(sql`${ca.artifactId}`)),
    );
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
      withheldAt: ca.withheldAt,
      withheldReason: ca.withheldReason,
    })
    .from(ca)
    .where(eq(ca.artifactId, artifactId))
    .orderBy(asc(ca.createdAt), asc(ca.id));
}

/** The operator's reference to one file, and when the decision is taken. */
export interface AttachmentRef {
  artifactId: string;
  attachmentId: string;
  now: number;
}

async function attachedFile(db: RegionalDb, input: AttachmentRef) {
  const ca = schema.commentAttachments;
  const [row] = await db
    .select({
      ownerId: ca.ownerId,
      artifactId: ca.artifactId,
      withheldAt: ca.withheldAt,
    })
    .from(ca)
    .where(
      and(
        eq(ca.id, input.attachmentId),
        eq(ca.artifactId, input.artifactId),
        eq(ca.state, "attached"),
      ),
    )
    .limit(1);
  return row;
}

function trail(db: Db, input: AttachmentRef, event: string, condition: SQL) {
  // Columns in schema order: id, artifact, actor, channel, event, details, at.
  return db
    .insert(schema.lifecycleEvents)
    .select(
      sql`select null, ${input.artifactId}, null, 'system', ${event}, ${JSON.stringify({ attachmentId: input.attachmentId })}, ${input.now} where ${condition}`,
    );
}

/**
 * The operator withholds one file (decision 0029, "Abuse and the operator"): from that moment
 * nobody views or downloads it, and the person who attached it and the people who manage the
 * artifact get the statement of reasons (`decisionStatements`, `moderation_notice`) unless the
 * law requires silence. Nothing is deleted: a review or a counter-notice can reinstate it, and
 * only `removeAttachment`, after `ATTACHMENT_LIMITS.removalWaitMs`, deletes it for good.
 */
export async function withholdAttachment(
  db: RegionalDb,
  input: AttachmentRef & {
    reason: AbuseReason;
    statement: DecisionStatement;
    reportId?: string | null | undefined;
  },
): Promise<Result<{ decisionId: string }>> {
  const row = await attachedFile(db, input);
  if (!row) return missingAttachment();
  if (row.withheldAt !== null) return fail("invalid_input", "That file is already withheld.");
  const ca = schema.commentAttachments;
  const open = sql`exists (select 1 from ${ca} where ${ca.id} = ${input.attachmentId} and ${ca.withheldAt} is null)`;
  const decisionId = newDecisionId();
  await db.batch([
    trail(db, input, "attachment_withheld", open),
    ...decisionStatements(
      db,
      decisionId,
      {
        targetKind: "attachment",
        targetId: input.attachmentId,
        ownerId: row.ownerId,
        action: "suspend",
        reason: input.reason,
        suspensionId: null,
        reportId: input.reportId ?? null,
        now: input.now,
      },
      input.statement,
      open,
    ),
    db
      .update(ca)
      .set({ withheldAt: input.now, withheldReason: input.reason })
      .where(and(eq(ca.id, input.attachmentId), isNull(ca.withheldAt))),
  ]);
  return ok({ decisionId });
}

/**
 * The operator gives a withheld file back (a review or a counter-notice that stands): it is
 * shown again to whoever can read its comment, with a statement that says so.
 */
export async function reinstateAttachment(
  db: RegionalDb,
  input: AttachmentRef & { statement: DecisionStatement },
): Promise<Result<{ decisionId: string }>> {
  const row = await attachedFile(db, input);
  if (!row) return missingAttachment();
  if (row.withheldAt === null) return fail("invalid_input", "That file is not withheld.");
  const ca = schema.commentAttachments;
  const withheld = sql`exists (select 1 from ${ca} where ${ca.id} = ${input.attachmentId} and ${ca.withheldAt} = ${row.withheldAt})`;
  const decisionId = newDecisionId();
  await db.batch([
    trail(db, input, "attachment_reinstated", withheld),
    ...decisionStatements(
      db,
      decisionId,
      {
        targetKind: "attachment",
        targetId: input.attachmentId,
        ownerId: row.ownerId,
        action: "reinstate",
        reason: null,
        suspensionId: null,
        reportId: null,
        now: input.now,
      },
      input.statement,
      withheld,
    ),
    db
      .update(ca)
      .set({ withheldAt: null, withheldReason: null })
      .where(and(eq(ca.id, input.attachmentId), eq(ca.withheldAt, row.withheldAt))),
  ]);
  return ok({ decisionId });
}

/**
 * Deletes a withheld file for good, once a counter-notice could no longer reinstate it: only a
 * file withheld at least `ATTACHMENT_LIMITS.removalWaitMs` ago, never while a legal hold keeps
 * the artifact. The row goes with a `comment_attachment` tombstone, so a restore deletes it again,
 * and its bytes go by the row's delete trigger. The statement was given when it was withheld.
 */
export async function removeAttachment(
  db: RegionalDb,
  input: AttachmentRef,
): Promise<Result<{ artifactId: string }>> {
  const ca = schema.commentAttachments;
  const row = await attachedFile(db, input);
  if (!row) return missingAttachment();
  if (row.withheldAt === null) {
    return fail(
      "invalid_input",
      "Withhold the file first; it can be removed once its wait is over.",
    );
  }
  const wait = row.withheldAt + ATTACHMENT_LIMITS.removalWaitMs;
  if (input.now < wait) {
    return fail(
      "invalid_input",
      `A counter-notice can still reinstate this file; it can be removed from ${new Date(wait).toISOString()}.`,
    );
  }
  const held = () =>
    fail<never>("forbidden", "A legal hold keeps this artifact; release it first.");
  if (await isHeld(db, row.artifactId)) return held();
  // Every statement holds to the live state: still withheld as read, and no hold placed since
  // (`notHeldSql`); the database refuses the delete of a held artifact's file anyway.
  const live = sql`exists (select 1 from ${ca} where ${ca.id} = ${input.attachmentId} and ${ca.withheldAt} = ${row.withheldAt}) and ${notHeldSql(sql`${input.artifactId}`)}`;
  const both = bothSides(db);
  const x: Db = both ?? db;
  // The marker that keeps it gone through a restore, on the same condition: with one database the
  // tombstone itself, with a separate regional one a `comment_tombstones` job that writes it.
  const marker = both
    ? // Columns in schema order: kind, id, deleted at.
      both
        .insert(schema.tombstones)
        .select(sql`select 'comment_attachment', ${input.attachmentId}, ${input.now} where ${live}`)
        .onConflictDoNothing()
    : // Columns in schema order: id, topic, payload, available, dispatched, attempts, created,
      // subject, generation.
      db
        .insert(schema.outbox)
        .select(
          sql`select null, 'comment_tombstones', json_object('ids', json('[]'), 'markers', json_array(json_object('kind', 'comment_attachment', 'id', ${input.attachmentId})), 'at', ${input.now}), ${input.now}, null, 0, ${input.now}, ${input.artifactId}, null where ${live}`,
        );
  const results = (await x.batch([
    marker,
    trail(x, input, "attachment_removed", live),
    x.delete(ca).where(sql`${ca.id} = ${input.attachmentId} and ${live}`).returning({ id: ca.id }),
  ])) as unknown[];
  if ((results.at(-1) as { id: string }[]).length === 0) {
    if (await isHeld(db, row.artifactId)) return held();
    return fail("version_conflict", "The file changed meanwhile. List it again and retry.");
  }
  return ok({ artifactId: row.artifactId });
}
