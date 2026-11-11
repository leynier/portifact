// @vitest-environment happy-dom
// "Download your data" and the grace notice (decision 0022, second delivery): the page lists every
// artifact with its retained versions and downloads, the logs and, during a grace, what goes on
// which date; the notice shows on every page of the space until hidden for the day.
import { PLANS } from "@portifact/contracts";
import { planRequestHref } from "@portifact/contracts/plans";
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  artifact,
  type FakeServer,
  fakeServer,
  renderDashboard,
  seedVersion,
  usageView,
  workspace,
} from "./test-support.tsx";

const ID = "k7d2qm4xab";
const GRACE = {
  until: "2027-01-09T12:00:00.000Z",
  plan: "pro" as const,
  limits: {
    archiveMonths: 12,
    retainedPreviousVersions: 50,
    previousVersionRetentionDays: 90,
    accessLogRetentionDays: 365,
    auditRetentionDays: 90,
  },
  features: ["versionDiff" as const],
};

let server: FakeServer;
beforeEach(async () => {
  server = fakeServer([artifact(ID, { name: "Launch plan" })]);
  server.activity[ID] = { versions: 2, currentBytes: 12, openThreads: 0, lastAnnotationAt: null };
  await seedVersion(server, ID, [
    { path: "index.html", text: "<h1>v1</h1>" },
    { path: "src.zip", text: "zip bytes", kind: "source", contentType: "application/zip" },
  ]);
  await seedVersion(server, ID, [{ path: "index.html", text: "<h1>v2</h1>" }]);
  try {
    localStorage.clear();
  } catch {
    // No storage in this environment: nothing to clear.
  }
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

function inGrace() {
  server.usage = usageView({ plan: { ...usageView().plan, grace: GRACE } });
  server.graceForecast = {
    grace: GRACE,
    kinds: [
      { kind: "versions", count: 4, from: GRACE.until },
      { kind: "pins", count: 1, from: GRACE.until },
    ],
  };
}

describe("the Download your data page", () => {
  it.each(["light", "dark"] as const)(
    "lists what goes on which date during a grace, and every artifact's versions (%s)",
    async (theme) => {
      document.documentElement.dataset.theme = theme;
      inGrace();
      const { container, saved } = renderDashboard("/data", server);
      await screen.findByRole("heading", { level: 1, name: "Download your data" });
      const table = await screen.findByRole("table", {
        name: "What is deleted when the grace ends, and from when",
      });
      const rows = within(table).getAllByRole("row").slice(1);
      expect(rows.map((row) => row.textContent)).toEqual([
        expect.stringContaining("Previous versionsHow many4"),
        expect.stringContaining("Pinned artifacts"),
      ]);
      // The grace's own page shows no notice on top of itself.
      expect(screen.queryByRole("button", { name: "Hide for today" })).toBeNull();

      fireEvent.click(await screen.findByText(/^Launch plan: 2 retained versions$/));
      fireEvent.click(await screen.findByRole("button", { name: "Download sources of version 1" }));
      await waitFor(() => expect(saved).toHaveLength(1));
      expect(saved[0]?.fileName).toBe("src.zip");
      expect(screen.getByRole("button", { name: "Access log as CSV" })).toBeTruthy();
      expect(
        screen.getByRole("link", { name: "Download your account's data (JSON)" }),
      ).toBeTruthy();
      expect(await axeViolations(container)).toEqual([]);
    },
  );

  it("says nothing about a grace outside one, and asks for no forecast", async () => {
    renderDashboard("/data", server);
    await screen.findByRole("heading", { level: 1, name: "Download your data" });
    await screen.findByText(/^Launch plan: 2 retained versions$/);
    expect(screen.queryByText("What goes and when")).toBeNull();
    expect(server.requests.some((r) => r.path === "/api/v1/grace-forecast")).toBe(false);
  });

  it("is for a workspace's admins: an editor reads why instead", async () => {
    server.workspaces.acme = workspace("acme", "editor", { name: "Acme" });
    const { container } = renderDashboard("/data?workspace=acme", server);
    expect(
      await screen.findByText("Downloading all of Acme's data is for its admins."),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Download your data" })).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("the grace notice", () => {
  it.each(["light", "dark"] as const)(
    "shows on every page of the space with both actions, and hides for the day (%s)",
    async (theme) => {
      document.documentElement.dataset.theme = theme;
      inGrace();
      const first = renderDashboard("/usage", server);
      const title = await screen.findByText(/^What the Pro plan kept is held until /);
      const notice = title.closest('[role="status"]') as HTMLElement;
      expect(
        within(notice).getByRole("link", { name: "Download your data" }).getAttribute("href"),
      ).toBe("/data");
      expect(
        within(notice).getByRole("link", { name: "Ask for Pro again" }).getAttribute("href"),
      ).toBe(planRequestHref("pro"));
      expect(await axeViolations(first.container)).toEqual([]);
      cleanup();

      renderDashboard("/", server);
      await screen.findByText(/^What the Pro plan kept is held until /);
      fireEvent.click(screen.getByRole("button", { name: "Hide for today" }));
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Hide for today" })).toBeNull(),
      );
      cleanup();
      // Hidden for the rest of the day in this browser, on every page.
      renderDashboard("/usage", server);
      await screen.findByRole("heading", { level: 1 });
      expect(screen.queryByRole("button", { name: "Hide for today" })).toBeNull();
    },
  );

  it("tells an editor to ask an admin, with no download or request", async () => {
    server.workspaces.acme = workspace("acme", "editor", {
      name: "Acme",
      usage: usageView({ plan: { ...usageView().plan, limits: PLANS.free.limits, grace: GRACE } }),
    });
    renderDashboard("/usage?workspace=acme", server);
    const title = await screen.findByText(/^What the Pro plan kept is held until /);
    const notice = title.closest('[role="status"]') as HTMLElement;
    expect(within(notice).queryByRole("link")).toBeNull();
    expect(within(notice).getByText(/Ask an admin of this space/)).toBeTruthy();
  });
});
