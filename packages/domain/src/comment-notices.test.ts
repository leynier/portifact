import { lowestPlanWith, PLANS } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import { reviewNoticesOn } from "./approval-reviews.ts";
import {
  activityCounts,
  COMMENT_NOTICE,
  COMMENT_NOTICE_FEATURE,
  commentNoticeDue,
  commentNoticeRecipients,
  commentNoticeSettledBefore,
  groupActivity,
  type ThreadActivity,
  unsubscribeUsable,
} from "./comment-notices.ts";
import {
  COMMENT_NOTICE_EMAIL_RESERVE,
  COMMENT_NOTICE_EMAILS_PER_CYCLE,
  checkCommentNoticeCapacity,
  checkReviewNoticeCapacity,
  NOTICE_EMAILS_PER_CYCLE,
  REVIEW_NOTICE_EMAIL_RESERVE,
  REVIEW_NOTICE_EMAILS_PER_CYCLE,
  SIGN_IN_EMAILS_PER_CYCLE,
} from "./email.ts";
import { entitlements } from "./plans.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const NOW = Date.UTC(2026, 10, 9, 12);

describe("COMMENT_NOTICE", () => {
  it("settles ten minutes, lists twenty artifacts and keeps links for sixty days", () => {
    expect(COMMENT_NOTICE.windowMs).toBe(10 * MINUTE);
    expect(COMMENT_NOTICE.recipientsPerRun).toBe(25);
    expect(COMMENT_NOTICE.artifactsListed).toBe(20);
    expect(COMMENT_NOTICE.unsubscribeTtlMs).toBe(60 * DAY);
  });

  it("is a Pro feature, not a free one", () => {
    expect(COMMENT_NOTICE_FEATURE).toBe("commentNotices");
    expect(PLANS.free.features).not.toContain(COMMENT_NOTICE_FEATURE);
    expect(lowestPlanWith(COMMENT_NOTICE_FEATURE)).toBe("pro");
  });
});

describe("activityCounts", () => {
  it("counts a new thread, a reply or a resolution", () => {
    expect(activityCounts("thread")).toEqual({ created: 1, replies: 0, resolved: 0 });
    expect(activityCounts("reply")).toEqual({ created: 0, replies: 1, resolved: 0 });
    expect(activityCounts("resolved")).toEqual({ created: 0, replies: 0, resolved: 1 });
  });
});

describe("commentNoticeRecipients", () => {
  const base = { ownerSide: ["owner", "editor"], participants: ["author", "replier", "owner"] };

  it("tells the owner side about a new thread, never its author", () => {
    expect(commentNoticeRecipients({ ...base, actorId: "author", activity: "thread" })).toEqual([
      "owner",
      "editor",
    ]);
    expect(commentNoticeRecipients({ ...base, actorId: "owner", activity: "thread" })).toEqual([
      "editor",
    ]);
  });

  it("tells the owner side and the participants about a reply or a resolution, each once", () => {
    for (const activity of ["reply", "resolved"] as const) {
      expect(commentNoticeRecipients({ ...base, actorId: "replier", activity })).toEqual([
        "owner",
        "editor",
        "author",
      ]);
    }
  });

  it("never tells the actor, whatever their role", () => {
    for (const actorId of ["owner", "editor", "author", "replier"]) {
      expect(
        commentNoticeRecipients({ ...base, actorId, activity: "reply" }).includes(actorId),
      ).toBe(false);
    }
  });
});

describe("commentNoticeDue", () => {
  it("waits until the oldest activity is ten minutes old", () => {
    expect(commentNoticeSettledBefore(NOW)).toBe(NOW - 10 * MINUTE);
    expect(commentNoticeDue(NOW - 10 * MINUTE, NOW)).toBe(true);
    expect(commentNoticeDue(NOW - 10 * MINUTE + 1, NOW)).toBe(false);
    expect(commentNoticeDue(NOW - DAY, NOW)).toBe(true);
  });
});

