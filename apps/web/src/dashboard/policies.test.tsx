// @vitest-environment happy-dom
// Workspace policies in the dashboard (premium plan E4, decision 0015): the Policies page, where
// admins change them after seeing what a save changes, and the notes that name a policy on the
// artifact page where it disables a control.
import { DEFAULT_POLICY, type WorkspacePolicy } from "@portifact/contracts";
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
    expect(server.bodies.at(-1)).toMatchObject({ confirm: true, revision: 0 });
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
