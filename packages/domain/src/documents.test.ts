import { LIMITS } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  checkDocumentManifest,
  checkRenderedVersion,
  DOCUMENT_CONTENT_TYPES,
  type DocumentFile,
  isDocumentType,
} from "./documents.ts";

const doc = (size: number): DocumentFile => ({ path: "plan.md", kind: "published", size });

describe("isDocumentType", () => {
  it("treats Markdown and text as documents and sites as not", () => {
    expect(isDocumentType("markdown")).toBe(true);
    expect(isDocumentType("text")).toBe(true);
    expect(isDocumentType("site")).toBe(false);
  });
});

describe("DOCUMENT_CONTENT_TYPES", () => {
  it("serves originals as UTF-8 Markdown or plain text", () => {
    expect(DOCUMENT_CONTENT_TYPES).toEqual({
      markdown: "text/markdown; charset=utf-8",
      text: "text/plain; charset=utf-8",
    });
  });
});

describe("checkDocumentManifest", () => {
  it("accepts a document at the limit with assets and sources", () => {
    expect(
      checkDocumentManifest("markdown", "plan.md", [
        doc(LIMITS.documentBytes),
        { path: "images/a.png", kind: "published", size: 10 },
        { path: "plan.md", kind: "source", size: 10 },
      ]),
    ).toEqual({ ok: true, value: true });
  });

  it("rejects a document one byte over the limit", () => {
    const result = checkDocumentManifest("markdown", "plan.md", [doc(LIMITS.documentBytes + 1)]);
    expect(result).toEqual({
      ok: false,
      code: "invalid_input",
      message: `Documents are limited to ${LIMITS.documentBytes} bytes; plan.md has ${LIMITS.documentBytes + 1}.`,
    });
  });

  it("rejects an entrypoint that is only a private source", () => {
    const result = checkDocumentManifest("markdown", "plan.md", [
      { path: "plan.md", kind: "source", size: 1 },
      { path: "other.md", kind: "published", size: 1 },
    ]);
    expect(result).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("allows a text document with private sources but no other published file", () => {
    expect(
      checkDocumentManifest("text", "notes.txt", [
        { path: "notes.txt", kind: "published", size: 5 },
        { path: "notes.src", kind: "source", size: 5 },
      ]).ok,
    ).toBe(true);
    expect(
      checkDocumentManifest("text", "notes.txt", [
        { path: "notes.txt", kind: "published", size: 5 },
        { path: "extra.txt", kind: "published", size: 5 },
      ]),
    ).toEqual({
      ok: false,
      code: "invalid_input",
      message: "A text artifact publishes a single file.",
    });
  });
});

describe("checkRenderedVersion", () => {
  it("accepts a version whose rendering fits exactly", () => {
    expect(checkRenderedVersion(LIMITS.artifactBytes - 100, 100)).toEqual({
      ok: true,
      value: true,
    });
  });

  it("rejects a version one byte over with its rendering", () => {
    expect(checkRenderedVersion(LIMITS.artifactBytes - 100, 101)).toEqual({
      ok: false,
      code: "quota_exceeded",
      message: "With its rendered page, this version exceeds 250 MB.",
    });
  });
});
