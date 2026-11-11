// @vitest-environment happy-dom
// Workspace policies in the dashboard (premium plan E4, decision 0015): the Policies page, where
// admins change them after seeing what a save changes, and the notes that name a policy on the
// artifact page where it disables a control.
import { type ClientKind, DEFAULT_POLICY, type WorkspacePolicy } from "@portifact/contracts";
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { policyOfDraft } from "./screens/policies.tsx";
import {
  artifact,
  type FakeServer,
  fakeServer,
  NO_IMPACT,
  renderDashboard,
  workspace,
} from "./test-support.tsx";

afterEach(cleanup);

const ID = "w3w3w3w3w3";
let server: FakeServer;
beforeEach(() => {
  server = fakeServer([
    artifact(ID, { name: "Team report", owner: { kind: "workspace", slug: "acme", name: "Acme" } }),
  ]);
});

const nav = () =>
  within(screen.getAllByRole("navigation", { name: "Main", hidden: true })[0] as HTMLElement)
    .getAllByRole("link", { hidden: true })
    .map((link) => link.textContent);
const radio = (name: string, group?: string) => {
  const scope = group ? within(screen.getByRole("group", { name: group })) : screen;
  return scope.getByRole("radio", { name }) as HTMLInputElement;
};
const puts = () =>
  server.requests.filter((r) => r.method === "PUT" && r.path.endsWith("/policies"));

async function themes(container: HTMLElement) {
  for (const colorScheme of ["light", "dark"] as const) {
    document.documentElement.dataset.theme = colorScheme;
    expect(await axeViolations(container), colorScheme).toEqual([]);
  }
  delete document.documentElement.dataset.theme;
}

function acme(role: "admin" | "editor" | "member", policy: WorkspacePolicy = DEFAULT_POLICY) {
  server.workspaces.acme = workspace("acme", role, { name: "Acme", policy });
}

