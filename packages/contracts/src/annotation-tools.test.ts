import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CreateAnnotationInput,
  DeleteThreadInput,
  EditAnnotationInput,
  ExportAnnotationsInput,
  ListAnnotationsInput,
  MessageRef,
  ModerateAnnotationInput,
  ReplyAnnotationInput,
  SetAnnotationsInput,
  ThreadRef,
} from "./annotation-tools.ts";

const artifactId = "abcdefghij";
const target = { schema: 1, path: "index.html", anchor: { kind: "document" } };

describe("annotation tool inputs", () => {
  it("defaults the list to the current version and the API's page size, and bounds it", () => {
    expect(ListAnnotationsInput.parse({ artifactId })).toEqual({
      artifactId,
      limit: 25,
      version: "current",
    });
    expect(ListAnnotationsInput.safeParse({ artifactId, limit: 51 }).success).toBe(false);
    expect(ListAnnotationsInput.safeParse({ artifactId, limit: 0 }).success).toBe(false);
    expect(ListAnnotationsInput.safeParse({ artifactId, limit: "5" }).success).toBe(false);
    expect(ListAnnotationsInput.safeParse({ artifactId, state: "closed" }).success).toBe(false);
    expect(ListAnnotationsInput.parse({ artifactId, version: "ver_1", state: "open" })).toEqual({
      artifactId,
      limit: 25,
      version: "ver_1",
      state: "open",
    });
  });

  it("normalizes the body and requires a valid target and an idempotency key to create", () => {
    const input = {
      artifactId,
      versionId: "ver_1",
      target,
      body: "  Fix this\r\nplease  ",
      idempotencyKey: "comment-0001",
    };
    expect(CreateAnnotationInput.parse(input).body).toBe("Fix this\nplease");
    const { idempotencyKey: _, ...withoutKey } = input;
    expect(CreateAnnotationInput.safeParse(withoutKey).success).toBe(false);
    expect(CreateAnnotationInput.safeParse({ ...input, body: "   " }).success).toBe(false);
    expect(
      CreateAnnotationInput.safeParse({ ...input, target: { ...target, path: "../x" } }).success,
    ).toBe(false);
    expect(
      ReplyAnnotationInput.safeParse({
        artifactId,
        threadId: "t1",
        body: "x".repeat(4_001),
        idempotencyKey: "reply-00001",
      }).success,
    ).toBe(false);
  });

  it("takes a revision to edit and the ID again to delete a thread", () => {
    expect(
      EditAnnotationInput.safeParse({ artifactId, messageId: "m1", body: "x", revision: 0 })
        .success,
    ).toBe(false);
    expect(DeleteThreadInput.safeParse({ artifactId, threadId: "t1" }).success).toBe(false);
    expect(ModerateAnnotationInput.parse({ artifactId, messageId: "m1", action: "hide" })).toEqual({
      artifactId,
      messageId: "m1",
      action: "hide",
    });
    expect(
      ModerateAnnotationInput.safeParse({ artifactId, messageId: "m1", action: "edit" }).success,
    ).toBe(false);
    expect(MessageRef.safeParse({ artifactId, messageId: "bad id" }).success).toBe(false);
    expect(ThreadRef.safeParse({ artifactId: "short", threadId: "t1" }).success).toBe(false);
    expect(SetAnnotationsInput.safeParse({ artifactId, mode: "closed" }).success).toBe(false);
  });

  it("exports JSON of the current version by default", () => {
    expect(ExportAnnotationsInput.parse({ artifactId })).toEqual({
      artifactId,
      format: "json",
      version: "current",
    });
  });

  it("describes every field for agents in the JSON Schema it advertises", () => {
    for (const schema of [
      SetAnnotationsInput,
      ListAnnotationsInput,
      ThreadRef,
      MessageRef,
      CreateAnnotationInput,
      ReplyAnnotationInput,
      EditAnnotationInput,
      ModerateAnnotationInput,
      DeleteThreadInput,
      ExportAnnotationsInput,
    ]) {
      const json = z.toJSONSchema(schema, { io: "input" }) as {
        properties: Record<string, { description?: string }>;
      };
      for (const [field, property] of Object.entries(json.properties)) {
        expect(property.description, field).toMatch(/\w/);
      }
    }
  });
});
