import { AUDIT_KINDS, type AuditEventView, type AuditKind } from "@portifact/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditActor, auditSummary } from "./audit.ts";
import { type FakeServer, startFakeServer } from "./testing/fake-server.ts";
import { createHarness, type Harness } from "./testing/harness.ts";

let server: FakeServer;
let h: Harness;

beforeEach(async () => {
  server = await startFakeServer();
  h = await createHarness({ server });
});

afterEach(async () => {
  await h.cleanup();
  await server.close();
});

const NOW = Date.UTC(2026, 10, 8, 12);
const HOUR = 3_600_000;

function event(i: number, overrides: Partial<AuditEventView> = {}): AuditEventView {
  return {
    id: `ae_${String(i).padStart(24, "0")}`,
    at: new Date(NOW - i * HOUR).toISOString(),
    kind: "artifact.archived",
    actor: { type: "member", id: "u_ada", name: "Ada" },
    target: { type: "artifact", id: "abcdefghij" },
    artifact: { id: "abcdefghij", name: "Plan" },
    detail: {},
    ...overrides,
  };
}

describe("portifact audit", () => {
  it("lists events as a table, in plain words, never with an address", async () => {
    h.signIn();
    server.api.audit.set("personal", [
      event(0, {
        kind: "access.changed",
        detail: { readersAdded: 2, readerDomains: ["corp.example"], mode: "restricted" },
      }),
      event(1, { actor: { type: "removed_member", id: "u_gone" }, kind: "artifact.deleted" }),
      event(2, { artifact: { id: "abcdefghij", name: null }, kind: "artifact.pinned" }),
    ]);
    const result = await h.invoke("audit");
    expect(result.code).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^WHEN\s+WHO\s+WHAT\s+ON$/);
    expect(lines[1]).toMatch(
      /^2026-11-08 12:00 UTC\s+Ada\s+Changed access: mode restricted, 2 reader\(s\) added, at corp\.example\s+Plan$/,
    );
    expect(lines[2]).toMatch(/Removed member\s+Deleted\s+Plan$/);
    expect(lines[3]).toMatch(/Pinned\s+abcdefghij \(gone\)$/);
    expect(lines.at(-1)).toBe(
      "Kept 90 days. Members are shown by name; removed members never by address.",
    );
    expect(result.stdout).not.toContain("@");
  });

  it("sends the filters, follows pages up to --limit and prints JSON", async () => {
    h.signIn();
    server.api.audit.set(
      "team",
      Array.from({ length: 150 }, (_, i) => event(i)),
    );
    const result = await h.invoke(
      "audit",
      "--workspace",
      "team",
      "--kind",
      "artifact.archived,artifact.deleted",
      "--kind",
      "plan.granted",
      "--actor",
      "u_ada",
      "--target",
      "abcdefghij",
      "--since",
      "2026-11-01",
      "--limit",
      "120",
      "--json",
    );
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.events).toHaveLength(120);
    expect(body.nextCursor).toBe("120");
    const [first, second] = server.api.auditQueries.map((q) => new URLSearchParams(q));
    expect(first?.getAll("kind")).toEqual([
      "artifact.archived",
      "artifact.deleted",
      "plan.granted",
    ]);
    expect(first?.get("workspace")).toBe("team");
    expect(first?.get("actor")).toBe("u_ada");
    expect(first?.get("target")).toBe("abcdefghij");
    expect(first?.get("from")).toBe("2026-11-01T00:00:00.000Z");
    expect(first?.get("limit")).toBe("100");
    expect(second?.get("limit")).toBe("20");
    expect(second?.get("cursor")).toBe("100");
  });

  it("says when nothing matches and when more remains", async () => {
    h.signIn();
    server.api.audit.set("personal", []);
    const empty = await h.invoke("audit");
    expect(empty.stdout).toContain("No audit events in the last 90 days match.");
    server.api.audit.set(
      "personal",
      Array.from({ length: 3 }, (_, i) => event(i)),
    );
    const more = await h.invoke("audit", "--limit", "2");
    expect(more.stdout).toContain("More events exist: raise --limit (up to 1000)");
  });

  it("refuses an unknown kind or limit before calling the API", async () => {
    h.signIn();
    const kind = await h.invoke("audit", "--kind", "artifact.vanished");
    expect(kind.code).toBe(2);
    expect(kind.stderr).toContain('"artifact.vanished" is not an audit event kind.');
    const limit = await h.invoke("audit", "--limit", "0");
    expect(limit.code).toBe(2);
    expect(limit.stderr).toContain("--limit must be a whole number from 1 to 1000.");
    expect(server.api.auditQueries).toEqual([]);
  });
});

