// Approval review rules (premium plan T6, decision 0013). Pure decisions: the status of a review
// from its request and verdicts, the bounds of a request and its changes, and who sees what.
// Who may be a reviewer is not decided here: it is exactly who the existing access rules let
// open the artifact and take part in its comments (`canRead` and the owner side), evaluated by
// packages/services for each address.
import {
  type AccessMode,
  APPROVALS,
  type ApprovalStatus,
  type ApprovalSummary,
  type ApprovalVerdict,
  type ApprovalViewerRole,
  type ArtifactState,
  type CommentScope,
  NO_APPROVAL_REVIEW,
} from "@portifact/contracts";
import { threadInScope } from "./annotations.ts";
import { type Entitlements, hasFeature } from "./plans.ts";
import { fail, ok, type Result } from "./result.ts";

export const APPROVAL_FEATURE = "reviews";

export const APPROVAL_MESSAGES = {
  missingArtifact: "Artifact not found.",
  noRequest: "This artifact has no open review request.",
  alreadyOpen: "This artifact already has an open review request. Change it or cancel it first.",
  notReviewer: "You are not one of this artifact's reviewers.",
  notCurrent: "The artifact has a new version; reload it and review that one.",
  notActive: "Only an active artifact can be reviewed.",
  noVersion: "Publish a version before asking for a review.",
  changed: "The review changed meanwhile. Reload and try again.",
  rateLimited: "Too many review requests. Wait a while and try again.",
  verdictsLimited: "Too many verdicts on this artifact. Wait a while and try again.",
  cannotOpen: (email: string) =>
    `${email} cannot open this artifact or comment on it yet. Share it with them first, then ask again.`,
  cannotOpenSome:
    "At least one of these addresses cannot open this artifact or comment on it yet. Share it with them first, then ask again.",
  tooMany: `A review can name at most ${APPROVALS.reviewersPerRequest} reviewers.`,
  required: (reviewers: number) =>
    `The required approvals must be between 1 and the number of reviewers (${reviewers}).`,
  notListed: (email: string) => `${email} is not a reviewer of this request.`,
  alreadyListed: (email: string) => `${email} is already a reviewer of this request.`,
  empty: "A review needs at least one reviewer.",
} as const;

/** One reviewer as the status counts them: whether they can still open it, and their verdict. */
export interface ApprovalReviewerFacts {
  /** False once they can no longer open the artifact: they stop counting. */
  active: boolean;
  /** Their verdict on the version under review, if any. */
  verdict: ApprovalVerdict | null;
}

/**
 * The status from the open request (null without one) and its reviewers. Only reviewers who can
 * still open the artifact count. The required number is the request's (`null` means every
 * reviewer), never more than the reviewers who count and never less than one, so a request
 * whose reviewers all lost access stays pending until the owner side changes it.
 */
export function approvalSummary(
  request: { required: number | null } | null,
  reviewers: readonly ApprovalReviewerFacts[],
): ApprovalSummary {
  if (request === null) return NO_APPROVAL_REVIEW;
  const counting = reviewers.filter((reviewer) => reviewer.active);
  const approvals = counting.filter((reviewer) => reviewer.verdict === "approve").length;
  const changesRequested = counting.filter((reviewer) => reviewer.verdict === "changes").length;
  const required = Math.max(1, Math.min(request.required ?? counting.length, counting.length));
  let status: ApprovalStatus = "pending";
  if (changesRequested > 0) status = "changes_requested";
  else if (counting.length > 0 && approvals >= required) status = "approved";
  return { status, reviewers: counting.length, required, approvals, changesRequested };
}

/**
 * Whether an owner's review emails are on (decision 0013, "Emails"): they need both approval
 * reviews and comment notices in the artifact owner's plan. Without either nothing is written or
 * sent.
 */
export function reviewNoticesOn(owner: Entitlements): boolean {
  return hasFeature(owner, APPROVAL_FEATURE) && hasFeature(owner, "commentNotices");
}

