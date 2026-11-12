// @vitest-environment happy-dom
// "Download your data" and the grace notice (decision 0022, second delivery): the page lists every
// artifact with its retained versions and downloads, the logs and, during a grace, what goes on
// which date; the notice shows on every page of the space until hidden for the day.
import { ArtifactRecords, PLANS, SpaceRecords } from "@portifact/contracts";
import { planRequestHref } from "@portifact/contracts/plans";
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  artifact,
  type FakeServer,
  fakeServer,
  renderDashboard,
  seedVersion,
  usageView,
  workspace,
} from "./test-support.tsx";

const ID = "k7d2qm4xab";
const GRACE = {
  until: "2027-01-09T12:00:00.000Z",
  plan: "pro" as const,
  limits: {
    archiveMonths: 12,
    retainedPreviousVersions: 50,
    previousVersionRetentionDays: 90,
    accessLogRetentionDays: 365,
    auditRetentionDays: 90,
  },
  features: ["versionDiff" as const],
};

let server: FakeServer;
beforeEach(async () => {
  server = fakeServer([artifact(ID, { name: "Launch plan" })]);
  server.activity[ID] = { versions: 2, currentBytes: 12, openThreads: 0, lastAnnotationAt: null };
  await seedVersion(server, ID, [
    { path: "index.html", text: "<h1>v1</h1>" },
    { path: "src.zip", text: "zip bytes", kind: "source", contentType: "application/zip" },
  ]);
  await seedVersion(server, ID, [{ path: "index.html", text: "<h1>v2</h1>" }]);
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    // No storage in this environment: nothing to clear.
  }
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

/** The end of an earlier hold, before the grace's own end. */
const EARLIER = "2026-12-01T00:00:00.000Z";

function inGrace() {
  server.usage = usageView({ plan: { ...usageView().plan, grace: GRACE } });
  server.graceForecast = {
    ownerId: "u_owner",
    grace: GRACE,
    kinds: [
      // Two holds: versions drop at the first one's end and again at the second's.
      { kind: "versions", count: 2, from: EARLIER },
      { kind: "versions", count: 4, from: GRACE.until },
      { kind: "pins", count: 1, from: GRACE.until },
    ],
  };
}

describe("the Download your data page", () => {
  it.each(["light", "dark"] as const)(
    "lists what goes on which date during a grace, and every artifact's versions (%s)",
    async (theme) => {
      document.documentElement.dataset.theme = theme;
      inGrace();
      const { container, saved } = renderDashboard("/data", server);
      await screen.findByRole("heading", { level: 1, name: "Download your data" });
      const table = await screen.findByRole("table", {
        name: "What is deleted when the grace ends, and from when",
      });
      const rows = within(table).getAllByRole("row").slice(1);
      expect(rows.map((row) => row.textContent)).toEqual([
        expect.stringContaining("Previous versionsHow many2"),
        expect.stringContaining("Previous versionsHow many4"),
        expect.stringContaining("Pinned artifacts"),
      ]);
      // The grace's own page shows no notice on top of itself.
      expect(screen.queryByRole("button", { name: "Hide for today" })).toBeNull();

      fireEvent.click(await screen.findByText(/^Launch plan: 2 retained versions$/));
      fireEvent.click(await screen.findByRole("button", { name: "Download sources of version 1" }));
      await waitFor(() => expect(saved).toHaveLength(1));
      expect(saved[0]?.fileName).toBe("src.zip");
      expect(screen.getByRole("button", { name: "Access log as CSV of Launch plan" })).toBeTruthy();
      expect(
        screen.getByRole("link", { name: "Download your account's data (JSON)" }),
      ).toBeTruthy();
      expect(await axeViolations(container)).toEqual([]);
    },
  );

  it("is not in the side menu, and links back to Settings, keeping the space", async () => {
    server.workspaces.acme = workspace("acme", "admin", { name: "Acme" });
    const { router } = renderDashboard("/data?workspace=acme", server);
    await screen.findByRole("heading", { level: 1, name: "Download your data" });
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(within(nav).queryByRole("link", { name: "Download your data" })).toBeNull();
    const back = within(screen.getByRole("main")).getByRole("link", { name: "Settings" });
    fireEvent.click(back);
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
    expect(router.state.location.search).toEqual({ workspace: "acme" });
    expect(router.state.location.hash).toBe("data");
  });

  it("says nothing about a grace outside one, and asks for no forecast", async () => {
    renderDashboard("/data", server);
    await screen.findByRole("heading", { level: 1, name: "Download your data" });
    await screen.findByText(/^Launch plan: 2 retained versions$/);
    expect(screen.queryByText("What goes and when")).toBeNull();
    expect(server.requests.some((r) => r.path === "/api/v1/grace-forecast")).toBe(false);
  });

  it("is for a workspace's admins: an editor reads why instead", async () => {
    server.workspaces.acme = workspace("acme", "editor", { name: "Acme" });
    const { container } = renderDashboard("/data?workspace=acme", server);
    expect(
      await screen.findByText("Downloading all of Acme's data is for its admins."),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Download your data" })).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });
});

async function savedJson(saved: { blob: Blob }[]) {
  return JSON.parse(await (saved.at(-1) as { blob: Blob }).blob.text());
}

describe("the records downloads", () => {
  it("saves an artifact's records: settings, access, comments and every page of their history", async () => {
    const entries = Array.from({ length: 501 }, (_, i) => ({
      seq: i + 1,
      threadId: "th_1",
      messageId: null,
      kind: "thread_created" as const,
      actor: { id: "u-bea", name: "Bea", image: null },
      at: "2026-11-01T00:00:00.000Z",
    }));
    server.annotations[ID] = {
      mode: "open",
      role: "owner",
      currentVersionId: "v_current",
      threads: [],
      deleted: [],
      seq: 0,
      history: entries,
    };
    const { container, saved } = renderDashboard("/data", server);
    fireEvent.click(await screen.findByText(/^Launch plan: 2 retained versions$/));
    fireEvent.click(await screen.findByRole("button", { name: "Records (JSON) of Launch plan" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]?.fileName).toBe(`${ID}-records.json`);
    const records = ArtifactRecords.parse(await savedJson(saved));
    expect(records).toMatchObject({
      kind: "artifact",
      artifact: { id: ID, name: "Launch plan" },
      access: { mode: expect.any(String) },
      comments: { artifact: { id: ID }, threads: [] },
    });
    expect(records.commentHistory).toEqual(entries);
    expect(
      server.requests.filter((r) =>
        r.path.startsWith(`/api/v1/artifacts/${ID}/annotations/history?`),
      ),
    ).toHaveLength(2);
    expect(await screen.findByText("The records are ready.")).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("names each artifact's download buttons after the artifact", async () => {
    server = fakeServer([
      artifact(ID, { name: "Launch plan" }),
      artifact("m3c7qn5ycd", { name: "Budget" }),
    ]);
    for (const id of [ID, "m3c7qn5ycd"]) {
      server.activity[id] = {
        versions: 1,
        currentBytes: 1,
        openThreads: 0,
        lastAnnotationAt: null,
      };
      await seedVersion(server, id, [{ path: "index.html", text: "<h1>x</h1>" }]);
    }
    const { container } = renderDashboard("/data", server);
    fireEvent.click(await screen.findByText(/^Launch plan: 1 retained version$/));
    fireEvent.click(await screen.findByText(/^Budget: 1 retained version$/));
    for (const name of ["Launch plan", "Budget"]) {
      expect(await screen.findByRole("button", { name: `Records (JSON) of ${name}` })).toBeTruthy();
      expect(screen.getByRole("button", { name: `Access log as CSV of ${name}` })).toBeTruthy();
      expect(screen.getByRole("button", { name: `Access log as JSON of ${name}` })).toBeTruthy();
    }
    expect(screen.queryAllByRole("button", { name: "Records (JSON)" })).toHaveLength(0);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("records what may not be read instead of failing the download", async () => {
    const { saved } = renderDashboard("/data", server);
    fireEvent.click(await screen.findByText(/^Launch plan: 2 retained versions$/));
    fireEvent.click(await screen.findByRole("button", { name: "Records (JSON) of Launch plan" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    const records = ArtifactRecords.parse(await savedJson(saved));
    // No annotations store in the fake: the comment routes answer like a missing artifact.
    expect(records.comments).toEqual({ skipped: "not_found" });
    expect(records.commentHistory).toEqual({ skipped: "not_found" });
  });

  it("saves a personal space's records with the brand and links its logo", async () => {
    server.branding = {
      ...server.branding,
      brand: {
        name: "Ada Studio",
        accentColor: "#112233",
        link: null,
        logo: { sha256: "a".repeat(64), type: "image/png", width: 10, height: 10, bytes: 100 },
        updatedAt: "2026-11-01T00:00:00.000Z",
      },
    };
    const { saved } = renderDashboard("/data", server);
    const logo = await screen.findByRole("link", { name: "Download the brand logo" });
    expect(logo.getAttribute("href")).toBe("/api/v1/account/branding/logo");
    fireEvent.click(screen.getByRole("button", { name: "Download the space's records (JSON)" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]?.fileName).toBe("personal-space-records.json");
    const records = SpaceRecords.parse(await savedJson(saved));
    expect(records).toMatchObject({
      space: { slug: null },
      workspace: null,
      members: null,
      branding: { brand: { name: "Ada Studio" } },
    });
  });

  it("saves a workspace's people and settings for its admins, without secrets", async () => {
    server.workspaces.acme = workspace("acme", "admin", { name: "Acme" });
    const { saved } = renderDashboard("/data?workspace=acme", server);
    await screen.findByRole("heading", { level: 1, name: "Download your data" });
    expect(screen.queryByRole("link", { name: "Download the brand logo" })).toBeNull();
    fireEvent.click(
      await screen.findByRole("button", { name: "Download the space's records (JSON)" }),
    );
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]?.fileName).toBe("acme-space-records.json");
    const text = await (saved[0] as { blob: Blob }).blob.text();
    const records = SpaceRecords.parse(JSON.parse(text));
    expect(records.space.slug).toBe("acme");
    expect(records.workspace).toMatchObject({ slug: "acme", name: "Acme" });
    for (const part of [records.members, records.invitations, records.groups, records.policies]) {
      expect(part).not.toBeNull();
      expect(part).not.toHaveProperty("skipped");
    }
    expect(text).not.toMatch(/pfst_|pfsc_|xoxb-|secret/i);
  });
});

/** The visible notice: the box around its title (the live region holds the same words). */
async function graceNotice(): Promise<HTMLElement> {
  const titles = await screen.findAllByText(/^What the Pro plan kept is held until /, {
    selector: "p.font-semibold",
  });
  return (titles[0] as HTMLElement).closest("div.flex") as HTMLElement;
}

describe("the grace notice", () => {
  it("is announced once per tab and content, then empties its live region; the box has none", async () => {
    inGrace();
    const { router } = renderDashboard("/usage", server);
    const notice = await graceNotice();
    expect(notice.closest('[role="status"]')).toBeNull();
    const spoken = () =>
      screen
        .getAllByRole("status")
        // The shell's live region (the Plan page's own callout is a status too, and stays).
        .filter((node) => node.tagName === "P" && node.className.includes("sr-only"))
        .filter((node) => node.textContent?.startsWith("What the Pro plan kept is held until "));
    await waitFor(() => expect(spoken()).toHaveLength(1));
    // It holds the words only for a moment: reading the page then hears them once, in the box.
    await waitFor(() => expect(spoken()).toHaveLength(0), { timeout: 3_000 });
    await router.navigate({ to: "/" });
    await screen.findByRole("heading", { level: 1 });
    await router.navigate({ to: "/plan" });
    await screen.findByRole("heading", { level: 1, name: "Plan" });
    expect(spoken()).toHaveLength(0);
    cleanup();
    // A reload in the same tab announces nothing new either.
    renderDashboard("/usage", server);
    await graceNotice();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(spoken()).toHaveLength(0);
  });

  it("puts no live region on the pages that show the grace themselves", async () => {
    inGrace();
    renderDashboard("/data", server);
    await screen.findByRole("heading", { level: 1, name: "Download your data" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      screen
        .getAllByRole("status")
        .some((node) => node.className.includes("sr-only") && node.textContent !== ""),
    ).toBe(false);
  });

  it.each(["light", "dark"] as const)(
    "shows on every page of the space with both actions, and hides for the day (%s)",
    async (theme) => {
      document.documentElement.dataset.theme = theme;
      inGrace();
      const first = renderDashboard("/usage", server);
      const notice = await graceNotice();
      expect(
        within(notice).getByRole("link", { name: "Download your data" }).getAttribute("href"),
      ).toBe("/data");
      expect(
        within(notice).getByRole("link", { name: "Ask for Pro again" }).getAttribute("href"),
      ).toBe(planRequestHref("pro"));
      expect(await axeViolations(first.container)).toEqual([]);
      cleanup();

      renderDashboard("/", server);
      await graceNotice();
      fireEvent.click(screen.getByRole("button", { name: "Hide for today" }));
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Hide for today" })).toBeNull(),
      );
      cleanup();
      // Hidden for the rest of the day in this browser, on every page.
      renderDashboard("/usage", server);
      await screen.findByRole("heading", { level: 1 });
      expect(screen.queryByRole("button", { name: "Hide for today" })).toBeNull();
    },
  );

  it("tells an editor to ask an admin, with no download or request", async () => {
    server.workspaces.acme = workspace("acme", "editor", {
      name: "Acme",
      usage: usageView({ plan: { ...usageView().plan, limits: PLANS.free.limits, grace: GRACE } }),
    });
    renderDashboard("/usage?workspace=acme", server);
    const notice = await graceNotice();
    expect(within(notice).queryByRole("link")).toBeNull();
    expect(within(notice).getByText(/Ask an admin of this space/)).toBeTruthy();
  });
});
