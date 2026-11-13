// Edit suggestions as comment threads (decision 0027, "The edit model", "Withdrawal, deletion and
// retention"): submitting one, reading it, rejecting it and withdrawing it. A suggestion is an
// `annotation_threads` row of kind `suggestion` whose first message is the reviewer's note, so it
// takes exactly the annotation rules: the same authorization and comment scope (`findThread`),
// the same quotas, rate limits and human check, the same claimed batch for its creation, the same
// comment notice and `comment.created` webhook event. The edit is inert data, validated by the
// strict contract, never written into a file except through a confirmed plan
// (`suggestion-accept.ts`), and never logged, audited or sent anywhere.
//
// Service tokens never take part: the annotation role of a token is none, so every path here
// answers a token as a missing artifact (decision 0027, "Who reads and closes").
import {
  ANNOTATION_LIMITS,
  type AnnotationTarget,
  type AnnotationThreadView,
  Edit,
  type SuggestionProofs,
  type SuggestionState,
  type SuggestionView,
  utf8Length,
} from "@portifact/contracts";
import { type RegionalDb, schema } from "@portifact/db";
import { fail, ok, type Result } from "@portifact/domain";
import {
  checkDecide,
  checkWithdraw,
  plannableKind,
  plannedOn,
} from "@portifact/domain/suggestions";
import { and, eq, sql } from "drizzle-orm";
import {
  type AnnotationActor,
  type AuthorizedAnnotations,
  annotationParts,
  type HumanCheck,
  WITHDRAWN,
} from "./annotations.ts";
import { auditEvent } from "./audit.ts";


const th = schema.annotationThreads;

const missingThread = () => fail<never>("not_found", "Thread not found.");
const notASuggestion = () => fail<never>("not_found", "Suggestion not found.");

type ThreadRow = typeof th.$inferSelect;

/** The stored proofs of a suggestion, or null when it has none (or they cannot be read). */
export function storedProofs(row: Pick<ThreadRow, "editProofs">): SuggestionProofs | null {
  if (row.editProofs === null) return null;
  try {
    return JSON.parse(row.editProofs) as SuggestionProofs;
  } catch {
    return null;
  }
}

/** The submitted edit of a suggestion still holding one. */
export function storedEdit(row: Pick<ThreadRow, "edit">): Edit | null {
  if (row.edit === null) return null;
  const parsed = Edit.safeParse(JSON.parse(row.edit));
  return parsed.success ? parsed.data : null;
}

function view(row: ThreadRow): SuggestionView {
  const edit = storedEdit(row);
  return {
    threadId: row.id,
    artifactId: row.artifactId,
    versionId: row.versionId,
    state: row.suggestionState as SuggestionState,
    edit,
    revision: row.suggestionRevision,
    attemptReason: row.attemptReason,
    decidedAt: row.decidedAt,
    resultVersionId: row.resultVersionId,
    originVersionId: row.originVersionId,
    planned: plannedOn(storedProofs(row), row.versionId),
  };
}

/** A suggestion the caller sees, or a missing thread's answer. */
async function visibleSuggestion(
  db: RegionalDb,
  loaded: AuthorizedAnnotations,
  threadId: string,
): Promise<Result<ThreadRow>> {
  const thread = await annotationParts.findThread(db, loaded, threadId);
  if (!thread) return missingThread();
  if (thread.kind !== "suggestion") return notASuggestion();
  return ok(thread);
}

/**
 * Starts a suggestion on the artifact's current version: a thread holding the edit, with the
 * reviewer's note as its first message. Whoever may comment may suggest, under the same limits
 * and human check; the edit's bytes count in the owner's annotation bytes (a trigger).
 */
