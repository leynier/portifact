// MCP tools for approval reviews (premium plan T6, decision 0013; not review mode):
// request_review (request, change or cancel), submit_review and get_review_status. Each calls the
// same service as its /api/v1/artifacts/:id/review route, with the same scope, and returns the
// same body, so the plan gate, the role checks and the errors are the API's.
import {
  ApprovalReviewView,
  type ErrorCode,
  GetReviewStatusToolInput,
  type OAuthScope,
  RequestReviewToolInput,
  SubmitReviewToolInput,
  UNTRUSTED_APPROVAL_NOTES,
} from "@portifact/contracts";
import type { RegionalDb } from "@portifact/db";
import {
  cancelApprovalReview,
  changeApprovalReview,
  getApprovalReview,
  hashRequest,
  requestApprovalReview,
  runIdempotent,
  type StoredResponse,
  submitApprovalVerdict,
} from "@portifact/services";
import { reviewResponse } from "../api/approval-reviews.ts";
import { artifactDb } from "../regions.ts";
import { failure, type RegisterTool, success, type ToolContext } from "./tools.ts";

export const REVIEW_TOOL_SCOPES: [string, OAuthScope][] = [
  // The API's scopes: managing a review is `artifacts:write`, a verdict is like a comment.
  ["request_review", "artifacts:write"],
  ["submit_review", "annotations:write"],
  ["get_review_status", "artifacts:read"],
];

type Body = ApprovalReviewView | { error: { code: ErrorCode; message: string } };

/** Runs once per idempotency key, with the API's operation names, so both answer the same. */
async function once(
  db: RegionalDb,
  context: ToolContext,
  key: string | undefined,
  operation: string,
  request: unknown,
  now: number,
  run: () => Promise<StoredResponse>,
) {
  if (!key) return { ok: true as const, response: await run() };
  const outcome = await runIdempotent(
    db,
    {
      actorId: context.userId,
      key,
      operation,
      requestHash: await hashRequest(request),
      now,
    },
    run,
  );
  if (outcome.kind === "mismatch") {
    return {
      ok: false as const,
      result: failure("invalid_input", "This idempotency key was used for a different request."),
    };
  }
  if (outcome.kind === "in_progress") {
    return {
      ok: false as const,
      result: failure("version_conflict", "A request with this idempotency key is still running."),
    };
  }
  return { ok: true as const, response: outcome.response };
}

function describe(view: ApprovalReviewView): string {
  const { review } = view;
  if (review.status === "none") return `${view.artifactId} has no open review request.`;
  const counts = `${review.approvals} of ${review.required} required approvals, ${review.changesRequested} asking for changes, ${review.reviewers} reviewers`;
  return `Review of ${view.artifactId}: ${review.status.replace("_", " ")} (${counts}).`;
}

