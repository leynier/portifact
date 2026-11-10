// @vitest-environment happy-dom
import { axeViolations, resetViewport, setViewportWidth } from "@portifact/ui/testing";
import { focusManager } from "@tanstack/react-query";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  artifact,
  choose,
  type FakeServer,
  fakeServer,
  renderDashboard,
  selectOptions,
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
    expect(await screen.findByRole("link", { name: "Profile: Ada ada@example.test" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
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
      // The name comes with the type and the ID; the last cell holds the quick actions.
      [
        "Launch planSitek7d2qm4xab",
        "Active",
        "Restricted",
        "ExpiresDec 8, 2026",
        "2 kB1 version kept",
        "Updated Nov 8, 2026",
        "",
      ],
      [
        "Old reportMarkdownm3n4p5q6rs",
        "Archived",
        "Restricted",
        "ExpiresDec 8, 2026",
        "2 kB1 version kept",
        "Updated Nov 8, 2026",
        "",
      ],
    ]);
    // An active artifact opens and goes to review from its row; an archived one cannot.
    const [active, archived] = rows as [HTMLElement, HTMLElement];
    expect(
      within(active)
        .getByRole("link", { name: "Open the published Launch plan" })
        .getAttribute("href"),
    ).toBe("https://k7d2qm4xab.portifact.dev/");
    expect(
      within(active)
        .getByRole("link", { name: "Review and comment on Launch plan" })
        .getAttribute("href"),
    ).toBe("/view/k7d2qm4xab");
    expect(within(archived).queryByRole("link", { name: /Open the published/ })).toBeNull();
    expect(within(archived).queryByRole("link", { name: /Review and comment/ })).toBeNull();
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
          .slice(4, 6)
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
    expect(screen.getByRole("link", { name: "See usage" }).getAttribute("href")).toBe("/usage");
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
      .map((row) => within(row).getAllByRole("link")[0]?.textContent);
  const chosen = (name: string) => selectOptions(name).chosen;
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

  it("searches by name on Enter, applies a filter as soon as it is chosen and keeps both in the URL", async () => {
    const { container, router } = renderDashboard("/", server);
    await screen.findByRole("table", { name: "Your artifacts" });
    const form = screen.getByRole("form", { name: "Search and filter artifacts" });
    expect(await axeViolations(container)).toEqual([]);
    // Nothing to clear yet.
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), {
      target: { value: "  LAUNCH " },
    });
    fireEvent.submit(form);
    await waitFor(() => expect(router.state.location.search).toEqual({ search: "LAUNCH" }));
    choose("Type", "Markdown");

    await screen.findByRole("table", { name: "Your artifacts that match the search and filters" });
    await waitFor(() => expect(rowNames()).toEqual(["Launch notes"]));
    expect(lastListPath()).toBe("/api/v1/artifacts?search=LAUNCH&type=markdown");
    expect(router.state.location.search).toEqual({ search: "LAUNCH", type: "markdown" });
    expect(screen.getByText("Showing 1 matching artifact").getAttribute("role")).toBe("status");
    // The chip shows the filter's value, and the clear link appears once something is on.
    expect(screen.getByRole("combobox", { name: "Type" }).textContent).toContain("Markdown");
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);

    // The search box's own clear button ends the search and keeps the filter.
    fireEvent.click(screen.getByRole("button", { name: "Clear the search" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ type: "markdown" }));
    expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "Search" }));
  });

  it("filters by state, access and comments, and finds an artifact by its ID", async () => {
    renderDashboard("/", server);
    await screen.findByRole("table");
    const form = screen.getByRole("form", { name: "Search and filter artifacts" });
    expect(selectOptions("State")).toEqual({
      options: ["Any", "Active", "Archived", "Suspended", "Being deleted"],
      chosen: "Any",
    });

    choose("State", "Archived");
    await waitFor(() => expect(rowNames()).toEqual(["Old report"]));

    choose("State", "Any");
    choose("Access", "Public");
    choose("Comments", "Comments open");
    await waitFor(() => expect(rowNames()).toEqual(["Launch notes"]));
    await waitFor(() =>
      expect(lastListPath()).toBe("/api/v1/artifacts?access=public&annotations=open"),
    );

    choose("Access", "Any");
    choose("Comments", "Any");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), {
      target: { value: "k7d2qm" },
    });
    fireEvent.submit(form);
    await waitFor(() => expect(rowNames()).toEqual(["Launch plan"]));
  });

  it("puts the filters behind a Filters button with their count on a phone", async () => {
    setViewportWidth(375);
    try {
      const { container, router } = renderDashboard("/?state=active&type=site", server);
      await waitFor(() => expect(rowNames()).toEqual(["Launch plan"]));
      // The search stays in sight; the selects wait in the sheet.
      expect(screen.getByRole("searchbox", { name: "Search" })).toBeTruthy();
      expect(screen.queryByRole("combobox", { name: "State" })).toBeNull();
      const open = screen.getByRole("button", { name: "Filters 2 on" });
      expect(await axeViolations(container)).toEqual([]);

      open.focus();
      fireEvent.click(open);
      const sheet = screen.getByRole("dialog", { name: "Filter artifacts" });
      expect(within(sheet).getByRole("combobox", { name: "State" }).textContent).toContain(
        "Active",
      );
      expect(await axeViolations(container)).toEqual([]);
      choose("Type", "Any");
      await waitFor(() => expect(router.state.location.search).toEqual({ state: "active" }));
      fireEvent.click(within(sheet).getByRole("button", { name: "Done" }));
      expect((sheet as HTMLDialogElement).open).toBe(false);
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Filters 1 on" }));

      fireEvent.click(screen.getByRole("button", { name: "Filters 1 on" }));
      fireEvent.click(within(sheet).getByRole("button", { name: "Clear filters" }));
      await waitFor(() => expect(router.state.location.search).toEqual({}));
      expect(screen.getByRole("button", { name: "Filters" })).toBeTruthy();
    } finally {
      resetViewport();
    }
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
    expect(chosen("Type")).toBe("Markdown");
    expect(chosen("State")).toBe("Any");
    expect(chosen("Access")).toBe("Any");

    choose("Type", "Site");
    await waitFor(() => expect(rowNames()).toEqual(["Launch plan"]));
    act(() => router.history.back());
    await waitFor(() => expect(rowNames()).toEqual(["Old report", "Launch notes"]));
    expect(chosen("Type")).toBe("Markdown");
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
      "Type",
      "State",
      "Access",
      "Created",
      "Updated",
      "Expires",
      "Archived",
      "Deleted for good on",
    ]);
    // The link leads the page, ready to copy, above the details.
    expect(screen.getByRole("link", { name: "https://m3n4p5q6rs.portifact.dev/" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
    expect(facts.textContent).toContain("Only you and the people you add");
    expect(document.title).toBe("Old report · Portifact");
  });

  it("groups the page by task, keeps renewing with the dates and removal in the danger zone", async () => {
    const { container } = renderDashboard("/artifacts/k7d2qm4xab", server);
    const nav = await screen.findByRole("navigation", { name: "Artifact sections" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Overview", "Sharing", "Comments", "Activity", "Danger zone"]);
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(["Overview", "Sharing", "Comments", "Activity", "Danger zone"]);
    const details = screen.getByRole("region", { name: "Details" });
    expect(
      within(details)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Renew for 30 days"]);
    const danger = screen.getByRole("region", { name: "Danger zone" });
    expect(
      within(danger)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Archive", "Delete"]);
    await screen.findByRole("group", { name: "Who can open this artifact" });
    expect(await axeViolations(container)).toEqual([]);
  });

  it("offers restore with the dates and only delete in the danger zone while archived", async () => {
    renderDashboard("/artifacts/m3n4p5q6rs", server);
    const details = await screen.findByRole("region", { name: "Details" });
    expect(
      within(details)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Restore"]);
    expect(
      within(screen.getByRole("region", { name: "Danger zone" }))
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Delete"]);
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

describe("pinned artifacts", () => {
  const onPro = () => {
    server.usage = usageView({
      plan: {
        name: "pro",
        validUntil: null,
        seats: 1,
        limits: { ...usageView().plan.limits, archiveMonths: 12 },
        features: ["pin"],
      },
    });
  };

  it("explains that pinning is part of a paid plan, with no button, on free", async () => {
    const { container } = renderDashboard("/artifacts/k7d2qm4xab", server);
    const details = await screen.findByRole("region", { name: "Details" });
    expect(
      await within(details).findByText(
        "Pinning keeps an artifact online with no expiry. It is part of the Pro plan.",
      ),
    ).toBeTruthy();
    expect(within(details).queryByRole("button", { name: "Pin" })).toBeNull();
    expect(within(details).queryByRole("link", { name: /upgrade|plan/i })).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("pins and unpins on a plan with pin, announcing each", async () => {
    onPro();
    const { container } = renderDashboard("/artifacts/k7d2qm4xab", server);
    const details = await screen.findByRole("region", { name: "Details" });
    fireEvent.click(await within(details).findByRole("button", { name: "Pin" }));
    expect(
      await screen.findByText("Artifact pinned. It stays online with no expiry."),
    ).toBeTruthy();
    expect(server.requests).toContainEqual({
      method: "POST",
      path: "/api/v1/artifacts/k7d2qm4xab/pin",
    });
    expect(await within(details).findByRole("button", { name: "Unpin" })).toBeTruthy();
    expect(
      within(details)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Unpin"]);
    expect(details.textContent).toContain("Never, it is pinned");
    expect(details.textContent).toContain(
      "Pinned: it stays online with no expiry until you unpin it.",
    );
    expect(await axeViolations(container)).toEqual([]);

    fireEvent.click(button("Unpin"));
    expect(
      await screen.findByText("Artifact unpinned. It now expires on Jan 7, 2027."),
    ).toBeTruthy();
    expect(await within(details).findByRole("button", { name: "Pin" })).toBeTruthy();
  });

  it("shows why pinning was refused", async () => {
    onPro();
    server.fail("POST", "/api/v1/artifacts/k7d2qm4xab/pin", {
      status: 403,
      code: "plan_required",
    });
    renderDashboard("/artifacts/k7d2qm4xab", server);
    fireEvent.click(await screen.findByRole("button", { name: "Pin" }));
    expect(
      await screen.findByText("This feature is not part of the plan of the artifact's owner."),
    ).toBeTruthy();
  });

  it("marks a pinned artifact in the list where the expiry is", async () => {
    server.artifacts[0] = {
      ...(server.artifacts[0] as (typeof server.artifacts)[number]),
      pinned: true,
      expiresAt: null,
    };
    const { container } = renderDashboard("/", server);
    const table = await screen.findByRole("table", { name: "Your artifacts" });
    const [first] = within(table).getAllByRole("row").slice(1) as [HTMLElement];
    expect(within(first).getAllByRole("cell")[3]?.textContent).toBe("ExpiresPinned");
    expect(await axeViolations(container)).toEqual([]);
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
