import { describe, expect, it } from "vitest";
import { ErrorCode } from "./core.ts";
import { LIMITS } from "./limits.ts";
import {
  AccessUpdate,
  ArtifactList,
  ArtifactListQuery,
  ERROR_STATUS,
  IdempotencyKey,
  LIST_SEARCH_MAX,
  ListQuery,
  ManifestFile,
  PublishRequest,
} from "./publishing.ts";

const file = {
  path: "index.html",
  sha256: "a".repeat(64),
  size: 12,
  contentType: "text/html",
};

describe("publishing contracts", () => {
  it("defaults a manifest file to published content and a new artifact to no base", () => {
    expect(ManifestFile.parse(file).kind).toBe("published");
    const request = PublishRequest.parse({
      type: "site",
      name: "  Plan  ",
      entrypoint: "index.html",
      files: [file],
    });
    expect(request).toMatchObject({ name: "Plan", baseVersionId: null });
  });

  it("rejects bad hashes, sizes, empty or oversized manifests and foreign ids", () => {
    expect(ManifestFile.safeParse({ ...file, sha256: "A".repeat(64) }).success).toBe(false);
    expect(ManifestFile.safeParse({ ...file, size: -1 }).success).toBe(false);
    expect(ManifestFile.safeParse({ ...file, size: 1.5 }).success).toBe(false);
    expect(ManifestFile.safeParse({ ...file, size: LIMITS.artifactBytes + 1 }).success).toBe(false);
    const base = { type: "site", name: "x", entrypoint: "index.html" };
    expect(PublishRequest.safeParse({ ...base, files: [] }).success).toBe(false);
    expect(
      PublishRequest.safeParse({
        ...base,
        files: Array.from({ length: LIMITS.filesPerVersion + 1 }, () => file),
      }).success,
    ).toBe(false);
    expect(PublishRequest.safeParse({ ...base, files: [file], artifactId: "Nope" }).success).toBe(
      false,
    );
    expect(PublishRequest.safeParse({ ...base, name: "   ", files: [file] }).success).toBe(false);
  });

  it("accepts idempotency keys of safe characters only", () => {
    expect(IdempotencyKey.safeParse("3f2c9a1e-retry.1:x_y").success).toBe(true);
    for (const bad of ["short", "x".repeat(129), "has space here", "semi;colon-key"]) {
      expect(IdempotencyKey.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("bounds the page size and defaults it", () => {
    expect(ListQuery.parse({}).limit).toBe(50);
    expect(ListQuery.parse({ limit: "10" }).limit).toBe(10);
    expect(ListQuery.safeParse({ limit: "0" }).success).toBe(false);
    expect(ListQuery.safeParse({ limit: "101" }).success).toBe(false);
    expect(ArtifactList.parse({ items: [], nextCursor: null })).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it("parses the artifact list filters and refuses unknown values", () => {
    expect(
      ArtifactListQuery.parse({
        limit: "5",
        search: " notes ",
        state: "active",
        type: "site",
        access: "restricted",
        annotations: "locked",
      }),
    ).toEqual({
      limit: 5,
      search: "notes",
      state: "active",
      type: "site",
      access: "restricted",
      annotations: "locked",
    });
    expect(ArtifactListQuery.parse({})).toEqual({ limit: 50 });
    expect(ArtifactListQuery.safeParse({ search: "" }).success).toBe(false);
    expect(ArtifactListQuery.safeParse({ search: "x".repeat(LIST_SEARCH_MAX) }).success).toBe(true);
    expect(ArtifactListQuery.safeParse({ search: "x".repeat(LIST_SEARCH_MAX + 1) }).success).toBe(
      false,
    );
    for (const state of ["draft", "deleted", "ACTIVE"]) {
      expect(ArtifactListQuery.safeParse({ state }).success, state).toBe(false);
    }
    expect(ArtifactListQuery.safeParse({ type: "pdf" }).success).toBe(false);
    expect(ArtifactListQuery.safeParse({ access: "private" }).success).toBe(false);
    expect(ArtifactListQuery.safeParse({ annotations: "on" }).success).toBe(false);
  });

  it("maps every error code to a client or service status", () => {
    for (const code of ErrorCode.options) {
      expect(ERROR_STATUS[code], code).toBeGreaterThanOrEqual(400);
    }
    expect(ERROR_STATUS.version_conflict).toBe(409);
    expect(ERROR_STATUS.quota_exceeded).toBe(429);
    expect(ERROR_STATUS.capacity_unavailable).toBe(503);
  });

  it("accepts an access change with at least one field and lowercases readers", () => {
    expect(AccessUpdate.parse({ addReaders: ["Ana@Example.COM"] })).toEqual({
      addReaders: ["ana@example.com"],
    });
    expect(AccessUpdate.safeParse({}).success).toBe(false);
    expect(AccessUpdate.safeParse({ mode: "everyone" }).success).toBe(false);
    expect(
      AccessUpdate.safeParse({
        addReaders: Array.from({ length: LIMITS.readersPerChange + 1 }, (_, i) => `r${i}@x.test`),
      }).success,
    ).toBe(false);
  });
});
