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

describe("profile page", () => {
  it("is reachable from the account at the bottom of the sidebar and shows who you are", async () => {
    const { router } = renderDashboard("/", server);
    const banner = await screen.findByRole("banner");
    const profileLink = await within(banner).findByRole("link", {
      name: "Profile: Ada, ada@example.test",
    });
    fireEvent.click(profileLink);
    await waitFor(() => expect(router.state.location.pathname).toBe("/profile"));
    expect(await screen.findByRole("heading", { level: 1, name: "Profile" })).toBeTruthy();
    expect(profileLink.getAttribute("aria-current")).toBe("page");
    expect(document.title).toBe("Profile · Portifact");
    const profile = await region("Your account");
    expect(
      within(profile)
        .getAllByRole("definition")
        .map((d) => d.textContent),
    ).toEqual(["Ada", "ada@example.test", "Sep 1, 2026"]);
    await waitFor(() => expect(document.activeElement?.id).toBe("main"));
  });

  it("leaves out the member date when the session does not say", async () => {
    server.createdAt = null;
    renderDashboard("/profile", server);
    const profile = await region("Your account");
    expect(
      within(profile)
        .getAllByRole("term")
        .map((d) => d.textContent),
    ).toEqual(["Name", "Email"]);
  });

  it("lists the email code and linked providers, ignoring internal ones", async () => {
    renderDashboard("/profile", server);
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
    const { container } = renderDashboard("/profile", server);
    await screen.findByRole("table", { name: "Browsers signed in to your account" });
    await screen.findByText("GitHub");
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("links to the old account page", () => {
  it.each([
    ["/account", "/profile"],
    ["/account#profile", "/profile"],
    ["/account#sessions", "/profile"],
    ["/account#usage", "/usage"],
    ["/account#apps", "/apps"],
    ["/account#data", "/settings"],
    ["/account#delete", "/settings"],
  ])("send %s to %s", async (from, to) => {
    const { router } = renderDashboard(from, server);
    await waitFor(() => expect(router.state.location.pathname).toBe(to));
  });
});

describe("browser sessions", () => {
  it("lists browsers in words, marks this one and when each was active", async () => {
    renderDashboard("/profile", server);
    const table = await screen.findByRole("table", { name: "Browsers signed in to your account" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell")[0]?.textContent)).toEqual([
      "Firefox on LinuxThis browser",
      "Safari on iOS",
      "Unknown browser",
    ]);
    expect(rows[1]?.textContent).toContain("Nov 7, 2026");
  });

  it("gives phones one card per browser instead of a table", async () => {
    renderDashboard("/profile", server);
    const cards = await screen.findByRole("list", { name: "Browsers signed in to your account" });
    const items = within(cards).getAllByRole("listitem");
    expect(items.map((item) => item.firstElementChild?.textContent)).toEqual([
      "Firefox on LinuxThis browser",
      "Safari on iOS",
      "Unknown browser",
    ]);
    expect(
      within(items[1] as HTMLElement)
        .getAllByRole("term")
        .map((term) => term.textContent),
    ).toEqual(["Last active", "Signed out on"]);
    expect(items[1]?.textContent).toContain("Nov 7, 2026");
  });

  it("signs out the other sessions only after confirming, and announces how many", async () => {
    const { container } = renderDashboard("/profile", server);
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
    renderDashboard("/profile", server);
    expect(await screen.findByText("This is the only browser signed in.")).toBeTruthy();
  });

  it("shows why signing out the others failed", async () => {
    server.fail("POST", "/api/v1/account/sessions/sign-out-others", {
      status: 429,
      code: "rate_limited",
    });
    renderDashboard("/profile", server);
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
    renderDashboard("/profile", server);
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
    renderDashboard("/profile", server);
    const table = await screen.findByRole("table");
    const names = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell")[0]?.textContent);
    expect(names).toEqual(["FirefoxThis browser", "Windows"]);
  });
});

describe("connected apps", () => {
  it("is reachable from the navigation, with a page header", async () => {
    const { router, container } = renderDashboard("/", server);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    fireEvent.click(within(nav).getByRole("link", { name: "Apps" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/apps"));
    expect(await screen.findByRole("heading", { level: 1, name: "Apps" })).toBeTruthy();
    expect(within(nav).getByRole("link", { name: "Apps" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(document.title).toBe("Apps · Portifact");
    await screen.findByRole("heading", { name: /Claude Code/ });
    expect(await axeViolations(container)).toEqual([]);
  });

  it("shows each app with who made it, what it connects to and what it may do", async () => {
    renderDashboard("/apps", server);
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
    const { container } = renderDashboard("/apps", server);
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
    renderDashboard("/apps", server);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Portifact CLI" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Disconnect" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The action did not finish");
  });

  it("explains how to connect one when there are none, and names unnamed apps", async () => {
    server.apps = [];
    const { container } = renderDashboard("/apps", server);
    expect(await screen.findByRole("heading", { name: "No apps connected" })).toBeTruthy();
    expect(screen.getByText(/Run portifact login in a terminal/)).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
    cleanup();

    server.apps = [connectedApp("x", { name: "  ", firstParty: false })];
    renderDashboard("/apps", server);
    expect(await screen.findByRole("button", { name: "Disconnect Unnamed app" })).toBeTruthy();
  });

  it("offers a retry when apps or sign-in methods cannot load", async () => {
    server.fail("GET", "/api/v1/account/apps", { status: 503, code: "capacity_unavailable" }, 2);
    server.fail("GET", "/api/auth/list-accounts", { status: 500 }, 2);
    renderDashboard("/apps", server);
    const apps = await region("Connected apps");
    expect((await within(apps).findByRole("alert", {}, RETRIED)).textContent).toContain(
      "Connected apps could not be loaded",
    );
    cleanup();
    renderDashboard("/profile", server);
    const methods = await region("Sign-in methods");
    expect((await within(methods).findByRole("alert", {}, RETRIED)).textContent).toContain(
      "Sign-in methods could not be loaded",
    );
  });
});

describe("your data", () => {
  it("offers the export as a download link", async () => {
    renderDashboard("/settings", server);
    const data = await region("Your data");
    const link = within(data).getByRole("link", { name: "Download your data" });
    expect(link.getAttribute("href")).toBe("/api/v1/account/export");
    expect(link.hasAttribute("download")).toBe(true);
  });
});

describe("account deletion", () => {
  const typeEmail = async (value: string) => {
    const section = await region("Danger zone");
    fireEvent.change(within(section).getByLabelText(/Type your email to confirm/), {
      target: { value },
    });
    return section;
  };

  it("deletes only after the email is typed and the dialog confirmed, then leaves", async () => {
    const { container, left } = renderDashboard("/settings", server);
    let section = await typeEmail("someone@example.test");
    fireEvent.click(within(section).getByRole("button", { name: "Delete account" }));
    expect(
      await within(section).findByText("Type your account's email exactly to confirm."),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();

    section = await typeEmail(" ADA@example.test ");
    fireEvent.click(within(section).getByRole("button", { name: "Delete account" }));
    const dialog = screen.getByRole("dialog", { name: "Delete your account for good?" });
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(server.requests.some((r) => r.path === "/api/v1/account/delete")).toBe(false);

    fireEvent.click(within(section).getByRole("button", { name: "Delete account" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Delete my account" }),
    );
    await waitFor(() => expect(left).toContain("/login"));
    expect(server.bodies.at(-1)).toEqual({ confirmEmail: "ADA@example.test" });
  });

  it("asks to sign in again when the session is too old", async () => {
    server.fail("POST", "/api/v1/account/delete", {
      status: 403,
      code: "reauthentication_required",
    });
    const { left } = renderDashboard("/settings", server);
    const section = await typeEmail("ada@example.test");
    fireEvent.click(within(section).getByRole("button", { name: "Delete account" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Delete my account" }),
    );
    const alert = await within(section).findByRole("alert");
    expect(alert.textContent).toContain("Sign in again to delete your account");
    fireEvent.click(within(alert).getByRole("button", { name: "Sign in again" }));
    await waitFor(() => expect(left).toContain("/login?next=%2Fsettings"));
    expect(server.requests).toContainEqual({ method: "POST", path: "/api/auth/sign-out" });
  });

  it("shows why the deletion failed otherwise", async () => {
    server.fail("POST", "/api/v1/account/delete", { status: 429, code: "rate_limited" });
    renderDashboard("/settings", server);
    const section = await typeEmail("ada@example.test");
    fireEvent.click(within(section).getByRole("button", { name: "Delete account" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Delete my account" }),
    );
    const alert = await within(section).findByRole("alert");
    expect(alert.textContent).toContain("Too many requests");
  });
});
