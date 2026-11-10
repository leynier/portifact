import { describe, expect, it } from "vitest";
import {
  DeleteObjectsPayload,
  EXPIRY_NOTICE_ARTIFACTS_MAX,
  ExpiryNoticePayload,
  JobMessage,
  LIMITS,
  OutboxTopic,
  TombstoneMarker,
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
      "workspace_deletion",
    ]);
    for (const kind of ["artifact", "account", "workspace"]) {
      expect(TombstoneMarker.parse({ ...marker, kind }).kind).toBe(kind);
    }
    expect(JobMessage.parse({ id: 1, topic: "workspace_deletion" }).topic).toBe(
      "workspace_deletion",
    );
    expect(TombstoneMarker.safeParse({ ...marker, deletedAt: -1 }).success).toBe(false);
    expect(TombstoneMarker.safeParse({ ...marker, extra: true }).success).toBe(false);
  });
});
