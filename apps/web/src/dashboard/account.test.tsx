// @vitest-environment happy-dom
import { CREDENTIALS_SCOPE, OAuthScope } from "@portifact/contracts";
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  browserSession,
  connectedApp,
  type FakeServer,
  fakeServer,
  renderDashboard,
  workspace,
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
      name: "Profile: Ada ada@example.test",
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

  it("stacks each browser as a card on phones, with the column names above the dates", async () => {
    renderDashboard("/profile", server);
    const table = await screen.findByRole("table", { name: "Browsers signed in to your account" });
    const cells = within(within(table).getAllByRole("row")[2] as HTMLElement).getAllByRole("cell");
    expect(cells.map((cell) => cell.firstElementChild?.textContent)).toEqual([
      "Safari on iOS",
      "Signed in with",
      "Last active",
      "Signed out on",
    ]);
    // How the browser signed in (decision 0021).
    expect(cells[1]?.textContent).toContain("Email code");
    expect(cells[2]?.textContent).toContain("Nov 7, 2026");
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

  it("shows each app at a glance and keeps permissions and exact dates behind Details", async () => {
    const hour = 3_600_000;
    server.apps = [
      connectedApp("portifact-cli", {
        scopes: [...OAuthScope.options, CREDENTIALS_SCOPE, "offline_access"],
        lastIssuedAt: new Date(Date.now() - 2 * hour).toISOString(),
      }),
      connectedApp("mcp-client-1", {
        name: "Claude Code",
        firstParty: false,
        resources: ["mcp"],
        scopes: ["artifacts:read", "artifacts:share", "custom:thing"],
        expiresAt: null,
      }),
    ];
    const { container } = renderDashboard("/apps", server);
    const apps = await region("Connected apps");
    const card = (name: RegExp) =>
      within(apps).getByRole("heading", { name }).closest("li") as HTMLElement;
    await within(apps).findByRole("heading", { name: /Portifact CLI/ });
    const cli = card(/Portifact CLI/);
    const claude = card(/Claude Code/);

    expect(cli.textContent).toContain("Made by Portifact");
    expect(cli.textContent).toContain("Full access");
    expect(cli.textContent).toContain("Connects to Portifact API");
    expect(cli.textContent).toContain("Last used 2 hours ago");
    expect(cli.textContent).toContain("Access expires Dec 1, 2026");
    expect(claude.textContent).toContain("Third-party app");
    expect(claude.textContent).toContain("2 of 7 permissions");
    expect(claude.textContent).toContain("Connects to Portifact MCP");
    expect(claude.textContent).toContain("Does not expire");
    // The exact time stays available on the relative one.
    const lastUsed = within(cli).getByText("Last used 2 hours ago");
    expect(lastUsed.tagName).toBe("TIME");
    expect(lastUsed.getAttribute("title")).toMatch(/2026/);

    // The full list and exact dates wait in a closed disclosure, one per app.
    const details = within(claude).getByText("Details").closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.getAttribute("aria-label")).toBe(
      "Details of Claude Code",
    );
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(details.textContent).toContain("Change who can open your artifacts");
    expect(details.textContent).toContain("Use the permission custom:thing");
    expect(details.textContent).toContain("Approved on");
    expect(details.textContent).toContain("Last token issued");
    // The CLI's credentials scope is named in plain words, not as an unknown permission.
    const cliDetails = within(cli).getByText("Details").closest("details") as HTMLDetailsElement;
    cliDetails.open = true;
    fireEvent(cliDetails, new Event("toggle"));
    expect(cliDetails.textContent).toContain(
      "See the apps connected to your account and disconnect them",
    );
    expect(cliDetails.textContent).not.toContain("Use the permission");

    // Disconnect is one click away on each card.
    expect(within(claude).getByRole("button", { name: "Disconnect Claude Code" })).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("sums up read-only and partial permissions, without counting staying connected", async () => {
    server.apps = [
      connectedApp("reader", {
        name: "Reader",
        firstParty: false,
        scopes: ["artifacts:read", "annotations:read", "offline_access"],
      }),
      connectedApp("writer", { name: "Writer", firstParty: false, scopes: ["artifacts:write"] }),
      connectedApp("idle", { name: "Idle", firstParty: false, scopes: ["offline_access"] }),
    ];
    renderDashboard("/apps", server);
    const apps = await region("Connected apps");
    const summary = async (name: string) =>
      ((await within(apps).findByRole("heading", { name })).closest("li") as HTMLElement)
        .textContent;
    expect(await summary("Reader")).toContain("Read only");
    expect(await summary("Writer")).toContain("1 of 7 permissions");
    expect(await summary("Idle")).toContain("0 of 7 permissions");
  });

  it("says how to connect another app with the CLI command and the MCP server URL", async () => {
    renderDashboard("/apps", server);
    const connect = await region("Connect an app");
    expect(within(connect).getByText("portifact login")).toBeTruthy();
    expect(within(connect).getByText(`${window.location.origin}/mcp`)).toBeTruthy();
    expect(within(connect).getByRole("button", { name: "Copy command" })).toBeTruthy();
    expect(within(connect).getByRole("button", { name: "Copy URL" })).toBeTruthy();
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

describe("section guides", () => {
  it.each([
    ["/profile", "Profile sections", ["Your account", "Sign-in methods", "Browser sessions"]],
    [
      "/settings",
      "Settings sections",
      [
        "Language",
        "Appearance",
        "Defaults for new artifacts",
        "Email notices",
        "Workspaces",
        "Your data",
        "Danger zone",
      ],
    ],
  ])("%s links each of its sections from an On this page guide", async (path, name, labels) => {
    const { container } = renderDashboard(path, server);
    const nav = await screen.findByRole("navigation", { name });
    expect(nav.textContent).toContain("On this page");
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(labels);
    for (const link of links) {
      const target = document.getElementById(link.getAttribute("href")?.slice(1) ?? "");
      expect(target?.getAttribute("aria-labelledby")).toBeTruthy();
      expect(target?.textContent).toContain(link.textContent);
    }
    expect(links[0]?.getAttribute("aria-current")).toBe("true");
    await waitFor(() => expect(screen.queryByText(/^Loading/)).toBeNull());
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("your data", () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  it("offers the account's export as a download link", async () => {
    renderDashboard("/settings", server);
    const data = await region("Your data");
    const link = within(data).getByRole("link", { name: "Download your account's data (JSON)" });
    expect(link.getAttribute("href")).toBe("/api/v1/account/export");
    // Saved, never shown in the tab, under the server's name (see accountExportFileName).
    expect(link.getAttribute("download")).toMatch(/^portifact-export-\d{4}-\d{2}-\d{2}\.json$/);
  });

  it.each(["light", "dark"] as const)(
    "leads the personal space's admin to the space's download page (%s)",
    async (theme) => {
      document.documentElement.dataset.theme = theme;
      const { container, router } = renderDashboard("/settings", server);
      const data = await region("Your data");
      expect(data.textContent).toContain(
        "To take out what your personal space holds (each artifact's retained versions and sources, the access logs, each artifact's records, the space's records and the audit log), use the space's download page.",
      );
      const link = within(data).getByRole("link", { name: "Download this space's data" });
      expect(link.getAttribute("href")).toBe("/data");
      expect(await axeViolations(container)).toEqual([]);
      fireEvent.click(link);
      await waitFor(() => expect(router.state.location.pathname).toBe("/data"));
      expect(
        await screen.findByRole("heading", { level: 1, name: "Download your data" }),
      ).toBeTruthy();
    },
  );

  it("names the workspace for its admin and keeps the space on the link", async () => {
    server.workspaces.acme = workspace("acme", "admin", { name: "Acme" });
    const { router } = renderDashboard("/settings?workspace=acme", server);
    const data = await region("Your data");
    await waitFor(() => expect(data.textContent).toContain("the workspace Acme holds"));
    const link = within(data).getByRole("link", { name: "Download this space's data" });
    expect(link.getAttribute("href")).toBe("/data?workspace=acme");
    fireEvent.click(link);
    await waitFor(() => expect(router.state.location.href).toBe("/data?workspace=acme"));
  });

  it("shows nothing about the space's data to a role that may not download it", async () => {
    server.workspaces.acme = workspace("acme", "editor", { name: "Acme" });
    const { container } = renderDashboard("/settings?workspace=acme", server);
    const data = await region("Your data");
    // The account's own export stays; the space's line and link are not offered.
    expect(
      within(data).getByRole("link", { name: "Download your account's data (JSON)" }),
    ).toBeTruthy();
    expect(within(data).queryByRole("link", { name: "Download this space's data" })).toBeNull();
    expect(data.textContent).not.toContain("download page");
    expect(await axeViolations(container)).toEqual([]);
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
