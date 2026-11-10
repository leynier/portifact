import { describe, expect, it } from "vitest";
import {
  AUDIT_DETAILS,
  AUDIT_KINDS,
  AUDIT_LIMITS,
  AUDIT_TARGETS,
  AuditEventView,
  AuditQuery,
  GetAuditLogInput,
} from "./audit.ts";
import { PLANS } from "./plans.ts";

describe("the audit catalog", () => {
  it("gives every kind a target, and nothing more", () => {
    expect(Object.keys(AUDIT_TARGETS).sort()).toEqual([...AUDIT_KINDS].sort());
    expect(Object.keys(AUDIT_DETAILS)).toEqual(AUDIT_KINDS);
  });

  it("keeps details strict: unknown fields, free text and addresses are refused", () => {
    expect(AUDIT_DETAILS["artifact.archived"].safeParse({ reason: "x" }).success).toBe(false);
    expect(
      AUDIT_DETAILS["member.invited"].safeParse({ role: "member", emailDomain: "a@b.example" })
        .success,
    ).toBe(false);
    expect(
      AUDIT_DETAILS["webhook.created"].safeParse({
        host: "https://hooks.example.com/x",
        format: "generic",
        events: [],
      }).success,
    ).toBe(false);
    const domains = Array.from(
      { length: AUDIT_LIMITS.readerDomains + 1 },
      (_, i) => `d${i}.example`,
    );
    expect(AUDIT_DETAILS["access.changed"].safeParse({ readerDomains: domains }).success).toBe(
      false,
    );
    expect(AUDIT_DETAILS["access.changed"].safeParse({ readersAdded: -1 }).success).toBe(false);
    expect(
      AUDIT_DETAILS["domain.removed"].safeParse({ hostname: "a.example", reason: "whim" }).success,
    ).toBe(false);
    expect(
      AUDIT_DETAILS["plan.granted"].safeParse({ plan: "team", seats: 0, validUntil: null }).success,
    ).toBe(false);
  });

  it("keeps 90 days on every plan, so a lapsed plan never shortens what was kept", () => {
    for (const plan of Object.values(PLANS)) expect(plan.limits.auditRetentionDays).toBe(90);
    expect(PLANS.team.features).toContain("audit");
    expect(PLANS.pro.features).not.toContain("audit");
  });
});

describe("queries", () => {
  it("reads kinds repeated or comma separated, and refuses unknown ones", () => {
    expect(
      AuditQuery.parse({ kind: ["artifact.archived", "plan.removed,member.left"] }),
    ).toMatchObject({ kind: ["artifact.archived", "plan.removed", "member.left"], limit: 50 });
    expect(AuditQuery.parse({ kind: "plan.removed" }).kind).toEqual(["plan.removed"]);
    expect(AuditQuery.parse({}).kind).toBeUndefined();
    expect(AuditQuery.safeParse({ kind: "nope" }).success).toBe(false);
    const tooMany = AUDIT_KINDS.slice(0, AUDIT_LIMITS.kindsPerQuery + 1);
    expect(AuditQuery.safeParse({ kind: tooMany }).success).toBe(false);
  });

  it("caps the page and validates dates", () => {
    expect(AuditQuery.parse({ limit: "100" }).limit).toBe(100);
    expect(AuditQuery.safeParse({ limit: "101" }).success).toBe(false);
    expect(AuditQuery.safeParse({ limit: "0" }).success).toBe(false);
    expect(AuditQuery.safeParse({ from: "yesterday" }).success).toBe(false);
    expect(GetAuditLogInput.parse({}).limit).toBe(50);
    expect(GetAuditLogInput.safeParse({ limit: 101 }).success).toBe(false);
  });

  it("describes events with a known kind and actor shape", () => {
    const event = {
      id: "ae_1",
      at: "2026-11-10T12:00:00.000Z",
      kind: "member.left",
      actor: { type: "removed_member", id: "u_1" },
      target: { type: "member", id: "u_1", member: { type: "removed_member", id: "u_1" } },
      artifact: null,
      detail: { role: "member" },
    };
    expect(AuditEventView.parse(event)).toEqual(event);
    expect(AuditEventView.safeParse({ ...event, kind: "member.vanished" }).success).toBe(false);
    expect(
      AuditEventView.safeParse({
        ...event,
        actor: { type: "removed_member", id: "u_1", name: "x" },
      }).data?.actor,
    ).toEqual({ type: "removed_member", id: "u_1" });
  });
});
