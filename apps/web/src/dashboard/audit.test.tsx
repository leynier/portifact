// @vitest-environment happy-dom
import type { AuditEventView } from "@portifact/contracts";
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

  it("filters by kind of change, person and period from keyboard reachable controls", async () => {
    server.audit[""] = EVENTS;
    renderDashboard("/audit", server);
    await table();
    const filters = screen.getByRole("region", { name: "Filter the audit log" });
    const [kind, person, period] = within(filters).getAllByRole("combobox");
    for (const control of [kind, person, period]) expect(control?.tagName).toBe("BUTTON");

    fireEvent.click(kind as HTMLElement);
    fireEvent.click(screen.getByRole("option", { name: "Members and plan" }));
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
  });
});

function requested(): string[] {
  return server.requests
    .filter((r) => r.method === "GET" && r.path.startsWith("/api/v1/audit"))
    .map((r) => r.path);
}
