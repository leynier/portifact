// Presigned multipart uploads (plan section 9, "Carga y commit": files over 64 MiB use presigned
// multipart with resumption, rehashed with crypto.DigestStream before the commit). The R2
// binding opens, completes and aborts each upload; the client puts the parts straight to R2's S3
// endpoint and reports each part's ETag, so the Worker never carries the bytes and the upload
// resumes from the parts already reported.
//
// A multipart upload is assembled at a staging key of its session, never at the object's
// content-addressed key: R2 cannot check a whole-object SHA-256 when it assembles parts, and a
// wrong assembly at the shared key could overwrite bytes another publish already verified. The
// commit rehashes the staged object as a stream, copies it to the object's key with the SHA-256
// R2 checks again, and only then deletes the staging copy.
import { type Db, type RegionalDb, schema } from "@portifact/db";
import {
  fail,
  isPlannedPart,
  type MultipartConfig,
  ok,
  type PartPlan,
  planParts,
  type Result,
} from "@portifact/domain";
import { and, eq, type SQL, sql } from "drizzle-orm";
import { authorizeUploadOn } from "./actors.ts";
import { hex } from "./objects.ts";

/** Where a session assembles the parts of one object before the commit verifies it. */
export function stagingKey(ownerId: string, sessionId: string, sha256: string): string {
  return `uploads/${ownerId}/${sessionId}/${sha256}`;
}

/** The multipart state of one object of an open upload. */
export interface MultipartState extends PartPlan {
  /** R2's upload ID, for signing the part URLs. */
  uploadId: string;
  /** The staging key the parts are uploaded to. */
  key: string;
  /** Parts the client reported, in order. */
  doneParts: number[];
}

type MultipartRow = typeof schema.multipartUploads.$inferInsert;

/**
 * Opens an R2 multipart upload at its staging key for every object above the threshold. If one
 * fails, the ones already opened are aborted; R2 also aborts any upload left incomplete after
 * seven days.
 */
export async function openMultipartUploads(
  bucket: R2Bucket,
  input: {
    ownerId: string;
    sessionId: string;
    objects: { sha256: string; size: number }[];
    config: MultipartConfig;
    now: number;
  },
): Promise<MultipartRow[]> {
  const rows: MultipartRow[] = [];
  try {
    for (const object of input.objects) {
      const plan = planParts(object.size, input.config);
      if (!plan) continue;
      const key = stagingKey(input.ownerId, input.sessionId, object.sha256);
      const upload = await bucket.createMultipartUpload(key);
      rows.push({
        sessionId: input.sessionId,
        sha256: object.sha256,
        ownerId: input.ownerId,
        r2Key: key,
        uploadId: upload.uploadId,
        partSize: plan.partSize,
        partCount: plan.partCount,
        createdAt: input.now,
      });
    }
  } catch (error) {
    await abortOpened(bucket, rows);
    throw error;
  }
  return rows;
}

/** Best-effort abort of uploads a failed prepare opened; R2's own expiry is the safety net. */
export async function abortOpened(bucket: R2Bucket, rows: MultipartRow[]): Promise<void> {
  await Promise.allSettled(
    rows.map((row) => bucket.resumeMultipartUpload(row.r2Key, row.uploadId).abort()),
  );
}

/** The multipart state of every object of a session, by SHA-256. */
export async function multipartStates(
  db: Db,
  sessionId: string,
): Promise<Map<string, MultipartState>> {
  const uploads = await db
    .select()
    .from(schema.multipartUploads)
    .where(eq(schema.multipartUploads.sessionId, sessionId));
  const states = new Map<string, MultipartState>();
  if (uploads.length === 0) return states;
  for (const upload of uploads) {
    states.set(upload.sha256, {
      uploadId: upload.uploadId,
      key: upload.r2Key,
      partSize: upload.partSize,
      partCount: upload.partCount,
      doneParts: [],
    });
  }
  const parts = await db
    .select({ sha256: schema.multipartParts.sha256, partNumber: schema.multipartParts.partNumber })
    .from(schema.multipartParts)
    .where(eq(schema.multipartParts.sessionId, sessionId))
    .orderBy(schema.multipartParts.partNumber);
  for (const part of parts) states.get(part.sha256)?.doneParts.push(part.partNumber);
  return states;
}

/**
 * Inserts an `abort_multipart` job for the session when `condition` holds and the session has
 * multipart uploads. Put it before the update that closes the session, on the same condition.
 */
