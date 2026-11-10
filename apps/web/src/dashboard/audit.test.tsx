// @vitest-environment happy-dom
import type { AuditEventView } from "@portifact/contracts";
import { auditCsvHeader, auditCsvRow, auditJsonLine } from "@portifact/domain";
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeServer, fakeServer, renderDashboard, workspace } from "./test-support.tsx";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

let server: FakeServer;
beforeEach(() => {
  server = fakeServer([]);
});

const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();

function event(overrides: Partial<AuditEventView>): AuditEventView {
  return {
    id: `ae_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
    at: at(1),
    kind: "artifact.archived",
    actor: { type: "member", id: "u_ada", name: "Ada" },
    target: { type: "artifact", id: "abcdefghij" },
    artifact: { id: "abcdefghij", name: "Launch plan" },
    detail: {},
    ...overrides,
  };
}

const EVENTS: AuditEventView[] = [
  event({
    at: at(1),
    kind: "access.changed",
    detail: { readersAdded: 2, readerDomains: ["corp.example"], bar: false },
  }),
  event({
    at: at(2),
    kind: "member.role_changed",
    actor: { type: "member", id: "u_ada", name: "Ada" },
    target: { type: "member", id: "u_ed", member: { type: "removed_member", id: "u_ed" } },
    artifact: null,
    detail: { from: "editor", to: "admin" },
  }),
  event({
    at: at(3),
    kind: "artifact.deleted",
    actor: { type: "removed_member", id: "u_gone00000" },
    artifact: { id: "abcdefghij", name: null },
  }),
  event({
    at: at(4),
    kind: "plan.granted",
    actor: { type: "operator" },
    target: { type: "plan", id: "ws_1" },
    artifact: null,
    detail: { plan: "team", seats: 3, validUntil: null },
  }),
];

async function table() {
  await screen.findByRole("heading", { level: 1, name: "Audit log" });
  return screen.findByRole("table", { name: "Changes in this space, newest first" });
}

describe("audit log page", () => {
  it("shows a workspace's changes in plain words, in a captioned table, axe clean in both themes", async () => {
    server.workspaces.acme = workspace("acme", "admin", { name: "Acme" });
    server.audit.acme = EVENTS;
    const { container } = renderDashboard("/audit?workspace=acme", server);
    const found = await table();
    const rows = within(found).getAllByRole("row");
    expect(rows).toHaveLength(EVENTS.length + 1);
    expect(rows[1]?.textContent).toContain(
      "Changed access: added 2 readers, at corp.example, turned the Portifact bar off",
    );
    expect(rows[2]?.textContent).toContain("Changed Removed member from Editor to Admin");
    expect(rows[3]?.textContent).toContain("Removed member");
    expect(rows[3]?.textContent).toContain("Deleted artifact");
    expect(rows[4]?.textContent).toContain("Portifact operator");
    expect(rows[4]?.textContent).toContain("Set the plan to Team with 3 seats");
    expect(requested()).toEqual(["/api/v1/audit?workspace=acme"]);
    expect(screen.getByRole("link", { name: "Audit log" }).getAttribute("href")).toBe(
      "/audit?workspace=acme",
    );
    expect(await axeViolations(container)).toEqual([]);
    document.documentElement.dataset.theme = "dark";
    expect(await axeViolations(container)).toEqual([]);
  });

  it("names service tokens by their label, and email domains by what happened to them", async () => {
    const tokenId = `st_${"0".repeat(32)}`;
    const live = { type: "service_token", id: tokenId, label: "CI previews" } as const;
    const gone = { type: "service_token", id: tokenId, label: null } as const;
    server.workspaces.acme = workspace("acme", "admin", { name: "Acme" });
    server.audit.acme = [
      event({ at: at(1), kind: "artifact.published", actor: live, detail: { version: 2 } }),
      event({
        at: at(2),
        kind: "service_token.created",
        target: { type: "service_token", id: tokenId, serviceToken: live },
        artifact: null,
        detail: { scopes: ["artifacts:read"], restriction: "none", days: 30 },
      }),
      event({
        at: at(3),
        kind: "service_token.revoked",
        actor: { type: "operator" },
        target: { type: "service_token", id: tokenId, serviceToken: gone },
        artifact: null,
      }),
      event({ at: at(4), kind: "artifact.renewed", actor: gone }),
      event({
        at: at(5),
        kind: "email_domain.verified",
        target: { type: "email_domain", id: "wd_1" },
        artifact: null,
        detail: { domain: "corp.example" },
      }),
      ...(["removed", "claimed", "record_missing"] as const).map((reason, i) =>
        event({
          at: at(6 + i),
          kind: "email_domain.removed",
          actor:
            reason === "removed"
              ? { type: "member", id: "u_ada", name: "Ada" }
              : { type: "system" },
          target: { type: "email_domain", id: "wd_1" },
          artifact: null,
          detail: { domain: "corp.example", reason },
        }),
      ),
    ];
    renderDashboard("/audit?workspace=acme", server);
    const rows = within(await table()).getAllByRole("row");
    const text = (row: number) => rows[row]?.textContent ?? "";
    expect(text(1)).toContain("CI previews (service token)");
    expect(text(1)).toContain("Published version 2");
    expect(text(2)).toContain("Created a service token that expires in 30 days");
    expect(text(2)).toContain("CI previews (service token)");
    expect(text(3)).toContain("Portifact operator");
    expect(text(3)).toContain("Revoked a service token");
    expect(text(3)).toContain("Revoked service token");
    expect(text(4)).toContain("Revoked service token");
    expect(text(5)).toContain("Verified the email domain corp.example");
    expect(text(5)).toContain("This space");
    expect(text(6)).toContain("Removed the email domain corp.example");
    expect(text(7)).toContain(
      "The email domain corp.example was removed because another workspace proved it",
    );
    expect(text(8)).toContain(
      "The email domain corp.example was removed because its DNS record is missing",
    );
  });

  it("filters by kind of change, person and period from keyboard reachable controls", async () => {
    server.audit[""] = EVENTS;
    renderDashboard("/audit", server);
    await table();
    const filters = screen.getByRole("region", { name: "Filter the audit log" });
    const [kind, person, period] = within(filters).getAllByRole("combobox");
    for (const control of [kind, person, period]) expect(control?.tagName).toBe("BUTTON");

    fireEvent.click(kind as HTMLElement);
    fireEvent.click(screen.getByRole("option", { name: "Members, tokens and plan" }));
    await waitFor(() =>
      expect(requested().at(-1)).toContain("kind=member.invited&kind=member.invitation_revoked"),
    );

    fireEvent.click(person as HTMLElement);
    fireEvent.click(screen.getByRole("option", { name: "Ada" }));
    await waitFor(() => expect(requested().at(-1)).toContain("actor=u_ada"));

    fireEvent.click(period as HTMLElement);
    fireEvent.click(screen.getByRole("option", { name: "Last 7 days" }));
    await waitFor(() => expect(requested().at(-1)).toContain("from="));
  });

  it("pages older changes on request", async () => {
    server.pageSize = 2;
    server.audit[""] = EVENTS;
    renderDashboard("/audit", server);
    const found = await table();
    expect(within(found).getAllByRole("row")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Show older changes" }));
    await waitFor(() => expect(within(found).getAllByRole("row")).toHaveLength(5));
    expect(screen.queryByRole("button", { name: "Show older changes" })).toBeNull();
  });

  it("says when nothing is recorded", async () => {
    server.audit[""] = [];
    const { container } = renderDashboard("/audit", server);
    expect(await screen.findByText("No changes recorded")).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("names the plan that includes it, with no checkout, when the owner's plan lacks it", async () => {
    const { container } = renderDashboard("/audit", server);
    expect(await screen.findByText("The audit log is part of a paid plan")).toBeTruthy();
    expect(screen.getByText(/The audit log is part of the Team plan\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /upgrade|buy|checkout/i })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("is not offered to editors, and says so if opened", async () => {
    server.workspaces.acme = workspace("acme", "editor", { name: "Acme" });
    server.audit.acme = EVENTS;
    renderDashboard("/audit?workspace=acme", server);
    expect(await screen.findByText("Only admins can read the audit log")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Audit log" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Export/ })).toBeNull();
  });
});

describe("exporting the audit log", () => {
  it("offers admins CSV and JSON Lines on a plan with the export, axe clean in both themes", async () => {
    server.workspaces.acme = workspace("acme", "admin", { name: "Acme" });
    server.audit.acme = EVENTS;
    server.auditExportable.add("acme");
    const view = renderDashboard("/audit?workspace=acme", server);
    await table();
    const region = await screen.findByRole("region", { name: "Export the audit log" });
    expect(within(region).getByText(/never by address/)).toBeTruthy();
    expect(await axeViolations(view.container)).toEqual([]);
    document.documentElement.dataset.theme = "dark";
    expect(await axeViolations(view.container)).toEqual([]);

    fireEvent.click(within(region).getByRole("button", { name: "Export as CSV" }));
    await waitFor(() => expect(view.saved).toHaveLength(1));
    expect(view.saved[0]?.fileName).toBe("portifact-audit.csv");
    // Two parts of two events, joined in order, with the header once.
    expect(await view.saved[0]?.blob.text()).toBe(
      auditCsvHeader() + EVENTS.map(auditCsvRow).join(""),
    );
    expect(exports().map((path) => new URL(path, "https://x").searchParams.get("cursor"))).toEqual([
      null,
      "2",
    ]);
    expect(exports()[0]).toContain("workspace=acme");
    expect(await screen.findByText("The audit log was exported as CSV.")).toBeTruthy();

    fireEvent.click(within(region).getByRole("button", { name: "Export as JSON Lines" }));
    await waitFor(() => expect(view.saved).toHaveLength(2));
    expect(view.saved[1]?.fileName).toBe("portifact-audit.jsonl");
    expect(await view.saved[1]?.blob.text()).toBe(EVENTS.map(auditJsonLine).join(""));
  });

  it("exports what the kind filter keeps", async () => {
    server.audit[""] = EVENTS;
    server.auditExportable.add("");
    const view = renderDashboard("/audit", server);
    await table();
    const filters = screen.getByRole("region", { name: "Filter the audit log" });
    fireEvent.click(within(filters).getAllByRole("combobox")[0] as HTMLElement);
    fireEvent.click(screen.getByRole("option", { name: "Members, tokens and plan" }));
    await waitFor(() => expect(requested().at(-1)).toContain("kind=member.invited"));
    fireEvent.click(await screen.findByRole("button", { name: "Export as CSV" }));
    await waitFor(() => expect(view.saved).toHaveLength(1));
    expect(exports()[0]).toContain("kind=member.invited");
    const members = EVENTS.filter(
      (e) => e.kind === "member.role_changed" || e.kind === "plan.granted",
    );
    expect(await view.saved[0]?.blob.text()).toBe(
      auditCsvHeader() + members.map(auditCsvRow).join(""),
    );
  });

  it("says why an export failed", async () => {
    server.audit[""] = EVENTS;
    server.auditExportable.add("");
    renderDashboard("/audit", server);
    await table();
    // The plan changes after the page loaded.
    server.auditExportable.delete("");
    fireEvent.click(await screen.findByRole("button", { name: "Export as CSV" }));
    expect(await screen.findByText("The audit log could not be exported")).toBeTruthy();
  });

  it("names the plan that includes the export, with no button, when the plan lacks it", async () => {
    server.audit[""] = EVENTS;
    const { container } = renderDashboard("/audit", server);
    await table();
    expect(
      screen.getByText("Exporting the audit log is part of the Enterprise plan."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Export/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /upgrade|buy|checkout/i })).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("says how long the plan keeps events, from the API", async () => {
    server.audit[""] = EVENTS;
    server.auditRetentionDays = 2557;
    renderDashboard("/audit", server);
    await table();
    expect(
      screen.getByText("Who changed what in this space. Changes are kept 2557 days."),
    ).toBeTruthy();
  });
});

function exports(): string[] {
  return server.requests
    .filter((r) => r.method === "GET" && r.path.startsWith("/api/v1/audit/export"))
    .map((r) => r.path);
}

function requested(): string[] {
  return server.requests
    .filter(
      (r) =>
        r.method === "GET" &&
        r.path.startsWith("/api/v1/audit") &&
        !r.path.startsWith("/api/v1/audit/export"),
    )
    .map((r) => r.path);
}
