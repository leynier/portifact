import type {
  AnnotationExport,
  AnnotationHistoryEntry,
  ArtifactStatsView,
  ArtifactSummary,
  ChangeItemView,
  IntegrationConnectionList,
  WorkspaceGroupDetail,
  WorkspaceGroupList,
} from "@portifact/contracts";
import { ANALYTICS } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import { parseDay } from "./analytics.ts";
import {
  type ArtifactRecordReads,
  collectArtifactRecords,
  collectSpaceRecords,
  isSkipped,
  recordsRetryLater,
  type SpaceRecordReads,
  statsWindows,
} from "./data-records.ts";

const NOW = Date.parse("2026-11-12T10:00:00.000Z");
const artifact = { id: "abcdefghij", name: "Plan" } as unknown as ArtifactSummary;
const DAY = 86_400_000;

function day(date: string, views: number) {
  return { date, views, signedInViews: 0, visitors: null };
}

function stats(from: string, to: string, retentionDays: number): ArtifactStatsView {
  const days = [];
  for (let at = parseDay(from); at <= parseDay(to); at += DAY) {
    days.push(day(new Date(at).toISOString().slice(0, 10), 1));
  }
  return {
    artifactId: "abcdefghij",
    from,
    to,
    days,
    totals: { views: days.length, signedInViews: 0, visitors: null },
    retentionDays,
  };
}

function entry(seq: number): AnnotationHistoryEntry {
  return {
    seq,
    threadId: "t1",
    messageId: null,
    kind: "thread_created",
    actor: null,
    at: "2026-11-01T00:00:00.000Z",
  };
}

function item(id: string): ChangeItemView {
  return {
    id,
    artifactId: "abcdefghij",
    origin: "suggestion",
    threadId: null,
    versionId: "ver_1",
    path: "index.md",
    route: null,
    envelope: { format: 2 },
    reason: "spans_nodes",
    state: "open",
    createdAt: 1,
    closedAt: null,
    closedVersionId: null,
    revision: 1,
  };
}

function reads(overrides: Partial<ArtifactRecordReads> = {}) {
  const calls: string[] = [];
  const base: ArtifactRecordReads = {
    access: async () => ({ skipped: "forbidden" }),
    shareLinks: async () => ({ skipped: "plan_required" }),
    approvalReview: async () => ({ skipped: "not_found" }),
    stats: async (range) => {
      calls.push(`stats:${range ? `${range.from}..${range.to}` : "default"}`);
      return range ? stats(range.from, range.to, 30) : stats("2026-10-14", "2026-11-12", 30);
    },
    comments: async (version) => {
      calls.push(`comments:${version}`);
      return { threads: [], version } as unknown as AnnotationExport;
    },
    commentHistory: async (cursor) => {
      calls.push(`history:${cursor ?? "start"}`);
      return cursor === undefined
        ? { artifactId: "abcdefghij", entries: [entry(1), entry(2)], nextCursor: "c2" }
        : { artifactId: "abcdefghij", entries: [entry(3)], nextCursor: null };
    },
    changeItems: async (cursor) => {
      calls.push(`changes:${cursor ?? "start"}`);
      return cursor === undefined
        ? { items: [item("chg_1"), item("chg_2")], nextCursor: "n2" }
        : { items: [item("chg_3")], nextCursor: null };
    },
  };
  return { reads: { ...base, ...overrides }, calls };
}

describe("statsWindows", () => {
  it("covers every kept day up to today in one range when it fits", () => {
    expect(statsWindows("2026-11-12", 30)).toEqual([{ from: "2026-10-13", to: "2026-11-12" }]);
    expect(statsWindows("2026-11-12", 365)).toEqual([{ from: "2025-11-12", to: "2026-11-12" }]);
  });

  it("splits a longer retention into contiguous ranges no longer than the route allows", () => {
    const windows = statsWindows("2026-11-12", 800);
    expect(windows).toHaveLength(3);
    expect(windows[0]?.from).toBe("2024-09-03");
    expect(windows.at(-1)?.to).toBe("2026-11-12");
    for (const [i, window] of windows.entries()) {
      const length = (parseDay(window.to) - parseDay(window.from)) / DAY + 1;
      expect(length).toBeLessThanOrEqual(ANALYTICS.maxRangeDays);
      const next = windows[i + 1];
      if (next) expect(parseDay(next.from) - parseDay(window.to)).toBe(DAY);
    }
  });
});