/** What decides whether a reviewer is told by email that their review was asked. */
export interface ReviewNoticeFacts {
  /** The artifact's access mode now. */
  mode: AccessMode;
  /** Whether the access rules let the person open the artifact and take part now. */
  takesPart: boolean;
  /** The owner side, or a member of the owning workspace (any role); null for anyone else. */
  side: "owner" | "member" | null;
  /** Their verified address is on the artifact's reader list (whatever the mode). */
  listedReader: boolean;
  /** They are in a group the artifact lists (decision 0014). */
  inListedGroup: boolean;
  /** Their verified address is at a verified email domain of the owning workspace. */
  atVerifiedDomain: boolean;
}

/**
 * Whether a requested reviewer gets the "review requested" email (decision 0013, "Emails"): only
 * someone who can open the artifact and has a standing relationship to it: the owner side or a
 * member of the owning workspace, an address on the reader list, a member of a listed group, or an
 * address at a verified domain of the workspace while the artifact is in `domain` mode. Someone
 * admitted only because the artifact is `public` or `authenticated` can be named and sees the
 * request in the viewer, but is not emailed, so a review cannot make Portifact email strangers.
 */
export function reviewNoticeRecipient(facts: ReviewNoticeFacts): boolean {
  if (!facts.takesPart) return false;
  if (facts.side !== null || facts.listedReader || facts.inListedGroup) return true;
  return facts.mode === "domain" && facts.atVerifiedDomain;
}

/** Whether a status ends the review of the version: approved or changes requested. */
export function approvalComplete(
  status: ApprovalStatus,
): status is "approved" | "changes_requested" {
  return status === "approved" || status === "changes_requested";
}

/** The addresses of a new request, lowercased and without repeats. */
export function checkReviewerList(emails: readonly string[]): Result<string[]> {
  const unique = [...new Set(emails.map((email) => email.trim().toLowerCase()))];
  if (unique.length === 0) return fail("invalid_input", APPROVAL_MESSAGES.empty);
  if (unique.length > APPROVALS.reviewersPerRequest) {
    return fail("invalid_input", APPROVAL_MESSAGES.tooMany);
  }
  return ok(unique);
}

/** The required approvals for `reviewers` people: null (every reviewer) or 1 to their number. */
export function checkRequiredApprovals(
  required: number | null,
  reviewers: number,
): Result<number | null> {
  if (required === null) return ok(null);
  if (!Number.isInteger(required) || required < 1 || required > reviewers) {
    return fail("invalid_input", APPROVAL_MESSAGES.required(reviewers));
  }
  return ok(required);
}

export interface ApprovalChange {
  /** Every address after the change. */
  reviewers: string[];
  added: string[];
  removed: string[];
  /** The required number after the change. */
  required: number | null;
}

/**
 * Applies a change to the open request's reviewers and number. Adding someone listed or removing
 * someone who is not is refused, so a repeated change says it already happened. Without a new
 * number, a number that no longer fits falls back to every reviewer.
 */
export function checkApprovalChange(input: {
  current: readonly string[];
  required: number | null;
  add?: readonly string[] | undefined;
  remove?: readonly string[] | undefined;
  /** undefined keeps the number. */
  newRequired?: number | null | undefined;
}): Result<ApprovalChange> {
  const add = [...new Set((input.add ?? []).map((email) => email.toLowerCase()))];
  const remove = [...new Set((input.remove ?? []).map((email) => email.toLowerCase()))];
  const current = new Set(input.current);
  for (const email of add) {
    if (current.has(email) && !remove.includes(email)) {
      return fail("invalid_input", APPROVAL_MESSAGES.alreadyListed(email));
    }
  }
  for (const email of remove) {
    if (!current.has(email)) return fail("invalid_input", APPROVAL_MESSAGES.notListed(email));
  }
  const reviewers = [
    ...input.current.filter((email) => !remove.includes(email)),
    ...add.filter((email) => !input.current.includes(email) || remove.includes(email)),
  ].filter((email, index, all) => all.indexOf(email) === index);
  if (reviewers.length === 0) return fail("invalid_input", APPROVAL_MESSAGES.empty);
  if (reviewers.length > APPROVALS.reviewersPerRequest) {
    return fail("invalid_input", APPROVAL_MESSAGES.tooMany);
  }
  let required: number | null;
  if (input.newRequired === undefined) {
    required = input.required !== null && input.required > reviewers.length ? null : input.required;
  } else {
    const checked = checkRequiredApprovals(input.newRequired, reviewers.length);
    if (!checked.ok) return checked;
    required = checked.value;
  }
  return ok({
    reviewers,
    added: add.filter((email) => !input.current.includes(email)),
    removed: remove.filter((email) => !add.includes(email)),
    required,
  });
}

