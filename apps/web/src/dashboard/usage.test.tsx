// @vitest-environment happy-dom
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  artifact,
  type FakeServer,
  fakeServer,
  renderDashboard,
  usageView,
} from "./test-support.tsx";

afterEach(cleanup);

/** How the dashboard shows an instant: in the visitor's time zone, with the time. */
const local = (iso: string) =>
  new Date(iso).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });

/** Queries retry a failed load once, about a second later. */
const RETRIED = { timeout: 3000 };

const TRAFFIC_BLOCK = {
  reason: "traffic" as const,
  stops: "serving" as const,
  message: "Your artifacts served this month's traffic.",
  until: "2026-12-01T00:00:00.000Z",
};

let server: FakeServer;
beforeEach(() => {
  server = fakeServer([artifact("k7d2qm4xab", { name: "Launch plan" })]);
});

const usageRegion = () => screen.findByRole("region", { name: "Usage" });

describe("account usage", () => {
  it("shows the quotas and this month's traffic with their limits", async () => {
    const { container } = renderDashboard("/account", server);
    const region = await usageRegion();
    await waitFor(() => expect(within(region).getAllByRole("term").length).toBeGreaterThan(0));
    const rows = Object.fromEntries(
      within(region)
        .getAllByRole("term")
        .map((term) => [term.textContent, term.nextElementSibling?.textContent]),
    );
    expect(rows).toEqual({
      "Active artifacts": "2 of 50",
      Storage: "1.5 MB of 2.5 GB",
      "Publishes, last 24 hours": "3 of 100",
      "Requests served this month": "12,345 of 1,000,000",
      "Data served this month": "3.2 GB of 25 GB",
      "Traffic resets on": local("2026-12-01T00:00:00.000Z"),
    });
    expect(within(region).queryByText("Your artifacts used this month's traffic")).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("explains that artifacts answer 429 until the next month when traffic is used up", async () => {
    server.usage = usageView({
      trafficThisMonth: {
        requests: { used: 1_000_000, limit: 1_000_000 },
        bytes: { used: 4_000_000, limit: 25_000_000_000 },
        resetsAt: "2026-12-01T00:00:00.000Z",
      },
      blocks: [
        TRAFFIC_BLOCK,
        {
          reason: "storage",
          stops: "publishing",
          message: "Your 2.5 GB of storage is full.",
          until: null,
        },
        {
          reason: "publishes_per_24h",
          stops: "publishing",
          message: "You published 100 times in the last 24 hours.",
          until: "2026-11-09T08:30:00.000Z",
        },
      ],
    });
    const { container } = renderDashboard("/account", server);
    const region = await usageRegion();
    const title = await within(region).findByText("Your artifacts used this month's traffic");
    const notice = title.closest('[role="status"]') as HTMLElement;
    expect(notice.textContent).toContain("HTTP 429");
    expect(notice.textContent).toContain(`until ${local("2026-12-01T00:00:00.000Z")}`);
    expect(notice.textContent).toContain("you can still publish");
    // The notice is already on this page, so it does not link to itself.
    expect(within(notice).queryByRole("link")).toBeNull();
    const others = within(region)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(others).toEqual([
      "Your 2.5 GB of storage is full.",
      `You published 100 times in the last 24 hours. Lifts ${local("2026-11-09T08:30:00.000Z")}.`,
    ]);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("shows an error with a retry when usage cannot load", async () => {
    server.fail("GET", "/api/v1/usage", { status: 500 }, 2);
    renderDashboard("/account", server);
    const region = await usageRegion();
    expect(await within(region).findByText("Usage could not be loaded", {}, RETRIED)).toBeTruthy();
    fireEvent.click(within(region).getByRole("button", { name: "Try again" }));
    expect(await within(region).findByText("Requests served this month")).toBeTruthy();
  });
});

describe("artifact list traffic notice", () => {
  it("explains the 429 state above the list and links to the usage section", async () => {
    server.usage = usageView({ blocks: [TRAFFIC_BLOCK] });
    const { router } = renderDashboard("/", server);
    const title = await screen.findByText("Your artifacts used this month's traffic");
    const notice = title.closest('[role="status"]') as HTMLElement;
    expect(notice.textContent).toContain("HTTP 429");
    expect(await screen.findByRole("link", { name: "Launch plan" })).toBeTruthy();
    fireEvent.click(within(notice).getByRole("link", { name: "See your usage" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/account"));
    expect(router.state.location.hash).toBe("usage");
  });

  it("shows no notice without a traffic block, or when usage cannot load", async () => {
    server.usage = usageView({
      blocks: [
        {
          reason: "storage",
          stops: "publishing",
          message: "Your 2.5 GB of storage is full.",
          until: null,
        },
      ],
    });
    renderDashboard("/", server);
    expect(await screen.findByRole("link", { name: "Launch plan" })).toBeTruthy();
    await waitFor(() =>
      expect(server.requests.some((request) => request.path === "/api/v1/usage")).toBe(true),
    );
    expect(screen.queryByText("Your artifacts used this month's traffic")).toBeNull();
    cleanup();

    server.fail("GET", "/api/v1/usage", { status: 500 }, 5);
    renderDashboard("/", server);
    expect(await screen.findByRole("link", { name: "Launch plan" })).toBeTruthy();
    expect(screen.queryByText("Your artifacts used this month's traffic")).toBeNull();
  });
});
