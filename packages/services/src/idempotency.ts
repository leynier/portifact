// Idempotency for retryable mutations (plan section 6): the first request with a key runs and
// its response is stored; a retry with the same key and body gets the stored response, and the
// same key with a different body is refused. Keys are scoped to the acting user.
import { ARTIFACT_DATA } from "@portifact/contracts/artifact-data";
import { type Db, schema } from "@portifact/db";
import { and, eq, lt, sql } from "drizzle-orm";

/** Stored responses are kept for a day, longer than any client retries one request. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** A claim without a response this old belongs to a request that died; its key is freed. */
export const ABANDONED_CLAIM_MS = 5 * 60 * 1000;

export interface IdempotentRequest {
  actorId: string;
  key: string;
  /** Operation name, so one key cannot replay a different endpoint. */
  operation: string;
  /** Hash of the request body, so one key cannot replay a different request. */
  requestHash: string;
  now: number;
}

export interface StoredResponse {
  status: number;
  body: unknown;
}

export type IdempotentOutcome =
  | { kind: "fresh"; response: StoredResponse }
  | { kind: "replayed"; response: StoredResponse }
  | { kind: "mismatch" }
  | { kind: "in_progress" };

/**
 * Runs `work` once per (actor, key). Server errors (status 500 and above) and exceptions are
 * not stored, so the client can retry them with the same key.
 */
export async function runIdempotent(
  db: Db,
  request: IdempotentRequest,
  work: () => Promise<StoredResponse>,
): Promise<IdempotentOutcome> {
  const key = and(
    eq(schema.operations.actorId, request.actorId),
    eq(schema.operations.idempotencyKey, request.key),
  );
  // An expired record, or a claim whose request died before answering, frees its key.
  await db
    .delete(schema.operations)
    .where(
      and(
        key,
        sql`(${schema.operations.createdAt} < ${request.now - IDEMPOTENCY_TTL_MS} or (${schema.operations.status} is null and ${schema.operations.createdAt} < ${request.now - ABANDONED_CLAIM_MS}))`,
      ),
    );

  const claimed = await db
    .insert(schema.operations)
    .values({
      actorId: request.actorId,
      idempotencyKey: request.key,
      operation: request.operation,
      requestHash: request.requestHash,
      createdAt: request.now,
    })
    .onConflictDoNothing()
    .returning({ actorId: schema.operations.actorId });

  if (claimed.length === 0) {
    const [existing] = await db.select().from(schema.operations).where(key).limit(1);
    if (!existing) return { kind: "in_progress" };
    if (existing.operation !== request.operation || existing.requestHash !== request.requestHash) {
      return { kind: "mismatch" };
    }
    if (existing.status === null) return { kind: "in_progress" };
    return { kind: "replayed", response: { status: existing.status, body: existing.result } };
  }

  let response: StoredResponse;
  try {
    response = await work();
  } catch (error) {
    await db.delete(schema.operations).where(and(key, sql`${schema.operations.status} is null`));
    throw error;
  }
  if (response.status >= 500) {
    await db.delete(schema.operations).where(and(key, sql`${schema.operations.status} is null`));
  } else {
    await db
      .update(schema.operations)
      .set({ status: response.status, result: response.body })
      .where(key);
  }
  return { kind: "fresh", response };
}

/**
 * Deletes up to `limit` stored responses older than the retention window. The maintenance job
 * picks up the rest on its next runs.
 */
export async function pruneOperations(db: Db, now: number, limit = 500): Promise<number> {
  const operations = schema.operations;
  // Artifact data's owner-side claims (decision 0026) keep only an operation ID, kept as long as
  // the object answers a retry from its own record (`replayMs`). One batch, one call for both.
  const claims = schema.dataOperations;
  // The tables have composite keys, so the bounded sets are chosen by rowid.
  const [removed, claimsRemoved] = await db.batch([
    db
      .delete(operations)
      .where(
        sql`rowid in (select rowid from ${operations} where ${lt(operations.createdAt, now - IDEMPOTENCY_TTL_MS)} limit ${limit})`,
      )
      .returning({ key: operations.idempotencyKey }),
    db
      .delete(claims)
      .where(
        sql`rowid in (select rowid from ${claims} where ${lt(claims.createdAt, now - ARTIFACT_DATA.replayMs)} limit ${limit})`,
      )
      .returning({ key: claims.idempotencyKey }),
  ]);
  return removed.length + claimsRemoved.length;
}

/** Hex SHA-256 of a request body, for `requestHash`. */
export async function hashRequest(body: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
