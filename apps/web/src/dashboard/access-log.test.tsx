// @vitest-environment happy-dom
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { artifact, type FakeServer, fakeServer, renderDashboard } from "./test-support.tsx";

afterEach(cleanup);

const ID = "k7d2qm4xab";
const PATH = `/artifacts/${ID}`;
/** Queries retry a failed load once, about a second later. */
const RETRIED = { timeout: 3000 };
const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-08T12:00:00.000Z");

let server: FakeServer;
beforeEach(() => {
  server = fakeServer([artifact(ID, { name: "Launch plan" })]);
});

const region = () => screen.findByRole("region", { name: "Who opened it" });

function seed(count: number) {
  server.accessLogs[ID] = Array.from({ length: count }, (_, i) => ({
    email: `visitor${i}@example.test`,
    openedAt: new Date(NOW - i * HOUR).toISOString(),
  }));
}

describe("access log", () => {
  it("lists who opened the artifact, newest first, and explains what is recorded", async () => {
    seed(2);
    const { container } = renderDashboard(PATH, server);
    const section = await region();
    const table = await within(section).findByRole("table", {
      name: "Openings of this artifact by signed-in visitors",
    });
    const rows = within(table).getAllByRole("row");
    expect(rows.map((row) => row.textContent)).toEqual([
      "OpenedVisitor",
      expect.stringContaining("visitor0@example.test"),
      expect.stringContaining("visitor1@example.test"),
    ]);
    expect(section.textContent).toContain("Only you see this list.");
    expect(section.textContent).toContain("Anonymous visits to public artifacts");
    expect(section.textContent).toContain("some openings may be missing");
    expect(within(section).queryByRole("button", { name: "Show more" })).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("loads more entries page by page", async () => {
    seed(3);
    server.pageSize = 2;
    renderDashboard(PATH, server);
    const section = await region();
    await within(section).findByText("visitor1@example.test");
    expect(within(section).queryByText("visitor2@example.test")).toBeNull();
    fireEvent.click(within(section).getByRole("button", { name: "Show more" }));
    await within(section).findByText("visitor2@example.test");
    expect(within(section).queryByRole("button", { name: "Show more" })).toBeNull();
    expect(
      server.requests.filter((r) => r.path.startsWith(`/api/v1/artifacts/${ID}/access-log`)),
    ).toEqual([
      { method: "GET", path: `/api/v1/artifacts/${ID}/access-log` },
      { method: "GET", path: `/api/v1/artifacts/${ID}/access-log?cursor=2` },
    ]);
  });

  it("says when nobody opened it", async () => {
    const { container } = renderDashboard(PATH, server);
    const section = await region();
    await within(section).findByRole("heading", { name: "No visitors yet" });
    expect(section.textContent).toContain("Nobody signed in has opened this artifact");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("shows an error with a retry when the log cannot be loaded", async () => {
    server.fail("GET", `/api/v1/artifacts/${ID}/access-log`, { status: 500 }, 2);
    const { container } = renderDashboard(PATH, server);
    const section = await region();
    const alert = await within(section).findByRole("alert", {}, RETRIED);
    expect(alert.textContent).toContain("The access log could not be loaded");
    expect(await axeViolations(container)).toEqual([]);
    seed(1);
    fireEvent.click(within(section).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(within(section).getByText("visitor0@example.test")).toBeTruthy());
  });
});
