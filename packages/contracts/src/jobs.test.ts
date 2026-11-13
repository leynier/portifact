import { describe, expect, it } from "vitest";
import {
  AcceptancePayload,
  COMMENT_NOTICE_THREADS_MAX,
  CommentNoticePayload,
  DeleteObjectsPayload,
  DomainNoticePayload,
  EXPIRY_NOTICE_ARTIFACTS_MAX,
  ExpiryNoticePayload,
  JobMessage,
  LegalHoldLine,
  LIMITS,
  OutboxTopic,
  ReviewNoticePayload,
  TombstoneMarker,
  VersionJobPayload,
} from "./index.ts";

describe("job contracts", () => {
  it("accepts a queue message that points at an outbox row", () => {
    expect(JobMessage.parse({ id: 7, topic: "purge_artifact" })).toEqual({
      id: 7,
      topic: "purge_artifact",
    });
  });

  it("refuses messages with unknown topics, bad ids or extra fields", () => {
    for (const bad of [
      { id: 7, topic: "drop_tables" },
      { id: 0, topic: "purge_artifact" },
      { id: 1.5, topic: "purge_artifact" },
      { id: 7, topic: "purge_artifact", artifactId: "k7d2qm4xab" },
      "7",
    ]) {
      expect(JobMessage.safeParse(bad).success).toBe(false);
    }
  });

  it("bounds the keys of a delete_objects payload", () => {
    expect(DeleteObjectsPayload.safeParse({ keys: ["objects/u/a"] }).success).toBe(true);
    expect(DeleteObjectsPayload.safeParse({ keys: [""] }).success).toBe(false);
    expect(DeleteObjectsPayload.safeParse({ keys: Array(101).fill("k") }).success).toBe(false);
  });

  it("bounds the artifacts of an expiry_notice payload by its safety cap, above the free plan", () => {
    const entry = { id: "k7d2qm4xab", expiresAt: 1 };
    expect(JobMessage.parse({ id: 3, topic: "expiry_notice" }).topic).toBe("expiry_notice");
    expect(ExpiryNoticePayload.parse({ artifacts: [entry] })).toEqual({ artifacts: [entry] });
    expect(ExpiryNoticePayload.safeParse({ artifacts: [] }).success).toBe(false);
    expect(EXPIRY_NOTICE_ARTIFACTS_MAX).toBeGreaterThan(LIMITS.activeArtifacts);
    const full = Array(EXPIRY_NOTICE_ARTIFACTS_MAX).fill(entry);
    expect(ExpiryNoticePayload.safeParse({ artifacts: full }).success).toBe(true);
    expect(ExpiryNoticePayload.safeParse({ artifacts: [...full, entry] }).success).toBe(false);
    expect(
      ExpiryNoticePayload.safeParse({ artifacts: [{ ...entry, expiresAt: -1 }] }).success,
    ).toBe(false);
    expect(ExpiryNoticePayload.safeParse({ artifacts: [{ ...entry, name: "x" }] }).success).toBe(
      false,
    );
  });

  it("accepts only artifact and account tombstone markers", () => {
    const marker = { kind: "artifact", id: "k7d2qm4xab", deletedAt: 1 };
    expect(TombstoneMarker.parse(marker)).toEqual(marker);
    expect(TombstoneMarker.safeParse({ ...marker, kind: "version" }).success).toBe(false);
    expect(TombstoneMarker.parse({ ...marker, kind: "workspace" }).kind).toBe("workspace");
    expect(OutboxTopic.options).toEqual([
      "purge_artifact",
      "account_deletion",
      "delete_objects",
      "abort_multipart",
      "erase_access_events",
      "expiry_notice",
      "comment_notice",
      "owner_retention",
      "webhook_delivery",
      "delete_custom_hostname",
      "workspace_deletion",
      "access_history_move",
      "domain_notice",
      "search_index",
      "review_notice",
      "workspace_policy",
      "directory_notice",
      "thread_issue",
      "plan_region",
      "audit_stream",
      "retention_notice",
      "plan_grace_notice",
      "comment_retention_notice",
      "comment_tombstones",
      "moderation_notice",
      "report_outcome",
      "legal_hold_release",
      "suggestion_accept",
      "draft_publish",
      "suggestion_carry",
      "change_list_check",
    ]);
    for (const kind of [
      "artifact",
      "account",
      "share_link",
      "workspace",
      "webhook",
      "integration_connection",
    ]) {
      expect(TombstoneMarker.parse({ ...marker, kind }).kind).toBe(kind);
    }
    expect(JobMessage.parse({ id: 1, topic: "workspace_deletion" }).topic).toBe(
      "workspace_deletion",
    );
    expect(TombstoneMarker.safeParse({ ...marker, deletedAt: -1 }).success).toBe(false);
    expect(TombstoneMarker.safeParse({ ...marker, extra: true }).success).toBe(false);
  });
});

