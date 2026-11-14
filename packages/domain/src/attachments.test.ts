import { readFileSync } from "node:fs";
import { ATTACHMENT_LIMITS } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  attachmentDisposition,
  attachmentKey,
  attachmentsEnabled,
  downloadFileName,
  isAttachmentKey,
  mayBeText,
  sniffAttachment,
} from "./attachments.ts";

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);

describe("sniffAttachment", () => {
  it.each([
    ["image/png", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0)],
    ["image/jpeg", bytes(0xff, 0xd8, 0xff, 0xe0)],
    ["image/gif", text("GIF89a....")],
    ["image/gif", text("GIF87a....")],
    ["image/webp", text("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ")],
    ["application/pdf", text("%PDF-1.7\n")],
  ])("recognizes %s by its first bytes", (type, start) => {
    expect(sniffAttachment(start, 1_000_000, false)).toBe(type);
  });

  it("judges the bytes, never a name: an HTML file is refused whatever it is called", () => {
    const page = text("<!doctype html><script>alert(1)</script>");
    expect(sniffAttachment(page, page.length, false)).toBeNull();
    // Read whole it is valid UTF-8, so it is text, downloaded as text, never a page.
    expect(sniffAttachment(page, page.length, true)).toBe("text/plain");
  });

  it("refuses SVG unless it is only text read whole", () => {
    const svg = text('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    expect(sniffAttachment(svg, svg.length, false)).toBeNull();
  });

  it("recognizes text only from the whole file", () => {
    const note = text("Steps to reproduce:\n1. Open the page\n");
    expect(sniffAttachment(note, note.length, true)).toBe("text/plain");
    expect(sniffAttachment(note.slice(0, 8), note.length, false)).toBeNull();
    // A partial read is never taken as the whole file.
    expect(sniffAttachment(note.slice(0, 8), note.length, true)).toBeNull();
  });

  it("refuses text with NUL, invalid UTF-8 or over the text limit", () => {
    expect(sniffAttachment(bytes(0x61, 0, 0x62), 3, true)).toBeNull();
    expect(sniffAttachment(bytes(0x61, 0xc3, 0x28), 3, true)).toBeNull();
    const big = new Uint8Array(ATTACHMENT_LIMITS.textMaxBytes + 1).fill(0x61);
    expect(sniffAttachment(big, big.length, true)).toBeNull();
    const exact = new Uint8Array(ATTACHMENT_LIMITS.textMaxBytes).fill(0x61);
    expect(sniffAttachment(exact, exact.length, true)).toBe("text/plain");
  });

  it("refuses empty files and truncated signatures", () => {
    expect(sniffAttachment(new Uint8Array(), 0, true)).toBeNull();
    expect(sniffAttachment(bytes(0x89, 0x50, 0x4e), 3, false)).toBeNull();
    expect(sniffAttachment(text("RIFF\u0000\u0000\u0000\u0000WAVE"), 100, false)).toBeNull();
  });
});

describe("mayBeText", () => {
  it("is true only up to the text limit", () => {
    expect(mayBeText(1)).toBe(true);
    expect(mayBeText(ATTACHMENT_LIMITS.textMaxBytes)).toBe(true);
    expect(mayBeText(ATTACHMENT_LIMITS.textMaxBytes + 1)).toBe(false);
    expect(mayBeText(0)).toBe(false);
  });
});

describe("downloadFileName", () => {
  it("keeps a name whose extension fits its bytes", () => {
    expect(downloadFileName("shot.PNG", "image/png")).toBe("shot.PNG");
    expect(downloadFileName("photo.jpeg", "image/jpeg")).toBe("photo.jpeg");
  });

  it("appends the bytes' extension otherwise", () => {
    expect(downloadFileName("report.html", "image/png")).toBe("report.html.png");
    expect(downloadFileName("notes", "text/plain")).toBe("notes.txt");
    expect(downloadFileName("invoice.pdf.exe", "application/pdf")).toBe("invoice.pdf.exe.pdf");
  });
});

describe("attachmentDisposition", () => {
  it("is an attachment with an encoded name only", () => {
    expect(attachmentDisposition('a "b"; c.png', "image/png")).toBe(
      "attachment; filename*=UTF-8''a%20%22b%22%3B%20c.png",
    );
    expect(attachmentDisposition("ñ (1)", "application/pdf")).toBe(
      "attachment; filename*=UTF-8''%C3%B1%20%281%29.pdf",
    );
  });
});

describe("keys and the switch", () => {
  it("derives the key from the artifact and the ID", () => {
    expect(attachmentKey("art1", "at1")).toBe("attachments/art1/at1");
    expect(isAttachmentKey("attachments/art1/at1")).toBe(true);
    expect(isAttachmentKey("objects/o/sha")).toBe(false);
  });

  it("is on only for exactly true", () => {
    expect(attachmentsEnabled({ ATTACHMENTS_ENABLED: "true" })).toBe(true);
    expect(attachmentsEnabled({ ATTACHMENTS_ENABLED: "TRUE" })).toBe(false);
    expect(attachmentsEnabled({})).toBe(false);
  });
});

describe("the attachments switch in deployed configuration", () => {
  it("is in no deployed Worker configuration", () => {
    for (const app of ["app", "content", "jobs", "web", "data"]) {
      let config: string;
      try {
        config = readFileSync(
          new URL(`../../../apps/${app}/wrangler.jsonc`, import.meta.url),
          "utf8",
        );
      } catch {
        continue;
      }
      expect(config, app).not.toContain("ATTACHMENTS_ENABLED");
    }
  });
});
