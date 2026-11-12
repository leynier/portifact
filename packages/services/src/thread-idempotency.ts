// Idempotent thread writes (creating a thread, replying): the record keeps the thread's ID, never
// its view, so a retry rebuilds the answer under the caller's current authorization and comment
// scope. A message or thread deleted since, or a thread the caller no longer sees, is never
// returned from the record (docs/security.md, "Comments").
import { type AnnotationThreadView, ERROR_STATUS, type ErrorCode } from "@portifact/contracts";
import type { RegionalDb } from "@portifact/db";
import { fail, ok, type Result } from "@portifact/domain";
import { type AnnotationActor, getAnnotationThread } from "./annotations.ts";
import { type IdempotentRequest, runIdempotent } from "./idempotency.ts";

export type IdempotentThreadOutcome =
  | { kind: "fresh" | "replayed"; result: Result<AnnotationThreadView> }
  | { kind: "mismatch" }
  | { kind: "in_progress" };

/** What the record keeps of a thread write: the thread's ID, or the refusal (no comment text). */
export function storedThreadAnswer(view: Result<AnnotationThreadView>) {
  return view.ok
    ? { status: 201, body: { threadId: view.value.id } }
    : {
        status: ERROR_STATUS[view.code],
        body: { error: { code: view.code, message: view.message } },
      };
}

function storedThreadId(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as { threadId?: unknown; id?: unknown };
  if (typeof record.threadId === "string") return record.threadId;
  // A record written before only the ID was kept holds the whole view: only its ID is used.
  return typeof record.id === "string" ? record.id : null;
}

function storedError(body: unknown): { code: ErrorCode; message: string } | null {
  if (typeof body !== "object" || body === null || !("error" in body)) return null;
  const error = (body as { error: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return typeof code === "string" && code in ERROR_STATUS && typeof message === "string"
    ? { code: code as ErrorCode, message }
    : null;
}

/**
 * Runs a thread write once per idempotency key. The first answer is the write's own; a retry
 * with the same key and request reads the thread again as `reader` (no read on the write path),
 * so it answers what the caller may see now: `not_found` once the thread is gone or out of their
 * scope, and a deleted message as the "message deleted" marker.
 */
export async function idempotentThreadWrite(
  db: RegionalDb,
  request: IdempotentRequest,
  reader: AnnotationActor,
  write: () => Promise<Result<AnnotationThreadView>>,
): Promise<IdempotentThreadOutcome> {
  let fresh: Result<AnnotationThreadView> | undefined;
  // The record keeps only what `storedThreadAnswer` gives; the first answer is the write's own.
  const outcome = await runIdempotent(db, request, async () => {
    fresh = await write();
    return storedThreadAnswer(fresh);
  });
  if (outcome.kind === "mismatch" || outcome.kind === "in_progress") return outcome;
  if (outcome.kind === "fresh" && fresh) return { kind: "fresh", result: fresh };
  const body = outcome.response.body;
  const refused = storedError(body);
  if (refused) return { kind: "replayed", result: fail(refused.code, refused.message) };
  const threadId = storedThreadId(body);
  if (!threadId) return { kind: "replayed", result: fail("not_found", "Thread not found.") };
  const view = await getAnnotationThread(db, { ...reader, threadId });
  return { kind: "replayed", result: view.ok ? ok(view.value) : view };
}
