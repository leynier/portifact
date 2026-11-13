// What may happen to a suggestion and to a change-list item (decision 0027, "Withdrawal, deletion
// and retention", "The change list"): who decides, who withdraws, which thread changes a pending
// suggestion refuses, how items are marked, when an acceptance attempt is overdue and which files
// a plan can be built for. The services apply these after authorization and re-check the states
// they read inside their write batches.
import {
  type ArtifactType,
  type ChangeItemState,
  type FileKind,
  SUGGESTION_LIMITS,
  type SuggestionState,
} from "@portifact/contracts";
import { fail, ok, type Result } from "../result.ts";

/** How the caller takes part in an artifact's comments: its owner side, a participant or nobody. */
export type SuggestionRole = "owner" | "participant" | null;

const undecided = (state: SuggestionState | null) => state === "pending" || state === "applying";

/** Refusal for a suggestion an acceptance is applying: it ends soon, one way or the other. */
const applying = () =>
  fail<never>("version_conflict", "The suggestion is being accepted. Try again in a moment.");

/** Accepting or rejecting: only the owner side, and only a pending suggestion. */
export function checkDecide(role: SuggestionRole, state: SuggestionState | null): Result<true> {
  if (role !== "owner") {
    return fail("forbidden", "Only the people who manage the artifact accept or reject suggestions.");
  }
  if (state === "applying") return applying();
  if (state !== "pending") return fail("invalid_input", "This suggestion was already decided.");
  return ok(true);
}

/** Withdrawing: only its author, and only while it is pending. */
export function checkWithdraw(
  userId: string,
  authorId: string,
  state: SuggestionState | null,
): Result<true> {
  if (userId !== authorId) {
    return fail("forbidden", "Only the person who suggested it can withdraw a suggestion.");
  }
  if (state === "applying") return applying();
  if (state !== "pending") return fail("invalid_input", "This suggestion was already decided.");
  return ok(true);
}

/**
 * Resolving a thread through the thread routes: an undecided suggestion's thread is refused, so
 * the only ways out of `pending` are accepting, rejecting and withdrawing. Reopening is free.
 */
export function checkSuggestionThreadState(
  kind: "comment" | "suggestion",
  state: SuggestionState | null,
  next: "open" | "resolved",
): Result<true> {
  if (kind === "suggestion" && next === "resolved" && undecided(state)) {
    return fail("invalid_input", "Accept, reject or withdraw the suggestion.");
  }
  return ok(true);
}

/**
 * Deleting one's own first message of a suggestion withdraws it when it is pending; while an
 * acceptance applies it, the deletion waits, so a suggestion never goes back to pending without
 * its author's words.
 */
export function firstMessageDeletion(
  kind: "comment" | "suggestion",
  state: SuggestionState | null,
  isFirst: boolean,
): Result<{ withdraws: boolean }> {
  if (kind !== "suggestion" || !isFirst) return ok({ withdraws: false });
  if (state === "applying") return applying();
  return ok({ withdraws: state === "pending" });
}

export type MarkTarget = "applied" | "dismissed" | "open";

/**
 * Marking a change-list item: the owner side only (people and their agents; the service checks
 * the credential is a person's). `unchanged` when the item already is in that state. Reopening
 * needs room in the list.
 */
export function checkMark(
  role: SuggestionRole,
  from: ChangeItemState,
  to: MarkTarget,
  openItems: number,
  cap: number,
): Result<"changed" | "unchanged"> {
  if (role !== "owner") {
    return fail("forbidden", "Only the people who manage the artifact mark change-list items.");
  }
  if (from === to) return ok("unchanged");
  if (to === "open" && openItems >= cap) {
    return fail("quota_exceeded", `The change list holds at most ${cap} open items.`);
  }
  return ok("changed");
}

/** Whether a running acceptance attempt is overdue: delivered too often or running too long. */
export function attemptOverdue(
  attempt: { deliveries: number; createdAt: number },
  now: number,
): boolean {
  return (
    attempt.deliveries >= SUGGESTION_LIMITS.attemptDeliveries ||
    now - attempt.createdAt >= SUGGESTION_LIMITS.attemptMs
  );
}

/**
 * The kind of plan a version's file takes, or null when no plan applies to it: a document's
 * entrypoint (its `published` original), or an HTML page of a site.
 */
export function plannableKind(
  type: ArtifactType,
  file: { path: string; contentType: string },
  entrypoint: string,
): FileKind | null {
  if (type === "markdown" || type === "text") return file.path === entrypoint ? type : null;
  const mime = file.contentType.split(";")[0]?.trim().toLowerCase();
  return mime === "text/html" ? "html" : null;
}
