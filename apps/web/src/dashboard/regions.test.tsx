// @vitest-environment happy-dom
// What the dashboard tells an EU workspace's admins about destinations they choose (decision
// 0005, "What leaves the region"): the Webhooks and Integrations pages say that what they send
// leaves the EU; a workspace in the default region and the personal space get no such notice.
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeServer, fakeServer, renderDashboard, workspace } from "./test-support.tsx";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

let server: FakeServer;
beforeEach(() => {
  server = fakeServer([]);
  server.integrations.offered = true;
  server.workspaces.engines = workspace("engines", "admin", { name: "Engines", region: "eu" });
  server.workspaces.home = workspace("home", "admin", { name: "Home" });
});

const TITLE = "Where you send it may be outside the EU";

describe("the notice that a destination leaves the EU", () => {
  it.each([
    ["/webhooks", "Webhooks", "Webhook deliveries go to the addresses you enter"],
    ["/integrations", "Integrations", "Issues you create go to GitHub or Linear"],
  ])("is on %s for an EU workspace", async (path, heading, body) => {
    const { container } = renderDashboard(`${path}?workspace=engines`, server);
    await screen.findByRole("heading", { level: 1, name: heading });
    expect(await screen.findByText(TITLE)).toBeTruthy();
    expect(screen.getByText(new RegExp(body))).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });

  it.each([
    ["/webhooks?workspace=home", "Webhooks"],
    ["/integrations?workspace=home", "Integrations"],
    ["/webhooks", "Webhooks"],
  ])("is not on %s", async (path, heading) => {
    renderDashboard(path, server);
    await screen.findByRole("heading", { level: 1, name: heading });
    expect(screen.queryByText(TITLE)).toBeNull();
  });
});
