import { describe, expect, it } from "vitest";
import { AnnotationHistoryPage } from "./annotations.ts";
import {
  ArtifactRecords,
  EXPORT_MANIFEST_FILE,
  EXPORT_MANIFEST_FORMAT,
  ExportedIntegrationConnectionList,
  ExportedLog,
  ExportedRecordFile,
  ExportManifest,
  RecordSkipReason,
  SpaceRecords,
} from "./data-export.ts";

const sha = "a".repeat(64);
const manifest = {
  format: EXPORT_MANIFEST_FORMAT,
  space: "personal",
  ownerId: "u_owner",
  exportedAt: "2026-11-11T00:00:00.000Z",
  artifacts: [
    {
      id: "abcdefghij",
      name: "Plan",
      versions: [
        {
          id: "v_1",
          number: 1,
          current: true,
          folder: "artifacts/abcdefghij/v1",
          files: [{ kind: "published", path: "index.md", size: 5, sha256: sha }],
        },
      ],
      accessLog: { file: "artifacts/abcdefghij/access-log.jsonl", lines: 2 },
      records: { file: "artifacts/abcdefghij/records.json" },
    },
  ],
  audit: { skipped: "plan_required" },
  spaceRecords: { file: "space.json" },
  totals: { artifacts: 1, versions: 1, files: 1, bytes: 5 },
  complete: true,
};

describe("the export manifest", () => {
  it("is manifest.json in format 2", () => {
    expect(EXPORT_MANIFEST_FORMAT).toBe(2);
    expect(EXPORT_MANIFEST_FILE).toBe("manifest.json");
    expect(ExportManifest.parse(manifest)).toEqual(manifest);
  });

  it("refuses another format, a bad hash, a bad artifact ID and unknown fields", () => {
    expect(ExportManifest.safeParse({ ...manifest, format: 1 }).success).toBe(false);
    const { spaceRecords: _, ...withoutSpace } = manifest;
    expect(ExportManifest.safeParse(withoutSpace).success).toBe(false);
    const badHash = {
      ...manifest,
      artifacts: [
        {
          ...manifest.artifacts[0],
          versions: [
            {
              ...manifest.artifacts[0]?.versions[0],
              files: [{ kind: "published", path: "index.md", size: 5, sha256: "nope" }],
            },
          ],
        },
      ],
    };
    expect(ExportManifest.safeParse(badHash).success).toBe(false);
    expect(
      ExportManifest.safeParse({ ...manifest, artifacts: [{ ...manifest.artifacts[0], id: "X" }] })
        .success,
    ).toBe(false);
    expect(ExportManifest.safeParse({ ...manifest, extra: true }).success).toBe(false);
  });

  it("says a log is a file with its lines, or why it was skipped", () => {
    expect(ExportedLog.parse({ file: "audit.jsonl", lines: 0 })).toEqual({
      file: "audit.jsonl",
      lines: 0,
    });
    for (const skipped of ["forbidden", "plan_required", "not_found", "rate_limited"]) {
      expect(ExportedLog.parse({ skipped })).toEqual({ skipped });
    }
    expect(ExportedLog.safeParse({ skipped: "broken" }).success).toBe(false);
  });
});

