import { describe, expect, it } from "vitest";
import { FeedbackQuery, ListOpenFeedbackInput } from "./feedback.ts";
import { FEEDBACK_LIMITS } from "./limits.ts";

describe("FeedbackQuery", () => {
  it("defaults the page size and leaves the filters out", () => {
    expect(FeedbackQuery.parse({})).toEqual({ limit: FEEDBACK_LIMITS.pageDefault });
  });

  it("reads the query string's values", () => {
    expect(
      FeedbackQuery.parse({ limit: "5", since: "2026-11-01T00:00:00Z", mine: "true" }),
    ).toEqual({ limit: 5, since: "2026-11-01T00:00:00Z", mine: true });
    expect(FeedbackQuery.parse({ mine: "false" }).mine).toBe(false);
  });

  it("caps the page size and refuses what it does not know", () => {
    expect(FeedbackQuery.safeParse({ limit: String(FEEDBACK_LIMITS.pageMax + 1) }).success).toBe(
      false,
    );
    expect(FeedbackQuery.safeParse({ limit: "0" }).success).toBe(false);
    expect(FeedbackQuery.safeParse({ mine: "yes" }).success).toBe(false);
    expect(FeedbackQuery.safeParse({ since: "yesterday" }).success).toBe(false);
    expect(FeedbackQuery.safeParse({ cursor: "x".repeat(129) }).success).toBe(false);
  });
});

describe("ListOpenFeedbackInput", () => {
  it("takes the space and the same filters", () => {
    expect(ListOpenFeedbackInput.parse({ workspace: "acme", mine: true })).toEqual({
      workspace: "acme",
      mine: true,
      limit: FEEDBACK_LIMITS.pageDefault,
    });
    expect(ListOpenFeedbackInput.safeParse({ workspace: "Not a slug!" }).success).toBe(false);
    expect(ListOpenFeedbackInput.safeParse({ limit: FEEDBACK_LIMITS.pageMax + 1 }).success).toBe(
      false,
    );
  });
});