describe("collectArtifactRecords", () => {
  it("records why the change list is missing, and stops at an empty page", async () => {
    const off = reads({ changeItems: async () => ({ skipped: "unavailable" }) });
    expect((await collectArtifactRecords(artifact, off.reads, NOW)).changeList).toEqual({
      skipped: "unavailable",
    });
    let pages = 0;
    const stuck = reads({
      changeItems: async (cursor) => {
        pages++;
        return cursor === undefined
          ? { items: [item("chg_1")], nextCursor: "again" }
          : { items: [], nextCursor: "again" };
      },
    });
    expect((await collectArtifactRecords(artifact, stuck.reads, NOW)).changeList).toEqual([
      item("chg_1"),
    ]);
    expect(pages).toBe(2);
    const refused = reads({
      changeItems: async (cursor) =>
        cursor === undefined
          ? { items: [item("chg_1")], nextCursor: "n2" }
          : { skipped: "rate_limited" },
    });
    expect((await collectArtifactRecords(artifact, refused.reads, NOW)).changeList).toEqual({
      skipped: "rate_limited",
    });
  });

  it("reads every part, every retained day and every history page", async () => {
    const { reads: r, calls } = reads();
    const records = await collectArtifactRecords(artifact, r, NOW);
    expect(records).toMatchObject({
      format: 1,
      kind: "artifact",
      exportedAt: "2026-11-12T10:00:00.000Z",
      artifact,
      access: { skipped: "forbidden" },
      shareLinks: { skipped: "plan_required" },
      approvalReview: { skipped: "not_found" },
      comments: { version: "all" },
    });
    expect(records.commentHistory).toEqual([entry(1), entry(2), entry(3)]);
    expect(records.analytics).toMatchObject({
      retentionDays: 30,
      from: "2026-10-13",
      to: "2026-11-12",
    });
    if (isSkipped(records.analytics)) throw new Error("analytics skipped");
    expect(records.analytics.days).toHaveLength(31);
    expect(calls).toEqual([
      "stats:default",
      "stats:2026-10-13..2026-11-12",
      "comments:all",
      "history:start",
      "history:c2",
      "changes:start",
      "changes:n2",
    ]);
    expect(records.changeList).toEqual([item("chg_1"), item("chg_2"), item("chg_3")]);
  });

  it("merges overlapping days once, oldest first", async () => {
    const { reads: r } = reads({
      stats: async (range) =>
        range === undefined
          ? stats("2026-11-11", "2026-11-12", 800)
          : stats(range.from, range.to, 800),
    });
    const records = await collectArtifactRecords(artifact, r, NOW);
    if (isSkipped(records.analytics)) throw new Error("analytics skipped");
    const dates = records.analytics.days.map((d) => d.date);
    expect(new Set(dates).size).toBe(dates.length);
    expect(dates).toEqual([...dates].sort());
    expect(dates).toHaveLength(801);
  });

  it("falls back to the current version's threads when every version is refused", async () => {
    const { reads: r, calls } = reads({
      comments: async (version) => {
        calls.push(`comments:${version}`);
        return version === "all"
          ? { skipped: "forbidden" }
          : ({ version } as unknown as AnnotationExport);
      },
    });
    const records = await collectArtifactRecords(artifact, r, NOW);
    expect(records.comments).toEqual({ version: "current" });
    expect(calls.filter((c) => c.startsWith("comments"))).toEqual([
      "comments:all",
      "comments:current",
    ]);
  });

  it("keeps other refusals of the comments as they are", async () => {
    const { reads: r, calls } = reads({
      comments: async (version) => {
        calls.push(`comments:${version}`);
        return { skipped: "rate_limited" };
      },
    });
    const records = await collectArtifactRecords(artifact, r, NOW);
    expect(records.comments).toEqual({ skipped: "rate_limited" });
    expect(calls.filter((c) => c.startsWith("comments"))).toEqual(["comments:all"]);
    expect(recordsRetryLater(records)).toBe(true);
  });

  it("records why analytics or the history are missing", async () => {
    const { reads: first } = reads({
      stats: async () => ({ skipped: "plan_required" }),
      commentHistory: async () => ({ skipped: "forbidden" }),
    });
    const records = await collectArtifactRecords(artifact, first, NOW);
    expect(records.analytics).toEqual({ skipped: "plan_required" });
    expect(records.commentHistory).toEqual({ skipped: "forbidden" });
    expect(recordsRetryLater(records)).toBe(false);

    const { reads: later } = reads({
      stats: async (range) =>
        range ? { skipped: "rate_limited" } : stats("2026-10-14", "2026-11-12", 30),
    });
    expect((await collectArtifactRecords(artifact, later, NOW)).analytics).toEqual({
      skipped: "rate_limited",
    });
  });

  it("stops paging the history at an empty page", async () => {
    let calls = 0;
    const { reads: r } = reads({
      commentHistory: async () => {
        calls += 1;
        return { artifactId: "abcdefghij", entries: [], nextCursor: "again" };
      },
    });
    expect((await collectArtifactRecords(artifact, r, NOW)).commentHistory).toEqual([]);
    expect(calls).toBe(1);
  });
});

