import { describe, expect, it } from "vitest";
import { ErrorCode } from "./core.ts";
import { LIMITS } from "./limits.ts";
import {
  AccessUpdate,
  ArtifactList,
  ArtifactListItem,
  ArtifactListQuery,
  ERROR_STATUS,
  IdempotencyKey,
  LIST_SEARCH_MAX,
  ListedArtifactState,
  ListQuery,
  ManifestFile,
  PreparedPublish,
  PublishRequest,
  Sha256Hex,
  SourceOrigin,
  UploadedPart,
  UploadTarget,
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
    expect(ListQuery.safeParse({ cursor: "c".repeat(200) }).success).toBe(true);
    expect(ListQuery.safeParse({ cursor: "c".repeat(201) }).success).toBe(false);
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
    expect(ListedArtifactState.options).toEqual(["active", "archived", "suspended", "purging"]);
    for (const state of ListedArtifactState.options) {
      expect(ArtifactListQuery.parse({ state }).state).toBe(state);
    }
    expect(ArtifactListQuery.safeParse({ cursor: "c".repeat(201) }).success).toBe(false);
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
    expect(AccessUpdate.safeParse({}).error?.issues[0]?.message).toBe("Send at least one change.");
    expect(AccessUpdate.safeParse({ mode: undefined, indexable: undefined }).success).toBe(false);
    expect(AccessUpdate.parse({ indexable: false })).toEqual({ indexable: false });
    expect(AccessUpdate.safeParse({ mode: "everyone" }).success).toBe(false);
    const readers = (count: number) => Array.from({ length: count }, (_, i) => `r${i}@x.test`);
    for (const field of ["addReaders", "removeReaders"]) {
      expect(
        AccessUpdate.safeParse({ [field]: readers(LIMITS.readersPerChange) }).success,
        field,
      ).toBe(true);
      expect(
        AccessUpdate.safeParse({ [field]: readers(LIMITS.readersPerChange + 1) }).success,
        field,
      ).toBe(false);
    }
  });

  it("lists each artifact with its activity and refuses impossible figures", () => {
    const item = {
      id: "k7d2qm4xab",
      name: "Plan",
      type: "site",
      state: "active",
      accessMode: "restricted",
      annotations: "open",
      currentVersionId: "ver_1",
      url: "https://k7d2qm4xab.portifact.dev/",
      expiresAt: null,
      archivedAt: null,
      purgeAt: null,
      createdAt: "2026-11-08T00:00:00.000Z",
      updatedAt: "2026-11-08T00:00:00.000Z",
      activity: {
        versions: 2,
        currentBytes: 1200,
        openThreads: 3,
        lastAnnotationAt: "2026-11-08T01:00:00.000Z",
      },
    };
    expect(ArtifactList.parse({ items: [item], nextCursor: null }).items[0]?.activity).toEqual(
      item.activity,
    );
    expect(
      ArtifactListItem.safeParse({
        ...item,
        activity: { ...item.activity, currentBytes: null, lastAnnotationAt: null },
      }).success,
    ).toBe(true);
    const { activity: _, ...withoutActivity } = item;
    expect(ArtifactListItem.safeParse(withoutActivity).success).toBe(false);
    for (const bad of [
      { versions: -1 },
      { versions: 1.5 },
      { currentBytes: -1 },
      { openThreads: -1 },
      { lastAnnotationAt: "yesterday" },
    ]) {
      expect(
        ArtifactListItem.safeParse({ ...item, activity: { ...item.activity, ...bad } }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });
  it("takes lowercase SHA-256 hex of exactly 64 characters", () => {
    const hash = "0123456789abcdef".repeat(4);
    expect(Sha256Hex.parse(hash)).toBe(hash);
    for (const bad of [hash.slice(1), `${hash}0`, `x${hash}`, `${hash}x`, hash.toUpperCase()]) {
      expect(Sha256Hex.safeParse(bad).success, bad).toBe(false);
    }
    expect(Sha256Hex.safeParse("").error?.issues[0]?.message).toBe("Invalid SHA-256");
  });

  it("checks the form of a git origin and names the field that fails", () => {
    const origin = {
      commit: "a".repeat(40),
      branch: "main",
      remote: "https://x.test/r",
      dirty: false,
    };
    expect(SourceOrigin.parse(origin)).toEqual(origin);
    expect(SourceOrigin.parse({ ...origin, commit: "b".repeat(64) }).commit).toBe("b".repeat(64));
    expect(
      SourceOrigin.parse({ commit: null, branch: null, remote: null, dirty: true }).dirty,
    ).toBe(true);
    const issue = (patch: object) =>
      SourceOrigin.safeParse({ ...origin, ...patch }).error?.issues[0]?.message;
    for (const commit of [
      "a".repeat(39),
      "a".repeat(41),
      `x${"a".repeat(40)}`,
      `${"a".repeat(40)}x`,
    ]) {
      expect(issue({ commit }), commit).toBe("Invalid commit");
    }
    expect(issue({ branch: "main\n" })).toBe("Invalid branch");
    expect(issue({ remote: "https://x.test/\u0000" })).toBe("Invalid remote");
    expect(issue({ branch: "b".repeat(256) })).toBeDefined();
    expect(issue({ remote: "r".repeat(2_049) })).toBeDefined();
    expect(issue({ branch: "" })).toBeDefined();
    expect(issue({ extra: 1 })).toBeDefined();
  });

  it("bounds the base version of a publish", () => {
    const base = { type: "site", name: "x", entrypoint: "index.html", files: [file] };
    expect(PublishRequest.parse({ ...base, baseVersionId: "v".repeat(64) }).baseVersionId).toBe(
      "v".repeat(64),
    );
    expect(PublishRequest.safeParse({ ...base, baseVersionId: "v".repeat(65) }).success).toBe(
      false,
    );
    expect(PublishRequest.safeParse({ ...base, baseVersionId: "" }).success).toBe(false);
  });

  it("describes single and multipart uploads with sizes and parts that make sense", () => {
    const hash = "a".repeat(64);
    const single = {
      sha256: hash,
      size: 0,
      method: "PUT",
      url: "https://r2.test/u",
      headers: { "content-type": "text/html" },
      expiresAt: "2026-11-08T00:00:00.000Z",
    };
    const part = { ...single, partNumber: 1, offset: 0, size: 1 };
    const { sha256: _, ...partTarget } = part;
    const multipart = {
      sha256: hash,
      size: 0,
      method: "MULTIPART",
      partSize: 1,
      partCount: 1,
      doneParts: [1],
      parts: [partTarget],
    };
    const prepared = {
      artifactId: "k7d2qm4xab",
      versionId: "ver_1",
      versionNumber: 1,
      uploadId: "up_1",
      expiresAt: "2026-11-08T00:00:00.000Z",
      uploads: [single, multipart],
    };
    expect(PreparedPublish.parse(prepared)).toEqual(prepared);
    expect(UploadTarget.safeParse({ ...single, method: "POST" }).success).toBe(false);
    for (const bad of [
      { ...single, size: -1 },
      { ...multipart, size: -1 },
      { ...multipart, partSize: 0 },
      { ...multipart, partCount: 0 },
      { ...multipart, doneParts: [0] },
      { ...multipart, parts: [{ ...partTarget, partNumber: 0 }] },
      { ...multipart, parts: [{ ...partTarget, offset: -1 }] },
      { ...multipart, parts: [{ ...partTarget, size: 0 }] },
      { ...multipart, parts: [{ ...partTarget, method: "POST" }] },
    ]) {
      expect(UploadTarget.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(PreparedPublish.safeParse({ ...prepared, versionNumber: 0 }).success).toBe(false);
  });

  it("takes a reported part with its ETag and nothing else", () => {
    const reported = { sha256: "a".repeat(64), partNumber: 1, etag: "e".repeat(200) };
    expect(UploadedPart.parse(reported)).toEqual(reported);
    for (const bad of [{ partNumber: 0 }, { etag: "" }, { etag: "e".repeat(201) }, { extra: 1 }]) {
      expect(UploadedPart.safeParse({ ...reported, ...bad }).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
  });
});
