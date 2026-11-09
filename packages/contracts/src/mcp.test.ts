import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GetAccessLogsInput } from "./access-log.ts";
import {
  CreateAnnotationInput,
  DeleteThreadInput,
  EditAnnotationInput,
  ExportAnnotationsInput,
  ListAnnotationsInput,
  ModerateAnnotationInput,
  ReplyAnnotationInput,
  SetAnnotationsInput,
} from "./annotation-tools.ts";
import { LIMITS } from "./limits.ts";
import {
  ArtifactRef,
  CommitUploadInput,
  DeleteArtifactInput,
  ListArtifactsInput,
  PrepareUploadInput,
  PublishDocumentInput,
  ReaderChangeInput,
  SetAccessInput,
  UploadRef,
} from "./mcp.ts";
import {
  ContentQuery,
  GetDownloadInput,
  GetVersionInput,
  ListVersionsInput,
  ReadArtifactInput,
  RollbackArtifactInput,
} from "./versions.ts";

const MCP_TOOL_INPUTS = {
  ArtifactRef,
  ListArtifactsInput,
  PublishDocumentInput,
  DeleteArtifactInput,
  GetAccessLogsInput,
  SetAnnotationsInput,
  ListAnnotationsInput,
  CreateAnnotationInput,
  ReplyAnnotationInput,
  EditAnnotationInput,
  ModerateAnnotationInput,
  DeleteThreadInput,
  ExportAnnotationsInput,
  ListVersionsInput,
  GetVersionInput,
  GetDownloadInput,
  RollbackArtifactInput,
  SetAccessInput,
  ReaderChangeInput,
  PrepareUploadInput,
  UploadRef,
  CommitUploadInput,
  ReadArtifactInput,
};

const doc = { type: "markdown", name: "  Plan  ", content: "# Plan" };