describe("the Policies page", () => {
  it("is in every workspace's navigation, and a personal space has none", async () => {
    acme("member");
    renderDashboard("/?workspace=acme", server);
    await waitFor(() => expect(nav()).toContain("Policies"));
    cleanup();
    renderDashboard("/", server);
    await waitFor(() => expect(nav()).toContain("Settings"));
    expect(nav()).not.toContain("Policies");
    cleanup();
    renderDashboard("/policies", server);
    expect(await screen.findByText("Policies are for workspaces")).toBeTruthy();
  });

  it("lets an admin save a policy that changes nothing existing, without a confirmation", async () => {
    acme("admin");
    const { container } = renderDashboard("/policies?workspace=acme", server);
    await screen.findByRole("group", { name: "Public access" });
    expect(screen.getByText("These policies apply to admins too.")).toBeTruthy();
    await themes(container);
    fireEvent.click(radio("Forbidden"));
    fireEvent.click(radio("Everyone in the workspace", "Access of new artifacts"));
    fireEvent.click(screen.getByRole("button", { name: "Save policies" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(server.bodies.at(-1)).toEqual({
      policy: { ...DEFAULT_POLICY, publicAccess: "forbidden", defaultAccess: "workspace" },
      revision: 0,
    });
    await waitFor(() => expect(server.workspaces.acme?.policyRevision).toBe(1));
  });

  it("lists what a save changes and saves only after the admin confirms", async () => {
    acme("admin");
    const workspaceState = server.workspaces.acme;
    if (!workspaceState) throw new Error("no workspace");
    workspaceState.policyImpact = { ...NO_IMPACT, publicArtifacts: 2, linksRevoked: 1 };
    const { container } = renderDashboard("/policies?workspace=acme", server);
    await screen.findByRole("group", { name: "Share links" });
    fireEvent.click(radio("Forbidden"));
    fireEvent.click(radio("Disabled"));
    fireEvent.click(screen.getByRole("button", { name: "Save policies" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Apply these policies to existing artifacts?",
    });
    expect(dialog.textContent).toContain("2 public artifacts become shared with the workspace");
    expect(dialog.textContent).toContain("1 share link is revoked");
    expect(dialog.textContent).not.toContain("reader");
    await themes(container);
    expect(puts()).toEqual([]);
    // Keep editing closes it and saves nothing.
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(puts()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Save policies" }));
    const again = await screen.findByRole("dialog");
    fireEvent.click(within(again).getByRole("button", { name: "Apply and save" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(server.bodies.at(-1)).toMatchObject({
      revision: 0,
      confirmed: { ...NO_IMPACT, publicArtifacts: 2, linksRevoked: 1 },
    });
    // After a save that changes existing artifacts, the page says where to see what changed.
    expect(
      await screen.findByText(
        "Existing artifacts are being brought in line with the policies. Their pages and the audit log show what changed.",
      ),
    ).toBeTruthy();
  });

  it("checks the domains and the lifetime before any request", async () => {
    acme("admin");
    renderDashboard("/policies?workspace=acme", server);
    await screen.findByRole("group", { name: "Reader domains" });
    fireEvent.click(radio("Only these domains"));
    fireEvent.click(screen.getByRole("button", { name: "Save policies" }));
    expect(
      await screen.findByText("Write between 1 and 20 plain domains, like example.com."),
    ).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Allowed domains" }), {
      target: { value: "corp.example\nlabs.example" },
    });
    fireEvent.change(
      screen.getByRole("textbox", { name: "Longest share link lifetime, in days" }),
      { target: { value: "0" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save policies" }));
    expect(
      await screen.findByText("Write a whole number of days from 1 to 365, or leave it empty."),
    ).toBeTruthy();
    expect(server.requests.filter((r) => r.path.includes("/policies/preview"))).toEqual([]);
  });

  it("shows the policies read-only to editors and members", async () => {
    acme("editor", { ...DEFAULT_POLICY, publicAccess: "forbidden" });
    const { container } = renderDashboard("/policies?workspace=acme", server);
    expect(await screen.findByText("Set by the workspace's admins")).toBeTruthy();
    expect(radio("Forbidden").checked).toBe(true);
    expect(radio("Forbidden").closest("fieldset")?.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Save policies" })).toBeNull();
    await themes(container);
  });

  it("refuses a confirmation whose counts grew since the preview, and says to review again", async () => {
    acme("admin");
    const workspaceState = server.workspaces.acme;
    if (!workspaceState) throw new Error("no workspace");
    workspaceState.policyImpact = { ...NO_IMPACT, publicArtifacts: 1 };
    renderDashboard("/policies?workspace=acme", server);
    await screen.findByRole("group", { name: "Public access" });
    fireEvent.click(radio("Forbidden"));
    fireEvent.click(screen.getByRole("button", { name: "Save policies" }));
    const dialog = await screen.findByRole("dialog");
    // Another artifact became public meanwhile.
    workspaceState.policyImpact = { ...NO_IMPACT, publicArtifacts: 2 };
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply and save" }));
    expect(
      await screen.findByText(
        "What this policy changes on existing artifacts grew since you reviewed it. Save again to review the new counts.",
      ),
    ).toBeTruthy();
    expect(workspaceState.policyRevision).toBe(0);
  });

  it("says when the domain default has no verified domain", async () => {
    acme("admin", { ...DEFAULT_POLICY, defaultAccess: "domain" });
    renderDashboard("/policies?workspace=acme", server);
    expect(
      await screen.findByText(
        "No email domain is verified, so new artifacts start shared with the workspace until one is verified again.",
      ),
    ).toBeTruthy();
  });

  it("says only loosening works when the plan does not include policies", async () => {
    server.workspaces.acme = workspace("acme", "admin", {
      name: "Acme",
      policiesAvailable: false,
    });
    renderDashboard("/policies?workspace=acme", server);
    expect(await screen.findByText("Setting policies is part of the Enterprise plan")).toBeTruthy();
  });

  it("shows the API's refusal and reloads after a conflict", async () => {
    acme("admin");
    const workspaceState = server.workspaces.acme;
    if (!workspaceState) throw new Error("no workspace");
    renderDashboard("/policies?workspace=acme", server);
    await screen.findByRole("group", { name: "Public access" });
    workspaceState.policyRevision = 5;
    fireEvent.click(radio("Forbidden"));
    fireEvent.click(screen.getByRole("button", { name: "Save policies" }));
    expect(
      await screen.findByText(
        "Someone changed the policies meanwhile. They were loaded again: review them and save.",
      ),
    ).toBeTruthy();
  });
});

describe("policyOfDraft", () => {
  const draft = {
    publicAccess: "allowed" as const,
    defaultAccess: "restricted" as const,
    readersLimited: true,
    readerDomains: " a.example, b.example\nc.example ",
    shareLinks: "allowed" as const,
    maxDays: " 30 ",
    networksLimited: false,
    networks: "",
    tokenNetworksLimited: false,
    tokenNetworks: "",
    sessionLimited: false,
    sessionHours: "",
    clientsLimited: false,
    clients: ["cli", "oauth_apps"] as ClientKind[],
    ssoRequired: false,
    lifeLimited: false,
    lifeDays: "",
    commentsLimited: false,
    commentDays: "",
  };
  it("splits domains on spaces, commas and lines and reads the days", () => {
    expect(policyOfDraft(draft)).toEqual({
      ok: true,
      policy: {
        ...DEFAULT_POLICY,
        readerDomains: ["a.example", "b.example", "c.example"],
        shareLinkMaxDays: 30,
      },
    });
    expect(policyOfDraft({ ...draft, readersLimited: false, maxDays: "" })).toEqual({
      ok: true,
      policy: DEFAULT_POLICY,
    });
  });
  it.each([
    [{ readerDomains: "" }, "domains"],
    [{ readerDomains: Array.from({ length: 21 }, (_, i) => `d${i}.example`).join(" ") }, "domains"],
    [{ maxDays: "1.5" }, "days"],
    [{ maxDays: "366" }, "days"],
    [{ maxDays: "x" }, "days"],
    [{ lifeLimited: true, lifeDays: "6" }, "lifeDays"],
    [{ lifeLimited: true, lifeDays: "3651" }, "lifeDays"],
    [{ lifeLimited: true, lifeDays: "" }, "lifeDays"],
    [{ commentsLimited: true, commentDays: "29" }, "commentDays"],
    [{ commentsLimited: true, commentDays: "3651" }, "commentDays"],
  ] as const)("refuses %j", (change, field) => {
    expect(policyOfDraft({ ...draft, ...change })).toEqual({ ok: false, field });
  });
});

describe("a control disabled by a policy on the artifact page", () => {
  it("keeps the public option visible, disabled, with a note naming the policy", async () => {
    acme("admin", {
      ...DEFAULT_POLICY,
      publicAccess: "forbidden",
      readerDomains: ["corp.example"],
      shareLinks: "disabled",
    });
    const { container } = renderDashboard(`/artifacts/${ID}?workspace=acme`, server);
    const region = await screen.findByRole("region", { name: "Access" }, { timeout: 10_000 });
    await waitFor(() => expect(radio("Public: anyone with the link").disabled).toBe(true));
    expect(region.textContent).toContain("The workspace's policy forbids public access.");
    await waitFor(() =>
      expect(
        screen.getByText("The workspace's policy allows readers only at corp.example."),
      ).toBeTruthy(),
    );
    const links = await screen.findByRole("region", { name: "Share links" });
    await waitFor(() =>
      expect(links.textContent).toContain("The workspace's policy does not allow share links."),
    );
    expect(within(links).queryByRole("button", { name: "Create link" })).toBeNull();
    await themes(container);
  });

  it("names the password and lifetime rules above the share link form", async () => {
    acme("admin", { ...DEFAULT_POLICY, shareLinks: "password_required", shareLinkMaxDays: 7 });
    renderDashboard(`/artifacts/${ID}?workspace=acme`, server);
    const links = await screen.findByRole("region", { name: "Share links" }, { timeout: 10_000 });
    await waitFor(() =>
      expect(links.textContent).toContain(
        "The workspace's policy requires a password on every share link.",
      ),
    );
    expect(links.textContent).toContain("The workspace's policy limits share links to 7 days.");
    expect(within(links).getByRole("button", { name: "Create link" })).toBeTruthy();
    expect(radio("Public: anyone with the link").disabled).toBe(false);
  });
});

describe("the maximum life of artifacts (decision 0023)", () => {
  const DAY = 86_400_000;
  const group = "Maximum life of artifacts";

  it("lets an admin set one after confirming what it archives, then says when it starts", async () => {
    acme("admin");
    const workspaceState = server.workspaces.acme;
    if (!workspaceState) throw new Error("no workspace");
    workspaceState.policyImpact = {
      ...NO_IMPACT,
      artifactsAtStart: 2,
      artifactsSoon: 3,
      pinsLifted: 1,
    };
    const { container } = renderDashboard("/policies?workspace=acme", server);
    await screen.findByRole("group", { name: group });
    expect(
      screen.getByText(/A new or shorter maximum takes effect 7 days after you save it/),
    ).toBeTruthy();
    fireEvent.click(radio("Archive after a maximum life", group));
    const days = screen.getByRole("textbox", { name: /Days after the last publish or restore/ });
    fireEvent.change(days, { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save policies" }));
    expect(await screen.findByText("Write a whole number of days from 7 to 3650.")).toBeTruthy();
    await themes(container);
    fireEvent.change(days, { target: { value: "90" } });
    fireEvent.click(screen.getByRole("button", { name: "Save policies" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(
      "2 active artifacts are archived the day the maximum life takes effect, unless someone publishes them again",
    );
    expect(dialog.textContent).toContain("3 more are archived within 30 days after that");
    expect(dialog.textContent).toContain("1 pinned artifact is unpinned");
    await themes(container);
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply and save" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(server.bodies.at(-1)).toMatchObject({
      policy: { artifactMaxDays: 90, artifactMaxDaysFrom: null },
      confirmed: { artifactsAtStart: 2, artifactsSoon: 3, pinsLifted: 1 },
    });
    expect(await screen.findByText(/^A maximum life takes effect on /)).toBeTruthy();
    expect(
      screen.getByText(
        "From then, artifacts are archived 90 days after their last publish or restore. Nothing is archived by it before that date.",
      ),
    ).toBeTruthy();
    await themes(container);
  });

  it("shows every member the rule in effect, read-only", async () => {
    acme("member", {
      ...DEFAULT_POLICY,
      artifactMaxDays: 30,
      artifactMaxDaysFrom: Date.now() - DAY,
    });
    const { container } = renderDashboard("/policies?workspace=acme", server);
    expect(
      await screen.findByText(
        "Artifacts are archived 30 days after their last publish or restore, and cannot be pinned.",
      ),
    ).toBeTruthy();
    expect(radio("Archive after a maximum life", group).checked).toBe(true);
    expect(screen.queryByRole("button", { name: "Save policies" })).toBeNull();
    await themes(container);
  });

  it("says so on the artifact page, and offers no pin", async () => {
    acme("editor", { ...DEFAULT_POLICY, artifactMaxDays: 30, artifactMaxDaysFrom: Date.now() });
    const { container } = renderDashboard(`/artifacts/${ID}`, server);
    const details = await screen.findByRole("region", { name: "Details" });
    expect(
      await within(details).findByText(
        "This workspace archives artifacts 30 days after their last publish or restore: the expiry includes it, and pinning is off.",
      ),
    ).toBeTruthy();
    expect(within(details).queryByRole("button", { name: "Pin" })).toBeNull();
    await themes(container);
  });
});

describe("comment retention (decision 0023)", () => {
  const DAY = 86_400_000;
  const group = "Comment retention";

  it("lets an admin set it after confirming the threads and messages it deletes", async () => {
    acme("admin");
    const workspaceState = server.workspaces.acme;
    if (!workspaceState) throw new Error("no workspace");
    workspaceState.policyImpact = {
      ...NO_IMPACT,
      threadsAtStart: 3,
      messagesAtStart: 14,
      threadsSoon: 2,
    };
    const { container } = renderDashboard("/policies?workspace=acme", server);
    await screen.findByRole("group", { name: group });
    expect(
      screen.getByText(/Deleted threads cannot be recovered by anyone, Portifact included\./),
    ).toBeTruthy();
    fireEvent.click(radio("Delete old threads", group));
    const days = screen.getByRole("textbox", { name: /Days after a thread's last activity/ });
    fireEvent.change(days, { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Save policies" }));
    expect(await screen.findByText("Write a whole number of days from 30 to 3650.")).toBeTruthy();
    await themes(container);
    fireEvent.change(days, { target: { value: "180" } });
    fireEvent.click(screen.getByRole("button", { name: "Save policies" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(
      "3 comment threads are deleted for good the day comment retention takes effect",
    );
    expect(dialog.textContent).toContain("14 messages in them are deleted with them");
    expect(dialog.textContent).toContain("2 more threads are deleted within 30 days after that");
    expect(dialog.textContent).toContain(
      "Open threads on an artifact's current version are not counted: they are kept, and when a new version replaces it, each gets the whole period from that moment.",
    );
    await themes(container);
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply and save" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(server.bodies.at(-1)).toMatchObject({
      policy: { commentRetentionDays: 180, commentRetentionFrom: null },
      confirmed: { threadsAtStart: 3, messagesAtStart: 14, threadsSoon: 2 },
    });
    expect(await screen.findByText(/^Comment retention takes effect on /)).toBeTruthy();
    await themes(container);
  });

  it("says when the rule is set but not in force, and how to fix it", async () => {
    acme("member", {
      ...DEFAULT_POLICY,
      commentRetentionDays: 90,
      commentRetentionFrom: Date.now() - DAY,
    });
    const workspaceState = server.workspaces.acme;
    if (!workspaceState) throw new Error("no workspace");
    workspaceState.commentRetentionInForce = false;
    const { container } = renderDashboard("/policies?workspace=acme", server);
    expect(await screen.findByText("Comment retention is set but not in force")).toBeTruthy();
    expect(screen.getByText(/Save the rule again to put it in force/)).toBeTruthy();
    expect(
      screen.queryByText(/Comment threads are deleted for good 90 days after their last activity/),
    ).toBeNull();
    await themes(container);
  });

  it("tells every member the rule in effect", async () => {
    acme("member", {
      ...DEFAULT_POLICY,
      commentRetentionDays: 90,
      commentRetentionFrom: Date.now() - DAY,
    });
    const { container } = renderDashboard("/policies?workspace=acme", server);
    expect(
      await screen.findByText(
        "Comment threads are deleted for good 90 days after their last activity, or, for an open thread, 90 days after its version was replaced when that is later. Open threads on an artifact's current version are kept.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /when a new version replaces that version, the thread gets the whole period again from that moment\./,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save policies" })).toBeNull();
    await themes(container);
  });
});
