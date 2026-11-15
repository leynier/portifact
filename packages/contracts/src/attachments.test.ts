import { describe, expect, it } from "vitest";
import { CreateThreadRequest, ReplyRequest } from "./annotations.ts";
import {
  ATTACHMENT_LIMITS,
  AttachmentIds,
  AttachmentName,
  PrepareAttachmentRequest,
} from "./attachments.ts";

const SHA = "a".repeat(64);

describe("PrepareAttachmentRequest", () => {
  it("takes a name, a size and a SHA-256, and no declared type", () => {
    expect(PrepareAttachmentRequest.parse({ name: " shot.png ", size: 10, sha256: SHA })).toEqual({
      name: "shot.png",
      size: 10,
      sha256: SHA,
    });
    expect(
      PrepareAttachmentRequest.safeParse({
        name: "shot.png",
        size: 10,
        sha256: SHA,
        contentType: "image/png",
      }).success,
    ).toBe(false);
  });

  it("refuses sizes outside one file's bounds and bad hashes", () => {
    for (const size of [0, ATTACHMENT_LIMITS.fileMaxBytes + 1, 1.5]) {
      expect(PrepareAttachmentRequest.safeParse({ name: "a", size, sha256: SHA }).success).toBe(
        false,
      );
    }
    expect(
      PrepareAttachmentRequest.safeParse({ name: "a", size: 1, sha256: SHA.toUpperCase() }).success,
    ).toBe(false);
  });
});

describe("AttachmentName", () => {
  it.each(["", "   ", "a/b", "a\\b", "a\nb", "\u0000", "x".repeat(201), "\ud800"])(
    "refuses %j",
    (name) => {
      expect(AttachmentName.safeParse(name).success).toBe(false);
    },
  );

  it("keeps any other text, which stays untrusted", () => {
    expect(AttachmentName.parse("Captura de pantalla (2).png")).toBe("Captura de pantalla (2).png");
    expect(AttachmentName.parse("x".repeat(200))).toHaveLength(200);
  });
});

describe("AttachmentIds", () => {
  it("names one to four files, each once", () => {
    expect(AttachmentIds.safeParse(["a"]).success).toBe(true);
    expect(AttachmentIds.safeParse([]).success).toBe(false);
    expect(AttachmentIds.safeParse(["a", "b", "c", "d", "e"]).success).toBe(false);
    expect(AttachmentIds.safeParse(["a", "a"]).success).toBe(false);
    expect(AttachmentIds.safeParse(["../x"]).success).toBe(false);
  });

  it("is optional on a new thread and a reply", () => {
    expect(ReplyRequest.parse({ body: "Hi", attachments: ["a"] })).toEqual({
      body: "Hi",
      attachments: ["a"],
    });
    expect(ReplyRequest.parse({ body: "Hi" })).toEqual({ body: "Hi" });
    expect(
      CreateThreadRequest.safeParse({
        versionId: "v",
        target: { schema: 1, path: "index.html", anchor: { kind: "document" } },
        body: "Hi",
        attachments: [],
      }).success,
    ).toBe(false);
  });
});
