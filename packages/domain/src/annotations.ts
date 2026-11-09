// Annotation rules (plan section 8, "Permisos", and section 2 for the limits). Pure decisions
// over the artifact's effective state, its annotations mode and the caller's role; the services
// apply them with D1 and re-check the same conditions inside the write transaction.
import {
  ANNOTATION_LIMITS,
  type AnnotationsState,
  type ArtifactState,
  type CommentScope,
  type CommentVisibility,
} from "@portifact/contracts";
import { fail, ok, type Result } from "./result.ts";

/** `owner` manages the artifact; `participant` can read it through its access policy. */
export type AnnotationRole = "owner" | "participant";

export interface AnnotationContext {
  /** `null` when the account cannot read the artifact at all. */
  role: AnnotationRole | null;
  /** The effective state: an active artifact past its expiry counts as archived. */
  state: ArtifactState;
  mode: AnnotationsState;
}

/**
 * - `read`: list, read and export threads.
 * - `participate`: start threads, reply and edit one's own messages.
 * - `delete_own`: delete one's own messages.
 * - `resolve`: resolve or reopen a thread (the owner, or the thread's author).
 * - `moderate`: hide, unhide or delete other people's messages and delete threads.
 */
export type AnnotationAction = "read" | "participate" | "delete_own" | "resolve" | "moderate";

const missing = () => fail<never>("not_found", "Artifact not found.");
const GONE: readonly ArtifactState[] = ["draft", "purging", "deleted"];

/** Whether the caller may perform `action` on the artifact's annotations at all. */
export function checkAnnotationAction(
  context: AnnotationContext,
  action: AnnotationAction,
): Result<true> {
  if (context.role === null || GONE.includes(context.state)) return missing();
  return context.role === "owner"
    ? ownerAction(context, action)
    : participantAction(context, action);
}

function participantAction(context: AnnotationContext, action: AnnotationAction): Result<true> {
  // Archiving or suspending takes the conversation away from visitors with the content.
  if (context.state !== "active") return missing();
  if (context.mode === "off") {
    return fail("forbidden", "Annotations are off for this artifact.");
  }
  if (action === "moderate") return fail("forbidden", "Only the owner can moderate annotations.");
  if (action === "read" || action === "delete_own") return ok(true);
  return context.mode === "open" ? ok(true) : locked();
}

function ownerAction(context: AnnotationContext, action: AnnotationAction): Result<true> {
  // The owner keeps the history in every state, also with annotations off.
  if (action === "read") return ok(true);
  if (context.state === "archived") {
    return fail("artifact_archived", "Restore the artifact to change its annotations.");
  }
  if (context.state === "suspended") {
    return fail("forbidden", "This artifact is suspended; its annotations cannot change.");
  }
  if (context.mode === "off") {
    return fail("forbidden", "Annotations are off for this artifact. Turn them on first.");
  }
  if (action === "participate" && context.mode === "locked") return locked();
  return ok(true);
}

const locked = () =>
  fail<never>("forbidden", "Annotations are locked: threads can be read but not added to.");

/** Only the owner changes the mode, on an active or archived artifact. */
export function checkAnnotationModeChange(context: Omit<AnnotationContext, "mode">): Result<true> {
  if (context.role !== "owner" || GONE.includes(context.state)) return missing();
  if (context.state === "suspended") {
    return fail("forbidden", "This artifact is suspended; its annotations cannot change.");
  }
  return ok(true);
}

/**
 * Visitors see only the threads of the current version; older ones are the owner's history.
 * A thread the caller cannot see answers like a missing one.
 */
export function threadVisible(
  role: AnnotationRole,
  threadVersionId: string,
  currentVersionId: string | null,
): boolean {
  return role === "owner" || threadVersionId === currentVersionId;
}

/**
 * Which threads a caller sees (plan section 8, decision of 2026-11-08 on visibility). The owner
 * sees all. A reader follows their exception on the reader list when they have one (matched by
 * verified address), and otherwise the artifact's setting: `everyone` shows all threads and
 * `owner` only their own and the owner's.
 */
export function commentScope(
  role: AnnotationRole,
  visibility: CommentVisibility,
  readerException: CommentScope | null,
): CommentScope {
  if (role === "owner") return "all";
  if (readerException !== null) return readerException;
  return visibility === "everyone" ? "all" : "own";
}

/**
 * Whether a thread is within the caller's scope: with `own`, the threads the caller or the
 * owner started, with every reply in them whoever wrote it. A reply never makes someone else's
 * thread visible to its writer. A thread outside the scope answers like a missing one.
 */
export function threadInScope(
  scope: CommentScope,
  viewerId: string,
  ownerId: string,
  threadAuthorId: string,
): boolean {
  return scope === "all" || threadAuthorId === viewerId || threadAuthorId === ownerId;
}

/** New messages and edits go only to threads of the current version. */
export function checkThreadWritable(
  threadVersionId: string,
  currentVersionId: string | null,
): Result<true> {
  if (threadVersionId !== currentVersionId) {
    return fail(
      "version_conflict",
      "A newer version was published; this thread is now history and takes no new messages.",
    );
  }
  return ok(true);
}

/** The owner resolves and reopens any thread; a participant only the threads they started. */
export function checkResolve(
  role: AnnotationRole,
  actorId: string,
  threadAuthorId: string,
): Result<true> {
  if (role === "owner" || actorId === threadAuthorId) return ok(true);
  return fail("forbidden", "Only the owner or the person who started the thread can do this.");
}

export interface MessageFacts {
  authorId: string;
  state: "visible" | "hidden" | "deleted";
}

