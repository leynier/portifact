import { describe, expect, it } from "vitest";
import {
  DownloadQuery,
  GetDownloadInput,
  RollbackArtifactInput,
  RollbackRequest,
  RolledBack,
  VersionDownload,
  VersionRef,
} from "./versions.ts";

describe("version contracts", () => {
  it("accepts version IDs and the current alias, and refuses anything unsafe in a URL path", () => {
    for (const id of ["current", "ver_0123456789abcdef0123456789abcdef", "ver-a_B"]) {
      expect(VersionRef.safeParse(id).success, id).toBe(true);
    }
    for (const id of ["", "ver/../x", "ver 1", "ver%2F", "a".repeat(65), "ver?x"]) {
      expect(VersionRef.safeParse(id).success, id).toBe(false);
    }
  });

  it("downloads published files of the current version by default", () => {
    expect(DownloadQuery.parse({})).toEqual({ kind: "published" });
    expect(DownloadQuery.safeParse({ kind: "build" }).success).toBe(false);
    expect(GetDownloadInput.parse({ artifactId: "abcdefghij" })).toEqual({
      artifactId: "abcdefghij",
      versionId: "current",
      kind: "published",
    });
  });

  it("requires both versions for a rollback", () => {
    expect(RollbackRequest.safeParse({ versionId: "ver_a" }).success).toBe(false);
    expect(RollbackRequest.parse({ versionId: "ver_a", baseVersionId: "ver_b" })).toEqual({
      versionId: "ver_a",
      baseVersionId: "ver_b",
    });
    expect(
      RollbackArtifactInput.safeParse({
        artifactId: "abcdefghij",
        versionId: "ver_a",
        baseVersionId: "ver_b",
        idempotencyKey: "short",
      }).success,
    ).toBe(false);
  });

  it("describes a rollback as a committed publish plus the version it came from", () => {
    const body = {
      artifactId: "abcdefghij",
      versionId: "ver_new",
      versionNumber: 4,
      url: "https://abcdefghij.portifact.dev/",
      expiresAt: "2026-12-08T12:00:00.000Z",
      fromVersionId: "ver_old",
      fromVersionNumber: 2,
    };
    expect(RolledBack.parse(body)).toEqual(body);
    expect(RolledBack.safeParse({ ...body, fromVersionNumber: 0 }).success).toBe(false);
  });

  it("gives every download link a GET method, a URL and an expiry", () => {
    const link = {
      path: "index.md",
      sha256: "a".repeat(64),
      size: 3,
      contentType: "text/markdown",
      method: "GET",
      url: "https://example.r2.cloudflarestorage.com/b/objects/u/x",
      expiresAt: "2026-11-08T12:05:00.000Z",
    };
    const download = {
      artifactId: "abcdefghij",
      versionId: "ver_a",
      versionNumber: 1,
      kind: "published",
      entrypoint: "index.md",
      files: [link],
    };
    expect(VersionDownload.parse(download)).toEqual(download);
    expect(
      VersionDownload.safeParse({ ...download, files: [{ ...link, method: "PUT" }] }).success,
    ).toBe(false);
  });
});
