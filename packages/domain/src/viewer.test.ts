import { describe, expect, it } from "vitest";
import {
  openToAnyone,
  VIEWER_HASH_MAX,
  VIEWER_PATH_MAX,
  viewerHash,
  viewerPath,
} from "./viewer.ts";

describe("viewer paths", () => {
  it("keeps a path and its query on the artifact origin", () => {
    expect(viewerPath("/")).toBe("/");
    expect(viewerPath("/docs/a.html?x=1&y=2")).toBe("/docs/a.html?x=1&y=2");
    expect(viewerPath("/a b.html")).toBe("/a%20b.html");
    expect(viewerPath("/docs/../b.html")).toBe("/b.html");
  });

  it("refuses anything that is not a path on the same origin", () => {
    for (const raw of [
      null,
      undefined,
      "",
      "docs/a.html",
      "https://evil.example/",
      "//evil.example/",
      "/\\evil.example/",
      "/\tx",
      "/a\nb",
      "/a\u0000",
    ]) {
      expect(viewerPath(raw), String(raw)).toBeNull();
    }
  });

  it("refuses the reserved paths in any spelling", () => {
    for (const raw of [
      "/__portifact/callback?code=x",
      "/__portifact/review?code=x",
      "/__PORTIFACT/review",
      "/%5f%5fportifact/review",
      "/__portifact",
    ]) {
      expect(viewerPath(raw), raw).toBeNull();
    }
    expect(viewerPath("/docs/__portifact/x")).toBe("/docs/__portifact/x");
  });

  it("refuses paths longer than the limit", () => {
    expect(viewerPath(`/${"a".repeat(VIEWER_PATH_MAX - 1)}`)).toHaveLength(VIEWER_PATH_MAX);
    expect(viewerPath(`/${"a".repeat(VIEWER_PATH_MAX)}`)).toBeNull();
    // Encoding can make a short input longer than the limit.
    expect(viewerPath(`/${" a".repeat(VIEWER_PATH_MAX / 2 - 10)}`)).toBeNull();
  });
});

describe("viewer fragments", () => {
  it("passes a fragment on and drops anything else", () => {
    expect(viewerHash("#intro")).toBe("#intro");
    expect(viewerHash("#")).toBe("");
    expect(viewerHash("intro")).toBe("");
    expect(viewerHash(null)).toBe("");
    expect(viewerHash("#a\nb")).toBe("");
    expect(viewerHash(`#${"a".repeat(VIEWER_HASH_MAX)}`)).toBe("");
    expect(viewerHash(`#${"a".repeat(VIEWER_HASH_MAX - 1)}`)).toHaveLength(VIEWER_HASH_MAX);
  });
});

describe("what anyone may see", () => {
  const now = new Date("2026-11-12T09:00:00Z");
  const base = {
    accessMode: "public" as const,
    state: "active" as const,
    expiresAt: null,
    archivedAt: null,
  };

  it("is a public artifact that is effectively active", () => {
    expect(openToAnyone(base, now)).toBe(true);
    expect(openToAnyone({ ...base, expiresAt: new Date(now.getTime() + 1) }, now)).toBe(true);
  });

  it("is never another access mode, an expired artifact or any other state", () => {
    for (const accessMode of ["authenticated", "restricted", "workspace", "domain"] as const) {
      expect(openToAnyone({ ...base, accessMode }, now), accessMode).toBe(false);
    }
    expect(openToAnyone({ ...base, expiresAt: now }, now)).toBe(false);
    for (const state of ["draft", "archived", "suspended", "purging", "deleted"] as const) {
      expect(openToAnyone({ ...base, state }, now), state).toBe(false);
    }
  });
});
