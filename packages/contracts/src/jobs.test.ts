import { describe, expect, it } from "vitest";
import { DeleteObjectsPayload, JobMessage, TombstoneMarker } from "./index.ts";

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

  it("accepts only artifact and account tombstone markers", () => {
    const marker = { kind: "artifact", id: "k7d2qm4xab", deletedAt: 1 };
    expect(TombstoneMarker.parse(marker)).toEqual(marker);
    expect(TombstoneMarker.safeParse({ ...marker, kind: "version" }).success).toBe(false);
    expect(TombstoneMarker.safeParse({ ...marker, deletedAt: -1 }).success).toBe(false);
    expect(TombstoneMarker.safeParse({ ...marker, extra: true }).success).toBe(false);
  });
});
