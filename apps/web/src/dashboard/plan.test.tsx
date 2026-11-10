// @vitest-environment happy-dom
// The Plan page (premium plan L5): the space's plan from the usage endpoint, every plan for
// comparison from PLANS, and the request by email offered only to a role that could act on it.
import { PLANS, planRequestHref } from "@portifact/contracts/plans";
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activateLocale, createI18n } from "./i18n/i18n.ts";
import {
  type FakeServer,
  fakeServer,
  renderDashboard,
  usageView,
  workspace,
} from "./test-support.tsx";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

let server: FakeServer;
beforeEach(() => {
  server = fakeServer([]);
});

const teamUsage = () =>
  usageView({
    plan: {
      name: "team",
      validUntil: null,
      seats: 3,
      limits: { ...PLANS.team.limits, accountBytes: 90_000_000_000 },
      features: [...PLANS.team.features],
    },
  });

const requestLinks = () =>
  screen
    .queryAllByRole("link", { name: /^Request access/ })
    .map((link) => [link.getAttribute("aria-label"), link.getAttribute("href")]);

async function planPage() {
  await screen.findByRole("heading", { level: 1, name: "Plan" });
  return screen.getByRole("region", { name: "All plans" });
}

describe("the Plan page", () => {
  it.each(["light", "dark"] as const)(
    "shows the personal space's plan and offers the paid plans by email (%s)",
    async (theme) => {
      document.documentElement.dataset.theme = theme;
      const { container } = renderDashboard("/plan", server);
      const all = await planPage();
      const current = await screen.findByRole("region", { name: "Current plan" });
      expect(within(current).getByText("Current plan", { selector: "dt" })).toBeTruthy();
      const limits = within(current).getByRole("table", { name: "Limits of the current plan" });
      expect(within(limits).getByRole("rowheader", { name: "Active artifacts" })).toBeTruthy();
      expect(within(limits).getByText("50")).toBeTruthy();
      expect(within(limits).getByText("2.5 GB")).toBeTruthy();
      expect(within(current).getByRole("link", { name: "See usage" })).toBeTruthy();
      const cards = within(all).getAllByRole("article");
      expect(cards.map((card) => card.getAttribute("data-plan"))).toEqual([
        "free",
        "pro",
        "team",
        "enterprise",
      ]);
      expect(within(cards[0] as HTMLElement).getByText("Current plan")).toBeTruthy();
      expect(requestLinks()).toEqual([
        ["Request access to the Pro plan", planRequestHref("pro")],
        ["Request access to the Team plan", planRequestHref("team")],
        ["Request access to the Enterprise plan", planRequestHref("enterprise")],
      ]);
      const pro = cards[1] as HTMLElement;
      expect(within(pro).getByText("$2")).toBeTruthy();
      expect(within(pro).getByText("Pinning artifacts")).toBeTruthy();
      // Built but switched off in production: shown as coming soon, never as included.
      const [included, soon] = within(pro).getAllByRole("list");
      expect(within(included as HTMLElement).queryByText("Sending webhooks")).toBeNull();
      expect(within(soon as HTMLElement).getByText("Sending webhooks")).toBeTruthy();
      const table = within(all).getByRole("table", { name: "Limits of each plan" });
      // Team and Enterprise share the per-seat values.
      expect(within(table).getAllByText("30 GB per seat")).toHaveLength(2);
      expect(await axeViolations(container)).toEqual([]);
    },
  );

  it("is in the navigation, and the Usage page links to it", async () => {
    renderDashboard("/usage", server);
    const plan = await screen.findByRole("region", { name: "Plan" });
    expect(within(plan).getByRole("link", { name: "Compare plans" }).getAttribute("href")).toBe(
      "/plan",
    );
    const nav = screen.getAllByRole("navigation", { name: "Main", hidden: true })[0] as HTMLElement;
    expect(within(nav).getByRole("link", { name: "Plan", hidden: true })).toBeTruthy();
  });

  it("shows a workspace admin its totals and requests for the other paid plans", async () => {
    server.workspaces.acme = workspace("acme", "admin", { name: "Acme", usage: teamUsage() });
    const { container } = renderDashboard("/plan?workspace=acme", server);
    const all = await planPage();
    const current = await screen.findByRole("region", { name: "Current plan" });
    expect(within(current).getByText("Seats").nextElementSibling?.textContent).toBe("3");
    // The usage endpoint's limits are the owner's totals: no "per seat" here.
    expect(within(current).getByText("90 GB")).toBeTruthy();
    expect(within(current).getByText("Using workspaces")).toBeTruthy();
    const team = within(all).getByRole("article", { name: "Team" });
    expect(within(team).getByText("Current plan")).toBeTruthy();
    expect(requestLinks().map(([name]) => name)).toEqual([
      "Request access to the Pro plan",
      "Request access to the Enterprise plan",
    ]);
    expect(screen.queryByText(/Only the admins of/)).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("shows a workspace editor the plan with a note instead of the requests", async () => {
    server.workspaces.acme = workspace("acme", "editor", { name: "Acme", usage: teamUsage() });
    const { container } = renderDashboard("/plan?workspace=acme", server);
    await planPage();
    await screen.findByRole("region", { name: "Current plan" });
    expect(requestLinks()).toEqual([]);
    expect(screen.getByText("Only the admins of Acme can request another plan.")).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("shows a workspace member the plans without the workspace's own or any request", async () => {
    server.workspaces.acme = workspace("acme", "member", { name: "Acme" });
    const { container } = renderDashboard("/plan?workspace=acme", server);
    const all = await planPage();
    expect(screen.getByText("The plan of Acme is shown to its editors and admins.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Current plan" })).toBeNull();
    expect(within(all).queryByText("Current plan")).toBeNull();
    expect(requestLinks()).toEqual([]);
    expect(screen.getByText("Only the admins of Acme can request another plan.")).toBeTruthy();
    expect(server.requests.some((r) => r.path === "/api/v1/usage")).toBe(false);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("is translated, with prices in US dollars and numbers in the language's format", async () => {
    const i18n = createI18n();
    await activateLocale(i18n, "es");
    renderDashboard("/plan", server, { i18n });
    await screen.findByRole("heading", { level: 1, name: "Plan" });
    const all = screen.getByRole("region", { name: "Todos los planes" });
    const table = within(all).getByRole("table", { name: "Límites de cada plan" });
    expect(within(table).getByRole("rowheader", { name: "Almacenamiento" })).toBeTruthy();
    expect(within(table).getAllByText(/^30\sGB por puesto$/)).toHaveLength(2);
    expect(
      screen.getByRole("link", { name: "Solicitar acceso al plan Pro" }).getAttribute("href"),
    ).toBe(planRequestHref("pro"));
    expect(within(all).getByRole("article", { name: "Pro" }).textContent).toMatch(/2\s?US\$/);
  });
});
