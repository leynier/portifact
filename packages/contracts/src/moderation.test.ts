import { describe, expect, it } from "vitest";
import {
  AbuseReportInput,
  AccountDeletionInput,
  DecisionSource,
  REPORT_LIMITS,
  reportedAddress,
  reportedArtifactId,
  reportedHost,
  STATEMENT_LIMITS,
  StatementText,
  SuspensionView,
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
      owner: { kind: "personal" },
      expiresAt: null,
      archivedAt: null,
      purgeAt: null,
      pinned: false,
      key: null,
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

describe("full notices and statements of reasons", () => {
  it("keeps the exact address of an artifact in full, and nothing else", () => {
    expect(
      reportedAddress("https://k7d2qm4xab.portifact.dev/A/b.html?q=1#x", "portifact.dev"),
    ).toBe("https://k7d2qm4xab.portifact.dev/A/b.html?q=1#x");
    expect(reportedAddress(" k7d2qm4xab.portifact.dev/page ", "portifact.dev")).toBe(
      "https://k7d2qm4xab.portifact.dev/page",
    );
    for (const value of [
      "k7d2qm4xab",
      "K7D2QM4XAB",
      "https://k7d2qm4xab.evil.example/",
      "ftp://k7d2qm4xab.portifact.dev/",
      "https://user:pass@k7d2qm4xab.portifact.dev/",
      "https://[bad",
      "https://k7d2qm4xab/page",
      "k7d2qm4xab/page",
      "https://k7d2qm4xab.portifact.dev.evil.example/",
      `https://k7d2qm4xab.portifact.dev/${"a".repeat(REPORT_LIMITS.addressMax)}`,
    ]) {
      expect(reportedAddress(value, "portifact.dev"), value).toBeNull();
    }
  });

  it("keeps the address on an active custom host of the artifact, and only that host", () => {
    const custom = { hostname: "docs.example.com", artifactId: "k7d2qm4xab" };
    expect(reportedAddress("https://Docs.Example.com/a?b=1", "portifact.dev", custom)).toBe(
      "https://docs.example.com/a?b=1",
    );
    expect(reportedAddress("https://other.example.com/a", "portifact.dev", custom)).toBeNull();
    expect(reportedAddress("https://docs.example.com/a", "portifact.dev", null)).toBeNull();
    expect(reportedHost(" https://Docs.Example.com/a ")).toBe("docs.example.com");
    expect(reportedHost("k7d2qm4xab")).toBeNull();
    expect(reportedHost("https://[bad")).toBeNull();
  });

  it("takes the notice's parts as optional, and refuses a bad name, statement or language", () => {
    const base = { artifact: "k7d2qm4xab", reason: "spam" };
    expect(
      AbuseReportInput.parse({ ...base, name: " Ada ", confirmed: true, locale: "pt-BR" }),
    ).toMatchObject({ name: "Ada", confirmed: true, locale: "pt-BR" });
    for (const extra of [
      { name: "two\nlines" },
      { name: "x".repeat(REPORT_LIMITS.nameMax + 1) },
      { name: "bell\u0007" },
      { confirmed: false },
      { locale: "xx" },
    ]) {
      expect(AbuseReportInput.safeParse({ ...base, ...extra }).success, JSON.stringify(extra)).toBe(
        false,
      );
    }
  });

  it("bounds the operator's statement and requires both parts", () => {
    expect(StatementText.parse({ facts: " Facts\nmore ", ground: " Rule " })).toEqual({
      facts: "Facts\nmore",
      ground: "Rule",
    });
    for (const value of [
      { facts: "", ground: "Rule" },
      { facts: "Facts", ground: "  " },
      { facts: "x".repeat(STATEMENT_LIMITS.factsMax + 1), ground: "Rule" },
      { facts: "Facts", ground: "x".repeat(STATEMENT_LIMITS.groundMax + 1) },
      { facts: "bell\u0007", ground: "Rule" },
    ]) {
      expect(StatementText.safeParse(value).success).toBe(false);
    }
    expect(DecisionSource.options).toEqual(["notice", "review"]);
    expect(
      SuspensionView.parse({
        reason: "spam",
        statement: {
          facts: "f",
          ground: "g",
          source: "review",
          decidedAt: "2026-11-08T12:00:00.000Z",
        },
      }).statement,
    ).toMatchObject({ source: "review" });
    expect(SuspensionView.parse({ reason: "spam" }).statement).toBeUndefined();
  });
});
