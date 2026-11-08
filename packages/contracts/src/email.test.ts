import { describe, expect, it } from "vitest";
import { DocumentPreview, DocumentPreviewRequest, PREVIEW_LIMIT } from "./documents.ts";
import { EMAIL_SUPPRESSED, EmailSendingEvent, EmailSuppressionReason } from "./email.ts";
import { LIMITS } from "./limits.ts";

const event = {
  type: "message.bounced",
  payload: { eventId: "evt_1", recipient: "a@b", bounce: { type: "hard" } },
};

describe("email delivery contracts", () => {
  it("names the refusal and the suppression reasons", () => {
    expect(EMAIL_SUPPRESSED).toBe("email_suppressed");
    expect(EmailSuppressionReason.options).toEqual(["hard_bounce", "complaint", "provider"]);
    expect(EmailSuppressionReason.safeParse("soft_bounce").success).toBe(false);
  });

  it("reads an Email Service event and keeps fields it does not act on", () => {
    const withExtra = { ...event, extra: 1, payload: { ...event.payload, more: "x" } };
    expect(EmailSendingEvent.parse(withExtra)).toEqual(withExtra);
    expect(
      EmailSendingEvent.parse({ type: "message.complained", payload: { recipient: "a@b" } }),
    ).toEqual({ type: "message.complained", payload: { recipient: "a@b" } });
  });

  it("bounds every field it reads", () => {
    const at = (payload: object, type = event.type) =>
      EmailSendingEvent.safeParse({ type, payload: { ...event.payload, ...payload } }).success;
    expect(at({}, "t".repeat(200))).toBe(true);
    expect(at({}, "t".repeat(201))).toBe(false);
    expect(at({}, "")).toBe(false);
    expect(at({ eventId: "e".repeat(200) })).toBe(true);
    expect(at({ eventId: "e".repeat(201) })).toBe(false);
    expect(at({ recipient: "a".repeat(320) })).toBe(true);
    expect(at({ recipient: "a".repeat(321) })).toBe(false);
    expect(at({ recipient: "ab" })).toBe(false);
    expect(at({ bounce: { type: "b".repeat(50) } })).toBe(true);
    expect(at({ bounce: { type: "b".repeat(51) } })).toBe(false);
    expect(at({ bounce: 1 })).toBe(false);
    expect(EmailSendingEvent.safeParse({ type: "message.bounced" }).success).toBe(false);
  });
});

describe("document preview contracts", () => {
  it("previews Markdown or TXT with a trimmed title", () => {
    expect(DocumentPreviewRequest.parse({ type: "text", name: " Notes ", source: "" })).toEqual({
      type: "text",
      name: "Notes",
      source: "",
    });
    expect(
      DocumentPreviewRequest.parse({ type: "markdown", name: "n".repeat(200), source: "# A" }).type,
    ).toBe("markdown");
  });

  it("refuses other types, blank or long titles, oversized sources and extra fields", () => {
    const request = { type: "markdown", name: "Notes", source: "# A" };
    expect(
      DocumentPreviewRequest.safeParse({ ...request, source: "a".repeat(LIMITS.documentBytes) })
        .success,
    ).toBe(true);
    for (const bad of [
      { type: "site" },
      { name: "   " },
      { name: "n".repeat(201) },
      { source: "a".repeat(LIMITS.documentBytes + 1) },
      { extra: true },
    ]) {
      expect(
        DocumentPreviewRequest.safeParse({ ...request, ...bad }).success,
        JSON.stringify(bad).slice(0, 80),
      ).toBe(false);
    }
  });

  it("returns the page and the renderer that made it, within a rate limit", () => {
    const preview = { html: "<p>A</p>", rendererVersion: "markdown-it@14/1" };
    expect(DocumentPreview.parse(preview)).toEqual(preview);
    expect(DocumentPreview.safeParse({ html: "<p>A</p>" }).success).toBe(false);
    expect(PREVIEW_LIMIT).toEqual({ requests: 120, windowMs: 600_000 });
  });
});