describe("CommentNoticePayload", () => {
  const thread = {
    artifactId: "k7d2qm4xab",
    threadId: "8b7e2c1a-thread",
    created: 1,
    replies: 3,
    resolved: 0,
  };

  it("carries IDs and counts only, up to the cap", () => {
    expect(CommentNoticePayload.parse({ claim: "claim-1", threads: [thread] })).toEqual({
      claim: "claim-1",
      threads: [thread],
    });
    expect(CommentNoticePayload.safeParse({ claim: "", threads: [thread] }).success).toBe(false);
    expect(CommentNoticePayload.safeParse({ claim: "c", threads: [] }).success).toBe(false);
    expect(CommentNoticePayload.safeParse({ threads: [thread] }).success).toBe(false);
    const full = Array(COMMENT_NOTICE_THREADS_MAX).fill(thread);
    expect(CommentNoticePayload.safeParse({ claim: "c", threads: full }).success).toBe(true);
    expect(CommentNoticePayload.safeParse({ claim: "c", threads: [...full, thread] }).success).toBe(
      false,
    );
    for (const wrong of [
      { ...thread, created: 2 },
      { ...thread, resolved: -1 },
      { ...thread, replies: 201 },
      { ...thread, body: "text" },
      { ...thread, artifactId: "" },
      { ...thread, threadId: "" },
    ]) {
      expect(CommentNoticePayload.safeParse({ claim: "c", threads: [wrong] }).success).toBe(false);
    }
  });

  it("is a topic of the outbox", () => {
    expect(OutboxTopic.parse("comment_notice")).toBe("comment_notice");
  });
});

describe("DomainNoticePayload", () => {
  const ok = { hostnames: ["docs.example.com"], detachAt: 1_800_000_000_000 };

  it("carries hostnames and the detach time only", () => {
    expect(DomainNoticePayload.parse(ok)).toEqual(ok);
    expect(DomainNoticePayload.safeParse({ ...ok, text: "x" }).success).toBe(false);
  });

  it("refuses empty, oversized and malformed lists and times", () => {
    for (const hostnames of [[], [""], ["a".repeat(254)], Array(101).fill("a.example")]) {
      expect(DomainNoticePayload.safeParse({ ...ok, hostnames }).success).toBe(false);
    }
    expect(DomainNoticePayload.safeParse({ ...ok, hostnames: ["a".repeat(253)] }).success).toBe(
      true,
    );
    expect(
      DomainNoticePayload.safeParse({ ...ok, hostnames: Array(100).fill("a.example") }).success,
    ).toBe(true);
    for (const detachAt of [-1, 1.5]) {
      expect(DomainNoticePayload.safeParse({ ...ok, detachAt }).success).toBe(false);
    }
    expect(DomainNoticePayload.safeParse({ ...ok, detachAt: 0 }).success).toBe(true);
  });
});

describe("ReviewNoticePayload", () => {
  it("holds IDs, a time and a status, and nothing else", () => {
    const event = { stage: "event", kind: "requested", versionId: "v1", addedAt: 1 };
    expect(ReviewNoticePayload.parse(event)).toEqual(event);
    const done = {
      stage: "event",
      kind: "completed",
      versionId: "v1",
      status: "approved",
      actorId: null,
    };
    expect(ReviewNoticePayload.parse(done)).toEqual(done);
    const send = {
      stage: "send",
      kind: "completed",
      requestId: "ar_1",
      artifactId: "a1",
      versionId: "v1",
      status: "changes_requested",
    };
    expect(ReviewNoticePayload.parse(send)).toEqual(send);
    for (const bad of [
      { ...event, email: "ada@example.com" },
      { ...done, status: "pending" },
      { ...send, note: "text" },
      { stage: "other" },
    ]) {
      expect(ReviewNoticePayload.safeParse(bad).success).toBe(false);
    }
  });
});

describe("legal hold lines", () => {
  it("parse a hold as export-tombstones writes it, and nothing looser", () => {
    const line = {
      legalHold: {
        id: `hold_${"a".repeat(32)}`,
        artifactId: "k7d2qm4xab",
        ownerId: "u_1",
        ownerEmail: null,
        reason: "child_safety",
        ground: "Authority",
        createdAt: 1,
        releaseAt: null,
        releasedAt: 2,
      },
    };
    expect(LegalHoldLine.parse(line)).toEqual(line);
    expect(
      LegalHoldLine.safeParse({ legalHold: { ...line.legalHold, id: "hold_x" } }).success,
    ).toBe(false);
    expect(LegalHoldLine.safeParse({ ...line, extra: 1 }).success).toBe(false);
  });
});

describe("suggestion job payloads", () => {
  it("names the attempt and the content domain, or the version and where a check resumes", () => {
    expect(AcceptancePayload.parse({ attemptId: "att_1", contentDomain: "portifact.dev" })).toEqual(
      {
        attemptId: "att_1",
        contentDomain: "portifact.dev",
      },
    );
    expect(AcceptancePayload.safeParse({ attemptId: "att_1" }).success).toBe(false);
    expect(VersionJobPayload.parse({ versionId: "ver_1", after: "chg_1" }).after).toBe("chg_1");
    expect(VersionJobPayload.safeParse({ versionId: "ver_1", extra: 1 }).success).toBe(false);
  });
});
