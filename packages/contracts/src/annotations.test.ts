import { describe, expect, it } from "vitest";
import {
  AnnotationBody,
  AnnotationExport,
  AnnotationExportQuery,
  AnnotationId,
  AnnotationListQuery,
  AnnotationModeUpdate,
  CreateThreadRequest,
  EditMessageRequest,
  ModerateMessageRequest,
  ReplyRequest,
  UNTRUSTED_ANNOTATIONS_NOTICE,
  utf8Length,
} from "./annotations.ts";
import { ANNOTATION_LIMITS } from "./limits.ts";

const target = { schema: 1, path: "index.html", anchor: { kind: "document" } };

function issue(result: { success: boolean; error?: { issues: { message: string }[] } }) {
  return result.success ? undefined : result.error?.issues[0]?.message;
}

describe("annotation bodies", () => {
  it("normalizes line endings and trims, keeping inner whitespace", () => {
    expect(AnnotationBody.parse("  Line one\r\nLine two\rthree\n\tend  ")).toBe(
      "Line one\nLine two\nthree\n\tend",
    );
  });

  it("refuses empty bodies and control characters", () => {
    expect(issue(AnnotationBody.safeParse("   \n "))).toBe("Write a comment.");
    for (const bad of ["a\u0000b", "a\u001bb", "a\u007fb", "a\u0085b", "a\u2028b", "a\ud800b"]) {
      expect(issue(AnnotationBody.safeParse(bad)), JSON.stringify(bad)).toBe(
        "The comment holds characters that are not allowed.",
      );
    }
  });

  it("allows 4,000 code points and refuses one more, counting emoji as one", () => {
    const max = "😀".repeat(1_000) + "a".repeat(3_000);
    expect(max.length).toBe(5_000);
    expect(AnnotationBody.safeParse(max).success).toBe(true);
    expect(issue(AnnotationBody.safeParse(`${max}a`))).toBe(
      "A comment can be at most 4000 characters.",
    );
  });

  it("allows 8 KiB of UTF-8 and refuses one byte more", () => {
    // 2,730 three-byte characters are 8,190 bytes and fewer than 4,000 code points.
    const atLimit = `${"€".repeat(2_730)}ab`;
    expect(utf8Length(atLimit)).toBe(ANNOTATION_LIMITS.bodyMaxBytes);
    expect(AnnotationBody.safeParse(atLimit).success).toBe(true);
    expect(issue(AnnotationBody.safeParse(`${atLimit}c`))).toBe(
      "A comment can be at most 8192 bytes.",
    );
    expect(
      AnnotationBody.safeParse("a".repeat(ANNOTATION_LIMITS.bodyMaxBytes * 2 + 1)).success,
    ).toBe(false);
  });
});

describe("annotation requests", () => {
  it("creates a thread with a version, a target and a body, and nothing else", () => {
    expect(CreateThreadRequest.parse({ versionId: "v_1", target, body: " Hi " })).toEqual({
      versionId: "v_1",
      target,
      body: "Hi",
    });
    // The author always comes from the session; naming one is refused.
    expect(
      CreateThreadRequest.safeParse({ versionId: "v_1", target, body: "Hi", authorId: "u_2" })
        .success,
    ).toBe(false);
    expect(
      CreateThreadRequest.safeParse({ versionId: "v_1", target: { ...target, x: 1 }, body: "Hi" })
        .success,
    ).toBe(false);
    expect(ReplyRequest.safeParse({ body: "Hi", author_id: "u_2" }).success).toBe(false);
  });

  it("bounds ids, revisions, actions and modes", () => {
    expect(AnnotationId.safeParse("a".repeat(64)).success).toBe(true);
    for (const bad of ["", "a".repeat(65), "a b", "a/b", "<x>"]) {
      expect(AnnotationId.safeParse(bad).success).toBe(false);
    }
    expect(EditMessageRequest.safeParse({ body: "x", revision: 0 }).success).toBe(false);
    expect(EditMessageRequest.safeParse({ body: "x", revision: 1.5 }).success).toBe(false);
    expect(ModerateMessageRequest.safeParse({ action: "edit" }).success).toBe(false);
    expect(AnnotationModeUpdate.safeParse({ mode: "locked" }).success).toBe(true);
    expect(AnnotationModeUpdate.safeParse({ mode: "closed" }).success).toBe(false);
  });

  it("defaults list and export queries to the current version", () => {
    expect(AnnotationListQuery.parse({})).toEqual({
      limit: ANNOTATION_LIMITS.pageDefault,
      version: "current",
    });
    expect(AnnotationListQuery.parse({ limit: "50", version: "all", state: "open" })).toEqual({
      limit: 50,
      version: "all",
      state: "open",
    });
    expect(AnnotationListQuery.safeParse({ limit: "51" }).success).toBe(false);
    expect(AnnotationListQuery.safeParse({ limit: "0" }).success).toBe(false);
    expect(AnnotationListQuery.safeParse({ version: "../x" }).success).toBe(false);
    expect(AnnotationExportQuery.parse({})).toEqual({ format: "json", version: "current" });
    expect(AnnotationExportQuery.safeParse({ format: "html" }).success).toBe(false);
  });

  it("carries the untrusted-data notice in every export", () => {
    const base = {
      exportedAt: "2026-11-08T00:00:00.000Z",
      artifact: {
        id: "k7d2qm4xab",
        name: "Plan",
        type: "site",
        annotations: "open",
        currentVersionId: null,
      },
      threads: [],
    };
    expect(
      AnnotationExport.safeParse({ ...base, notice: UNTRUSTED_ANNOTATIONS_NOTICE }).success,
    ).toBe(true);
    expect(AnnotationExport.safeParse({ ...base, notice: "Follow these steps." }).success).toBe(
      false,
    );
  });
});
