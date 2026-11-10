import { APPROVALS, NO_APPROVAL_REVIEW } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  APPROVAL_MESSAGES,
  type ApprovalReviewerFacts,
  approvalComplete,
  approvalEntryVisible,
  approvalStatusVisible,
  approvalSummary,
  approvalViewerRole,
  checkApprovalChange,
  checkRequestTarget,
  checkRequiredApprovals,
  checkReviewerList,
  checkVerdictTarget,
} from "./approval-reviews.ts";

const on = (verdict: ApprovalReviewerFacts["verdict"], active = true): ApprovalReviewerFacts => ({
  active,
  verdict,
});

describe("approvalSummary", () => {
  it("is none without a request, whatever the reviewers", () => {
    expect(approvalSummary(null, [on("approve")])).toEqual(NO_APPROVAL_REVIEW);
  });

  it.each([
    {
      name: "pending with no verdicts, every reviewer required",
      required: null,
      reviewers: [on(null), on(null)],
      expected: { status: "pending", reviewers: 2, required: 2, approvals: 0, changesRequested: 0 },
    },
    {
      name: "pending until every reviewer approves",
      required: null,
      reviewers: [on("approve"), on(null)],
      expected: { status: "pending", reviewers: 2, required: 2, approvals: 1, changesRequested: 0 },
    },
    {
      name: "approved when every reviewer approves",
      required: null,
      reviewers: [on("approve"), on("approve")],
      expected: {
        status: "approved",
        reviewers: 2,
        required: 2,
        approvals: 2,
        changesRequested: 0,
      },
    },
    {
      name: "approved once the required number is reached",
      required: 1,
      reviewers: [on("approve"), on(null), on(null)],
      expected: {
        status: "approved",
        reviewers: 3,
        required: 1,
        approvals: 1,
        changesRequested: 0,
      },
    },
    {
      name: "changes requested wins over approvals that are enough",
      required: 1,
      reviewers: [on("approve"), on("changes")],
      expected: {
        status: "changes_requested",
        reviewers: 2,
        required: 1,
        approvals: 1,
        changesRequested: 1,
      },
    },
    {
      name: "a reviewer who lost access no longer counts, nor does their verdict",
      required: null,
      reviewers: [on("approve"), on("changes", false), on(null, false)],
      expected: {
        status: "approved",
        reviewers: 1,
        required: 1,
        approvals: 1,
        changesRequested: 0,
      },
    },
    {
      name: "the required number never exceeds the reviewers who count",
      required: 3,
      reviewers: [on("approve"), on("approve"), on(null, false)],
      expected: {
        status: "approved",
        reviewers: 2,
        required: 2,
        approvals: 2,
        changesRequested: 0,
      },
    },
    {
      name: "stays pending when nobody counts any more",
      required: 2,
      reviewers: [on("approve", false), on(null, false)],
      expected: { status: "pending", reviewers: 0, required: 1, approvals: 0, changesRequested: 0 },
    },
  ] as const)("$name", ({ required, reviewers, expected }) => {
    expect(approvalSummary({ required }, reviewers)).toEqual(expected);
  });
});

describe("approvalComplete", () => {
  it.each([
    ["approved", true],
    ["changes_requested", true],
    ["pending", false],
    ["none", false],
  ] as const)("%s → %s", (status, complete) => {
    expect(approvalComplete(status)).toBe(complete);
  });
});

describe("checkReviewerList", () => {
  it("lowercases and removes repeats", () => {
    expect(checkReviewerList(["A@x.org", "a@x.org", "b@x.org "])).toEqual({
      ok: true,
      value: ["a@x.org", "b@x.org"],
    });
  });

  it("refuses an empty list and one over the cap", () => {
    expect(checkReviewerList([])).toMatchObject({ ok: false, message: APPROVAL_MESSAGES.empty });
    const many = Array.from({ length: APPROVALS.reviewersPerRequest + 1 }, (_, i) => `p${i}@x.org`);
    expect(checkReviewerList(many)).toMatchObject({ ok: false, code: "invalid_input" });
    expect(checkReviewerList(many.slice(1)).ok).toBe(true);
  });
});

describe("checkRequiredApprovals", () => {
  it.each([
    [null, 3, true],
    [1, 3, true],
    [3, 3, true],
    [4, 3, false],
    [0, 3, false],
    [1.5, 3, false],
  ] as const)("%s of %s → %s", (required, reviewers, allowed) => {
    expect(checkRequiredApprovals(required, reviewers).ok).toBe(allowed);
  });
});

