import { describe, expect, it } from "vitest";
import {
  AUDIT_DETAILS,
  AUDIT_KINDS,
  AUDIT_LIMITS,
  AUDIT_TARGETS,
  AuditActorView,
  AuditEventView,
  AuditLogView,
  AuditQuery,
  DOMAIN_DETACH_REASONS,
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

describe("the catalog's exact shapes", () => {
  it("names each kind's target", () => {
    expect(AUDIT_TARGETS).toEqual({
      "artifact.published": "artifact",
      "artifact.rolled_back": "artifact",
      "artifact.renewed": "artifact",
      "artifact.archived": "artifact",
      "artifact.restored": "artifact",
      "artifact.deleted": "artifact",
      "artifact.pinned": "artifact",
      "artifact.unpinned": "artifact",
      "artifact.transferred_in": "artifact",
      "artifact.transferred_out": "artifact",
      "access.changed": "artifact",
      "share_link.created": "share_link",
      "share_link.revoked": "share_link",
      "domain.attached": "artifact",
      "domain.removed": "artifact",
      "webhook.created": "webhook",
      "webhook.changed": "webhook",
      "webhook.removed": "webhook",
      "brand.changed": "brand",
      "brand.removed": "brand",
      "member.invited": "invitation",
      "member.invitation_revoked": "invitation",
      "member.joined": "member",
      "member.role_changed": "member",
      "member.removed": "member",
      "member.left": "member",
      "plan.granted": "plan",
      "plan.removed": "plan",
    });
  });

  it("bounds counts, domains and identifiers", () => {
    const access = AUDIT_DETAILS["access.changed"];
    expect(access.safeParse({ readersAdded: 0 }).success).toBe(true);
    expect(access.safeParse({ readersAdded: 500 }).success).toBe(true);
    expect(access.safeParse({ readersAdded: 501 }).success).toBe(false);
    expect(access.safeParse({ readersAdded: 1.5 }).success).toBe(false);
    expect(access.safeParse({ readerDomains: ["corp.example"] }).success).toBe(true);
    expect(access.safeParse({ readerDomains: [""] }).success).toBe(false);
    const attached = AUDIT_DETAILS["domain.attached"];
    expect(attached.safeParse({ hostname: "a" }).success).toBe(true);
    expect(attached.safeParse({ hostname: "a".repeat(253) }).success).toBe(true);
    expect(attached.safeParse({ hostname: "a".repeat(254) }).success).toBe(false);
    expect(attached.safeParse({ hostname: "x.example extra" }).success).toBe(false);
    expect(AUDIT_DETAILS["artifact.published"].safeParse({ version: 1, first: true }).success).toBe(
      true,
    );
    expect(
      AUDIT_DETAILS["domain.removed"].safeParse({ hostname: "a.example", reason: "removed" })
        .success,
    ).toBe(true);
    expect(
      AUDIT_DETAILS["plan.granted"].safeParse({ plan: "team", seats: 2, validUntil: null }).success,
    ).toBe(true);
    for (const value of ["a", "x".repeat(200)]) {
      expect(AuditQuery.safeParse({ actor: value, target: value, cursor: value }).success).toBe(
        true,
      );
      expect(GetAuditLogInput.safeParse({ actor: value, workspace: "w" }).success).toBe(true);
    }
    expect(AuditQuery.safeParse({ actor: "" }).success).toBe(false);
    expect(AuditQuery.safeParse({ actor: "x".repeat(201) }).success).toBe(false);
    expect(AuditQuery.safeParse({ cursor: "x".repeat(201) }).success).toBe(false);
    expect(GetAuditLogInput.safeParse({ workspace: "w".repeat(40) }).success).toBe(true);
    expect(GetAuditLogInput.safeParse({ workspace: "w".repeat(41) }).success).toBe(false);
    expect(GetAuditLogInput.safeParse({ kinds: [] }).success).toBe(false);
    expect(GetAuditLogInput.parse({ limit: 1 }).limit).toBe(1);
  });

  it("describes every MCP input for agents", () => {
    for (const [name, field] of Object.entries(GetAuditLogInput.shape)) {
      expect(field.description, name).toMatch(/\w{3,}/);
    }
  });

  it("shows actors and the page with their fields", () => {
    expect(
      AuditLogView.parse({
        owner: { kind: "personal" },
        events: [],
        nextCursor: null,
        retentionDays: 90,
      }),
    ).toEqual({ owner: { kind: "personal" }, events: [], nextCursor: null, retentionDays: 90 });
    expect(
      AuditLogView.safeParse({
        owner: { kind: "personal" },
        events: [],
        nextCursor: null,
        retentionDays: -1,
      }).success,
    ).toBe(false);
    expect(AuditActorView.parse({ type: "member", id: "u", name: "Ada" })).toEqual({
      type: "member",
      id: "u",
      name: "Ada",
    });
    expect(AuditActorView.safeParse({ type: "member", id: "u" }).success).toBe(false);
    expect(AuditActorView.parse({ type: "operator" })).toEqual({ type: "operator" });
    expect(AuditActorView.parse({ type: "system" })).toEqual({ type: "system" });
    expect(DOMAIN_DETACH_REASONS).toContain("plan_limit");
  });
});
