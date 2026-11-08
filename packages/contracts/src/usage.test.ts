import { describe, expect, it } from "vitest";
import { PublishRequest, SourceOrigin } from "./publishing.ts";
import { AccountUsageView, GetUsageInput, UsageBlock } from "./usage.ts";
import { VersionSummary } from "./versions.ts";

const COMMIT = "a".repeat(40);

describe("source origin", () => {
  it("accepts a commit, branch, remote and dirty flag, each but the flag nullable", () => {
    const origin = {
      commit: COMMIT,
      branch: "main",
      remote: "https://github.com/leynier/portifact.git",
      dirty: true,
    };
    expect(SourceOrigin.parse(origin)).toEqual(origin);
    expect(SourceOrigin.parse({ commit: null, branch: null, remote: null, dirty: false })).toEqual({
      commit: null,
      branch: null,
      remote: null,
      dirty: false,
    });
    expect(SourceOrigin.safeParse({ ...origin, commit: "b".repeat(64) }).success).toBe(true);
  });

  it("refuses malformed commits, control characters, unknown keys and a missing flag", () => {
    const base = { commit: COMMIT, branch: "main", remote: null, dirty: false };
    for (const bad of [
      { ...base, commit: "abc" },
      { ...base, commit: "A".repeat(40) },
      { ...base, branch: "" },
      { ...base, branch: "main\nx" },
      { ...base, remote: "https://example.test/\u0000" },
      { ...base, remote: "r".repeat(2_049) },
      { ...base, extra: 1 },
      { commit: COMMIT, branch: null, remote: null },
    ]) {
      expect(SourceOrigin.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("is optional in a publish request", () => {
    const request = {
      type: "site",
      name: "Site",
      entrypoint: "index.html",
      files: [{ path: "index.html", sha256: "c".repeat(64), size: 1, contentType: "text/html" }],
    };
    expect(PublishRequest.parse(request).sourceOrigin).toBeUndefined();
    const origin = { commit: null, branch: null, remote: null, dirty: false };
    expect(PublishRequest.parse({ ...request, sourceOrigin: origin }).sourceOrigin).toEqual(origin);
  });

  it("defaults to null in a version summary from a server that does not send it", () => {
    const summary = VersionSummary.parse({
      id: "ver_a",
      number: 1,
      current: true,
      entrypoint: "index.html",
      publishedBytes: 1,
      sourceBytes: 0,
      publishedFiles: 1,
      sourceFiles: 0,
      rendererVersion: null,
      committedAt: "2026-11-08T00:00:00.000Z",
      expiresAt: null,
    });
    expect(summary.sourceOrigin).toBeNull();
  });
});

describe("usage", () => {
  const meter = { used: 1, limit: 50 };
  const view = {
    activeArtifacts: meter,
    storage: { used: 10, limit: 2_500_000_000, reserved: 0 },
    publishesLast24h: meter,
    newFilesLast24h: meter,
    newBytesLast24h: meter,
    newObjectsThisMonth: { ...meter, resetsAt: "2026-12-01T00:00:00.000Z" },
    openUploads: { used: 0, limit: 2 },
    trafficThisMonth: {
      requests: { used: 1_000_000, limit: 1_000_000 },
      bytes: { used: 30_000_000_000, limit: 25_000_000_000 },
      resetsAt: "2026-12-01T00:00:00.000Z",
    },
    versionLimits: { publishedBytes: 250_000_000, files: 1_000, documentBytes: 5_000_000 },
    publicAccessFrom: "2026-11-01T00:00:00.000Z",
    blocks: [
      {
        reason: "publishes_per_24h",
        stops: "publishing",
        message: "Limit reached.",
        until: "2026-11-09T00:00:00.000Z",
      },
      {
        reason: "traffic",
        stops: "serving",
        message: "Traffic used.",
        until: "2026-12-01T00:00:00.000Z",
      },
    ],
  };

  it("parses the usage body", () => {
    expect(AccountUsageView.parse(view)).toEqual(view);
    expect(GetUsageInput.parse({})).toEqual({});
  });

  it("refuses negative counters, unknown reasons and effects", () => {
    expect(
      AccountUsageView.safeParse({ ...view, activeArtifacts: { used: -1, limit: 50 } }).success,
    ).toBe(false);
    const traffic = view.trafficThisMonth;
    for (const bad of [
      { ...traffic, bytes: { used: -1, limit: 1 } },
      { ...traffic, resetsAt: "next month" },
      { requests: traffic.requests, bytes: traffic.bytes },
    ]) {
      expect(AccountUsageView.safeParse({ ...view, trafficThisMonth: bad }).success).toBe(false);
    }
    const { trafficThisMonth: _, ...withoutTraffic } = view;
    expect(AccountUsageView.safeParse(withoutTraffic).success).toBe(false);
    const block = view.blocks[0];
    expect(UsageBlock.safeParse({ ...block, reason: "mood" }).success).toBe(false);
    expect(UsageBlock.safeParse({ ...block, stops: "everything" }).success).toBe(false);
    expect(UsageBlock.safeParse({ ...block, until: null }).success).toBe(true);
  });
});