export function registerReviewTools(
  register: RegisterTool,
  context: ToolContext,
  db: RegionalDb,
): void {
  register(
    "request_review",
    {
      title: "Request a review",
      description:
        "Ask people to review the current version of the user's artifact, or change or cancel the open request (action). Reviewers are named by email and must already be able to open the artifact and comment on it (readers on its list, or members of its workspace): requesting a review gives nobody access, and an address that cannot open it is refused with a message to share it first. requiredApprovals is how many approvals decide the review (every reviewer when omitted). showStatus lets everyone else who can open the artifact see the overall status (off by default). A new version starts the review again with no verdicts. Only call it when the user asked for a review and named the reviewers. Requesting and changing are part of a paid plan (plan_required otherwise); cancelling never is. Pass the same idempotencyKey when you retry.",
      inputSchema: RequestReviewToolInput,
      outputSchema: ApprovalReviewView,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args: RequestReviewToolInput) => {
      const { idempotencyKey, artifactId, action = "request", ...rest } = args;
      const now = context.now();
      const target = await artifactDb(context.env, artifactId);
      if (action === "cancel") {
        const result = await cancelApprovalReview(target, {
          userId: context.userId,
          artifactId,
          now,
        });
        if (!result.ok) return failure(result.code, result.message);
        const body = ApprovalReviewView.parse(result.value);
        return success(`Cancelled the review request of ${artifactId}.`, body);
      }
      if (action === "request" && !rest.reviewers?.length) {
        return failure("invalid_input", "Name the reviewers by email in reviewers.");
      }
      // The API's request bodies, in its schemas' key order: unset fields drop out of the hash
      // like absent ones, so a key used at either answers the same.
      const request =
        action === "request"
          ? {
              artifactId,
              reviewers: rest.reviewers,
              requiredApprovals: rest.requiredApprovals,
              showStatus: rest.showStatus,
            }
          : {
              artifactId,
              add: rest.add,
              remove: rest.remove,
              requiredApprovals: rest.requiredApprovals,
              showStatus: rest.showStatus,
            };
      const outcome = await once(
        db,
        context,
        idempotencyKey,
        action === "request" ? "review.request" : "review.change",
        request,
        now,
        async () =>
          action === "request"
            ? reviewResponse(
                await requestApprovalReview(target, {
                  userId: context.userId,
                  artifactId,
                  reviewers: rest.reviewers as string[],
                  requiredApprovals: rest.requiredApprovals,
                  showStatus: rest.showStatus,
                  now,
                }),
                201,
              )
            : reviewResponse(
                await changeApprovalReview(target, {
                  userId: context.userId,
                  artifactId,
                  add: rest.add,
                  remove: rest.remove,
                  requiredApprovals: rest.requiredApprovals,
                  showStatus: rest.showStatus,
                  now,
                }),
              ),
      );
      if (!outcome.ok) return outcome.result;
      const body = outcome.response.body as Body;
      if ("error" in body) return failure(body.error.code, body.error.message);
      return success(describe(body), body);
    },
  );

  register(
    "submit_review",
    {
      title: "Submit a review verdict",
      description:
        "Give the signed-in user's verdict on the version under review of an artifact they were asked to review: approve, or changes to request changes, with an optional short note (plain text, at most 1000 characters). It is the user's own judgment in their name: never decide it yourself, always ask the user which verdict to give and what the note says before calling it. The user can change their verdict while the version is current. Only requested reviewers can call it; anyone else gets forbidden. Pass versionId from get_review_status so a newer version is never approved by mistake, and the same idempotencyKey when you retry. " +
        UNTRUSTED_APPROVAL_NOTES,
      inputSchema: SubmitReviewToolInput,
      outputSchema: ApprovalReviewView,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args: SubmitReviewToolInput) => {
      const { idempotencyKey, artifactId, ...request } = args;
      const now = context.now();
      const outcome = await once(
        db,
        context,
        idempotencyKey,
        "review.verdict",
        { artifactId, ...request },
        now,
        async () =>
          reviewResponse(
            await submitApprovalVerdict(await artifactDb(context.env, artifactId), {
              userId: context.userId,
              artifactId,
              verdict: request.verdict,
              note: request.note,
              versionId: request.versionId,
              now,
            }),
          ),
      );
      if (!outcome.ok) return outcome.result;
      const body = outcome.response.body as Body;
      if ("error" in body) return failure(body.error.code, body.error.message);
      return success(describe(body), body);
    },
  );

  register(
    "get_review_status",
    {
      title: "Get the review status",
      description:
        "Get the approval review of an artifact: its status on the current version (none, pending, changes_requested or approved) with counts, and, for the owner side and the reviewers, the request with the reviewers' verdicts and notes the caller may see (role says which: owner, reviewer or reader; readers see only the status, and only when the request shows it). The owner side also gets earlier versions' verdicts as history. " +
        UNTRUSTED_APPROVAL_NOTES,
      inputSchema: GetReviewStatusToolInput,
      outputSchema: ApprovalReviewView,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ artifactId }: GetReviewStatusToolInput) => {
      const result = await getApprovalReview(await artifactDb(context.env, artifactId), {
        userId: context.userId,
        artifactId,
        now: context.now(),
      });
      if (!result.ok) return failure(result.code, result.message);
      const body = ApprovalReviewView.parse(result.value);
      return success(describe(body), body);
    },
  );
}
