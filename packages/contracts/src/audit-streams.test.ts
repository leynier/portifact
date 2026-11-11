import { describe, expect, it } from "vitest";
import {
  AUDIT_STREAM,
  AuditStreamCreate,
  AuditStreamId,
  AuditStreamUpdate,
} from "./audit-streams.ts";

describe("audit stream contracts", () => {
  it("starts a new stream from now unless asked for the oldest event", () => {
    const body = { label: " SIEM ", url: "https://collector.example/in" };
    expect(AuditStreamCreate.parse(body)).toEqual({
      label: "SIEM",
      url: "https://collector.example/in",
      start: "now",
    });
    expect(AuditStreamCreate.parse({ ...body, start: "oldest" }).start).toBe("oldest");
    expect(AuditStreamCreate.safeParse({ ...body, start: "yesterday" }).success).toBe(false);
  });

  it("bounds the label and the URL and refuses unknown fields", () => {
    const url = "https://collector.example/in";
    expect(AuditStreamCreate.safeParse({ label: "   ", url }).success).toBe(false);
    expect(
      AuditStreamCreate.safeParse({ label: "x".repeat(AUDIT_STREAM.labelMaxLength + 1), url })
        .success,
    ).toBe(false);
    expect(
      AuditStreamCreate.safeParse({
        label: "SIEM",
        url: `https://collector.example/${"x".repeat(AUDIT_STREAM.urlMaxLength)}`,
      }).success,
    ).toBe(false);
    expect(AuditStreamCreate.safeParse({ label: "SIEM", url: "" }).success).toBe(false);
    expect(AuditStreamCreate.safeParse({ label: "SIEM", url, secret: "mine" }).success).toBe(false);
  });

  it("needs a change in an update", () => {
    expect(AuditStreamUpdate.safeParse({}).success).toBe(false);
    expect(AuditStreamUpdate.parse({ label: "Renamed" })).toEqual({ label: "Renamed" });
    expect(AuditStreamUpdate.parse({ state: "paused" })).toEqual({ state: "paused" });
    expect(AuditStreamUpdate.safeParse({ state: "attention" }).success).toBe(false);
    expect(AuditStreamUpdate.safeParse({ rotateSecret: false }).success).toBe(false);
  });

  it("revokes the old secret only together with a rotation", () => {
    expect(AuditStreamUpdate.parse({ rotateSecret: true, revokeOldSecret: true })).toEqual({
      rotateSecret: true,
      revokeOldSecret: true,
    });
    expect(AuditStreamUpdate.safeParse({ revokeOldSecret: true }).success).toBe(false);
    expect(AuditStreamUpdate.safeParse({ label: "x", revokeOldSecret: true }).success).toBe(false);
  });

  it("knows a stream ID by its shape", () => {
    expect(AuditStreamId.safeParse(`as_${"0f".repeat(16)}`).success).toBe(true);
    expect(AuditStreamId.safeParse(`as_${"0F".repeat(16)}`).success).toBe(false);
    expect(AuditStreamId.safeParse(`wh_${"0f".repeat(16)}`).success).toBe(false);
    expect(AuditStreamId.safeParse("as_123").success).toBe(false);
  });
});
