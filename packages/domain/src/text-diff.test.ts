import { VERSION_DIFF } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  type DiffHunk,
  decodeUtf8,
  diffText,
  pageHunks,
  splitLines,
  textDiffEligibility,
  unifiedDiff,
} from "./text-diff.ts";

const LABELS = { before: "a/index.md (v1)", after: "b/index.md (v2)" };

/** The diff of two texts as a unified diff, or the reason there is none. */
function unified(before: string, after: string, limits = VERSION_DIFF): string {
  const diff = diffText(before, after, limits);
  return diff.status === "text" ? unifiedDiff(diff.hunks, LABELS) : diff.status;
}

describe("splitLines", () => {
  it.each([
    ["", []],
    ["a", [{ text: "a", noNewline: true }]],
    ["a\n", [{ text: "a", noNewline: false }]],
    [
      "a\nb",
      [
        { text: "a", noNewline: false },
        { text: "b", noNewline: true },
      ],
    ],
    [
      "a\n\n",
      [
        { text: "a", noNewline: false },
        { text: "", noNewline: false },
      ],
    ],
    ["\r\n", [{ text: "\r", noNewline: false }]],
  ])("splits %j", (text, lines) => {
    expect(splitLines(text)).toEqual(lines);
  });
});

describe("decodeUtf8", () => {
  it("decodes valid UTF-8, keeping a byte order mark", () => {
    expect(decodeUtf8(new TextEncoder().encode("héllo ✓"))).toBe("héllo ✓");
    expect(decodeUtf8(Uint8Array.of(0xef, 0xbb, 0xbf, 0x61))).toBe("﻿a");
  });

  it("refuses invalid UTF-8", () => {
    expect(decodeUtf8(Uint8Array.of(0x61, 0xff, 0x62))).toBeNull();
    expect(decodeUtf8(Uint8Array.of(0xe2, 0x82))).toBeNull();
  });
});

describe("textDiffEligibility", () => {
  it("diffs text types up to the size cap, including a missing side", () => {
    expect(textDiffEligibility(null)).toBe("text");
    expect(textDiffEligibility({ contentType: "text/markdown; charset=utf-8", size: 10 })).toBe(
      "text",
    );
    expect(
      textDiffEligibility({ contentType: "application/json", size: VERSION_DIFF.fileBytes }),
    ).toBe("text");
    expect(
      textDiffEligibility({ contentType: "text/html", size: VERSION_DIFF.fileBytes + 1 }),
    ).toBe("too_large");
    expect(textDiffEligibility({ contentType: "image/png", size: 10 })).toBe("binary");
    expect(textDiffEligibility({ contentType: "text/plain", size: 11 }, 10)).toBe("too_large");
    expect(textDiffEligibility({ contentType: "text/plain", size: 10 }, 10)).toBe("text");
  });
});

