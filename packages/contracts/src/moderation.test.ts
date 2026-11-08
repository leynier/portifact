import { describe, expect, it } from "vitest";
import {
  AbuseReportInput,
  AccountDeletionInput,
  REPORT_LIMITS,
  reportedArtifactId,
} from "./moderation.ts";
import { ArtifactSummary, ERROR_STATUS } from "./publishing.ts";

describe("reported artifact", () => {
  it("accepts a bare ID or an artifact address and nothing else", () => {
    expect(reportedArtifactId(" K7D2QM4XAB ", "portifact.dev")).toBe("k7d2qm4xab");
    expect(reportedArtifactId("https://k7d2qm4xab.portifact.dev/a/b?c#d", "portifact.dev")).toBe(
      "k7d2qm4xab",
    );
    expect(reportedArtifactId("k7d2qm4xab.portifact.dev", "portifact.dev")).toBe("k7d2qm4xab");
    for (const value of [
      "",
      "k7d2qm4xa",
      "k7d2qm4xab1",
      "https://k7d2qm4xab.evil.example/",
      "https://k7d2qm4xab.portifact.dev.evil.example/",
      "https://x.k7d2qm4xab.portifact.dev/",
      "https://portifact.dev/",
      "http://[::1",
      "k7d2qm4x01.portifact.dev",
    ]) {
      expect(reportedArtifactId(value, "portifact.dev"), value).toBeNull();
    }
  });
});

describe("report input", () => {
  it("keeps the fields and lowercases the email", () => {
    expect(
      AbuseReportInput.parse({
        artifact: "k7d2qm4xab",
        reason: "phishing",
        details: " Multi\nline\tdetails ",
        email: "Me@Example.test",
      }),
    ).toEqual({
      artifact: "k7d2qm4xab",
      reason: "phishing",
      details: "Multi\nline\tdetails",
      email: "me@example.test",
    });
    expect(AbuseReportInput.parse({ artifact: "x", reason: "spam", email: "" }).email).toBe("");
  });

  it("refuses unknown reasons, extra keys, control characters and long details", () => {
    for (const body of [
      { artifact: "x", reason: "boredom" },
      { artifact: "x", reason: "spam", ownerId: "u_1" },
      { artifact: "x", reason: "spam", details: "bell\u0007" },
      { artifact: "x", reason: "spam", details: "x".repeat(REPORT_LIMITS.detailsMax + 1) },
      { artifact: "", reason: "spam" },
      { artifact: "x", reason: "spam", email: "nope" },
    ]) {
      expect(AbuseReportInput.safeParse(body).success, JSON.stringify(body).slice(0, 60)).toBe(
        false,
      );
    }
    // Code points, not UTF-16 units, are counted.
    expect(
      AbuseReportInput.safeParse({
        artifact: "x",
        reason: "spam",
        details: "😀".repeat(REPORT_LIMITS.detailsMax),
      }).success,
    ).toBe(true);
  });
});

describe("account shapes", () => {
  it("refuses deletion requests with other keys", () => {
    expect(AccountDeletionInput.safeParse({ confirmEmail: "a@b.c" }).success).toBe(true);
    expect(AccountDeletionInput.safeParse({ confirmEmail: "a@b.c", userId: "u" }).success).toBe(
      false,
    );
  });

  it("maps reauthentication to 403 and carries a suspension reason in summaries", () => {
    expect(ERROR_STATUS.reauthentication_required).toBe(403);
    const summary = {
      id: "k7d2qm4xab",
      name: "Plan",
      type: "site",
      state: "suspended",
      accessMode: "public",
      annotations: "off",
      currentVersionId: null,
      url: "https://k7d2qm4xab.portifact.dev/",
      expiresAt: null,
      archivedAt: null,
      purgeAt: null,
      createdAt: "2026-11-08T00:00:00.000Z",
      updatedAt: "2026-11-08T00:00:00.000Z",
    };
    expect(
      ArtifactSummary.parse({ ...summary, suspension: { reason: "spam" } }).suspension,
    ).toEqual({ reason: "spam" });
    expect(ArtifactSummary.safeParse({ ...summary, suspension: { reason: "x" } }).success).toBe(
      false,
    );
  });
});
