import { describe, expect, it } from "vitest";
import { SubmitReviewToolInput } from "./approval-review-tools.ts";
import {
  APPROVALS,
  ApprovalChangeInput,
  ApprovalNote,
  ApprovalRequestInput,
  ApprovalVerdictInput,
} from "./approval-reviews.ts";

describe("approval review contracts", () => {
  it("normalizes a note and refuses control characters and oversized ones", () => {
    expect(ApprovalNote.parse("  Fix it\r\nplease  ")).toBe("Fix it\nplease");
    expect(ApprovalNote.safeParse("bad\u0007bell").success).toBe(false);
    expect(ApprovalNote.safeParse("x".repeat(APPROVALS.noteMaxCodePoints)).success).toBe(true);
    expect(ApprovalNote.safeParse("x".repeat(APPROVALS.noteMaxCodePoints + 1)).success).toBe(false);
    expect(ApprovalNote.safeParse("é".repeat(APPROVALS.noteMaxCodePoints)).success).toBe(true);
    expect(ApprovalNote.safeParse("😀".repeat(APPROVALS.noteMaxCodePoints)).success).toBe(true);
    expect(ApprovalNote.safeParse("\ud800").success).toBe(false);
  });

  it("bounds the reviewers and the required number, and lowercases addresses", () => {
    expect(ApprovalRequestInput.parse({ reviewers: ["Ana@Example.com"] }).reviewers).toEqual([
      "ana@example.com",
    ]);
    expect(ApprovalRequestInput.safeParse({ reviewers: [] }).success).toBe(false);
    expect(
      ApprovalRequestInput.safeParse({ reviewers: ["a@x.org"], requiredApprovals: 0 }).success,
    ).toBe(false);
    expect(ApprovalRequestInput.safeParse({ reviewers: ["a@x.org"], extra: 1 }).success).toBe(
      false,
    );
    const many = Array.from({ length: APPROVALS.reviewersPerRequest + 1 }, (_, i) => `p${i}@x.org`);
    expect(ApprovalRequestInput.safeParse({ reviewers: many }).success).toBe(false);
  });

  it("needs a change to say what changes", () => {
    expect(ApprovalChangeInput.safeParse({}).success).toBe(false);
    expect(ApprovalChangeInput.safeParse({ add: [] }).success).toBe(false);
    expect(ApprovalChangeInput.safeParse({ showStatus: false }).success).toBe(true);
    expect(ApprovalChangeInput.safeParse({ requiredApprovals: null }).success).toBe(true);
    expect(ApprovalChangeInput.safeParse({ remove: ["a@x.org"] }).success).toBe(true);
  });

  it("takes a verdict, an optional note and version, and the tool needs a key", () => {
    expect(ApprovalVerdictInput.parse({ verdict: "approve" })).toEqual({ verdict: "approve" });
    expect(ApprovalVerdictInput.safeParse({ verdict: "maybe" }).success).toBe(false);
    expect(
      SubmitReviewToolInput.safeParse({ artifactId: "k7d2qm4xab", verdict: "changes" }).success,
    ).toBe(false);
  });
});