export async function submitSuggestion(
  db: RegionalDb,
  input: AnnotationActor & {
    versionId: string;
    edit: unknown;
    body: string;
    humanCheck: HumanCheck;
  },
): Promise<Result<AnnotationThreadView>> {
  const parsed = Edit.safeParse(input.edit);
  if (!parsed.success) {
    return fail("invalid_input", parsed.error.issues[0]?.message ?? "Invalid edit.");
  }
  const edit = parsed.data;
  const target = (edit.operations[0] as { target: AnnotationTarget }).target;
  const targetJson = JSON.stringify(target);
  const targetBytes = utf8Length(targetJson);
  const editJson = JSON.stringify(edit);
  const editBytes = utf8Length(editJson);
  const bodyBytes = utf8Length(input.body);
  const threadId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const writeId = crypto.randomUUID();
  const checkHuman = annotationParts.humanGate(db, input.userId, input.humanCheck);
  const claimed = annotationParts.claimed(writeId);

  return annotationParts.guardedWrite(
    async () => {
      const loaded = await annotationParts.authorize(db, input, "participate");
      if (!loaded.ok) return loaded;
      const { artifact } = loaded.value;
      if (artifact.currentVersionId !== input.versionId) {
        return fail("version_conflict", "Suggest on the current version of the artifact.");
      }
      const [file] = await db
        .select({
          path: schema.versionFiles.path,
          contentType: schema.versionFiles.contentType,
          entrypoint: schema.versions.entrypoint,
        })
        .from(schema.versionFiles)
        .innerJoin(schema.versions, eq(schema.versions.id, schema.versionFiles.versionId))
        .where(
          and(
            eq(schema.versionFiles.versionId, input.versionId),
            eq(schema.versionFiles.kind, "published"),
            eq(schema.versionFiles.path, target.path),
          ),
        )
        .limit(1);
      if (!file) return fail("invalid_input", "target.path: No such file in this version.");
      // Only a page a plan can be built for: a document's original or an HTML page.
      if (plannableKind(artifact.type, file, file.entrypoint) === null) {
        return fail("invalid_input", "target.path: Suggestions are made on pages and documents.");
      }
      const limits = await annotationParts.checkLimits(db, loaded.value, input.userId, input.now, {
        kind: "thread",
        addedBytes: bodyBytes + targetBytes + editBytes,
      });
      if (!limits.ok) return limits;
      const human = await checkHuman(loaded.value);
      return human.ok ? loaded : human;
    },
    async (loaded) => {
      const a = loaded.artifact;
      const guard = sql`${annotationParts.artifactGuard(loaded, "participate", input.now)} and exists (select 1 from ${schema.artifacts} where ${schema.artifacts.id} = ${a.id} and ${schema.artifacts.currentVersionId} = ${input.versionId}) and ${annotationParts.rateGuard(input.userId, a.id, input.now)} and (select count(*) from ${th} where ${th.artifactId} = ${a.id}) < ${ANNOTATION_LIMITS.threadsPerArtifact}`;
      return annotationParts.runClaimed(db, [
        annotationParts.claim(
          db,
          writeId,
          {
            artifactId: a.id,
            threadId,
            messageId,
            actorId: input.userId,
            kind: "thread_created",
            now: input.now,
          },
          guard,
        ),
        // Columns in schema order (see `createAnnotationThread`), then the suggestion columns:
        // kind, suggestion state, edit, edit bytes, edit proofs, suggestion revision, attempt,
        // attempt reason, decided by, decided at, result version, origin version, origin target.
        db
          .insert(th)
          .select(
            sql`select ${threadId}, ${a.id}, ${input.versionId}, ${a.ownerId}, ${input.userId}, ${targetJson}, ${targetBytes}, ${target.path}, 'open', 1, 1, ${annotationParts.claimedEventId(writeId)}, null, null, ${input.now}, ${input.now}, 'suggestion', 'pending', ${editJson}, ${editBytes}, null, 1, null, null, null, null, null, null, null where ${claimed}`,
          ),
        annotationParts.insertMessage(db, {
          id: messageId,
          threadId,
          artifact: a,
          authorId: input.userId,
          body: input.body,
          bodyBytes,
          now: input.now,
          writeId,
        }),
        // A new suggestion is a new comment: the comment notice and `comment.created`.
        ...annotationParts.noticeMark(db, loaded, writeId, {
          threadId,
          actorId: input.userId,
          activity: "thread",
          now: input.now,
        }),
      ]);
    },
    (loaded) => annotationParts.threadResult(db, loaded, input.userId, threadId),
  );
}

/** A suggestion with its edit, for whoever sees its thread. */
export async function getSuggestion(
  db: RegionalDb,
  input: AnnotationActor & { threadId: string },
): Promise<Result<SuggestionView>> {
  const loaded = await annotationParts.authorize(db, input, "read");
  if (!loaded.ok) return loaded;
  const thread = await visibleSuggestion(db, loaded.value, input.threadId);
  return thread.ok ? ok(view(thread.value)) : thread;
}

/**
 * The guard of a decision on a suggestion: the artifact as authorized, the suggestion still
 * pending at the revision the caller saw. Every statement of the batch carries it, the update
 * last, so a concurrent decision or acceptance wins cleanly.
 */