describe("diffText", () => {
  const table: [string, string, string, string][] = [
    ["identical texts", "a\nb\n", "a\nb\n", ""],
    ["both empty", "", "", ""],
    [
      "a file created",
      "",
      "a\nb\n",
      "--- a/index.md (v1)\n+++ b/index.md (v2)\n@@ -0,0 +1,2 @@\n+a\n+b\n",
    ],
    ["a file emptied", "a\n", "", "--- a/index.md (v1)\n+++ b/index.md (v2)\n@@ -1 +0,0 @@\n-a\n"],
    [
      "one line changed",
      "a\nb\nc\n",
      "a\nB\nc\n",
      "--- a/index.md (v1)\n+++ b/index.md (v2)\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n",
    ],
    [
      "a line appended",
      "a\n",
      "a\nb\n",
      "--- a/index.md (v1)\n+++ b/index.md (v2)\n@@ -1 +1,2 @@\n a\n+b\n",
    ],
    [
      "a line inserted first",
      "b\n",
      "a\nb\n",
      "--- a/index.md (v1)\n+++ b/index.md (v2)\n@@ -1 +1,2 @@\n+a\n b\n",
    ],
    [
      "the final line break removed",
      "a\nb\n",
      "a\nb",
      "--- a/index.md (v1)\n+++ b/index.md (v2)\n@@ -1,2 +1,2 @@\n a\n-b\n+b\n\\ No newline at end of file\n",
    ],
    [
      "line endings changed",
      "a\n",
      "a\r\n",
      "--- a/index.md (v1)\n+++ b/index.md (v2)\n@@ -1 +1 @@\n-a\n+a\r\n",
    ],
  ];
  it.each(table)("%s", (_label, before, after, expected) => {
    expect(unified(before, after)).toBe(expected);
  });

  it("counts added and removed lines and numbers them on each side", () => {
    const diff = diffText("a\nb\nc\nd\n", "a\nc\nd\ne\n");
    expect(diff).toMatchObject({ status: "text", added: 1, removed: 1 });
    if (diff.status !== "text") throw new Error("expected a text diff");
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]?.lines).toEqual([
      { type: "context", text: "a", before: 1, after: 1, noNewline: false },
      { type: "removed", text: "b", before: 2, after: null, noNewline: false },
      { type: "context", text: "c", before: 3, after: 2, noNewline: false },
      { type: "context", text: "d", before: 4, after: 3, noNewline: false },
      { type: "added", text: "e", before: null, after: 4, noNewline: false },
    ]);
  });

  it("splits changes far apart into hunks with three lines of context, and merges near ones", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const far = [...lines];
    far[1] = "changed 2";
    far[20] = "changed 21";
    const diff = diffText(`${lines.join("\n")}\n`, `${far.join("\n")}\n`);
    if (diff.status !== "text") throw new Error("expected a text diff");
    expect(
      diff.hunks.map((h) => [h.beforeStart, h.beforeLines, h.afterStart, h.afterLines]),
    ).toEqual([
      [1, 5, 1, 5],
      [18, 7, 18, 7],
    ]);
    const near = [...lines];
    near[1] = "changed 2";
    near[8] = "changed 9";
    const merged = diffText(`${lines.join("\n")}\n`, `${near.join("\n")}\n`);
    if (merged.status !== "text") throw new Error("expected a text diff");
    expect(merged.hunks).toHaveLength(1);
    // Six context lines between the changes is still one hunk; seven are two.
    const seven = [...lines];
    seven[1] = "changed 2";
    seven[9] = "changed 10";
    const split = diffText(`${lines.join("\n")}\n`, `${seven.join("\n")}\n`);
    if (split.status !== "text") throw new Error("expected a text diff");
    expect(split.hunks).toHaveLength(2);
  });

  it("finds the shortest edit, not a remove and re-add of everything", () => {
    const diff = diffText("a\nb\nc\nd\ne\n", "b\nc\nX\nd\ne\nf\n");
    expect(diff).toMatchObject({ status: "text", added: 2, removed: 1 });
  });

  it("refuses sides with more lines than the cap", () => {
    const limits = { ...VERSION_DIFF, lines: 3 };
    expect(diffText("a\nb\nc\n", "a\nb\nc\nd\n", limits)).toEqual({ status: "too_many_lines" });
    expect(diffText("a\nb\nc\nd\n", "a\n", limits)).toEqual({ status: "too_many_lines" });
    expect(diffText("a\nb\nc\n", "x\ny\nz\n", limits)).toMatchObject({ status: "text" });
  });

  it("stops once more lines would change than the cap", () => {
    const limits = { ...VERSION_DIFF, changedLines: 4 };
    expect(diffText("a\nb\n", "c\nd\n", limits)).toMatchObject({
      status: "text",
      added: 2,
      removed: 2,
    });
    expect(diffText("a\nb\nc\n", "d\ne\nf\n", limits)).toEqual({ status: "too_many_changes" });
  });

  it("stays bounded in time and memory on adversarial input at the caps", () => {
    // Every line differs and the sides alternate the same two lines shifted by one, which makes
    // Myers' search explore every diagonal up to the cap of changed lines.
    const n = VERSION_DIFF.lines;
    const before = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? "a" : "b")).join("\n");
    const after = Array.from({ length: n }, (_, i) => (i % 3 === 0 ? "a" : "c")).join("\n");
    const unique = (side: string) => Array.from({ length: n }, (_, i) => `${side}${i}`).join("\n");
    const started = performance.now();
    expect(diffText(before, after).status).toBe("too_many_changes");
    expect(diffText(unique("x"), unique("y")).status).toBe("too_many_changes");
    // The worst case is O((N + M) * D) with N and M at 10,000 and D at 1,000.
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe("pageHunks", () => {
  const hunk = (lines: number): DiffHunk => ({
    beforeStart: 1,
    beforeLines: lines,
    afterStart: 1,
    afterLines: lines,
    lines: Array.from({ length: lines }, () => ({
      type: "context" as const,
      text: "",
      before: 1,
      after: 1,
      noNewline: false,
    })),
  });

  it("returns whole hunks while they fit, and where to continue", () => {
    const hunks = [hunk(3), hunk(3), hunk(3)];
    expect(pageHunks(hunks, 0, 6)).toEqual({ hunks: [hunks[0], hunks[1]], nextCursor: 2 });
    expect(pageHunks(hunks, 2, 6)).toEqual({ hunks: [hunks[2]], nextCursor: null });
    expect(pageHunks(hunks, 0, 9)).toEqual({ hunks, nextCursor: null });
  });

  it("always returns at least one hunk, even one larger than a page", () => {
    const hunks = [hunk(10), hunk(1)];
    expect(pageHunks(hunks, 0, 4)).toEqual({ hunks: [hunks[0]], nextCursor: 1 });
  });

  it("returns nothing past the end", () => {
    expect(pageHunks([hunk(1)], 5)).toEqual({ hunks: [], nextCursor: null });
    expect(pageHunks([], 0)).toEqual({ hunks: [], nextCursor: null });
  });
});

describe("unifiedDiff", () => {
  it("prints nothing without hunks and single-line ranges without a count", () => {
    expect(unifiedDiff([], LABELS)).toBe("");
    expect(unified("a\n", "b\n")).toBe(
      "--- a/index.md (v1)\n+++ b/index.md (v2)\n@@ -1 +1 @@\n-a\n+b\n",
    );
  });
});