/**
 * Whether a verdict may be given: the artifact is active, has a current version and the request
 * is about that version (a publish in between moved it, and the verdict would land on the wrong
 * one).
 */
export function checkVerdictTarget(input: {
  state: ArtifactState;
  currentVersionId: string | null;
  requestVersionId: string;
  /** The version the caller was looking at, when they say. */
  seenVersionId?: string | undefined;
}): Result<string> {
  if (input.state !== "active") return fail("forbidden", APPROVAL_MESSAGES.notActive);
  if (input.currentVersionId === null || input.currentVersionId !== input.requestVersionId) {
    return fail("version_conflict", APPROVAL_MESSAGES.notCurrent);
  }
  if (input.seenVersionId !== undefined && input.seenVersionId !== input.currentVersionId) {
    return fail("version_conflict", APPROVAL_MESSAGES.notCurrent);
  }
  return ok(input.currentVersionId);
}

/** Whether an artifact can get a new request: active, with a current version. */
export function checkRequestTarget(input: {
  state: ArtifactState;
  currentVersionId: string | null;
}): Result<string> {
  if (input.state !== "active") return fail("forbidden", APPROVAL_MESSAGES.notActive);
  if (input.currentVersionId === null) return fail("invalid_input", APPROVAL_MESSAGES.noVersion);
  return ok(input.currentVersionId);
}

/**
 * How the caller relates to a review: the owner side, a listed reviewer (matched by their
 * verified address), or someone else who can open the artifact. Null for anyone who cannot open
 * it, who gets exactly what a missing artifact gives.
 */
export function approvalViewerRole(input: {
  /** The caller's role in the annotation rules: owner side, participant or nobody. */
  role: "owner" | "participant" | null;
  listed: boolean;
}): ApprovalViewerRole | null {
  if (input.role === null) return null;
  if (input.role === "owner") return "owner";
  return input.listed ? "reviewer" : "reader";
}

/**
 * Whether the caller sees one reviewer's entry and verdict. The owner side sees all; a reviewer
 * sees what their comment scope shows of other people's comments (`commentScope`: everyone's with
 * `all`, otherwise their own and the owner side's), and always their own. Entries of addresses
 * with no account are shown only to the owner side and with the `all` scope.
 */
export function approvalEntryVisible(input: {
  role: ApprovalViewerRole;
  scope: CommentScope;
  viewerId: string;
  ownerSide: readonly string[];
  /** The reviewer's account, or null for an address with no account yet. */
  reviewerId: string | null;
}): boolean {
  if (input.role === "owner") return true;
  if (input.role !== "reviewer") return false;
  if (input.reviewerId === null) return input.scope === "all";
  return threadInScope(input.scope, input.viewerId, input.ownerSide, input.reviewerId);
}

/**
 * Whether the caller sees the overall status. The owner side and reviewers always do; anyone
 * else only when the request shows it (off by default), and otherwise gets exactly what an
 * artifact without a request gives.
 */
export function approvalStatusVisible(role: ApprovalViewerRole, showStatus: boolean): boolean {
  return role !== "reader" || showStatus;
}
