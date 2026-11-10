import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AUDIT_KINDS, type AuditEventView, type AuditKind } from "@portifact/contracts";
import { auditCsvHeader, auditCsvRow, auditJsonLine } from "@portifact/domain";
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

describe("portifact audit export", () => {
  beforeEach(async () => {
    await mkdir(h.workspace, { recursive: true });
  });

  const FIVE = () => [
    event(0, { actor: { type: "member", id: "u_ada", name: "=SUM(A1)" } }),
    event(1, { actor: { type: "removed_member", id: "u_gone" }, kind: "artifact.deleted" }),
    event(2, {
      kind: "member.role_changed",
      artifact: null,
      target: { type: "member", id: "u_ed" },
      detail: { from: "editor", to: "admin" },
    }),
    event(3, { artifact: { id: "abcdefghij", name: 'Plan, "final"\nv2 ✓' } }),
    event(4, { actor: { type: "operator" }, kind: "plan.removed", artifact: null }),
  ];

  it("follows the cursor to stdout and writes exactly the API's parts, in order", async () => {
    h.signIn();
    const events = FIVE();
    server.api.audit.set("personal", events);
    const result = await h.invoke("audit", "export", "--format", "csv");
    expect(result.code).toBe(0);
    // Three parts of two, two and one events: the bytes are the header and the rows, in order.
    expect(server.api.auditExportQueries.map((q) => new URLSearchParams(q).get("cursor"))).toEqual([
      null,
      "2",
      "4",
    ]);
    expect(result.stdout).toBe(auditCsvHeader() + events.map(auditCsvRow).join(""));
    expect(result.stdout).toContain("'=SUM(A1)");
    expect(result.stderr).toContain("never by address");
  });

  it("writes JSON Lines to a new file, sends the filters, and never overwrites a file", async () => {
    h.signIn();
    const events = FIVE();
    server.api.audit.set("team", events);
    const out = join(h.workspace, "audit.jsonl");
    const result = await h.invoke(
      "audit",
      "export",
      "--format",
      "jsonl",
      "--out",
      out,
      "--workspace",
      "team",
      "--kind",
      "artifact.archived,plan.removed",
      "--actor",
      "u_ada",
      "--target",
      "abcdefghij",
      "--since",
      "2026-11-01",
      "--until",
      "2026-11-08",
    );
    expect(result.code).toBe(0);
    const written = await readFile(out, "utf8");
    expect(written).toBe(events.map(auditJsonLine).join(""));
    expect(
      written
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual(events);
    expect(result.stdout).toBe(
      `Exported the audit log as JSONL to ${out} (${Buffer.byteLength(written)} bytes).\n`,
    );
    const first = new URLSearchParams(server.api.auditExportQueries[0]);
    expect(first.get("format")).toBe("jsonl");
    expect(first.get("workspace")).toBe("team");
    expect(first.getAll("kind")).toEqual(["artifact.archived", "plan.removed"]);
    expect(first.get("actor")).toBe("u_ada");
    expect(first.get("target")).toBe("abcdefghij");
    expect(first.get("from")).toBe("2026-11-01T00:00:00.000Z");
    expect(first.get("to")).toBe("2026-11-08T00:00:00.000Z");
    // Every part asks with the same filters.
    for (const query of server.api.auditExportQueries) {
      expect(new URLSearchParams(query).getAll("kind")).toEqual([
        "artifact.archived",
        "plan.removed",
      ]);
    }

    const again = await h.invoke("audit", "export", "--format", "csv", "--out", out, "--json");
    expect(again.code).toBe(2);
    expect(JSON.parse(again.stdout).error.message).toContain("already exists");
    expect(await readFile(out, "utf8")).toBe(written);

    const summaryOut = join(h.workspace, "audit.csv");
    const summary = await h.invoke(
      "audit",
      "export",
      "--format",
      "csv",
      "--out",
      summaryOut,
      "--workspace",
      "team",
      "--json",
    );
    expect(JSON.parse(summary.stdout)).toEqual({
      format: "csv",
      out: summaryOut,
      bytes: (await readFile(summaryOut)).length,
    });
  });

  it("refuses a missing or unknown format and an unknown kind before calling the API", async () => {
    h.signIn();
    server.api.audit.set("personal", FIVE());
    const missing = await h.invoke("audit", "export");
    expect(missing.code).not.toBe(0);
    const pdf = await h.invoke("audit", "export", "--format", "pdf");
    expect(pdf.code).toBe(2);
    expect(pdf.stderr).toContain("--format must be csv or jsonl.");
    const kind = await h.invoke("audit", "export", "--format", "csv", "--kind", "nope");
    expect(kind.code).toBe(2);
    expect(server.api.auditExportQueries).toEqual([]);
  });

  it("removes the file it started when a part fails, and shows the API's error", async () => {
    h.signIn();
    server.api.audit.set("personal", FIVE());
    server.faults.push({
      method: "GET",
      path: /^\/api\/v1\/audit\/export$/,
      reply: {
        status: 403,
        body: {
          error: {
            code: "plan_required",
            message: "Exporting the audit log is part of the Enterprise plan.",
          },
        },
      },
    });
    const out = join(h.workspace, "refused.csv");
    const result = await h.invoke("audit", "export", "--format", "csv", "--out", out);
    expect(result.code).toBe(7);
    expect(result.stderr).toContain("Exporting the audit log is part of the Enterprise plan.");
    await expect(readFile(out)).rejects.toThrow();
  });

  it("refuses a path it cannot create", async () => {
    h.signIn();
    server.api.audit.set("personal", FIVE());
    const blocker = join(h.workspace, "file");
    await writeFile(blocker, "x");
    const result = await h.invoke(
      "audit",
      "export",
      "--format",
      "csv",
      "--out",
      join(blocker, "inside.csv"),
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Could not write");
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
    "review.requested": { reviewers: 2, required: 1, showStatus: false },
    "review.changed": { added: 1, removed: 2 },
    "review.cancelled": {},
    "review.verdict": { verdict: "changes", version: 3 },
    "domain.attached": { hostname: "docs.example.com" },
    "domain.removed": { hostname: "docs.example.com", reason: "plan_limit" },
    "webhook.created": { host: "hooks.example.com", format: "slack", events: [] },
    "webhook.changed": { enabled: true },
    "webhook.removed": {},
    "integration.connected": { service: "github", targets: 2 },
    "integration.changed": { credential: true, targets: 1 },
    "integration.removed": { service: "linear" },
    "integration.failing": { service: "github", reason: "credential_rejected" },
    "issue.created": {
      service: "github",
      target: "acme/site",
      link: true,
      artifactName: true,
      quote: false,
      message: true,
    },
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
    "service_token.created": {
      scopes: ["artifacts:read", "artifacts:write"],
      restriction: "key",
      days: 30,
    },
    "service_token.revoked": {},
    "email_domain.verified": { domain: "corp.example" },
    "email_domain.removed": { domain: "corp.example", reason: "removed" },
    "group.created": {},
    "group.renamed": {},
    "group.deleted": {},
    "group.member_added": { group: "wg_11111111111111111111111111111111" },
    "group.member_removed": { group: "wg_11111111111111111111111111111111" },
    "sso.created": { issuerHost: "login.corp.example", domains: 2 },
    "sso.changed": { fields: ["clientSecret", "domains"] },
    "sso.removed": {},
    "scim_token.created": { days: 365 },
    "scim_token.revoked": {},
    "member.provisioned": { role: "member", emailDomain: "corp.example" },
    "scim.changed": { fields: ["invitationEmails"], invitationEmails: true },
    "group.sync_stopped": {},
    "audit.exported": { format: "csv", kinds: 0, from: "2026-01-01" },
    "policy.changed": {
      fields: ["publicAccess", "readerDomains", "shareLinks", "shareLinkMaxDays"],
      publicAccess: "forbidden",
      readerDomains: ["corp.example"],
      shareLinks: "password_required",
      shareLinkMaxDays: 30,
      confirmed: true,
    },
    "policy.enforced": {
      artifactsNarrowed: 2,
      readersRemoved: 0,
      linksRevoked: 1,
      sessionsEnded: 3,
    },
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
    "review.requested": "Asked 2 people to review (1 approval required)",
    "review.changed": "Changed a review request: 1 added, 2 removed",
    "review.cancelled": "Cancelled a review request",
    "review.verdict": "Asked for changes to version 3",
    "domain.attached": "Attached the domain docs.example.com",
    "domain.removed": "Removed the domain docs.example.com (plan limit)",
    "webhook.created": "Created a slack webhook to hooks.example.com",
    "webhook.changed": "Enabled a webhook",
    "webhook.removed": "Removed a webhook",
    "integration.connected": "Connected GitHub with 2 targets",
    "integration.changed": "Changed a connection: its credential, its targets (now 1)",
    "integration.removed": "Removed a Linear connection",
    "integration.failing": "GitHub refused a connection's credential",
    "issue.created":
      "Created a GitHub issue in acme/site from a thread (sent: the link, the name, the first message)",
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
    "service_token.created": "Created a service token (artifacts:read, artifacts:write; 30 days)",
    "service_token.revoked": "Revoked a service token",
    "email_domain.verified": "Verified the email domain corp.example",
    "email_domain.removed": "Removed the email domain corp.example",
    "group.created": 'Created the group "Design"',
    "group.renamed": 'Renamed the group "Design"',
    "group.deleted": 'Deleted the group "Design"',
    "group.member_added": 'Added Grace to the group "Design"',
    "group.member_removed": 'Removed Grace from the group "Design"',
    "sso.created": "Set up single sign-on with login.corp.example for 2 domains",
    "sso.changed": "Changed single sign-on (client secret, domains)",
    "sso.removed": "Removed single sign-on",
    "scim_token.created": "Created a SCIM token (365 days)",
    "scim_token.revoked": "Revoked a SCIM token",
    "member.provisioned":
      "Provisioned someone at corp.example as member; they join when they sign in",
    "scim.changed": "Turned on invitation emails for provisioned people",
    "group.sync_stopped": 'Stopped syncing the group "Design" from the directory',
    "audit.exported": "Exported the audit log as CSV (2026-01-01 to now)",
    "policy.changed":
      "Changed the workspace's policies: public access forbidden, readers only at corp.example, share links password required, share links at most 30 days (existing artifacts changed)",
    "policy.enforced":
      "Applied the workspace's policies: 2 artifact(s) made workspace-only, 1 share link(s) revoked, 3 link session(s) ended",
  };

  it.each(AUDIT_KINDS)("%s", (kind) => {
    const member = { type: "member" as const, id: "u_g", name: "Grace" };
    expect(
      auditSummary(
        event(0, {
          kind,
          detail: details[kind],
          target: { type: "member", id: "u_g", member },
          group: { id: "wg_11111111111111111111111111111111", name: "Design" },
        }),
      ),
    ).toBe(expected[kind]);
  });

  it("says when the workspace's policy changed access", () => {
    expect(
      auditSummary(
        event(0, {
          kind: "access.changed",
          detail: { mode: "workspace", policy: "publicAccess" },
        }),
      ),
    ).toBe("Changed access: mode workspace, by the workspace's policy");
  });

  it("names a group by its current name, or as deleted, never from the event", () => {
    expect(
      auditSummary(
        event(0, {
          kind: "group.deleted",
          group: { id: "wg_11111111111111111111111111111111", name: null },
        }),
      ),
    ).toBe("Deleted the group (deleted)");
    expect(auditSummary(event(0, { kind: "group.created" }))).toBe("Created the group (unknown)");
    expect(
      auditSummary(
        event(0, {
          kind: "member.joined",
          detail: { role: "member", via: "sso" },
          target: { type: "member", id: "u1" },
        }),
      ),
    ).toContain("joined as member through single sign-on");
    expect(
      auditSummary(
        event(0, {
          kind: "access.changed",
          detail: { groupsAdded: 2, groupsRemoved: 1, groupExceptions: 1 },
        }),
      ),
    ).toBe("Changed access: 2 group(s) added, 1 group(s) removed, 1 group comment exception(s)");
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
    expect(
      auditSummary(
        event(0, {
          kind: "service_token.created",
          detail: { scopes: ["artifacts:read"], restriction: "none", days: 1 },
        }),
      ),
    ).toBe("Created a service token (artifacts:read; 1 day)");
    const lost = (reason: string) =>
      auditSummary(
        event(0, { kind: "email_domain.removed", detail: { domain: "corp.example", reason } }),
      );
    expect(lost("claimed")).toBe(
      "The email domain corp.example was removed (another workspace proved it)",
    );
    expect(lost("record_missing")).toBe(
      "The email domain corp.example was removed (its DNS record is missing)",
    );
    expect(auditActor({ type: "service_token", id: "st_1", label: "CI previews" })).toBe(
      "CI previews (service token)",
    );
    expect(auditActor({ type: "service_token", id: "st_1", label: null })).toBe(
      "Revoked service token",
    );
    expect(auditActor({ type: "directory", id: "sc_1", label: "Okta" })).toBe("Okta (directory)");
    expect(auditActor({ type: "directory", id: "sc_1", label: null })).toBe(
      "Directory (revoked SCIM token)",
    );
    expect(
      auditSummary(
        event(0, {
          kind: "member.joined",
          detail: { role: "member", via: "directory" },
          target: { type: "member", id: "u1" },
        }),
      ),
    ).toContain("joined as member through the directory");
    expect(auditSummary(event(0, { kind: "scim_token.created", detail: { days: 1 } }))).toBe(
      "Created a SCIM token (1 day)",
    );
    expect(
      auditSummary(
        event(0, {
          kind: "scim.changed",
          detail: { fields: ["invitationEmails"], invitationEmails: false },
        }),
      ),
    ).toBe("Turned off invitation emails for provisioned people");
    expect(
      auditSummary(
        event(0, {
          kind: "scim.changed",
          detail: { fields: ["editorGroup", "adminGroup"], editorGroup: "wg_1", adminGroup: null },
        }),
      ),
    ).toBe(
      "Gave editor to the members of a directory group; Stopped giving admin through a directory group",
    );
    expect(auditActor({ type: "operator" })).toBe("Portifact operator");
    expect(auditActor({ type: "system" })).toBe("Portifact");
  });
});
