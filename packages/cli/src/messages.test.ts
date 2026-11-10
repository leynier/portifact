import { describe, expect, it } from "vitest";
import { formatBytes, formatDate, formatExpiry, messages } from "./messages.ts";

describe("formatBytes", () => {
  it("uses decimal units, as the product limits do", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1000)).toBe("1.0 kB");
    expect(formatBytes(1_500_000)).toBe("1.5 MB");
    expect(formatBytes(2_500_000_000)).toBe("2.5 GB");
  });
});

describe("formatDate", () => {
  it("shows an instant in UTC to the minute, and never for none", () => {
    expect(formatDate("2026-12-08T12:34:56.000Z")).toBe("2026-12-08 12:34 UTC");
    expect(formatDate(null)).toBe("never");
  });
});

describe("formatExpiry", () => {
  it("shows a date, or that a pinned artifact never expires", () => {
    expect(formatExpiry("2026-12-08T12:34:56.000Z")).toBe("2026-12-08 12:34 UTC");
    expect(formatExpiry(null)).toBe("never (pinned)");
    expect(messages.published("https://x/", "a", 2, null)).toContain("Expires: never (pinned)");
    expect(messages.rolledBack("a", 3, 1, "https://x/", null)).toContain("Expires: never (pinned)");
  });
});

describe("messages", () => {
  it("uses singular and plural forms", () => {
    expect(messages.manifestHeader(1, 10, "text")).toBe("1 file (10 B) to publish as text:");
    expect(messages.excludedHeader(1)).toBe("Left out 1 entry by default:");
    expect(messages.prepared(2, 1, 1, 5)).toBe("Prepared version 2. Uploading 1 of 1 file (5 B).");
  });

  it("omits the purge date when an archive has none", () => {
    expect(messages.archived("abcdefghij", null)).toBe(
      "Archived abcdefghij. Restore it with `portifact restore abcdefghij`.",
    );
  });
});
