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

/** Each meter's accessible name and the words it is described by. */
function meters(region: HTMLElement): Record<string, string> {
  return Object.fromEntries(
    within(region)
      .getAllByRole("meter")
      .map((meter) => {
        const name = document.getElementById(meter.getAttribute("aria-labelledby") ?? "");
        const [text] = (meter.getAttribute("aria-describedby") ?? "").split(" ");
        return [name?.textContent ?? "", document.getElementById(text ?? "")?.textContent ?? ""];
      }),
  );
}

const usagePage = async () => {
  await screen.findByRole("heading", { level: 1, name: "Usage" });
  return screen.getByRole("main");
};

describe("account usage", () => {
  it("shows the free plan without seats or an end", async () => {
    renderDashboard("/usage", server);
    const plan = await screen.findByRole("region", { name: "Plan" });
    expect(within(plan).getByText("Your plan sets the limits on this page.")).toBeTruthy();
    expect(within(plan).getByText("Current plan").nextElementSibling?.textContent).toBe("Free");
    expect(within(plan).queryByText("Seats")).toBeNull();
    expect(within(plan).queryByText("Valid until")).toBeNull();
  });

  it("shows a team plan's seats, its end and its higher limits", async () => {
    const base = usageView();
    server.usage = usageView({
      plan: {
        ...base.plan,
        name: "team",
        seats: 3,
        validUntil: "2027-01-31T00:00:00.000Z",
      },
      activeArtifacts: { used: 60, limit: 2_000 },
    });
    const { container } = renderDashboard("/usage", server);
    const plan = await screen.findByRole("region", { name: "Plan" });
    expect(within(plan).getByText("Current plan").nextElementSibling?.textContent).toBe("Team");
    expect(within(plan).getByText("Seats").nextElementSibling?.textContent).toBe("3");
    expect(within(plan).getByText("Valid until").nextElementSibling?.textContent).toBe(
      local("2027-01-31T00:00:00.000Z"),
    );
    await waitFor(() =>
      expect(meters(screen.getByRole("main"))["Active artifacts"]).toBe("60 of 2,000 (3%)"),
    );
    expect(await axeViolations(container)).toEqual([]);
  });

  it("is reachable from the navigation", async () => {
    const { router } = renderDashboard("/", server);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    fireEvent.click(within(nav).getByRole("link", { name: "Usage" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/usage"));
    expect(document.title).toBe("Usage · Portifact");
    expect(within(nav).getByRole("link", { name: "Usage" }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("shows every quota with its value, limit, share and what it counts", async () => {
    const { container } = renderDashboard("/usage", server);
    const page = await usagePage();
    await waitFor(() => expect(within(page).getAllByRole("meter").length).toBeGreaterThan(0));
    expect(meters(page)).toEqual({
      "Requests served this month": "12,345 of 1,000,000 (1%)",
      "Data served this month": "3.2 GB of 25 GB (13%)",
      "Active artifacts": "2 of 50 (4%)",
      Storage: "1.5 MB of 2.5 GB (0%)",
      "Publishes, last 24 hours": "3 of 100 (3%)",
      "Uploads in progress": "0 of 2 (0%)",
      "New files, last 24 hours": "0 of 10,000 (0%)",
      "New data, last 24 hours": "0 bytes of 5 GB (0%)",
      "New files this month": "0 of 100,000 (0%)",
    });
    expect(
      within(await screen.findByRole("region", { name: "Traffic this month" })).getByText(
        /Counted for your whole account/,
      ),
    ).toBeTruthy();
    const newObjects = within(page)
      .getAllByRole("meter")
      .find(
        (meter) =>
          document.getElementById(meter.getAttribute("aria-labelledby") ?? "")?.textContent ===
          "New files this month",
      );
    expect(newObjects?.getAttribute("aria-describedby")?.split(" ")).toHaveLength(2);
    expect(page.textContent).toContain(`Resets on ${local("2026-12-01T00:00:00.000Z")}.`);
    const traffic = await screen.findByRole("region", { name: "Traffic this month" });
    const reset = within(traffic).getByRole("term");
    expect(reset.textContent).toBe("Traffic resets on");
    expect(reset.nextElementSibling?.textContent).toBe(local("2026-12-01T00:00:00.000Z"));
    const versions = await screen.findByRole("region", { name: "Limits of each version" });
    expect(
      within(versions)
        .getAllByRole("definition")
        .map((d) => d.textContent),
    ).toEqual(["250 MB", "1,000", "5 MB"]);
    // The account is old enough to publish in public, so nothing says when it may.
    expect(within(page).queryByText("Public artifacts are available soon")).toBeNull();
    // Nothing is close to its limit, so no meter warns.
    expect(within(page).queryByText("Near the limit")).toBeNull();
    expect(within(page).queryByText("Your artifacts used this month's traffic")).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("says when a new account may make artifacts public", async () => {
    const from = new Date(Date.now() + 10 * 60_000).toISOString();
    server.usage = usageView({ publicAccessFrom: from });
    renderDashboard("/usage", server);
    const title = await screen.findByText("Public artifacts are available soon");
    expect(title.closest('[role="status"]')?.textContent).toContain(`You can from ${local(from)}.`);
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
    const { container } = renderDashboard("/usage", server);
    const region = await usagePage();
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
    // The requests meter is full: it says so in words, read with the meter.
    expect(meters(region)["Requests served this month"]).toBe("1,000,000 of 1,000,000 (100%)");
    expect(within(region).getByText("Limit reached")).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("shows an error with a retry when usage cannot load", async () => {
    server.fail("GET", "/api/v1/usage", { status: 500 }, 2);
    renderDashboard("/usage", server);
    const region = await usagePage();
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
    await waitFor(() => expect(router.state.location.pathname).toBe("/usage"));
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
