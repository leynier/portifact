// Attaching files to a new comment or reply (decision 0029): the checks of the bytes in R2 before
// the comment's batch, the guard its claim adds and the statement that attaches the rows. Kept
// apart from ./attachments.ts so the annotation writes import it without a cycle.
import { ATTACHMENT_LIMITS, type AttachmentType } from "@portifact/contracts";
import { type Db, type RegionalDb, schema } from "@portifact/db";
import {
  ATTACHMENT_SNIFF_BYTES,
  attachmentKey,
  fail,
  mayBeText,
  ok,
  type Result,
  sniffAttachment,
} from "@portifact/domain";
import { and, eq, gt, inArray, type SQL, sql } from "drizzle-orm";

/** The files a write names, with the R2 bucket of the artifact's region. */
export interface AttachmentRequest {
  ids: readonly string[];
  bucket: R2Bucket;
}

export interface VerifiedAttachment {
  id: string;
  size: number;
  contentType: AttachmentType;
}

const notReady = () =>
  fail<never>(
    "invalid_input",
    "A file is missing, still uploading or expired. Attach it again and post the comment.",
  );

function hex(buffer: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The start of the object (or all of it, when it may be text) and its SHA-256, streamed: the
 * whole file is never held unless it is small enough to be text.
 */
async function readObject(object: R2ObjectBody, keepAll: boolean) {
  const digest = new crypto.DigestStream("SHA-256");
  const writer = digest.getWriter();
  const kept: Uint8Array[] = [];
  let keptBytes = 0;
  const limit = keepAll ? ATTACHMENT_LIMITS.textMaxBytes : ATTACHMENT_SNIFF_BYTES;
  const reader = object.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    await writer.write(value);
    if (keptBytes < limit) {
      const part = value.subarray(0, limit - keptBytes);
      kept.push(part);
      keptBytes += part.byteLength;
    }
  }
  await writer.close();
  const start = new Uint8Array(keptBytes);
  let at = 0;
  for (const part of kept) {
    start.set(part, at);
    at += part.byteLength;
  }
  return { start, sha256: hex(await digest.digest) };
}

/**
 * Checks every named upload before the comment's batch: a pending row of this person on this
 * artifact, not expired, whose R2 object has the row's size and SHA-256 and whose bytes are an
 * allowed type. Anything else refuses the whole write, which then writes nothing.
 */
export async function verifyAttachments(
  db: RegionalDb,
  request: AttachmentRequest,
  input: { userId: string; artifactId: string; now: number },
): Promise<Result<VerifiedAttachment[]>> {
  const ca = schema.commentAttachments;
  const rows = await db
    .select({ id: ca.id, size: ca.size, sha256: ca.sha256 })
    .from(ca)
    .where(
      and(
        inArray(ca.id, [...request.ids]),
        eq(ca.artifactId, input.artifactId),
        eq(ca.uploadedBy, input.userId),
        eq(ca.state, "pending"),
        gt(ca.expiresAt, input.now),
      ),
    );
  if (rows.length !== request.ids.length) return notReady();
  const verified: VerifiedAttachment[] = [];
  for (const id of request.ids) {
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) return notReady();
    const object = await request.bucket.get(attachmentKey(input.artifactId, id));
    if (!object) return notReady();
    if (object.size !== row.size) {
      await object.body.cancel();
      return notReady();
    }
    const whole = mayBeText(object.size);
    const { start, sha256 } = await readObject(object, whole);
    if (sha256 !== row.sha256) return notReady();
    const contentType = sniffAttachment(start, object.size, whole);
    if (!contentType) {
      return fail(
        "invalid_input",
        "A file is not an image (PNG, JPEG, GIF or WebP), a PDF or plain text.",
      );
    }
    verified.push({ id, size: row.size, contentType });
  }
  return ok(verified);
}

/** Total bytes the files add to the owner's comment storage. */
export function attachedBytes(files: readonly VerifiedAttachment[]): number {
  return files.reduce((total, file) => total + file.size, 0);
}

/**
 * The claim's guard: every named row is still this person's pending upload on this artifact and
 * unexpired, so an upload pruned, used by another write or of someone else never attaches.
 */
export function attachmentsGuard(
  files: readonly VerifiedAttachment[],
  input: { userId: string; artifactId: string; now: number },
): SQL {
  if (files.length === 0) return sql`1`;
  const ca = schema.commentAttachments;
  const ids = sql.join(
    files.map((file) => sql`${file.id}`),
    sql`, `,
  );
  return sql`(select count(*) from ${ca} where ${ca.id} in (${ids}) and ${ca.artifactId} = ${input.artifactId} and ${ca.uploadedBy} = ${input.userId} and ${ca.state} = 'pending' and ${ca.expiresAt} > ${input.now}) = ${files.length}`;
}

/**
 * Attaches the rows to the message the batch inserted, on the claim. The attach trigger counts
 * their sizes in the owner's comment storage, whose CHECK constraint fails the whole batch when
 * they do not fit.
 */
export function attachStatement(
  db: Db,
  files: readonly VerifiedAttachment[],
  target: { threadId: string; messageId: string; userId: string; now: number },
  claimed: SQL,
) {
  const ca = schema.commentAttachments;
  const types = sql.join(
    files.map((file) => sql`when ${file.id} then ${file.contentType}`),
    sql` `,
  );
  return db
    .update(ca)
    .set({
      state: "attached",
      threadId: target.threadId,
      messageId: target.messageId,
      contentType: sql`case ${ca.id} ${types} end`,
      expiresAt: null,
      attachedAt: target.now,
    })
    .where(
      and(
        inArray(
          ca.id,
          files.map((file) => file.id),
        ),
        eq(ca.uploadedBy, target.userId),
        eq(ca.state, "pending"),
        claimed,
      ),
    );
}