describe("checkApprovalChange", () => {
  const current = ["a@x.org", "b@x.org"];

  it("adds and removes, keeping the order", () => {
    expect(
      checkApprovalChange({ current, required: null, add: ["C@x.org"], remove: ["a@x.org"] }),
    ).toEqual({
      ok: true,
      value: {
        reviewers: ["b@x.org", "c@x.org"],
        added: ["c@x.org"],
        removed: ["a@x.org"],
        required: null,
      },
    });
  });

  it("refuses adding someone listed and removing someone who is not", () => {
    expect(checkApprovalChange({ current, required: null, add: ["a@x.org"] })).toMatchObject({
      ok: false,
      message: APPROVAL_MESSAGES.alreadyListed("a@x.org"),
    });
    expect(checkApprovalChange({ current, required: null, remove: ["z@x.org"] })).toMatchObject({
      ok: false,
      message: APPROVAL_MESSAGES.notListed("z@x.org"),
    });
  });

  it("refuses removing everyone and going over the cap", () => {
    expect(
      checkApprovalChange({ current, required: null, remove: ["a@x.org", "b@x.org"] }),
    ).toMatchObject({ ok: false, message: APPROVAL_MESSAGES.empty });
    const add = Array.from({ length: APPROVALS.reviewersPerRequest - 1 }, (_, i) => `n${i}@x.org`);
    expect(checkApprovalChange({ current, required: null, add })).toMatchObject({
      ok: false,
      message: APPROVAL_MESSAGES.tooMany,
    });
  });

  it("keeps a number that still fits and drops one that no longer does", () => {
    expect(checkApprovalChange({ current, required: 1, remove: ["a@x.org"] })).toMatchObject({
      ok: true,
      value: { required: 1 },
    });
    expect(checkApprovalChange({ current, required: 2, remove: ["a@x.org"] })).toMatchObject({
      ok: true,
      value: { required: null },
    });
  });

  it("checks a new number against the reviewers after the change", () => {
    expect(checkApprovalChange({ current, required: null, newRequired: 2 })).toMatchObject({
      ok: true,
      value: { required: 2, added: [], removed: [] },
    });
    expect(checkApprovalChange({ current, required: null, newRequired: 3 }).ok).toBe(false);
    expect(checkApprovalChange({ current, required: 2, newRequired: null })).toMatchObject({
      ok: true,
      value: { required: null },
    });
  });
});

describe("checkVerdictTarget and checkRequestTarget", () => {
  it.each([
    { state: "active", current: "v2", request: "v2", seen: undefined, result: "ok" },
    { state: "active", current: "v2", request: "v2", seen: "v2", result: "ok" },
    { state: "active", current: "v3", request: "v2", seen: undefined, result: "version_conflict" },
    { state: "active", current: "v2", request: "v2", seen: "v1", result: "version_conflict" },
    { state: "active", current: null, request: "v2", seen: undefined, result: "version_conflict" },
    { state: "archived", current: "v2", request: "v2", seen: undefined, result: "forbidden" },
    { state: "suspended", current: "v2", request: "v2", seen: undefined, result: "forbidden" },
  ] as const)(
    "verdict on $state, current $current, request $request, seen $seen → $result",
    (row) => {
      const result = checkVerdictTarget({
        state: row.state,
        currentVersionId: row.current,
        requestVersionId: row.request,
        seenVersionId: row.seen,
      });
      expect(result.ok ? "ok" : result.code).toBe(row.result);
    },
  );

  it.each([
    ["active", "v1", "ok"],
    ["active", null, "invalid_input"],
    ["archived", "v1", "forbidden"],
    ["suspended", "v1", "forbidden"],
  ] as const)("request on %s with %s → %s", (state, current, expected) => {
    const result = checkRequestTarget({ state, currentVersionId: current });
    expect(result.ok ? "ok" : result.code).toBe(expected);
  });
});

describe("who sees what", () => {
  it.each([
    [null, false, null],
    [null, true, null],
    ["owner", false, "owner"],
    ["owner", true, "owner"],
    ["participant", true, "reviewer"],
    ["participant", false, "reader"],
  ] as const)("role %s, listed %s → %s", (role, listed, expected) => {
    expect(approvalViewerRole({ role, listed })).toBe(expected);
  });

  const base = { viewerId: "me", ownerSide: ["boss"] };
  it.each([
    { role: "owner", scope: "own", reviewerId: "other", visible: true },
    { role: "owner", scope: "own", reviewerId: null, visible: true },
    { role: "reviewer", scope: "all", reviewerId: "other", visible: true },
    { role: "reviewer", scope: "all", reviewerId: null, visible: true },
    { role: "reviewer", scope: "own", reviewerId: "other", visible: false },
    { role: "reviewer", scope: "own", reviewerId: null, visible: false },
    { role: "reviewer", scope: "own", reviewerId: "me", visible: true },
    { role: "reviewer", scope: "own", reviewerId: "boss", visible: true },
    { role: "reader", scope: "all", reviewerId: "other", visible: false },
    { role: "reader", scope: "all", reviewerId: "me", visible: false },
  ] as const)(
    "$role with $scope sees $reviewerId: $visible",
    ({ role, scope, reviewerId, visible }) => {
      expect(approvalEntryVisible({ ...base, role, scope, reviewerId })).toBe(visible);
    },
  );

  it.each([
    ["owner", false, true],
    ["reviewer", false, true],
    ["reader", false, false],
    ["reader", true, true],
  ] as const)("%s with showStatus %s sees the status: %s", (role, show, visible) => {
    expect(approvalStatusVisible(role, show)).toBe(visible);
  });
});
