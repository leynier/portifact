import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LIMITS } from "./core.ts";
import {
  ArtifactRef,
  DeleteArtifactInput,
  ListArtifactsInput,
  PublishDocumentInput,
} from "./mcp.ts";

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
  });

  it("requires a valid artifact id, and a confirmation to delete", () => {
    expect(ArtifactRef.safeParse({ artifactId: "abcdefghij" }).success).toBe(true);
    expect(ArtifactRef.safeParse({ artifactId: "abc" }).success).toBe(false);
    expect(DeleteArtifactInput.safeParse({ artifactId: "abcdefghij" }).success).toBe(false);
    expect(
      DeleteArtifactInput.safeParse({ artifactId: "abcdefghij", confirm: "abcdefghij" }).success,
    ).toBe(true);
  });

  it("describes every field for agents in the JSON Schema it advertises", () => {
    for (const schema of [ArtifactRef, ListArtifactsInput, PublishDocumentInput]) {
      const json = z.toJSONSchema(schema, { io: "input" }) as {
        properties: Record<string, { description?: string }>;
      };
      for (const [field, property] of Object.entries(json.properties)) {
        expect(property.description, field).toMatch(/\w/);
      }
    }
  });
});
