import { describe, expect, it } from "vitest";
import { SearchContentInput } from "./mcp.ts";
import { SEARCH_LIMITS, SearchIndexPayload, SearchQuery, SearchText } from "./search.ts";

describe("content search contracts", () => {
  it("bounds the query and trims it, refusing empty and oversized ones", () => {
    expect(SearchText.parse("  roadmap  ")).toBe("roadmap");
    expect(SearchText.safeParse("   ").success).toBe(false);
    expect(SearchText.safeParse("x".repeat(SEARCH_LIMITS.queryChars)).success).toBe(true);
    expect(SearchText.safeParse("x".repeat(SEARCH_LIMITS.queryChars + 1)).success).toBe(false);
  });

  it("pages by the API's limits, with the default when none is named", () => {
    expect(SearchQuery.parse({ q: "x" })).toEqual({ q: "x", limit: SEARCH_LIMITS.pageDefault });
    expect(SearchQuery.parse({ q: "x", limit: "50", cursor: "c" })).toEqual({
      q: "x",
      limit: 50,
      cursor: "c",
    });
    for (const limit of ["0", "51", "1.5", "x"]) {
      expect(SearchQuery.safeParse({ q: "x", limit }).success, limit).toBe(false);
    }
    expect(SearchContentInput.parse({ query: "x" })).toEqual({
      query: "x",
      limit: SEARCH_LIMITS.pageDefault,
    });
    expect(SearchContentInput.safeParse({ query: "x", workspace: "Not A Slug" }).success).toBe(
      false,
    );
  });

  it("keeps the caps in order and the job's payload strict", () => {
    expect(SEARCH_LIMITS.fileTextBytes).toBeLessThanOrEqual(SEARCH_LIMITS.versionTextBytes);
    expect(SEARCH_LIMITS.versionTextBytes).toBeLessThanOrEqual(SEARCH_LIMITS.ownerTextBytes);
    expect(SEARCH_LIMITS.fileTextBytes).toBeLessThanOrEqual(SEARCH_LIMITS.fileReadBytes);
    expect(SearchIndexPayload.parse({ versionId: "ver_1" })).toEqual({ versionId: "ver_1" });
    expect(SearchIndexPayload.safeParse({ versionId: "ver_1", extra: 1 }).success).toBe(false);
  });
});