describe("groupActivity", () => {
  const row = (artifactId: string, threadId: string, counts: Partial<ThreadActivity> = {}) => ({
    artifactId,
    threadId,
    created: 0,
    replies: 0,
    resolved: 0,
    ...counts,
  });

  it("sums each artifact's visible threads, the most active first", () => {
    const threads = [
      row("a", "t1", { created: 1, replies: 2 }),
      row("b", "t2", { created: 1 }),
      row("a", "t3", { resolved: 1 }),
      row("b", "t4", { replies: 5 }),
      row("c", "t5", { replies: 1 }),
    ];
    expect(groupActivity(threads, () => true)).toEqual([
      { artifactId: "b", newThreads: 1, newReplies: 5, resolvedThreads: 0 },
      { artifactId: "a", newThreads: 1, newReplies: 2, resolvedThreads: 1 },
      { artifactId: "c", newThreads: 0, newReplies: 1, resolvedThreads: 0 },
    ]);
  });

  it("drops the threads the recipient does not see and artifacts left with nothing", () => {
    const threads = [
      row("a", "hidden", { created: 1 }),
      row("a", "seen", { replies: 1 }),
      row("b", "hidden-too", { created: 1 }),
    ];
    expect(groupActivity(threads, (thread) => thread.threadId === "seen")).toEqual([
      { artifactId: "a", newThreads: 0, newReplies: 1, resolvedThreads: 0 },
    ]);
    expect(groupActivity([row("z", "t")], () => true)).toEqual([]);
  });

  it("orders ties by artifact ID, whatever the order they came in", () => {
    const ids = (threads: ThreadActivity[]) =>
      groupActivity(threads, () => true).map((entry) => entry.artifactId);
    expect(ids([row("b", "t1", { replies: 1 }), row("a", "t2", { replies: 1 })])).toEqual([
      "a",
      "b",
    ]);
    expect(ids([row("a", "t2", { replies: 1 }), row("b", "t1", { replies: 1 })])).toEqual([
      "a",
      "b",
    ]);
  });

  it("counts resolutions as activity, in the order and in what is kept", () => {
    const threads = [
      row("replied", "t1", { replies: 1 }),
      row("resolved", "t2", { resolved: 1 }),
      row("resolved", "t3", { resolved: 1 }),
    ];
    expect(groupActivity(threads, () => true)).toEqual([
      { artifactId: "resolved", newThreads: 0, newReplies: 0, resolvedThreads: 2 },
      { artifactId: "replied", newThreads: 0, newReplies: 1, resolvedThreads: 0 },
    ]);
  });
});

describe("unsubscribeUsable", () => {
  it("accepts a link inside its lifetime", () => {
    expect(unsubscribeUsable(NOW - MINUTE, null, NOW)).toBe(true);
    expect(unsubscribeUsable(NOW - 60 * DAY, null, NOW)).toBe(true);
    expect(unsubscribeUsable(NOW, null, NOW)).toBe(true);
  });

  it("refuses an expired link and one from the future", () => {
    expect(unsubscribeUsable(NOW - 60 * DAY - 1, null, NOW)).toBe(false);
    expect(unsubscribeUsable(NOW + 1, null, NOW)).toBe(false);
  });

  it("refuses a link issued before the preference last changed", () => {
    expect(unsubscribeUsable(NOW - DAY, NOW - MINUTE, NOW)).toBe(false);
    expect(unsubscribeUsable(NOW - DAY, NOW - DAY, NOW)).toBe(false);
    expect(unsubscribeUsable(NOW - MINUTE, NOW - DAY, NOW)).toBe(true);
  });
});

describe("checkCommentNoticeCapacity", () => {
  it("stops comment notices before expiry notices, and those before sign-in codes", () => {
    expect(COMMENT_NOTICE_EMAILS_PER_CYCLE).toBe(
      NOTICE_EMAILS_PER_CYCLE - COMMENT_NOTICE_EMAIL_RESERVE,
    );
    expect(COMMENT_NOTICE_EMAIL_RESERVE).toBe(5_000);
    expect(SIGN_IN_EMAILS_PER_CYCLE - COMMENT_NOTICE_EMAILS_PER_CYCLE).toBe(10_000);
    expect(checkCommentNoticeCapacity(COMMENT_NOTICE_EMAILS_PER_CYCLE - 1)).toEqual({
      ok: true,
      value: true,
    });
    expect(checkCommentNoticeCapacity(COMMENT_NOTICE_EMAILS_PER_CYCLE)).toEqual({
      ok: false,
      code: "capacity_unavailable",
      message: "Comment notices are paused until the next cycle.",
    });
  });
});

describe("checkReviewNoticeCapacity", () => {
  it("stops review notices first, 5,000 emails before comment notices", () => {
    expect(REVIEW_NOTICE_EMAIL_RESERVE).toBe(5_000);
    expect(REVIEW_NOTICE_EMAILS_PER_CYCLE).toBe(COMMENT_NOTICE_EMAILS_PER_CYCLE - 5_000);
    expect(REVIEW_NOTICE_EMAILS_PER_CYCLE).toBe(4_900);
    expect(SIGN_IN_EMAILS_PER_CYCLE - REVIEW_NOTICE_EMAILS_PER_CYCLE).toBe(15_000);
    expect(checkReviewNoticeCapacity(REVIEW_NOTICE_EMAILS_PER_CYCLE - 1)).toEqual({
      ok: true,
      value: true,
    });
    expect(checkReviewNoticeCapacity(REVIEW_NOTICE_EMAILS_PER_CYCLE)).toEqual({
      ok: false,
      code: "capacity_unavailable",
      message: "Review notices are paused until the next cycle.",
    });
  });
});

describe("reviewNoticesOn", () => {
  it("needs both reviews and comment notices in the owner's plan", () => {
    const now = Date.UTC(2026, 10, 10);
    const plan = (name: string, overrides: unknown = null) =>
      entitlements({ plan: name, seats: 1, validUntil: null, overrides }, now);
    expect(reviewNoticesOn(plan("team"))).toBe(true);
    expect(reviewNoticesOn(plan("pro"))).toBe(false);
    expect(reviewNoticesOn(plan("team", { features: { commentNotices: false } }))).toBe(false);
    expect(reviewNoticesOn(plan("free"))).toBe(false);
  });
});
