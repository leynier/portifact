import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { normalizePath, validateManifestPaths } from "./paths.ts";

const value = (raw: string) => {
  const result = normalizePath(raw);
  if (!result.ok) throw new Error(`expected ${raw} to be valid: ${result.message}`);
  return result.value;
};
const rejected = (raw: string) => {
  const result = normalizePath(raw);
  return result.ok ? null : result.message;
};

describe("normalizePath", () => {
  it("keeps canonical relative paths", () => {
    expect(value("index.html")).toBe("index.html");
    expect(value("assets/app.3f9a.js")).toBe("assets/app.3f9a.js");
  });

  it("drops empty and dot segments", () => {
    expect(value("./docs//guide/./index.html")).toBe("docs/guide/index.html");
  });

  it("normalizes Unicode to NFC so equivalent names are one path", () => {
    expect(value("cafe\u0301.html")).toBe("caf\u00e9.html");
  });

  it.each([
    ["/etc/passwd", "relative"],
    ["../secrets.txt", "`..`"],
    ["docs/../../x", "`..`"],
    ["C:/Windows/x.txt", "drive letter"],
    ["docs\\index.html", "forward slashes"],
    ["a\u0000b", "control characters"],
    ["a\nb", "control characters"],
    ["", "empty"],
    ["./", "empty"],
    ["__portifact/callback", "reserved"],
    ["__PORTIFACT/review", "reserved"],
    [`${"a".repeat(256)}.txt`, "segment is too long"],
    [`${"abcdefghij/".repeat(103)}x`, "too long"],
  ])("rejects %j", (raw, reason) => {
    expect(rejected(raw)).toContain(reason);
  });

  it("allows the reserved name below the root", () => {
    expect(value("docs/__portifact/notes.md")).toBe("docs/__portifact/notes.md");
  });

  it("never produces an unsafe path, and is idempotent", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 80 }), (raw) => {
        const result = normalizePath(raw);
        if (!result.ok) return;
        const path = result.value;
        expect(path.startsWith("/")).toBe(false);
        expect(path.split("/")).not.toContain("..");
        expect(path.split("/")).not.toContain("");
        expect(path).not.toContain("\\");
        expect(path.split("/")[0]?.toLowerCase()).not.toBe("__portifact");
        expect(normalizePath(path)).toEqual(result);
      }),
      { numRuns: 2000 },
    );
  });

  it("rejects every path that tries to climb out of the root", () => {
    const segment = fc.stringMatching(/^[a-z0-9._-]{1,8}$/);
    fc.assert(
      fc.property(
        fc.array(segment, { maxLength: 4 }),
        fc.array(segment, { maxLength: 4 }),
        (a, b) => {
          expect(normalizePath([...a, "..", ...b].join("/")).ok).toBe(false);
        },
      ),
    );
  });
});

describe("validateManifestPaths", () => {
  it("returns the normalized paths of a valid manifest", () => {
    const result = validateManifestPaths(["index.html", "./assets/app.js", "docs/a.md"]);
    expect(result).toEqual({ ok: true, value: ["index.html", "assets/app.js", "docs/a.md"] });
  });

  it("rejects duplicates after normalization", () => {
    const result = validateManifestPaths(["a/b.txt", "a//b.txt"]);
    expect(result.ok).toBe(false);
  });

  it("rejects names that differ only by case", () => {
    const result = validateManifestPaths(["Readme.md", "README.md"]);
    expect(result).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("rejects a file that is also a directory", () => {
    const result = validateManifestPaths(["docs", "docs/index.html"]);
    expect(result).toMatchObject({ ok: false, code: "invalid_input" });
    if (!result.ok) expect(result.message).toContain("parent");
  });

  it("reports which entry is invalid", () => {
    const result = validateManifestPaths(["ok.txt", "../escape.txt"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("../escape.txt");
  });

  it("enforces the file count limit", () => {
    const paths = Array.from({ length: 1001 }, (_, i) => `f${i}.txt`);
    expect(validateManifestPaths(paths)).toMatchObject({ ok: false, code: "quota_exceeded" });
    expect(validateManifestPaths(paths.slice(0, 1000)).ok).toBe(true);
  });
});
