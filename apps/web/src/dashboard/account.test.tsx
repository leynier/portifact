// @vitest-environment happy-dom
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  browserSession,
  connectedApp,
  type FakeServer,
  fakeServer,
  renderDashboard,
} from "./test-support.tsx";

afterEach(cleanup);

/** Queries retry a failed load once, about a second later. */
const RETRIED = { timeout: 3000 };

let server: FakeServer;
beforeEach(() => {
  server = fakeServer([]);
  server.providers = [
    { providerId: "github", createdAt: "2026-10-01T12:00:00.000Z" },
    { providerId: "credential", createdAt: "2026-10-01T12:00:00.000Z" },
  ];
  server.sessions = [
    browserSession({ current: true }),
    browserSession({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      lastActiveAt: "2026-11-07T09:30:00.000Z",
    }),
    browserSession({ userAgent: null }),
  ];
  server.apps = [
    connectedApp("portifact-cli"),
    connectedApp("mcp-client-1", {
      name: "Claude Code",
      firstParty: false,
      resources: ["mcp"],
      scopes: ["artifacts:read", "artifacts:share", "custom:thing"],
      expiresAt: null,
    }),
  ];
});

const region = (name: string) => screen.findByRole("region", { name });

describe("account screen", () => {
  it("is reachable from the navigation and shows the signed-in email and member date", async () => {
    const { router } = renderDashboard("/", server);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    fireEvent.click(within(nav).getByRole("link", { name: "Account" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/account"));
    expect(await screen.findByRole("heading", { level: 1, name: "Account" })).toBeTruthy();
    expect(within(nav).getByRole("link", { name: "Account" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(document.title).toBe("Account · Portifact");
    const profile = await region("Profile");
    expect(
      within(profile)
        .getAllByRole("definition")
        .map((d) => d.textContent),
    ).toEqual(["ada@example.test", "Sep 1, 2026"]);
    await waitFor(() => expect(document.activeElement?.id).toBe("main"));
  });

  it("leaves out the member date when the session does not say", async () => {
    server.createdAt = null;
    renderDashboard("/account", server);
    const profile = await region("Profile");
    expect(
      within(profile)
        .getAllByRole("term")
        .map((d) => d.textContent),
    ).toEqual(["Email"]);
  });

  it("lists the email code and linked providers, ignoring internal ones", async () => {
    renderDashboard("/account", server);
    const methods = await region("Sign-in methods");
    await within(methods).findByText("GitHub");
    expect(
      within(methods)
        .getAllByRole("term")
        .map((t) => t.textContent),
    ).toEqual(["Email code", "GitHub"]);
    expect(methods.textContent).toContain("Codes are sent to ada@example.test");
    expect(methods.textContent).toContain("Connected on Oct 1, 2026");
    expect(methods.textContent).toContain("joins this account automatically");
  });

  it("has no axe violations with every section loaded", async () => {
    const { container } = renderDashboard("/account", server);
    await screen.findByRole("table", { name: "Browsers signed in to your account" });
    await screen.findByRole("heading", { name: /Claude Code/ });
    await screen.findByText("GitHub");
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("browser sessions", () => {
  it("lists browsers in words, marks this one and when each was active", async () => {
    renderDashboard("/account", server);
    const table = await screen.findByRole("table", { name: "Browsers signed in to your account" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell")[0]?.textContent)).toEqual([
      "Firefox on LinuxThis browser",
      "Safari on iOS",
      "Unknown browser",
    ]);
    expect(rows[1]?.textContent).toContain("Nov 7, 2026");
  });

  it("signs out the other sessions only after confirming, and announces how many", async () => {
    const { container } = renderDashboard("/account", server);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out other sessions" }));
    const dialog = screen.getByRole("dialog", { name: "Sign out other sessions?" });
    expect(dialog.textContent).toContain(
      "Apps you connected, such as the CLI and your agents, keep working",
    );
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(server.requests.some((r) => r.method === "POST")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Sign out other sessions" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Sign out others" }),
    );
    expect(await screen.findByText("Signed out 2 other sessions.")).toBeTruthy();
    expect(server.requests).toContainEqual({
      method: "POST",
      path: "/api/v1/account/sessions/sign-out-others",
    });
    expect(await screen.findByText("This is the only browser signed in.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign out other sessions" })).toBeNull();
  });

  it("offers nothing to sign out when this is the only browser", async () => {
    server.sessions = [browserSession({ current: true })];
    renderDashboard("/account", server);
    expect(await screen.findByText("This is the only browser signed in.")).toBeTruthy();
  });

  it("shows why signing out the others failed", async () => {
    server.fail("POST", "/api/v1/account/sessions/sign-out-others", {
      status: 429,
      code: "rate_limited",
    });
    renderDashboard("/account", server);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out other sessions" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Sign out others" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The action did not finish");
    expect(alert.textContent).toContain("Too many requests.");
    expect(server.sessions).toHaveLength(3);
  });

  it("offers a retry when sessions cannot load", async () => {
    server.fail("GET", "/api/v1/account/sessions", { status: 0, network: true }, 2);
    renderDashboard("/account", server);
    const sessions = await region("Browser sessions");
    const alert = await within(sessions).findByRole("alert", {}, RETRIED);
    expect(alert.textContent).toContain("Browser sessions could not be loaded");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table")).toBeTruthy();
  });

  it("names a browser or a system alone when only one is known", async () => {
    server.sessions = [
      browserSession({ current: true, userAgent: "Mozilla/5.0 Firefox/140.0" }),
      browserSession({ userAgent: "SomeBot (Windows NT 10.0)" }),
    ];
    renderDashboard("/account", server);
    const table = await screen.findByRole("table");
    const names = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell")[0]?.textContent);
    expect(names).toEqual(["FirefoxThis browser", "Windows"]);
  });
});

describe("connected apps", () => {
  it("shows each app with who made it, what it connects to and what it may do", async () => {
    renderDashboard("/account", server);
    const apps = await region("Connected apps");
    const cli = (await within(apps).findByRole("heading", { name: /Portifact CLI/ })).closest("li");
    const claude = within(apps)
      .getByRole("heading", { name: /Claude Code/ })
      .closest("li");
    expect(cli?.textContent).toContain("Made by Portifact");
    expect(cli?.textContent).toContain("Portifact API");
    expect(cli?.textContent).toContain("See your artifacts, their settings and their versions");
    expect(cli?.textContent).toContain("Stay connected until you disconnect it");
    expect(cli?.textContent).toContain("Dec 1, 2026");
    expect(claude?.textContent).toContain("Third-party app");
    expect(claude?.textContent).toContain("Portifact MCP");
    expect(claude?.textContent).toContain("Change who can open your artifacts");
    expect(claude?.textContent).toContain("Use the permission custom:thing");
    expect(claude?.textContent).toContain("Does not expire");
  });

  it("disconnects an app only after confirming and announces it", async () => {
    const { container } = renderDashboard("/account", server);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Claude Code" }));
    const dialog = screen.getByRole("dialog", { name: "Disconnect Claude Code?" });
    expect(dialog.textContent).toContain("It loses access right away");
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(server.requests.some((r) => r.method === "DELETE")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect Claude Code" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("Claude Code disconnected.")).toBeTruthy();
    expect(server.requests).toContainEqual({
      method: "DELETE",
      path: "/api/v1/account/apps/mcp-client-1",
    });
    await waitFor(() => expect(screen.queryByRole("heading", { name: /Claude Code/ })).toBeNull());
    expect(screen.getByRole("heading", { name: /Portifact CLI/ })).toBeTruthy();
  });

  it("shows why a disconnection failed", async () => {
    server.fail("DELETE", "/api/v1/account/apps/portifact-cli", { status: 404, code: "not_found" });
    renderDashboard("/account", server);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Portifact CLI" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Disconnect" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The action did not finish");
  });

  it("explains how to connect one when there are none, and names unnamed apps", async () => {
    server.apps = [];
    const { container } = renderDashboard("/account", server);
    expect(await screen.findByRole("heading", { name: "No apps connected" })).toBeTruthy();
    expect(screen.getByText(/Run portifact login in a terminal/)).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
    cleanup();

    server.apps = [connectedApp("x", { name: "  ", firstParty: false })];
    renderDashboard("/account", server);
    expect(await screen.findByRole("button", { name: "Disconnect Unnamed app" })).toBeTruthy();
  });

  it("offers a retry when apps or sign-in methods cannot load", async () => {
    server.fail("GET", "/api/v1/account/apps", { status: 503, code: "capacity_unavailable" }, 2);
    server.fail("GET", "/api/auth/list-accounts", { status: 500 }, 2);
    renderDashboard("/account", server);
    const apps = await region("Connected apps");
    expect((await within(apps).findByRole("alert", {}, RETRIED)).textContent).toContain(
      "Connected apps could not be loaded",
    );
    const methods = await region("Sign-in methods");
    expect((await within(methods).findByRole("alert", {}, RETRIED)).textContent).toContain(
      "Sign-in methods could not be loaded",
    );
  });
});
