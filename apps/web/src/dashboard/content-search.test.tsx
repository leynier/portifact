// @vitest-environment happy-dom
import { PLANS } from "@portifact/contracts";
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  artifact,
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

const teamUsage = () =>
  usageView({
    plan: {
      ...usageView().plan,
      name: "team",
      limits: { ...PLANS.team.limits },
      features: [...PLANS.team.features],
    },
  });

let server: FakeServer;
beforeEach(() => {
  server = fakeServer([
    artifact("k7d2qm4xab", { name: "Launch plan" }),
    artifact("p3c5rn7yzd", { name: "Budget" }),
  ]);
  server.search[""] = [
    {
      artifactId: "k7d2qm4xab",
      path: "docs/roadmap.html",
      snippet: { text: "The quarterly roadmap <b>for</b> Q3", highlights: [[4, 13]] },
      partial: true,
    },
  ];
});

const toggle = () => screen.queryByRole("checkbox", { name: /Search inside content/ });
const searchPaths = () =>
  server.requests.filter((r) => r.path.startsWith("/api/v1/search")).map((r) => r.path);

describe("searching inside content", () => {
  it("finds artifacts by their text, with the file and a highlighted snippet", async () => {
    server.usage = teamUsage();
    const { container, router } = renderDashboard("/", server);
    await screen.findByRole("table", { name: "Your artifacts" });
    fireEvent.click(await screen.findByRole("checkbox", { name: /Search inside content/ }));
    await waitFor(() => expect(router.state.location.search).toEqual({ in: "content" }));
    // The filters describe names and settings, so they step aside.
    expect(screen.queryByRole("combobox", { name: "Type" })).toBeNull();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search inside content" }), {
      target: { value: " quarterly " },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Search and filter artifacts" }));
    const table = await screen.findByRole("table", {
      name: "Artifacts whose text matches the search",
    });
    expect(router.state.location.search).toEqual({ in: "content", search: "quarterly" });
    expect(searchPaths()).toEqual(["/api/v1/search?q=quarterly"]);
    const row = within(table).getAllByRole("row")[1] as HTMLElement;
    expect(within(row).getByRole("link", { name: "Launch plan" })).toBeTruthy();
    expect(row.textContent).toContain("In docs/roadmap.html");
    expect(row.textContent).toContain("Partly indexed");
    // The snippet is text: its markup is shown, never rendered, and the match is marked.
    expect(row.querySelector("b")).toBeNull();
    expect(row.textContent).toContain("<b>for</b>");
    expect([...row.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual([
      "quarterly",
    ]);
    expect(screen.getByText("Showing 1 artifact whose text matches").getAttribute("role")).toBe(
      "status",
    );
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.dataset.theme = theme;
      expect(await axeViolations(container), theme).toEqual([]);
    }
  });

  it("says when no text matches, and goes back to the name search when unchecked", async () => {
    server.usage = teamUsage();
    const { router } = renderDashboard("/?in=content&search=nothing", server);
    expect(await screen.findByText("No artifact's text matches")).toBeTruthy();
    expect(screen.getByText(/Archived artifacts are not searched/).getAttribute("role")).toBe(
      "status",
    );
    fireEvent.click(toggle() as HTMLElement);
    await waitFor(() => expect(router.state.location.search).toEqual({ search: "nothing" }));
    expect(await screen.findByText("No artifacts match")).toBeTruthy();
  });

  it("is not offered without the plan, and the URL alone does not turn it on", async () => {
    renderDashboard("/?in=content&search=quarterly", server);
    await screen.findByText("No artifacts match");
    expect(toggle()).toBeNull();
    expect(searchPaths()).toEqual([]);
  });

  it("is offered to a workspace's editors on a plan with it, and not to its members", async () => {
    server.workspaces.acme = workspace("acme", "editor", { usage: teamUsage() });
    server.search.acme = [
      {
        artifactId: "p3c5rn7yzd",
        path: "index.md",
        snippet: { text: "budget lines", highlights: [[0, 6]] },
        partial: false,
      },
    ];
    renderDashboard("/?workspace=acme&in=content&search=budget", server);
    await screen.findByRole("table", { name: "Artifacts whose text matches the search" });
    expect(searchPaths()).toEqual(["/api/v1/search?q=budget&workspace=acme"]);
    cleanup();

    server.workspaces.team = workspace("team", "member", { usage: teamUsage() });
    renderDashboard("/?workspace=team&in=content&search=budget", server);
    await screen.findByRole("heading", { name: "Artifacts" });
    expect(toggle()).toBeNull();
    expect(searchPaths()).toEqual(["/api/v1/search?q=budget&workspace=acme"]);
  });
});
