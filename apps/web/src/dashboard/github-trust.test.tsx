// @vitest-environment happy-dom
// The GitHub Actions section of the Service tokens page (decision 0024): admins list, add and
// remove trusted repositories; privileged events need a confirmation; switched off on the
// deployment only the list and removing remain; accessible in both themes.
import type { GitHubTrustRuleView } from "@portifact/contracts";
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeServer, fakeServer, renderDashboard, workspace } from "./test-support.tsx";

afterEach(cleanup);

let server: FakeServer;
beforeEach(() => {
  server = fakeServer();
});

const RULE: GitHubTrustRuleView = {
  id: `gtr_${"1".repeat(32)}`,
  repository: "acme/site",
  repositoryId: "123456",
  repositoryOwnerId: "777",
  events: ["push", "pull_request"],
  ref: null,
  environment: "preview",
  scopes: ["artifacts:read", "artifacts:write"],
  keyPrefix: "gh-123456/",
  liveCredentials: 1,
  createdAt: "2026-11-01T12:00:00.000Z",
  updatedAt: "2026-11-01T12:00:00.000Z",
  createdBy: { name: "Ada" },
  revision: 0,
};

const posted = () =>
  server.requests.filter((r) => r.path.endsWith("/github-trust") && r.method === "POST");

const section = async () =>
  (await screen.findByRole("heading", { name: "GitHub Actions" })).closest(
    "section",
  ) as HTMLElement;

describe("the GitHub Actions section", () => {
  it("lists trusted repositories with their IDs, events and namespace, accessibly in both themes", async () => {
    server.workspaces.acme = workspace("acme", "admin", { name: "Acme" });
    server.workspaces.acme.githubTrust = [RULE];
    const { container } = renderDashboard("/service-tokens?workspace=acme", server);
    const card = (await screen.findByRole("heading", { name: "acme/site" })).closest(
      "li",
    ) as HTMLElement;
    expect(within(card).getByText("Repository ID 123456, owner ID 777")).toBeTruthy();
    expect(within(card).getByText("Events: push, pull_request")).toBeTruthy();
    expect(within(card).getByText("Publishes only keys that start with gh-123456/")).toBeTruthy();
    expect(within(card).getByText("Environment: preview")).toBeTruthy();
    expect(within(card).getByText("1 live credential")).toBeTruthy();
    expect(screen.getByText("https://app.portifact.com/workspaces/acme/github")).toBeTruthy();
    for (const colorScheme of ["light", "dark"] as const) {
      document.documentElement.dataset.theme = colorScheme;
      expect(await axeViolations(container), colorScheme).toEqual([]);
    }
    delete document.documentElement.dataset.theme;
  });

  it("trusts a repository by its IDs, with the safe events by default", async () => {
    server.workspaces.acme = workspace("acme", "admin", { name: "Acme" });
    renderDashboard("/service-tokens?workspace=acme", server);
    const area = await section();
    expect(await within(area).findByText("No trusted repositories")).toBeTruthy();
    fireEvent.change(within(area).getByRole("textbox", { name: "Repository" }), {
      target: { value: "acme/site" },
    });
    fireEvent.change(within(area).getByRole("textbox", { name: "Repository ID" }), {
      target: { value: "123456" },
    });
    fireEvent.change(within(area).getByRole("textbox", { name: "Owner ID" }), {
      target: { value: "777" },
    });
    expect((within(area).getByLabelText("pull_request") as HTMLInputElement).checked).toBe(true);
    expect((within(area).getByLabelText("pull_request_target") as HTMLInputElement).checked).toBe(
      false,
    );
    fireEvent.click(within(area).getByRole("button", { name: "Trust repository" }));
    expect(await within(area).findByRole("heading", { name: "acme/site" })).toBeTruthy();
    expect(server.workspaces.acme?.githubTrust[0]).toMatchObject({
      repository: "acme/site",
      repositoryId: "123456",
      repositoryOwnerId: "777",
      events: ["push", "pull_request"],
      scopes: ["artifacts:read", "artifacts:write"],
      ref: null,
      environment: null,
    });
  });

  it("asks for a confirmation before trusting events a fork can start, and checks the IDs", async () => {
    server.workspaces.acme = workspace("acme", "admin", { name: "Acme" });
    renderDashboard("/service-tokens?workspace=acme", server);
    const area = await section();
    await within(area).findByText("No trusted repositories");
    fireEvent.change(within(area).getByRole("textbox", { name: "Repository" }), {
      target: { value: "acme/site" },
    });
    fireEvent.change(within(area).getByRole("textbox", { name: "Repository ID" }), {
      target: { value: "acme" },
    });
    fireEvent.change(within(area).getByRole("textbox", { name: "Owner ID" }), {
      target: { value: "777" },
    });
    fireEvent.click(within(area).getByLabelText("pull_request_target"));
    fireEvent.click(within(area).getByRole("button", { name: "Trust repository" }));
    expect(await within(area).findByText("Use the number GitHub shows.")).toBeTruthy();
    expect(
      within(area).getAllByText("Confirm this to trust pull_request_target or workflow_run.")
        .length,
    ).toBeGreaterThan(1);
    expect(posted()).toEqual([]);
    fireEvent.change(within(area).getByRole("textbox", { name: "Repository ID" }), {
      target: { value: "123456" },
    });
    fireEvent.click(within(area).getByLabelText(/^I understand/));
    fireEvent.click(within(area).getByRole("button", { name: "Trust repository" }));
    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(server.workspaces.acme?.githubTrust[0]?.events).toContain("pull_request_target");
  });

  it("removes a repository after a confirmation", async () => {
    server.workspaces.acme = workspace("acme", "admin", { name: "Acme" });
    server.workspaces.acme.githubTrust = [RULE];
    renderDashboard("/service-tokens?workspace=acme", server);
    fireEvent.click(await screen.findByRole("button", { name: "Remove acme/site" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/credentials already issued/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("No trusted repositories")).toBeTruthy();
  });

  it("switched off, lists and removes but offers no new trust", async () => {
    server.workspaces.acme = workspace("acme", "admin", { name: "Acme" });
    server.workspaces.acme.githubTrust = [RULE];
    server.workspaces.acme.githubOidcEnabled = false;
    renderDashboard("/service-tokens?workspace=acme", server);
    expect(await screen.findByRole("heading", { name: "acme/site" })).toBeTruthy();
    expect(screen.getByText(/not available on Portifact yet/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Trust repository" })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove acme/site" })).toBeTruthy();
  });
});
