import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTOR_TYPES,
  AUDIT_CSV_COLUMNS,
  AUDIT_DETAILS,
  AUDIT_EXPORT_CURSOR_HEADER,
  AUDIT_KINDS,
  AUDIT_LIMITS,
  AUDIT_TARGETS,
  AuditActorView,
  AuditEventView,
  AuditExportQuery,
  AuditLogView,
  AuditQuery,
  DOMAIN_DETACH_REASONS,
  EMAIL_DOMAIN_REMOVAL_REASONS,
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
      "review.requested": "review",
      "review.changed": "review",
      "review.cancelled": "review",
      "review.verdict": "review",
      "domain.attached": "artifact",
      "domain.removed": "artifact",
      "webhook.created": "webhook",
      "webhook.changed": "webhook",
      "webhook.removed": "webhook",
      "integration.connected": "integration",
      "integration.changed": "integration",
      "integration.removed": "integration",
      "integration.failing": "integration",
      "issue.created": "artifact",
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
      "service_token.created": "service_token",
      "service_token.revoked": "service_token",
      "email_domain.verified": "email_domain",
      "email_domain.removed": "email_domain",
      "sso.created": "sso",
      "sso.changed": "sso",
      "sso.removed": "sso",
      "scim_token.created": "scim_token",
      "scim_token.revoked": "scim_token",
      "member.provisioned": "invitation",
      "scim.changed": "scim",
      "group.created": "group",
      "group.renamed": "group",
      "group.deleted": "group",
      "group.sync_stopped": "group",
      "group.member_added": "member",
      "group.member_removed": "member",
      "audit.exported": "audit_log",
      "policy.changed": "policy",
      "policy.enforced": "policy",
    });
  });

  it("names a group by its ID only, and access changes count groups", () => {
    const group = `wg_${"a".repeat(32)}`;
    expect(AUDIT_DETAILS["group.member_added"].safeParse({ group }).success).toBe(true);
    for (const wrong of [{}, { group: "Design" }, { group, name: "Design" }]) {
      expect(AUDIT_DETAILS["group.member_removed"].safeParse(wrong).success).toBe(false);
    }
    expect(AUDIT_DETAILS["group.created"].safeParse({ name: "Design" }).success).toBe(false);
    const access = AUDIT_DETAILS["access.changed"];
    expect(
      access.safeParse({ groupsAdded: 20, groupsRemoved: 1, groupExceptions: 0 }).success,
    ).toBe(true);
    expect(access.safeParse({ groupsAdded: 21 }).success).toBe(false);
    expect(access.safeParse({ groups: [group] }).success).toBe(false);
  });

  it("keeps a service token's event to what it may do", () => {
    const created = AUDIT_DETAILS["service_token.created"];
    const detail = { scopes: ["artifacts:read"], restriction: "key", days: 30 };
    expect(created.safeParse(detail).success).toBe(true);
    expect(created.safeParse({ ...detail, days: 366 }).success).toBe(true);
    for (const wrong of [
      { ...detail, scopes: [] },
      { ...detail, scopes: ["credentials:manage"] },
      { ...detail, scopes: Array.from({ length: 5 }, () => "artifacts:read") },
      { ...detail, restriction: "prefix" },
      { ...detail, days: 0 },
      { ...detail, days: 367 },
      { ...detail, days: 1.5 },
      { ...detail, label: "CI previews" },
      { ...detail, prefix: "pr-" },
    ]) {
      expect(created.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false);
    }
    expect(AUDIT_DETAILS["service_token.revoked"].safeParse({}).success).toBe(true);
    expect(AUDIT_DETAILS["service_token.revoked"].safeParse({ label: "x" }).success).toBe(false);
  });

  it("keeps an email domain's event to the domain and why it went", () => {
    const verified = AUDIT_DETAILS["email_domain.verified"];
    expect(verified.safeParse({ domain: "corp.example" }).success).toBe(true);
    expect(verified.safeParse({ domain: "ada@corp.example" }).success).toBe(false);
    expect(verified.safeParse({ domain: "corp.example", token: "abc" }).success).toBe(false);
    const removed = AUDIT_DETAILS["email_domain.removed"];
    for (const reason of EMAIL_DOMAIN_REMOVAL_REASONS) {
      expect(removed.safeParse({ domain: "corp.example", reason }).success).toBe(true);
    }
    expect([...EMAIL_DOMAIN_REMOVAL_REASONS]).toEqual(["removed", "record_missing", "claimed"]);
    expect(removed.safeParse({ domain: "corp.example", reason: "expired" }).success).toBe(false);
    expect(removed.safeParse({ domain: "corp.example" }).success).toBe(false);
  });

  it("keeps an export's event to its format, kinds count and dates", () => {
    const detail = AUDIT_DETAILS["audit.exported"];
    expect(detail.safeParse({ format: "csv", kinds: 0 }).success).toBe(true);
    expect(
      detail.safeParse({ format: "jsonl", kinds: 10, from: "2026-01-01", to: "2026-02-01" })
        .success,
    ).toBe(true);
    for (const bad of [
      { format: "xlsx", kinds: 0 },
      { format: "csv", kinds: 11 },
      { format: "csv", kinds: 0, from: "2026-01-01T00:00:00Z" },
      { format: "csv", kinds: 0, actor: "u_ada" },
      { format: "csv", kinds: 0, rows: 10 },
    ]) {
      expect(detail.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("reads an export's query with a required format and no page size", () => {
    expect(AuditExportQuery.parse({ format: "csv", kind: "plan.granted,plan.removed" })).toEqual({
      format: "csv",
      kind: ["plan.granted", "plan.removed"],
    });
    expect(AuditExportQuery.safeParse({}).success).toBe(false);
    expect(AuditExportQuery.safeParse({ format: "pdf" }).success).toBe(false);
    expect(AuditExportQuery.parse({ format: "jsonl", limit: "5" })).toEqual({ format: "jsonl" });
    expect(AUDIT_CSV_COLUMNS).toHaveLength(11);
    expect(AUDIT_EXPORT_CURSOR_HEADER).toBe("Portifact-Next-Cursor");
  });

  it("knows a service token as an actor and as a target", () => {
    expect([...AUDIT_ACTOR_TYPES]).toEqual(["user", "operator", "system", "token", "directory"]);
    const directory = { type: "directory", id: "sc_1", label: null };
    expect(AuditActorView.safeParse(directory).success).toBe(true);
    expect(AuditActorView.safeParse({ type: "directory", id: "sc_1" }).success).toBe(false);
    const token = { type: "service_token", id: "st_1", label: null };
    expect(AuditActorView.safeParse(token).success).toBe(true);
    expect(AuditActorView.safeParse({ ...token, label: "CI" }).success).toBe(true);
    expect(AuditActorView.safeParse({ type: "service_token", id: "st_1" }).success).toBe(false);
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
        exportable: false,
      }),
    ).toEqual({
      owner: { kind: "personal" },
      events: [],
      nextCursor: null,
      retentionDays: 90,
      exportable: false,
    });
    expect(
      AuditLogView.safeParse({
        owner: { kind: "personal" },
        events: [],
        nextCursor: null,
        retentionDays: 90,
      }).success,
    ).toBe(false);
    expect(
      AuditLogView.safeParse({
        owner: { kind: "personal" },
        events: [],
        nextCursor: null,
        retentionDays: -1,
        exportable: false,
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