/** Only the author edits a message, and only while it is visible. Nobody edits others' text. */
export function checkEditMessage(actorId: string, message: MessageFacts): Result<true> {
  if (message.authorId !== actorId)
    return fail("forbidden", "You can only edit your own messages.");
  if (message.state === "deleted") return fail("not_found", "Message not found.");
  if (message.state === "hidden") {
    return fail("forbidden", "The owner hid this message; it cannot be edited.");
  }
  return ok(true);
}

/** Only the author deletes through this path; the owner uses moderation. */
export function checkDeleteOwnMessage(actorId: string, message: MessageFacts): Result<true> {
  if (message.authorId !== actorId) {
    return fail("forbidden", "You can only delete your own messages.");
  }
  return ok(true);
}

export type ModerationAction = "hide" | "unhide" | "delete";

/** What moderation does to a message, or `null` when it is already in that state. */
export function moderationTransition(
  message: MessageFacts,
  action: ModerationAction,
): Result<"hidden" | "visible" | "deleted" | null> {
  if (message.state === "deleted") {
    return action === "delete" ? ok(null) : fail("not_found", "Message not found.");
  }
  if (action === "delete") return ok("deleted");
  const target = action === "hide" ? "hidden" : "visible";
  return ok(message.state === target ? null : target);
}

/**
 * Who sees a message body: nobody once deleted; the owner and the author while hidden;
 * everyone with access otherwise.
 */
export function messageBodyVisible(
  role: AnnotationRole,
  viewerId: string,
  message: MessageFacts,
): boolean {
  if (message.state === "deleted") return false;
  if (message.state === "hidden") return role === "owner" || viewerId === message.authorId;
  return true;
}

/** Recent writes and stored totals that bound a new message or an edit. */
export interface AnnotationUsageSnapshot {
  /** New messages and edits by the author in the last minute and the last 24 hours. */
  authorWritesLastMinute: number;
  authorWritesLast24h: number;
  /** New messages and edits on the artifact in the last 24 hours, by everyone. */
  artifactWritesLast24h: number;
  /** Threads of the artifact, in every version. */
  artifactThreads: number;
  /** Messages of the thread being replied to; 0 when starting a thread. */
  threadMessages: number;
  /** Live messages and logical bytes stored for the artifact's owner. */
  ownerMessages: number;
  ownerBytes: number;
}

export interface AnnotationWrite {
  kind: "thread" | "reply" | "edit";
  /** Bytes the write adds to the owner's total; negative when an edit shortens a body. */
  addedBytes: number;
}

/** Applies the rate limits first, then the stored-data quotas. */
export function checkAnnotationWrite(
  usage: AnnotationUsageSnapshot,
  write: AnnotationWrite,
): Result<true> {
  if (usage.authorWritesLastMinute >= ANNOTATION_LIMITS.writesPerMinute) {
    return fail(
      "rate_limited",
      `You can write ${ANNOTATION_LIMITS.writesPerMinute} comments per minute. Wait a moment.`,
    );
  }
  if (usage.authorWritesLast24h >= ANNOTATION_LIMITS.writesPer24h) {
    return fail(
      "rate_limited",
      `You can write ${ANNOTATION_LIMITS.writesPer24h} comments per 24 hours.`,
    );
  }
  if (usage.artifactWritesLast24h >= ANNOTATION_LIMITS.artifactWritesPer24h) {
    return fail("rate_limited", "This artifact received too many comments today. Try later.");
  }
  if (write.kind === "thread" && usage.artifactThreads >= ANNOTATION_LIMITS.threadsPerArtifact) {
    return fail(
      "quota_exceeded",
      `An artifact can hold at most ${ANNOTATION_LIMITS.threadsPerArtifact} threads.`,
    );
  }
  if (write.kind === "reply" && usage.threadMessages >= ANNOTATION_LIMITS.messagesPerThread) {
    return fail(
      "quota_exceeded",
      `A thread can hold at most ${ANNOTATION_LIMITS.messagesPerThread} messages.`,
    );
  }
  const addedMessages = write.kind === "edit" ? 0 : 1;
  if (
    usage.ownerMessages + addedMessages > ANNOTATION_LIMITS.messagesPerOwner ||
    usage.ownerBytes + write.addedBytes > ANNOTATION_LIMITS.bytesPerOwner
  ) {
    return fail("quota_exceeded", "The owner of this artifact has no room for more comments.");
  }
  return ok(true);
}

/**
 * Whether a new comment (thread or reply) needs a solved human check: the account's first
 * comments on artifacts it does not own do (plan section 13). Owners never need one on their
 * own artifacts, so they can answer with any client, agents included.
 */
export function needsHumanCheck(role: AnnotationRole, commentsOnOthersArtifacts: number): boolean {
  return (
    role === "participant" && commentsOnOthersArtifacts < ANNOTATION_LIMITS.humanCheckedComments
  );
}

/** Outcome of verifying a human check token with the provider. */
export type HumanVerdict = "passed" | "failed" | "unavailable";

/**
 * The decision for a comment that needs a human check, from the token the client sent (if any)
 * and the provider's verdict on it. Without a token the comment must come from the review
 * viewer, which shows the challenge.
 */
export function checkHumanVerdict(verdict: HumanVerdict | "missing"): Result<true> {
  if (verdict === "passed") return ok(true);
  if (verdict === "unavailable") {
    return fail(
      "capacity_unavailable",
      "The human check is unavailable right now. Try again in a few minutes.",
    );
  }
  if (verdict === "failed") {
    return fail(
      "human_verification_required",
      "The human check failed or expired. Complete it again and resend the comment.",
    );
  }
  return fail(
    "human_verification_required",
    `Your first ${ANNOTATION_LIMITS.humanCheckedComments} comments on other people's artifacts need a human check. Post them from the review viewer at app.portifact.com.`,
  );
}