describe("MCP tool inputs", () => {
  it("trims the name and leaves a new document without artifact, base or key", () => {
    expect(PublishDocumentInput.parse(doc)).toEqual({
      type: "markdown",
      name: "Plan",
      content: "# Plan",
    });
  });

  it("accepts content up to the inline limit in UTF-16 units and rejects one more", () => {
    const max = "a".repeat(LIMITS.inlineMcpBytes);
    expect(PublishDocumentInput.safeParse({ ...doc, content: max }).success).toBe(true);
    expect(PublishDocumentInput.safeParse({ ...doc, content: `${max}a` }).success).toBe(false);
  });

  it("rejects unknown types, blank names, foreign ids and malformed idempotency keys", () => {
    expect(PublishDocumentInput.safeParse({ ...doc, type: "pdf" }).success).toBe(false);
    expect(PublishDocumentInput.safeParse({ ...doc, name: "   " }).success).toBe(false);
    expect(PublishDocumentInput.safeParse({ ...doc, artifactId: "ABC" }).success).toBe(false);
    expect(PublishDocumentInput.safeParse({ ...doc, baseVersionId: "" }).success).toBe(false);
    expect(PublishDocumentInput.safeParse({ ...doc, baseVersionId: "v".repeat(64) }).success).toBe(
      true,
    );
    expect(PublishDocumentInput.safeParse({ ...doc, baseVersionId: "v".repeat(65) }).success).toBe(
      false,
    );
    expect(PublishDocumentInput.safeParse({ ...doc, idempotencyKey: "short" }).success).toBe(false);
    expect(PublishDocumentInput.safeParse({ ...doc, idempotencyKey: "publish-0001" }).success).toBe(
      true,
    );
  });

  it("defaults the page size and bounds it", () => {
    expect(ListArtifactsInput.parse({})).toEqual({ limit: 50 });
    expect(ListArtifactsInput.safeParse({ limit: 0 }).success).toBe(false);
    expect(ListArtifactsInput.safeParse({ limit: 101 }).success).toBe(false);
    expect(ListArtifactsInput.safeParse({ limit: 2.5 }).success).toBe(false);
    expect(ListArtifactsInput.safeParse({ cursor: "c".repeat(200) }).success).toBe(true);
    expect(ListArtifactsInput.safeParse({ cursor: "c".repeat(201) }).success).toBe(false);
  });

  it("takes the same list filters as the API", () => {
    const filters = {
      search: "  Report ",
      state: "archived",
      type: "markdown",
      access: "public",
      annotations: "open",
    };
    expect(ListArtifactsInput.parse(filters)).toEqual({ ...filters, search: "Report", limit: 50 });
    expect(ListArtifactsInput.safeParse({ search: "   " }).success).toBe(false);
    expect(ListArtifactsInput.safeParse({ search: "x".repeat(201) }).success).toBe(false);
    expect(ListArtifactsInput.safeParse({ state: "deleted" }).success).toBe(false);
    expect(ListArtifactsInput.safeParse({ state: "draft" }).success).toBe(false);
    expect(ListArtifactsInput.safeParse({ access: "private" }).success).toBe(false);
  });

  it("requires a valid artifact id, and a confirmation to delete", () => {
    expect(ArtifactRef.safeParse({ artifactId: "abcdefghij" }).success).toBe(true);
    expect(ArtifactRef.safeParse({ artifactId: "abc" }).success).toBe(false);
    expect(DeleteArtifactInput.safeParse({ artifactId: "abcdefghij" }).success).toBe(false);
    expect(
      DeleteArtifactInput.safeParse({ artifactId: "abcdefghij", confirm: "abcdefghij" }).success,
    ).toBe(true);
  });

  it("describes every field of every tool for agents in the JSON Schema it advertises", () => {
    for (const [tool, schema] of Object.entries(MCP_TOOL_INPUTS)) {
      const json = z.toJSONSchema(schema, { io: "input" }) as {
        properties: Record<string, { description?: string }>;
      };
      expect(Object.keys(json.properties).length, tool).toBeGreaterThan(0);
      for (const [field, property] of Object.entries(json.properties)) {
        expect(property.description, `${tool}.${field}`).toMatch(/\w{3}/);
      }
    }
  });

  it("pages versions within the same bounds as the API", () => {
    const ref = { artifactId: "abcdefghij" };
    expect(ListVersionsInput.parse(ref)).toEqual({ ...ref, limit: 50 });
    expect(
      ListVersionsInput.safeParse({ ...ref, limit: 100, cursor: "c".repeat(200) }).success,
    ).toBe(true);
    for (const bad of [{ limit: 0 }, { limit: 101 }, { cursor: "c".repeat(201) }]) {
      expect(ListVersionsInput.safeParse({ ...ref, ...bad }).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
    expect(GetDownloadInput.safeParse({ ...ref, path: "p".repeat(1_024) }).success).toBe(true);
    expect(GetDownloadInput.safeParse({ ...ref, path: "p".repeat(1_025) }).success).toBe(false);
    expect(GetDownloadInput.safeParse({ ...ref, path: "" }).success).toBe(false);
  });

  it("pages annotations with their short cursor and offers only the known actions", () => {
    const ref = { artifactId: "abcdefghij" };
    expect(ListAnnotationsInput.safeParse({ ...ref, cursor: "c".repeat(32) }).success).toBe(true);
    expect(ListAnnotationsInput.safeParse({ ...ref, cursor: "c".repeat(33) }).success).toBe(false);
    const message = { ...ref, messageId: "msg_1" };
    for (const action of ["hide", "unhide", "delete"]) {
      expect(ModerateAnnotationInput.parse({ ...message, action }).action).toBe(action);
    }
    expect(ModerateAnnotationInput.safeParse({ ...message, action: "edit" }).success).toBe(false);
    expect(ExportAnnotationsInput.parse(ref).format).toBe("json");
    expect(ExportAnnotationsInput.parse({ ...ref, format: "markdown" }).format).toBe("markdown");
    expect(ExportAnnotationsInput.safeParse({ ...ref, format: "csv" }).success).toBe(false);
  });

  it("takes sharing changes the access update validates, within its reader bounds", () => {
    const ref = { artifactId: "abcdefghij" };
    expect(SetAccessInput.parse({ ...ref, mode: "public", indexable: true })).toEqual({
      ...ref,
      mode: "public",
      indexable: true,
    });
    // An empty change passes here; the access update refuses it with the API's message.
    expect(SetAccessInput.safeParse(ref).success).toBe(true);
    expect(SetAccessInput.safeParse({ ...ref, mode: "private" }).success).toBe(false);
    const emails = (n: number) => Array.from({ length: n }, (_, i) => `r${i}@example.test`);
    expect(ReaderChangeInput.safeParse({ ...ref, emails: [] }).success).toBe(false);
    expect(
      ReaderChangeInput.safeParse({ ...ref, emails: emails(LIMITS.readersPerChange) }).success,
    ).toBe(true);
    expect(
      ReaderChangeInput.safeParse({ ...ref, emails: emails(LIMITS.readersPerChange + 1) }).success,
    ).toBe(false);
  });

  it("prepares uploads with the API's manifest and a required idempotency key", () => {
    const file = { path: "index.html", sha256: "a".repeat(64), size: 4, contentType: "text/html" };
    const upload = {
      type: "site",
      name: " Site ",
      entrypoint: "index.html",
      files: [file],
      idempotencyKey: "prepare-0001",
    };
    expect(PrepareUploadInput.parse(upload)).toEqual({
      ...upload,
      name: "Site",
      baseVersionId: null,
      files: [{ ...file, kind: "published" }],
    });
    const { idempotencyKey: _, ...withoutKey } = upload;
    expect(PrepareUploadInput.safeParse(withoutKey).success).toBe(false);
    expect(PrepareUploadInput.safeParse({ ...upload, files: [] }).success).toBe(false);
    expect(
      PrepareUploadInput.safeParse({ ...upload, files: [{ ...file, sha256: "x" }] }).success,
    ).toBe(false);
    expect(
      PrepareUploadInput.safeParse({
        ...upload,
        files: Array.from({ length: LIMITS.filesPerVersion + 1 }, () => file),
      }).success,
    ).toBe(false);
    expect(UploadRef.safeParse({ uploadId: "" }).success).toBe(false);
    const part = { sha256: "a".repeat(64), partNumber: 1, etag: "e" };
    expect(CommitUploadInput.parse({ uploadId: "upl_1", parts: [part] }).parts).toEqual([part]);
    expect(
      CommitUploadInput.safeParse({ uploadId: "upl_1", parts: [{ ...part, partNumber: 0 }] })
        .success,
    ).toBe(false);
  });

  it("reads the current entrypoint from the first byte by default, within the file limit", () => {
    const ref = { artifactId: "abcdefghij" };
    expect(ReadArtifactInput.parse(ref)).toEqual({
      ...ref,
      versionId: "current",
      kind: "published",
      offset: 0,
    });
    expect(ReadArtifactInput.safeParse({ ...ref, offset: -1 }).success).toBe(false);
    expect(ReadArtifactInput.safeParse({ ...ref, offset: 1.5 }).success).toBe(false);
    expect(ReadArtifactInput.safeParse({ ...ref, offset: LIMITS.artifactBytes + 1 }).success).toBe(
      false,
    );
    // The API's query takes the offset as text.
    expect(ContentQuery.parse({ offset: "42" })).toEqual({ kind: "published", offset: 42 });
    expect(ContentQuery.parse({})).toEqual({ kind: "published", offset: 0 });
    expect(ContentQuery.safeParse({ offset: "x" }).success).toBe(false);
    expect(ContentQuery.safeParse({ offset: "-1" }).success).toBe(false);
  });
});
