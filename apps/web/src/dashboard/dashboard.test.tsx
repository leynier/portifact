// @vitest-environment happy-dom
import { axeViolations } from "@portifact/ui/testing";
import { focusManager } from "@tanstack/react-query";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  artifact,
  type FakeServer,
  fakeServer,
  renderDashboard,
  usageView,
} from "./test-support.tsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  focusManager.setFocused(undefined);
});

let server: FakeServer;
beforeEach(() => {
  server = fakeServer([
    artifact("k7d2qm4xab", { name: "Launch plan" }),
    artifact("m3n4p5q6rs", {
      name: "Old report",
      type: "markdown",
      state: "archived",
      archivedAt: "2026-11-01T12:00:00.000Z",
      purgeAt: "2027-05-01T12:00:00.000Z",
    }),
  ]);
});

const button = (name: string) => screen.getByRole("button", { name });

/** Queries retry a failed load once, about a second later. */
const RETRIED = { timeout: 3000 };

describe("app shell", () => {
  it("shows the signed-in account, a labelled navigation and a skip link", async () => {
    renderDashboard("/", server);
    expect(await screen.findByText("Signed in as ada@example.test")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Main" });
    const current = within(nav).getByRole("link", { name: "Artifacts" });
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Skip to content" }).getAttribute("href")).toBe(
      "#main",
    );
    expect(screen.getByRole("link", { name: "Portifact dashboard" })).toBeTruthy();
  });

  it("shows a notice while the platform's budget protection limits publishing", async () => {
    server.usage = usageView({
      blocks: [{ reason: "capacity", stops: "publishing", message: "server text", until: null }],
    });
    const { container } = renderDashboard("/", server);
    const title = await screen.findByText("Portifact is protecting its capacity");
    // Announced politely as a status, not as an error.
    expect(title.closest('[role="status"]')).toBeTruthy();
    expect(screen.getByText(/New uploads are paused for now/)).toBeTruthy();
    // The notice uses the dashboard's own text, never the server's message.
    expect(screen.queryByText("server text")).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("explains a brake on new artifacts, and shows nothing without protection", async () => {
    server.usage = usageView({
      blocks: [{ reason: "capacity", stops: "new_artifacts", message: "x", until: null }],
    });
    renderDashboard("/", server);
    expect(await screen.findByText(/Creating new artifacts is paused for now/)).toBeTruthy();
    cleanup();

    server.usage = usageView({
      blocks: [
        { reason: "storage", stops: "publishing", message: "Your storage is full", until: null },
      ],
    });
    renderDashboard("/", server);
    expect(await screen.findByText("Launch plan")).toBeTruthy();
    await waitFor(() => expect(server.requests.some((r) => r.path === "/api/v1/usage")).toBe(true));
    expect(screen.queryByText("Portifact is protecting its capacity")).toBeNull();
  });

  it("sends visitors without a session to sign in and come back here", async () => {
    server.email = null;
    const { left } = renderDashboard("/artifacts/k7d2qm4xab", server);
    await waitFor(() => expect(left).toEqual(["/login?next=%2Fartifacts%2Fk7d2qm4xab"]));
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("signs out and leaves for the login page", async () => {
    const { left } = renderDashboard("/", server);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(left).toEqual(["/login"]));
    expect(server.requests.at(-1)).toEqual({ method: "POST", path: "/api/auth/sign-out" });
  });

  it("announces a sign out that did not finish", async () => {
    server.fail("POST", "/api/auth/sign-out", { status: 500 });
    const { left } = renderDashboard("/", server);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await waitFor(() =>
      expect(document.body.textContent).toContain("Sign out did not finish. Try again."),
    );
    expect(left).toEqual([]);
  });

  it("answers unknown dashboard paths with a not found page", async () => {
    renderDashboard("/nowhere", server);
    expect(await screen.findByRole("heading", { level: 1, name: "Page not found" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "All artifacts" })).toBeTruthy();
    expect(document.title).toBe("Page not found · Portifact");
  });
});

describe("artifact list", () => {
  it("lists the artifacts with their type, state in words and expiry", async () => {
    renderDashboard("/", server);
    const table = await screen.findByRole("table", { name: "Your artifacts" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(
      rows.map((row) =>
        within(row)
          .getAllByRole("cell")
          .map((c) => c.textContent),
      ),
    ).toEqual([
      [
        "Launch plan",
        "Site",
        "Active",
        "Restricted",
        "Dec 8, 2026",
        "2 kB1 version kept",
        "Updated Nov 8, 2026",
      ],
      [
        "Old report",
        "Markdown",
        "Archived",
        "Restricted",
        "Dec 8, 2026",
        "2 kB1 version kept",
        "Updated Nov 8, 2026",
      ],
    ]);
    expect(within(table).getByRole("link", { name: "Launch plan" }).getAttribute("href")).toBe(
      "/artifacts/k7d2qm4xab",
    );
    expect(screen.getByText("Showing 2 artifacts")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(document.title).toBe("Artifacts · Portifact");
  });

  it("shows each artifact's size, kept versions, open threads and last comment activity", async () => {
    server.artifacts = [
      artifact("k7d2qm4xab", { name: "Launch plan", annotations: "open" }),
      artifact("m3n4p5q6rs", { name: "Old report", currentVersionId: null }),
      artifact("p2q3r4s5tu", { name: "Notes", annotations: "locked" }),
    ];
    server.activity = {
      k7d2qm4xab: {
        versions: 3,
        currentBytes: 1_500_000,
        openThreads: 2,
        lastAnnotationAt: "2026-11-07T09:30:00.000Z",
      },
      m3n4p5q6rs: { versions: 0, currentBytes: null, openThreads: 0, lastAnnotationAt: null },
      p2q3r4s5tu: { versions: 1, currentBytes: 900, openThreads: 0, lastAnnotationAt: null },
    };
    const { container } = renderDashboard("/", server);
    const table = await screen.findByRole("table", { name: "Your artifacts" });
    expect(within(table).getByRole("columnheader", { name: "Size" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Activity" })).toBeTruthy();
    const cells = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole("cell")
          .slice(5)
          .map((cell) => [...cell.children].map((line) => line.textContent)),
      );
    expect(cells).toEqual([
      [
        ["1.5 MB", "3 versions kept"],
        ["Updated Nov 8, 2026", "2 open threads", "Comments changed Nov 7, 2026"],
      ],
      // Without a version there is no size; with comments off, no thread count either.
      [["No version", "0 versions kept"], ["Updated Nov 8, 2026"]],
      [
        ["900 bytes", "1 version kept"],
        ["Updated Nov 8, 2026", "No open threads"],
      ],
    ]);
    // Traffic is not per artifact: the list says so and points to the account's usage.
    expect(
      screen.getByText("Traffic is counted for your whole account, not per artifact.", {
        exact: false,
      }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "See usage" }).getAttribute("href")).toBe(
      "/account#usage",
    );
    expect(await axeViolations(container)).toEqual([]);
  });

  it("shows a loading state in words while the list loads", async () => {
    renderDashboard("/", server);
    expect(await screen.findByText("Loading your artifacts")).toBeTruthy();
  });

  it("shows an empty state with how to publish", async () => {
    server.artifacts = [];
    renderDashboard("/", server);
    expect(await screen.findByRole("heading", { name: "No artifacts yet" })).toBeTruthy();
    expect(screen.getByText("portifact publish ./report.html")).toBeTruthy();
  });

  it("pages with the cursor and appends the next page", async () => {
    server.artifacts = ["a", "b", "c"].map((letter) => artifact(letter.repeat(10)));
    server.pageSize = 2;
    renderDashboard("/", server);
    await screen.findByText("Showing 2 artifacts");
    fireEvent.click(button("Load more"));
    expect(await screen.findByText("Showing 3 artifacts")).toBeTruthy();
    expect(server.requests.map((r) => r.path)).toContain("/api/v1/artifacts?cursor=2");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(screen.getAllByRole("row")).toHaveLength(4);
  });

  it("shows an error with a retry when the list cannot load", async () => {
    server.fail("GET", "/api/v1/artifacts", { status: 503, code: "capacity_unavailable" }, 2);
    renderDashboard("/", server);
    const alert = await screen.findByRole("alert", {}, RETRIED);
    expect(alert.textContent).toContain("Your artifacts could not be loaded");
    expect(alert.textContent).toContain("Portifact is at capacity right now. Try again later.");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table")).toBeTruthy();
  });

  it("reports a lost connection in words", async () => {
    server.fail("GET", "/api/v1/artifacts", { status: 0, network: true }, 2);
    renderDashboard("/", server);
    expect((await screen.findByRole("alert", {}, RETRIED)).textContent).toContain(
      "Portifact could not be reached.",
    );
  });

  it("sends the user to sign in when the session ends while browsing", async () => {
    server.fail("GET", "/api/v1/artifacts", { status: 401 });
    const { left } = renderDashboard("/", server);
    await waitFor(() => expect(left).toContain("unauthenticated"));
  });

  it("refreshes every 30 seconds while the tab is visible and pauses when it is hidden", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderDashboard("/", server);
    await screen.findByRole("table");
    expect(server.listRequests()).toBe(1);

    await act(() => vi.advanceTimersByTimeAsync(29_000));
    expect(server.listRequests()).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(server.listRequests()).toBe(2);

    act(() => focusManager.setFocused(false));
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(server.listRequests()).toBe(2);
  });

  it("keeps the last list on a failed refresh, says so and backs off", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderDashboard("/", server);
    await screen.findByRole("table");
    server.fail("GET", "/api/v1/artifacts", { status: 503, code: "capacity_unavailable" }, 2);
    // The refresh at 30 s fails, and so does its one retry a second later.
    await act(() => vi.advanceTimersByTimeAsync(35_000));
    expect(await screen.findByText("The list could not be refreshed")).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
    const afterFailure = server.listRequests();
    // Two failures double the wait twice: nothing for the next 30 or 60 seconds.
    await act(() => vi.advanceTimersByTimeAsync(90_000));
    expect(server.listRequests()).toBe(afterFailure);
    await act(() => vi.advanceTimersByTimeAsync(40_000));
    expect(server.listRequests()).toBe(afterFailure + 1);
    await waitFor(() => expect(screen.queryByText("The list could not be refreshed")).toBeNull());
  });
});

describe("artifact search and filters", () => {
  const rowNames = () =>
    within(screen.getByRole("table"))
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell")[0]?.textContent);
  const select = (name: string) => screen.getByRole("combobox", { name }) as HTMLSelectElement;
  const lastListPath = () =>
    server.requests
      .filter((r) => r.path.startsWith("/api/v1/artifacts") && r.method === "GET")
      .at(-1)?.path;

  beforeEach(() => {
    server.artifacts.push(
      artifact("p4r5s2t3uv", {
        name: "Launch notes",
        type: "markdown",
        accessMode: "public",
        annotations: "open",
      }),
    );
  });

  it("searches by name on the server, keeps the filters in the URL and announces the count", async () => {
    const { container, router } = renderDashboard("/", server);
    await screen.findByRole("table", { name: "Your artifacts" });
    const form = screen.getByRole("form", { name: "Search and filter artifacts" });
    expect(await axeViolations(container)).toEqual([]);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), {
      target: { value: "  LAUNCH " },
    });
    fireEvent.change(select("Type"), { target: { value: "markdown" } });
    fireEvent.submit(form);

    await screen.findByRole("table", { name: "Your artifacts that match the search and filters" });
    await waitFor(() => expect(rowNames()).toEqual(["Launch notes"]));
    expect(lastListPath()).toBe("/api/v1/artifacts?search=LAUNCH&type=markdown");
    expect(router.state.location.search).toEqual({ search: "LAUNCH", type: "markdown" });
    expect(screen.getByText("Showing 1 matching artifact").getAttribute("role")).toBe("status");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("filters by state, access and comments, and finds an artifact by its ID", async () => {
    renderDashboard("/", server);
    await screen.findByRole("table");
    const form = screen.getByRole("form", { name: "Search and filter artifacts" });
    expect(Array.from(select("State").options, (option) => option.textContent)).toEqual([
      "Any state",
      "Active",
      "Archived",
      "Suspended",
      "Being deleted",
    ]);

    fireEvent.change(select("State"), { target: { value: "archived" } });
    fireEvent.submit(form);
    await waitFor(() => expect(rowNames()).toEqual(["Old report"]));

    fireEvent.change(select("State"), { target: { value: "any" } });
    fireEvent.change(select("Access"), { target: { value: "public" } });
    fireEvent.change(select("Comments"), { target: { value: "open" } });
    fireEvent.submit(form);
    await waitFor(() => expect(rowNames()).toEqual(["Launch notes"]));
    expect(lastListPath()).toBe("/api/v1/artifacts?access=public&annotations=open");

    fireEvent.change(select("Access"), { target: { value: "any" } });
    fireEvent.change(select("Comments"), { target: { value: "any" } });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), {
      target: { value: "k7d2qm" },
    });
    fireEvent.submit(form);
    await waitFor(() => expect(rowNames()).toEqual(["Launch plan"]));
  });

  it("says when nothing matches and clears the filters back to every artifact", async () => {
    const { router } = renderDashboard("/?search=nothing", server);
    expect(await screen.findByRole("heading", { name: "No artifacts match" })).toBeTruthy();
    expect((screen.getByRole("searchbox", { name: "Search" }) as HTMLInputElement).value).toBe(
      "nothing",
    );
    fireEvent.click(button("Clear filters"));
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    expect(router.state.location.search).toEqual({});
    expect((screen.getByRole("searchbox", { name: "Search" }) as HTMLInputElement).value).toBe("");
  });

  it("reads the filters from the URL, drops values the API would refuse and follows back", async () => {
    const { router } = renderDashboard("/?state=deleted&type=markdown&access=everyone", server);
    await waitFor(() => expect(rowNames()).toEqual(["Old report", "Launch notes"]));
    expect(lastListPath()).toBe("/api/v1/artifacts?type=markdown");
    expect(select("Type").value).toBe("markdown");
    expect(select("State").value).toBe("any");
    expect(select("Access").value).toBe("any");

    fireEvent.change(select("Type"), { target: { value: "site" } });
    fireEvent.submit(screen.getByRole("form", { name: "Search and filter artifacts" }));
    await waitFor(() => expect(rowNames()).toEqual(["Launch plan"]));
    act(() => router.history.back());
    await waitFor(() => expect(rowNames()).toEqual(["Old report", "Launch notes"]));
    expect(select("Type").value).toBe("markdown");
  });

  it("pages through the filtered list with the same filters", async () => {
    server.artifacts = ["a", "b", "c", "d"].map((letter, i) =>
      artifact(letter.repeat(10), { name: `Report ${letter}`, type: i < 3 ? "text" : "site" }),
    );
    server.pageSize = 2;
    renderDashboard("/?type=text", server);
    await screen.findByText("Showing 2 matching artifacts");
    fireEvent.click(button("Load more"));
    expect(await screen.findByText("Showing 3 matching artifacts")).toBeTruthy();
    expect(lastListPath()).toBe("/api/v1/artifacts?cursor=2&type=text");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("refuses a search longer than the API takes, next to the field", async () => {
    renderDashboard("/", server);
    await screen.findByRole("table");
    const before = server.listRequests();
    const search = screen.getByRole("searchbox", { name: "Search" });
    fireEvent.change(search, { target: { value: "x".repeat(201) } });
    fireEvent.submit(screen.getByRole("form", { name: "Search and filter artifacts" }));
    expect(await screen.findByText("Search for at most 200 characters")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(search));
    expect(server.listRequests()).toBe(before);
  });

  it("hides the search while the account has no artifacts", async () => {
    server.artifacts = [];
    renderDashboard("/", server);
    await screen.findByRole("heading", { name: "No artifacts yet" });
    expect(screen.queryByRole("form", { name: "Search and filter artifacts" })).toBeNull();
  });
});

describe("artifact detail", () => {
  it("shows the URL, state, access and dates", async () => {
    renderDashboard("/artifacts/m3n4p5q6rs", server);
    expect(await screen.findByRole("heading", { level: 1, name: "Old report" })).toBeTruthy();
    const facts = screen.getByRole("region", { name: "Details" });
    const terms = within(facts)
      .getAllByRole("term")
      .map((t) => t.textContent);
    expect(terms).toEqual([
      "URL",
      "Type",
      "State",
      "Access",
      "Created",
      "Updated",
      "Expires",
      "Archived",
      "Deleted for good on",
    ]);
    expect(
      within(facts).getByRole("link", { name: "https://m3n4p5q6rs.portifact.dev/" }),
    ).toBeTruthy();
    expect(facts.textContent).toContain("Only you and the people you add");
    expect(document.title).toBe("Old report · Portifact");
  });

  it("offers the actions that fit the state", async () => {
    renderDashboard("/artifacts/k7d2qm4xab", server);
    const actions = await screen.findByRole("region", { name: "Actions" });
    expect(
      within(actions)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Renew for 30 days", "Archive", "Delete"]);
  });

  it("archives and restores, announcing the new dates", async () => {
    renderDashboard("/artifacts/k7d2qm4xab", server);
    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
    expect(await screen.findByRole("button", { name: "Restore" })).toBeTruthy();
    expect(
      screen.getByText(/Artifact archived\. It is deleted for good on May 8, 2027/),
    ).toBeTruthy();
    expect(server.requests).toContainEqual({
      method: "POST",
      path: "/api/v1/artifacts/k7d2qm4xab/archive",
    });

    fireEvent.click(button("Restore"));
    expect(await screen.findByRole("button", { name: "Archive" })).toBeTruthy();
    expect(screen.getByText("Artifact restored. It expires on Jan 7, 2027.")).toBeTruthy();
  });

  it("renews and announces the new expiry", async () => {
    renderDashboard("/artifacts/k7d2qm4xab", server);
    fireEvent.click(await screen.findByRole("button", { name: "Renew for 30 days" }));
    expect(
      await screen.findByText("Artifact renewed. It now expires on Jan 7, 2027."),
    ).toBeTruthy();
  });

  it("deletes only after explicit confirmation, then returns to the list", async () => {
    const { router } = renderDashboard("/artifacts/k7d2qm4xab", server);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog", { name: "Delete Launch plan?" });
    expect(dialog.textContent).toContain("This cannot be undone.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep it" }));
    expect(server.requests.some((r) => r.method === "DELETE")).toBe(false);

    fireEvent.click(button("Delete"));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Delete artifact" }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(server.requests).toContainEqual({
      method: "DELETE",
      path: "/api/v1/artifacts/k7d2qm4xab",
    });
    expect(await screen.findByText("Artifact Launch plan deleted.")).toBeTruthy();
    const table = await screen.findByRole("table");
    await waitFor(() => expect(within(table).queryByText("Launch plan")).toBeNull());
    expect(document.activeElement?.id).toBe("main");
  });

  it("shows why an action failed", async () => {
    server.fail("POST", "/api/v1/artifacts/m3n4p5q6rs/restore", {
      status: 429,
      code: "quota_exceeded",
    });
    renderDashboard("/artifacts/m3n4p5q6rs", server);
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The action did not finish");
    expect(alert.textContent).toContain("You reached the limit of active artifacts.");
  });

  it("says when the artifact does not exist or belongs to someone else", async () => {
    renderDashboard("/artifacts/zzzzzzzzzz", server);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Artifact not found" }),
    ).toBeTruthy();
    expect(document.title).toBe("Artifact not found · Portifact");
  });

  it("offers a retry when the artifact cannot load", async () => {
    server.fail("GET", "/api/v1/artifacts/k7d2qm4xab", { status: 0, network: true }, 2);
    renderDashboard("/artifacts/k7d2qm4xab", server);
    const alert = await screen.findByRole("alert", {}, RETRIED);
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Launch plan" })).toBeTruthy();
  });

  it("explains why a suspended artifact is suspended, without the operator's notes", async () => {
    const server = fakeServer([
      artifact("k7d2qm4xab", { state: "suspended", suspension: { reason: "phishing" } }),
    ]);
    const { container } = renderDashboard("/artifacts/k7d2qm4xab", server);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Suspended for a possible Acceptable Use Policy violation");
    expect(alert.textContent).toContain("Reason: phishing or a fake sign-in page.");
    expect(alert.textContent).toContain("abuse@portifact.com");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("offers no actions for an artifact being deleted", async () => {
    server.artifacts.push(artifact("pppppppppp", { state: "purging", expiresAt: null }));
    renderDashboard("/artifacts/pppppppppp", server);
    expect(await screen.findByText("No actions are available in this state.")).toBeTruthy();
    expect(screen.getAllByText("Being deleted")).toHaveLength(2);
  });

  it("moves focus to the main content after navigating from the list", async () => {
    renderDashboard("/", server);
    fireEvent.click(await screen.findByRole("link", { name: "Launch plan" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Launch plan" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.id).toBe("main"));
  });
});

describe("accessibility", () => {
  it("has no axe violations on the list, the empty list and the detail with its dialog", async () => {
    const list = renderDashboard("/", server);
    await screen.findByRole("table");
    expect(await axeViolations(list.container)).toEqual([]);
    cleanup();

    server.artifacts = [];
    const empty = renderDashboard("/", fakeServer([]));
    await screen.findByRole("heading", { name: "No artifacts yet" });
    expect(await axeViolations(empty.container)).toEqual([]);
    cleanup();

    const detail = renderDashboard("/artifacts/m3n4p5q6rs", fakeServer([artifact("m3n4p5q6rs")]));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(await axeViolations(detail.container)).toEqual([]);
  });
});
