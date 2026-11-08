import { describe, expect, it } from "vitest";
import {
  ACCESS_LOG,
  AccessLogQuery,
  AccessLogView,
  EraseAccessEventsPayload,
  GetAccessLogsInput,
  JobMessage,
} from "./index.ts";

describe("access log contracts", () => {
  it("keeps one entry per visitor every 30 minutes for 30 days", () => {
    expect(ACCESS_LOG).toEqual({ windowMinutes: 30, retentionDays: 30, pageSize: 100 });
  });

  it("reads the API query from strings, with a default page of 50", () => {
    expect(AccessLogQuery.parse({})).toEqual({ limit: 50 });
    expect(
      AccessLogQuery.parse({ limit: "100", cursor: "abc", since: "2026-11-01T00:00:00Z" }),
    ).toEqual({ limit: 100, cursor: "abc", since: "2026-11-01T00:00:00Z" });
    for (const bad of [
      { limit: "0" },
      { limit: "101" },
      { limit: "1.5" },
      { limit: "x" },
      { since: "yesterday" },
      { since: "2026-11-01" },
      { cursor: "c".repeat(201) },
    ]) {
      expect(AccessLogQuery.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("takes the MCP input with the artifact ID and the same bounds", () => {
    expect(GetAccessLogsInput.parse({ artifactId: "k7d2qm4xab" })).toEqual({
      artifactId: "k7d2qm4xab",
      limit: 50,
    });
    for (const bad of [
      {},
      { artifactId: "nope" },
      { artifactId: "k7d2qm4xab", limit: 101 },
      { artifactId: "k7d2qm4xab", limit: "5" },
      { artifactId: "k7d2qm4xab", since: "7d" },
    ]) {
      expect(GetAccessLogsInput.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("describes a page of entries with ISO times", () => {
    const view = {
      artifactId: "k7d2qm4xab",
      entries: [{ email: "ana@example.com", openedAt: "2026-11-08T12:00:00.000Z" }],
      nextCursor: null,
      windowMinutes: 30,
      retentionDays: 30,
    };
    expect(AccessLogView.parse(view)).toEqual(view);
    expect(
      AccessLogView.safeParse({ ...view, entries: [{ email: "a", openedAt: 1 }] }).success,
    ).toBe(false);
  });

  it("erases by artifact or by account, and queues the job like any other", () => {
    expect(EraseAccessEventsPayload.parse({ kind: "artifact" })).toEqual({ kind: "artifact" });
    expect(EraseAccessEventsPayload.parse({ kind: "user" })).toEqual({ kind: "user" });
    expect(EraseAccessEventsPayload.safeParse({ kind: "owner" }).success).toBe(false);
    expect(EraseAccessEventsPayload.safeParse({ kind: "user", id: "u" }).success).toBe(false);
    expect(JobMessage.parse({ id: 3, topic: "erase_access_events" }).topic).toBe(
      "erase_access_events",
    );
  });
});