const artifactSummary = {
  id: "abcdefghij",
  name: "Plan",
  type: "markdown",
  state: "active",
  accessMode: "restricted",
  annotations: "open",
  currentVersionId: "v_1",
  url: "https://abcdefghij.portifact.dev/",
  owner: { kind: "personal" },
  expiresAt: null,
  archivedAt: null,
  purgeAt: null,
  pinned: false,
  key: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

const artifactRecords = {
  format: 1,
  kind: "artifact",
  exportedAt: "2026-11-11T00:00:00.000Z",
  artifact: artifactSummary,
  access: { skipped: "forbidden" },
  shareLinks: { skipped: "plan_required" },
  approvalReview: { skipped: "not_found" },
  analytics: {
    retentionDays: 30,
    from: "2026-10-12",
    to: "2026-11-11",
    days: [{ date: "2026-11-11", views: 3, signedInViews: 1, visitors: null }],
  },
  comments: { skipped: "rate_limited" },
  commentHistory: [
    {
      seq: 1,
      threadId: "th_1",
      messageId: null,
      kind: "thread_resolved",
      actor: { id: "u_1", name: "Ada", image: null },
      at: "2026-11-01T00:00:00.000Z",
    },
  ],
};

const nothing = { skipped: "dashboard_only" };
const spaceRecords = {
  format: 1,
  kind: "space",
  exportedAt: "2026-11-11T00:00:00.000Z",
  space: { ownerId: "u_owner", slug: null },
  workspace: null,
  members: null,
  invitations: null,
  groups: null,
  groupMembers: null,
  emailDomains: null,
  policies: null,
  serviceTokens: null,
  githubTrust: null,
  sso: null,
  scim: null,
  branding: nothing,
  webhooks: nothing,
  integrations: nothing,
  auditStreams: nothing,
};

describe("the records files", () => {
  it("hold an artifact's parts, each a body or why it is missing", () => {
    expect(ArtifactRecords.parse(artifactRecords)).toEqual(artifactRecords);
    expect(ArtifactRecords.safeParse({ ...artifactRecords, extra: 1 }).success).toBe(false);
    expect(ArtifactRecords.safeParse({ ...artifactRecords, kind: "space" }).success).toBe(false);
    expect(
      ArtifactRecords.safeParse({ ...artifactRecords, access: { skipped: "lost" } }).success,
    ).toBe(false);
    // The history never carries text.
    expect(
      ArtifactRecords.safeParse({
        ...artifactRecords,
        commentHistory: [{ ...artifactRecords.commentHistory[0], body: "words" }],
      }).success,
    ).toBe(false);
  });

  it("hold a space's parts, null where a personal space has none", () => {
    expect(SpaceRecords.parse(spaceRecords)).toEqual(spaceRecords);
    expect(SpaceRecords.safeParse({ ...spaceRecords, branding: null }).success).toBe(false);
    expect(SpaceRecords.safeParse({ ...spaceRecords, members: nothing }).success).toBe(true);
    expect(SpaceRecords.safeParse({ ...spaceRecords, format: 2 }).success).toBe(false);
  });

  it("refuse a connection's credential hint", () => {
    const list = {
      available: true,
      serviceAvailable: true,
      slackAvailable: false,
      limit: 5,
      targetLimit: 20,
    };
    expect(ExportedIntegrationConnectionList.parse({ ...list, connections: [] })).toEqual({
      ...list,
      connections: [],
    });
    expect(
      ExportedIntegrationConnectionList.safeParse({
        ...list,
        connections: [{ credentialHint: "Ab12" }],
      }).success,
    ).toBe(false);
  });

  it("name every skip reason, dashboard_only only inside a records file", () => {
    expect(RecordSkipReason.options).toEqual([
      "forbidden",
      "plan_required",
      "not_found",
      "rate_limited",
      "unavailable",
      "dashboard_only",
    ]);
    expect(ExportedRecordFile.safeParse({ skipped: "dashboard_only" }).success).toBe(false);
    expect(ExportedRecordFile.parse({ file: "space.json" })).toEqual({ file: "space.json" });
  });

  it("page the comment history with a cursor", () => {
    const page = {
      artifactId: "abcdefghij",
      entries: artifactRecords.commentHistory,
      nextCursor: null,
    };
    expect(AnnotationHistoryPage.parse(page)).toEqual(page);
    expect(
      AnnotationHistoryPage.safeParse({
        ...page,
        entries: [{ ...page.entries[0], kind: "message_sent" }],
      }).success,
    ).toBe(false);
    for (const bad of ["th 1", "\u001b[31m", "a".repeat(65), ""]) {
      expect(
        AnnotationHistoryPage.safeParse({
          ...page,
          entries: [{ ...page.entries[0], threadId: bad }],
        }).success,
        bad,
      ).toBe(false);
      expect(
        AnnotationHistoryPage.safeParse({
          ...page,
          entries: [{ ...page.entries[0], messageId: bad }],
        }).success,
        bad,
      ).toBe(false);
    }
  });
});
