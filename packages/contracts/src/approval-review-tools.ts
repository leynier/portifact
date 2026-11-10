// MCP inputs of approval reviews (decision 0013): the API's bodies plus the artifact. Kept apart
// from approval-reviews.ts, which the audit catalog imports, so it does not import publishing.
import { z } from "zod";
import { APPROVALS, ApprovalNote, ApprovalVerdict, RequiredApprovals } from "./approval-reviews.ts";
import { ArtifactId, Email } from "./core.ts";
import { IdempotencyKey } from "./publishing.ts";

// MCP inputs, the same shapes as the API's bodies plus the artifact.

const idempotencyKey = IdempotencyKey.describe(
  "A unique key for this change; pass the same key again when you retry, so it is not applied twice.",
);

export const RequestReviewToolInput = z.strictObject({
  artifactId: ArtifactId,
  /** `request` (the default) starts one, `change` changes the open one, `cancel` cancels it. */
  action: z.enum(["request", "change", "cancel"]).optional(),
  reviewers: z.array(Email).max(APPROVALS.reviewersPerRequest).optional(),
  add: z.array(Email).max(APPROVALS.reviewersPerRequest).optional(),
  remove: z.array(Email).max(APPROVALS.reviewersPerRequest).optional(),
  requiredApprovals: RequiredApprovals.nullable().optional(),
  showStatus: z.boolean().optional(),
  idempotencyKey: idempotencyKey.optional(),
});
export type RequestReviewToolInput = z.infer<typeof RequestReviewToolInput>;

export const SubmitReviewToolInput = z.strictObject({
  artifactId: ArtifactId,
  verdict: ApprovalVerdict,
  note: ApprovalNote.optional(),
  versionId: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "The version you showed the user, from get_review_status; refused once another is current.",
    ),
  idempotencyKey,
});
export type SubmitReviewToolInput = z.infer<typeof SubmitReviewToolInput>;

export const GetReviewStatusToolInput = z.strictObject({ artifactId: ArtifactId });
export type GetReviewStatusToolInput = z.infer<typeof GetReviewStatusToolInput>;