function spaceReads(overrides: Partial<SpaceRecordReads> = {}) {
  const calls: string[] = [];
  const skip = (name: string) => async () => {
    calls.push(name);
    return { skipped: "dashboard_only" as const };
  };
  const base: SpaceRecordReads = {
    workspace: skip("workspace"),
    members: skip("members"),
    invitations: skip("invitations"),
    groups: async () => {
      calls.push("groups");
      return {
        items: [{ id: "g1" }, { id: "g2" }, { id: "g3" }],
        available: true,
        limit: 50,
      } as unknown as WorkspaceGroupList;
    },
    group: async (id) => {
      calls.push(`group:${id}`);
      return id === "g2"
        ? { skipped: "not_found" }
        : ({ id, members: [] } as unknown as WorkspaceGroupDetail);
    },
    emailDomains: skip("emailDomains"),
    policies: skip("policies"),
    serviceTokens: skip("serviceTokens"),
    githubTrust: skip("githubTrust"),
    sso: skip("sso"),
    scim: skip("scim"),
    branding: skip("branding"),
    webhooks: skip("webhooks"),
    integrations: skip("integrations"),
    auditStreams: skip("auditStreams"),
  };
  return { reads: { ...base, ...overrides }, calls };
}

describe("collectSpaceRecords", () => {
  it("reads only the parts a personal space has", async () => {
    const { reads: r, calls } = spaceReads();
    const records = await collectSpaceRecords({ ownerId: "u_1", slug: null }, r, NOW);
    expect(calls).toEqual(["branding", "webhooks", "integrations", "auditStreams"]);
    expect(records).toMatchObject({
      format: 1,
      kind: "space",
      space: { ownerId: "u_1", slug: null },
      workspace: null,
      members: null,
      groups: null,
      groupMembers: null,
      branding: { skipped: "dashboard_only" },
    });
  });

  it("reads each group's members and leaves out a group removed meanwhile", async () => {
    const { reads: r, calls } = spaceReads();
    const records = await collectSpaceRecords({ ownerId: "ws_1", slug: "acme" }, r, NOW);
    expect(records.groupMembers).toEqual([
      { id: "g1", members: [] },
      { id: "g3", members: [] },
    ]);
    expect(calls).toContain("group:g2");
    expect(records.members).toEqual({ skipped: "dashboard_only" });
    expect(recordsRetryLater(records)).toBe(false);
  });

  it("leaves every connection's credential hint out, and keeps the rest", async () => {
    const { reads: r } = spaceReads({
      integrations: async () =>
        ({
          connections: [
            { id: "c1", identity: "octo-bot", credentialHint: "Ab12", service: "github" },
          ],
          available: true,
          serviceAvailable: true,
          slackAvailable: false,
          limit: 5,
          targetLimit: 20,
        }) as unknown as IntegrationConnectionList,
    });
    const records = await collectSpaceRecords({ ownerId: "u_1", slug: null }, r, NOW);
    expect(records.integrations).toEqual({
      connections: [{ id: "c1", identity: "octo-bot", service: "github" }],
      available: true,
      serviceAvailable: true,
      slackAvailable: false,
      limit: 5,
      targetLimit: 20,
    });
    expect(JSON.stringify(records)).not.toContain("Ab12");
  });

  it("records one refusal for every group's members", async () => {
    const forbidden = spaceReads({ group: async () => ({ skipped: "forbidden" }) });
    expect(
      (await collectSpaceRecords({ ownerId: "ws_1", slug: "acme" }, forbidden.reads, NOW))
        .groupMembers,
    ).toEqual({ skipped: "forbidden" });
    const noGroups = spaceReads({ groups: async () => ({ skipped: "rate_limited" }) });
    const records = await collectSpaceRecords(
      { ownerId: "ws_1", slug: "acme" },
      noGroups.reads,
      NOW,
    );
    expect(records.groupMembers).toEqual({ skipped: "rate_limited" });
    expect(recordsRetryLater(records)).toBe(true);
  });
});