export function abortMultipartJob(db: Db, sessionId: string, condition: SQL, now: number) {
  const m = schema.multipartUploads;
  return db
    .insert(schema.outbox)
    .select(
      sql`select null, 'abort_multipart', '{}', ${now}, null, 0, ${now}, ${sessionId}, null where ${condition} and exists (select 1 from ${m} where ${m.sessionId} = ${sessionId})`,
    );
}

/**
 * Job of a closed session: aborts its multipart uploads that were not completed, deletes their
 * staging copies and then their rows. Aborting a completed or aborted upload does nothing, so
 * the job can run again.
 */
export async function abortSessionMultipart(
  db: Db,
  bucket: R2Bucket,
  sessionId: string,
): Promise<"done" | "stale"> {
  const [session] = await db
    .select({ state: schema.uploadSessions.state })
    .from(schema.uploadSessions)
    .where(eq(schema.uploadSessions.id, sessionId));
  // An open session still needs its uploads; the job is only written when it closes.
  if (session && (session.state === "uploading" || session.state === "ready")) return "stale";
  const uploads = await db
    .select()
    .from(schema.multipartUploads)
    .where(eq(schema.multipartUploads.sessionId, sessionId));
  for (const upload of uploads) {
    await bucket.resumeMultipartUpload(upload.r2Key, upload.uploadId).abort();
  }
  if (uploads.length > 0) await bucket.delete(uploads.map((upload) => upload.r2Key));
  await db.delete(schema.multipartUploads).where(eq(schema.multipartUploads.sessionId, sessionId));
  return "done";
}

/**
 * Brings one multipart object of a session to its content-addressed key, or explains why it
 * cannot. Safe to repeat: a staged copy is verified and copied again, and an upload completed by
 * an earlier attempt leaves the object at its key for the commit's own check.
 */
export async function assembleObject(
  db: Db,
  bucket: R2Bucket,
  input: {
    sessionId: string;
    sha256: string;
    size: number;
    r2Key: string;
    state: MultipartState;
  },
): Promise<string | null> {
  const { state } = input;
  let staged = await bucket.head(state.key);
  if (!staged) {
    const missing = missingParts(state);
    if (missing.length > 0) {
      // Another publish may have stored these bytes meanwhile; the commit checks them.
      if (await bucket.head(input.r2Key)) return null;
      return `${input.sha256} is missing parts ${missing.join(", ")}`;
    }
    const completed = await completeUpload(db, bucket, input);
    if (completed !== null) {
      if (await bucket.head(input.r2Key)) return null;
      return completed;
    }
    staged = await bucket.head(state.key);
    if (!staged) return `${input.sha256} could not be assembled from its parts`;
  }

  const body = await bucket.get(state.key);
  if (!body) return `${input.sha256} could not be assembled from its parts`;
  let problem: string | null = null;
  if (body.size !== input.size) {
    await body.body.cancel();
    problem = `${input.sha256} has ${body.size} bytes, expected ${input.size}`;
  } else {
    const digest = new crypto.DigestStream("SHA-256");
    await body.body.pipeTo(digest);
    if (hex(await digest.digest) !== input.sha256) {
      problem = `${input.sha256} does not match its hash`;
    }
  }
  if (problem) {
    await restartUpload(db, bucket, input);
    return problem;
  }

  const copy = await bucket.get(state.key);
  if (!copy) return `${input.sha256} could not be assembled from its parts`;
  // R2 checks the SHA-256 again while it writes, so a changed staging copy cannot slip through.
  await bucket.put(input.r2Key, copy.body.pipeThrough(new FixedLengthStream(input.size)), {
    sha256: input.sha256,
  });
  await bucket.delete(state.key);
  return null;
}

function missingParts(state: MultipartState): number[] {
  const done = new Set(state.doneParts);
  const missing: number[] = [];
  for (let part = 1; part <= state.partCount; part += 1) {
    if (!done.has(part)) missing.push(part);
  }
  return missing;
}

/** Completes the upload with the reported ETags; null on success, else the problem. */
async function completeUpload(
  db: Db,
  bucket: R2Bucket,
  input: { sessionId: string; sha256: string; state: MultipartState },
): Promise<string | null> {
  const parts = await db
    .select({ partNumber: schema.multipartParts.partNumber, etag: schema.multipartParts.etag })
    .from(schema.multipartParts)
    .where(
      and(
        eq(schema.multipartParts.sessionId, input.sessionId),
        eq(schema.multipartParts.sha256, input.sha256),
      ),
    )
    .orderBy(schema.multipartParts.partNumber);
  try {
    await bucket
      .resumeMultipartUpload(input.state.key, input.state.uploadId)
      .complete(parts.map((part) => ({ partNumber: part.partNumber, etag: bareEtag(part.etag) })));
    return null;
  } catch (error) {
    // Only the error's name and message: they carry no token, key material or user content.
    console.error(
      JSON.stringify({
        event: "multipart_complete_failed",
        error: error instanceof Error ? `${error.name}: ${error.message}` : "unknown",
      }),
    );
    // A reported ETag or part R2 does not have: the client sends every part again.
    await forgetParts(db, input.sessionId, input.sha256);
    return `${input.sha256} could not be assembled from its parts; they must be uploaded again`;
  }
}

