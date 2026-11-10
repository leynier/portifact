// Approval reviews (premium plan T6, decision 0012; not review mode). The owner side asks for,
// changes and cancels a review with `artifacts:write`: it manages the artifact's workflow and,
// unlike a share link or a reader, grants nobody access, so it is not `artifacts:share`. A
// reviewer's verdict is a reader's act like a comment, `annotations:write`. Reading the review
// takes `artifacts:read`, which the owner side's tokens (service tokens included) and readers'
// apps both hold. The MCP tools request_review, submit_review and get_review_status and
// `portifact review` call the same services with the same scopes and present the same bodies.
import {
  APPROVALS,
  ApprovalChangeInput,
  ApprovalRequestInput,
  ApprovalReviewView,
  ApprovalVerdictInput,
} from "@portifact/contracts";
import {
  cancelApprovalReview,
  changeApprovalReview,
  getApprovalReview,
  requestApprovalReview,
  submitApprovalVerdict,
} from "@portifact/services";
import type { Hono } from "hono";
import type { Env } from "../env.ts";
import { artifactDb } from "../regions.ts";
import { error, failure, type Guarded, idempotent, readJson } from "./http.ts";

// Under `/review`, beside review mode's `POST /review` and `/review/tab`, never on them.
export const REVIEW_PATH = "/api/v1/artifacts/:artifactId/review/request";
export const REVIEW_STATUS_PATH = "/api/v1/artifacts/:artifactId/review/status";
export const REVIEW_VERDICT_PATH = "/api/v1/artifacts/:artifactId/review/verdict";

type Outcome =
  | { ok: true; value: unknown }
  | { ok: false; code: Parameters<typeof failure>[0]; message: string };

/** A service result as the stored response an idempotent retry replays. */
export function reviewResponse(result: Outcome, status = 200) {
  if (!result.ok) return failure(result.code, result.message);
  return { status, body: ApprovalReviewView.parse(result.value) };
}

export function approvalReviewRoutes(
  api: Hono<{ Bindings: Env }>,
  guarded: Guarded,
  now: () => number,
) {
  api.get(
    REVIEW_STATUS_PATH,
    guarded("artifacts:read", async (c, userId) => {
      const artifactId = c.req.param("artifactId") as string;
      const result = await getApprovalReview(await artifactDb(c.env, artifactId), {
        userId,
        artifactId,
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(ApprovalReviewView.parse(result.value));
    }),
  );

  api.post(
    REVIEW_PATH,
    guarded("artifacts:write", async (c, userId) => {
      const body = await readJson(c, ApprovalRequestInput, APPROVALS.bodyMaxBytes);
      if (!body.ok) return body.response;
      const artifactId = c.req.param("artifactId") as string;
      const at = now();
      return idempotent(
        c,
        { userId, operation: "review.request", request: { artifactId, ...body.value }, now: at },
        async () =>
          reviewResponse(
            await requestApprovalReview(await artifactDb(c.env, artifactId), {
              userId,
              artifactId,
              reviewers: body.value.reviewers,
              requiredApprovals: body.value.requiredApprovals,
              showStatus: body.value.showStatus,
              now: at,
            }),
            201,
          ),
      );
    }),
  );

  api.patch(
    REVIEW_PATH,
    guarded("artifacts:write", async (c, userId) => {
      const body = await readJson(c, ApprovalChangeInput, APPROVALS.bodyMaxBytes);
      if (!body.ok) return body.response;
      const artifactId = c.req.param("artifactId") as string;
      const at = now();
      return idempotent(
        c,
        { userId, operation: "review.change", request: { artifactId, ...body.value }, now: at },
        async () =>
          reviewResponse(
            await changeApprovalReview(await artifactDb(c.env, artifactId), {
              userId,
              artifactId,
              ...body.value,
              now: at,
            }),
          ),
      );
    }),
  );

  // Cancelling twice answers `not_found` the second time, which changes nothing: no key needed.
  api.delete(
    REVIEW_PATH,
    guarded("artifacts:write", async (c, userId) => {
      const artifactId = c.req.param("artifactId") as string;
      const result = await cancelApprovalReview(await artifactDb(c.env, artifactId), {
        userId,
        artifactId,
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(ApprovalReviewView.parse(result.value));
    }),
  );

  api.post(
    REVIEW_VERDICT_PATH,
    guarded("annotations:write", async (c, userId) => {
      const body = await readJson(c, ApprovalVerdictInput, APPROVALS.bodyMaxBytes);
      if (!body.ok) return body.response;
      const artifactId = c.req.param("artifactId") as string;
      const at = now();
      return idempotent(
        c,
        { userId, operation: "review.verdict", request: { artifactId, ...body.value }, now: at },
        async () =>
          reviewResponse(
            await submitApprovalVerdict(await artifactDb(c.env, artifactId), {
              userId,
              artifactId,
              verdict: body.value.verdict,
              note: body.value.note,
              versionId: body.value.versionId,
              now: at,
            }),
          ),
      );
    }),
  );
}