function pendingGuard(
  loaded: AuthorizedAnnotations,
  action: "moderate" | "delete_own",
  threadId: string,
  revision: number,
  now: number,
) {
  return sql`${annotationParts.artifactGuard(loaded, action, now)} and exists (select 1 from ${th} where ${th.id} = ${threadId} and ${th.kind} = 'suggestion' and ${th.suggestionState} = 'pending' and ${th.suggestionRevision} = ${revision})`;
}

async function decide(
  db: RegionalDb,
  input: AnnotationActor & { threadId: string; revision: number },
  rule: (loaded: AuthorizedAnnotations, thread: ThreadRow) => Result<true>,
  action: "moderate" | "delete_own",
  write: (loaded: AuthorizedAnnotations, guard: ReturnType<typeof sql>) => Promise<boolean>,
): Promise<Result<SuggestionView>> {
  const check = async (): Promise<Result<AuthorizedAnnotations>> => {
    const loaded = await annotationParts.authorize(db, input, action);
    if (!loaded.ok) return loaded;
    const thread = await visibleSuggestion(db, loaded.value, input.threadId);
    if (!thread.ok) return thread;
    const allowed = rule(loaded.value, thread.value);
    if (!allowed.ok) return allowed;
    if (thread.value.suggestionRevision !== input.revision) {
      return fail("version_conflict", "The suggestion changed meanwhile. Reload and try again.");
    }
    return ok(loaded.value);
  };
  const first = await check();
  if (!first.ok) return first;
  const guard = pendingGuard(first.value, action, input.threadId, input.revision, input.now);
  if (!(await write(first.value, guard))) {
    const again = await check();
    return again.ok
      ? fail("version_conflict", "The suggestion changed meanwhile. Reload and try again.")
      : again;
  }
  return getSuggestion(db, input);
}

/**
 * Rejects a pending suggestion: the owner side only, as a person. The thread stays open as a
 * conversation; never refused by budget protection.
 */
export async function rejectSuggestion(
  db: RegionalDb,
  input: AnnotationActor & { threadId: string; revision: number },
): Promise<Result<SuggestionView>> {
  return decide(
    db,
    input,
    (loaded, thread) => checkDecide(loaded.role, thread.suggestionState),
    "moderate",
    async (loaded, guard) => {
      const [, updated] = await db.batch([
        auditEvent(
          db,
          {
            ownerId: loaded.artifact.ownerId,
            kind: "suggestion.rejected",
            actor: { type: "user", id: input.userId },
            targetId: loaded.artifact.id,
            artifactId: loaded.artifact.id,
            detail: {},
            now: input.now,
          },
          guard,
        ),
        db
          .update(th)
          .set({
            suggestionState: "rejected",
            attemptReason: null,
            decidedBy: input.userId,
            decidedAt: input.now,
            suggestionRevision: sql`${th.suggestionRevision} + 1`,
            updatedAt: input.now,
          })
          .where(and(eq(th.id, input.threadId), guard))
          .returning({ id: th.id }),
      ]);
      return updated.length === 1;
    },
  );
}

/**
 * Withdraws one's own pending suggestion: its edit is cleared (its bytes given back) and the
 * thread stays as a conversation. The only way an author removes a pending edit.
 */
export async function withdrawSuggestion(
  db: RegionalDb,
  input: AnnotationActor & { threadId: string; revision: number },
): Promise<Result<SuggestionView>> {
  return decide(
    db,
    input,
    (_loaded, thread) => checkWithdraw(input.userId, thread.authorId, thread.suggestionState),
    "delete_own",
    async (loaded, guard) => {
      const owned = sql`${guard} and exists (select 1 from ${th} where ${th.id} = ${input.threadId} and ${th.authorId} = ${input.userId})`;
      const [, updated] = await db.batch([
        auditEvent(
          db,
          {
            ownerId: loaded.artifact.ownerId,
            kind: "suggestion.withdrawn",
            actor: { type: "user", id: input.userId },
            targetId: loaded.artifact.id,
            artifactId: loaded.artifact.id,
            detail: {},
            now: input.now,
          },
          owned,
        ),
        db
          .update(th)
          .set({ ...WITHDRAWN, updatedAt: input.now })
          .where(and(eq(th.id, input.threadId), owned))
          .returning({ id: th.id }),
      ]);
      return updated.length === 1;
    },
  );
}