describe("plain words for every kind", () => {
  const details: Record<AuditKind, Record<string, unknown>> = {
    "artifact.published": { version: 3, first: false },
    "artifact.rolled_back": { version: 4, from: 2 },
    "artifact.renewed": {},
    "artifact.archived": {},
    "artifact.restored": {},
    "artifact.deleted": {},
    "artifact.pinned": {},
    "artifact.unpinned": {},
    "artifact.transferred_in": { from: "workspace" },
    "artifact.transferred_out": { to: "personal" },
    "access.changed": {
      readersRemoved: 1,
      readerExceptions: 1,
      bar: true,
      commentVisibility: "everyone",
      indexable: false,
      embeddable: true,
    },
    "share_link.created": { password: false, expires: true },
    "share_link.revoked": {},
    "domain.attached": { hostname: "docs.example.com" },
    "domain.removed": { hostname: "docs.example.com", reason: "plan_limit" },
    "webhook.created": { host: "hooks.example.com", format: "slack", events: [] },
    "webhook.changed": { enabled: true },
    "webhook.removed": {},
    "brand.changed": { fields: ["logo"] },
    "brand.removed": { fields: ["all"] },
    "member.invited": { role: "editor", emailDomain: "corp.example" },
    "member.invitation_revoked": {},
    "member.joined": { role: "member" },
    "member.role_changed": { from: "member", to: "admin" },
    "member.removed": { role: "editor" },
    "member.left": { role: "member" },
    "plan.granted": { plan: "team", seats: 1, validUntil: "2027-01-01T00:00:00.000Z" },
    "plan.removed": {},
  };
  const expected: Record<AuditKind, string> = {
    "artifact.published": "Published version 3",
    "artifact.rolled_back": "Rolled back to the files of version 2 (now version 4)",
    "artifact.renewed": "Renewed",
    "artifact.archived": "Archived",
    "artifact.restored": "Restored",
    "artifact.deleted": "Deleted",
    "artifact.pinned": "Pinned",
    "artifact.unpinned": "Unpinned",
    "artifact.transferred_in": "Moved here from a workspace",
    "artifact.transferred_out": "Moved to a personal space",
    "access.changed":
      "Changed access: 1 reader(s) removed, 1 comment exception(s), bar on, comments visible to everyone, indexing off, embedding on",
    "share_link.created": "Created a share link that expires",
    "share_link.revoked": "Revoked a share link",
    "domain.attached": "Attached the domain docs.example.com",
    "domain.removed": "Removed the domain docs.example.com (plan limit)",
    "webhook.created": "Created a slack webhook to hooks.example.com",
    "webhook.changed": "Enabled a webhook",
    "webhook.removed": "Removed a webhook",
    "brand.changed": "Changed the brand's logo",
    "brand.removed": "Removed the brand",
    "member.invited": "Invited someone at corp.example as editor",
    "member.invitation_revoked": "Revoked an invitation",
    "member.joined": "Grace joined as member",
    "member.role_changed": "Changed Grace from member to admin",
    "member.removed": "Removed Grace",
    "member.left": "Grace left",
    "plan.granted": "Plan set to team with 1 seat until 2027-01-01 00:00 UTC",
    "plan.removed": "Plan removed (back to free)",
  };

  it.each(AUDIT_KINDS)("%s", (kind) => {
    const member = { type: "member" as const, id: "u_g", name: "Grace" };
    expect(
      auditSummary(
        event(0, {
          kind,
          detail: details[kind],
          target: { type: "member", id: "u_g", member },
        }),
      ),
    ).toBe(expected[kind]);
  });

  it("covers the other variants and actors", () => {
    expect(
      auditSummary(event(0, { kind: "artifact.published", detail: { version: 1, first: true } })),
    ).toBe("Published version 1 (new artifact)");
    expect(auditSummary(event(0, { kind: "webhook.changed", detail: { enabled: false } }))).toBe(
      "Disabled a webhook",
    );
    expect(auditSummary(event(0, { kind: "webhook.changed", detail: { events: [] } }))).toBe(
      "Changed a webhook's events",
    );
    expect(
      auditSummary(
        event(0, {
          kind: "member.left",
          detail: { role: "member" },
          target: { type: "member", id: "u" },
        }),
      ),
    ).toBe("a member left");
    expect(auditActor({ type: "operator" })).toBe("Portifact operator");
    expect(auditActor({ type: "system" })).toBe("Portifact");
  });
});
