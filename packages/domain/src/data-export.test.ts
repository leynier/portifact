import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { exportPathSegments, exportVersionFolder } from "./data-export.ts";

describe("exportVersionFolder", () => {
  it("puts each version's files of a kind in its own folder", () => {
    expect(exportVersionFolder("abcdefghij", 3, "published")).toBe(
      "artifacts/abcdefghij/v3/published",
    );
    expect(exportVersionFolder("abcdefghij", 1, "source")).toBe("artifacts/abcdefghij/v1/source");
  });
});

describe("exportPathSegments", () => {
  it.each([
    ["index.html", ["index.html"]],
    ["docs/a b/c.md", ["docs", "a b", "c.md"]],
    ["con.txt", ["con.txt"]],
  ])("writes %s on any system", (path, segments) => {
    expect(exportPathSegments(path, false)).toEqual({ ok: true, value: segments });
  });

  it.each([
    ["../escape.txt", false],
    ["/etc/passwd", false],
    ["a//b.txt", false],
    ["a/./b.txt", false],
    ["C:/windows/system.ini", false],
    ["a\\b.txt", false],
    [".git/hooks/post-checkout", false],
    ["src/.GIT/config", false],
    ["git~1/config", false],
    ["CON", true],
    ["docs/nul.txt", true],
    ["com1.md", true],
    ["lpt9", true],
    ["aux. ", true],
    ["a:b.txt", true],
    ["what?.md", true],
    ["trailing.", true],
    ["trailing ", true],
  ])("refuses %s (Windows rules: %s)", (path, windows) => {
    expect(exportPathSegments(path, windows).ok).toBe(false);
  });

  it("never yields an empty, `.`, `..` or `.git` segment, nor an absolute path", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.constantFrom("..", ".", "", ".git", "con", "a", "b.txt", "C:", "\\", " "),
            fc.string({ maxLength: 6 }),
          ),
          { minLength: 1, maxLength: 5 },
        ),
        fc.boolean(),
        (parts, windows) => {
          const path = parts.join("/");
          const result = exportPathSegments(path, windows);
          if (!result.ok) return;
          expect(path.startsWith("/")).toBe(false);
          for (const segment of result.value) {
            expect(["", ".", ".."]).not.toContain(segment);
            expect(segment.toLowerCase()).not.toBe(".git");
          }
          expect(result.value.join("/")).toBe(path);
        },
      ),
      { numRuns: 2_000 },
    );
  });
});
