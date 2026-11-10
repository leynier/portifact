// @vitest-environment happy-dom
import type { ArtifactStatsView } from "@portifact/contracts";
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rangeStart } from "./screens/analytics.tsx";
import { artifact, choose, type FakeServer, fakeServer, renderDashboard } from "./test-support.tsx";

afterEach(cleanup);

const ID = "k7d2qm4xab";
const PATH = `/artifacts/${ID}`;

let server: FakeServer;
beforeEach(() => {
  server = fakeServer([artifact(ID, { name: "Launch plan" })]);
});

const region = () => screen.findByRole("region", { name: "Analytics" });

function stats(visitors: boolean): ArtifactStatsView {
  return {
    artifactId: ID,
    from: "2026-11-06",
    to: "2026-11-08",
    days: [
      { date: "2026-11-06", views: 4, signedInViews: 1, visitors: visitors ? 1 : null },
      { date: "2026-11-07", views: 0, signedInViews: 0, visitors: visitors ? 0 : null },
      { date: "2026-11-08", views: 12, signedInViews: 3, visitors: visitors ? 2 : null },
    ],
    totals: { views: 16, signedInViews: 4, visitors: visitors ? 3 : null },
    retentionDays: 365,
  };
}

describe("analytics", () => {
  it("shows the totals, a keyboard chart and the same numbers as a table", async () => {
    server.stats[ID] = stats(true);
    const { container } = renderDashboard(PATH, server);
    const section = await region();
    const chart = await within(section).findByRole("group", { name: "Views per day" });
    expect(section.textContent).toContain("Distinct signed-in visitors");
    expect(within(section).getByText("16")).toBeTruthy();
    // The last day is selected first; the arrow keys move along the series.
    expect(section.textContent).toContain("Views: 12. Signed in: 3. Distinct visitors: 2.");
    fireEvent.keyDown(chart, { key: "Home" });
    expect(section.textContent).toContain("Views: 4. Signed in: 1. Distinct visitors: 1.");
    const table = within(section).getByRole("table", {
      name: "Views per day of this artifact",
      hidden: true,
    });
    expect(within(table).getAllByRole("row", { hidden: true })).toHaveLength(4);
    expect(section.textContent).toContain("Kept 365 days.");
    expect(section.textContent).toContain("an indicator, not an audit");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("says visitors are only counted for restricted artifacts, and leaves the column out", async () => {
    server.stats[ID] = stats(false);
    renderDashboard(PATH, server);
    const section = await region();
    await within(section).findByRole("group", { name: "Views per day" });
    expect(section.textContent).toContain(
      "Only counted for artifacts restricted to the people you list",
    );
    expect(section.textContent).toContain("Views: 12. Signed in: 3.");
    expect(section.textContent).not.toContain("Distinct visitors:");
    const table = within(section).getByRole("table", { hidden: true });
    expect(within(table).getAllByRole("columnheader", { hidden: true })).toHaveLength(3);
  });

  it("asks for another period", async () => {
    server.stats[ID] = stats(true);
    renderDashboard(PATH, server);
    const section = await region();
    await within(section).findByRole("group", { name: "Views per day" });
    choose("Period", "Last 7 days");
    await waitFor(() =>
      expect(
        server.requests.filter((r) => r.path.includes("/stats")).map((r) => r.path),
      ).toContainEqual(expect.stringMatching(/\/stats\?from=\d{4}-\d{2}-\d{2}$/)),
    );
    expect(server.requests.filter((r) => r.path.includes("/stats")).length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it("explains that analytics are part of a paid plan when the owner's plan lacks them", async () => {
    const { container } = renderDashboard(PATH, server);
    const section = await region();
    await within(section).findByText(
      "Analytics per artifact and a one-year access log are part of the Pro plan.",
    );
    expect(within(section).queryByRole("button")).toBeNull();
    expect(within(section).queryByRole("link")).toBeNull();
    // Asked once: a plan answer is not retried.
    expect(server.requests.filter((r) => r.path.includes("/stats"))).toHaveLength(1);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("offers a retry when the analytics fail to load", async () => {
    server.fail("GET", `/api/v1/artifacts/${ID}/stats`, { status: 500 }, 2);
    server.stats[ID] = stats(true);
    renderDashboard(PATH, server);
    const section = await region();
    await within(section).findByText("The analytics could not be loaded", undefined, {
      timeout: 5000,
    });
    fireEvent.click(within(section).getByRole("button", { name: "Try again" }));
    await within(section).findByRole("group", { name: "Views per day" });
  });

  it("counts the period back from today in UTC", () => {
    const now = Date.parse("2026-11-08T23:00:00Z");
    expect(rangeStart(1, now)).toBe("2026-11-08");
    expect(rangeStart(30, now)).toBe("2026-10-10");
  });
});