/** Replaces an upload whose assembled bytes were wrong with a new one at the same staging key. */
async function restartUpload(
  db: Db,
  bucket: R2Bucket,
  input: { sessionId: string; sha256: string; state: MultipartState },
): Promise<void> {
  await bucket.delete(input.state.key);
  const upload = await bucket.createMultipartUpload(input.state.key);
  await db.batch([
    db
      .delete(schema.multipartParts)
      .where(
        and(
          eq(schema.multipartParts.sessionId, input.sessionId),
          eq(schema.multipartParts.sha256, input.sha256),
        ),
      ),
    db
      .update(schema.multipartUploads)
      .set({ uploadId: upload.uploadId })
      .where(
        and(
          eq(schema.multipartUploads.sessionId, input.sessionId),
          eq(schema.multipartUploads.sha256, input.sha256),
        ),
      ),
  ]);
}

async function forgetParts(db: Db, sessionId: string, sha256: string): Promise<void> {
  await db
    .delete(schema.multipartParts)
    .where(
      and(eq(schema.multipartParts.sessionId, sessionId), eq(schema.multipartParts.sha256, sha256)),
    );
}

export interface ReportPartInput {
  /** The signed-in user; an admin or editor of the upload's owner may report its parts. */
  userId: string;
  sessionId: string;
  sha256: string;
  partNumber: number;
  etag: string;
  now: number;
}

/**
 * Records a part the client put to storage, with the ETag storage answered. Reporting the same
 * part again replaces its ETag, so a retried or re-uploaded part is harmless.
 */
/**
 * The ETag as R2's binding expects it. Clients read it from the S3 endpoint's `ETag` header,
 * which quotes it (`"abc"`), while `R2MultipartUpload.complete` refuses quoted values.
 */
export function bareEtag(etag: string): string {
  return etag.replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
}

export async function reportUploadedPart(
  db: RegionalDb,
  input: ReportPartInput,
): Promise<Result<true>> {
  const [session] = await db
    .select({
      ownerId: schema.uploadSessions.ownerId,
      artifactId: schema.uploadSessions.artifactId,
      state: schema.uploadSessions.state,
      expiresAt: schema.uploadSessions.expiresAt,
    })
    .from(schema.uploadSessions)
    .where(eq(schema.uploadSessions.id, input.sessionId))
    .limit(1);
  const missing = () => fail<never>("not_found", "Upload not found.");
  if (!session) return missing();
  const allowed = await authorizeUploadOn(db, input.userId, session, "publish", missing);
  if (!allowed.ok) return allowed;
  if (
    (session.state !== "uploading" && session.state !== "ready") ||
    input.now >= session.expiresAt
  ) {
    return fail("upload_incomplete", "This upload is no longer open; start a new one.");
  }
  const [upload] = await db
    .select({
      partSize: schema.multipartUploads.partSize,
      partCount: schema.multipartUploads.partCount,
    })
    .from(schema.multipartUploads)
    .where(
      and(
        eq(schema.multipartUploads.sessionId, input.sessionId),
        eq(schema.multipartUploads.sha256, input.sha256),
      ),
    )
    .limit(1);
  if (!upload) return fail("invalid_input", "This upload has no multipart object with that hash.");
  if (!isPlannedPart(upload, input.partNumber)) {
    return fail(
      "invalid_input",
      `Part ${input.partNumber} is not one of the ${upload.partCount} parts.`,
    );
  }
  try {
    await db
      .insert(schema.multipartParts)
      .values({
        sessionId: input.sessionId,
        sha256: input.sha256,
        partNumber: input.partNumber,
        etag: bareEtag(input.etag),
      })
      .onConflictDoUpdate({
        target: [
          schema.multipartParts.sessionId,
          schema.multipartParts.sha256,
          schema.multipartParts.partNumber,
        ],
        set: { etag: bareEtag(input.etag) },
      });
  } catch (error) {
    // The session closed meanwhile and its cleanup removed the upload.
    if (String(error instanceof Error ? (error.cause ?? error) : error).includes("FOREIGN KEY")) {
      return fail("upload_incomplete", "This upload is no longer open; start a new one.");
    }
    throw error;
  }
  return ok(true);
}
