import { describe, expect, it } from "vitest";
import { renderMarkdownDocument, renderTextDocument } from "./document.ts";
import {
  BLOCK_MAP_CONTENT_TYPE,
  RENDERED_CONTENT_TYPE,
  renderStoredDocument,
  STORED_RENDERING,
} from "./stored.ts";
import { RENDERER_VERSION } from "./version.ts";

const sha = "a".repeat(64);

describe("renderStoredDocument", () => {
  it("renders a Markdown page with the stored flags and its block map", () => {
    const source = "# Title\n\nSome *text*.\n\n```mermaid\ngraph TD; A-->B\n```\n";
    const files = renderStoredDocument("markdown", source, { title: "Doc", sourceSha256: sha });
    const direct = renderMarkdownDocument(source, {
      title: "Doc",
      reportLink: true,
      liveDiagrams: true,
    });
    expect(files.map((file) => [file.kind, file.contentType])).toEqual([
      ["rendered", RENDERED_CONTENT_TYPE],
      ["block_map", BLOCK_MAP_CONTENT_TYPE],
    ]);
    expect(files[0]?.text).toBe(direct.html);
    expect(files[0]?.text).toContain("Report this artifact");
    expect(JSON.parse(files[1]?.text ?? "")).toEqual({
      rendererVersion: RENDERER_VERSION,
      sourceSha256: sha,
      blocks: direct.blocks,
      headings: direct.headings,
    });
    // The block map's keys are written in this order; a stored map must reproduce byte for byte.
    expect(
      files[1]?.text.startsWith(`{"rendererVersion":"${RENDERER_VERSION}","sourceSha256"`),
    ).toBe(true);
  });

  it("renders a text page alone, with the report link", () => {
    const files = renderStoredDocument("text", "a < b", { title: "T", sourceSha256: sha });
    expect(files).toEqual([
      {
        kind: "rendered",
        contentType: RENDERED_CONTENT_TYPE,
        text: renderTextDocument("a < b", { title: "T", reportLink: true }).html,
      },
    ]);
  });

  it("pins the flags of every stored rendering", () => {
    expect(STORED_RENDERING).toEqual({ reportLink: true, liveDiagrams: true });
  });

  it("is deterministic", () => {
    const once = renderStoredDocument("markdown", "# A\n\nb", { title: "x", sourceSha256: sha });
    const twice = renderStoredDocument("markdown", "# A\n\nb", { title: "x", sourceSha256: sha });
    expect(twice).toEqual(once);
  });
});
