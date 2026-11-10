// @vitest-environment happy-dom
// Workspace groups in the dashboard (premium plan T3, decision 0014): the Groups page for admins,
// and groups in an artifact's sharing settings, picked by name with each one's comment exception.
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  artifact,
  choose,
  type FakeServer,
  fakeServer,
  renderDashboard,
  workspace,
} from "./test-support.tsx";

afterEach(cleanup);

const ID = "w2w2w2w2w2";
const DESIGN = `wg_${"1".repeat(32)}`;
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

const requested = () =>
  server.requests.filter((r) => r.path.includes("/groups")).map((r) => `${r.method} ${r.path}`);

async function themes(container: HTMLElement) {
  for (const colorScheme of ["light", "dark"] as const) {
    document.documentElement.dataset.theme = colorScheme;
    expect(await axeViolations(container), colorScheme).toEqual([]);
  }
  delete document.documentElement.dataset.theme;
}

function withDesign(role: "admin" | "editor" = "admin", available = true) {
  server.workspaces.acme = workspace("acme", role, {
    name: "Acme",
    domainsAvailable: available,
    groups: [
      {
        id: DESIGN,
        name: "Design",
        members: 1,
        createdAt: "2026-11-01T12:00:00.000Z",
        directory: false,
        memberIds: ["u_ada"],
      },
    ],
  });
}

describe("the Groups page", () => {
  it("is offered to admins of a workspace only", async () => {
    withDesign("admin");
    server.workspaces.beta = workspace("beta", "editor", { name: "Beta" });
    const admin = renderDashboard("/?workspace=acme", server);
    await waitFor(() => expect(nav()).toContain("Groups"));
    admin.unmount();
    cleanup();

    renderDashboard("/?workspace=beta", server);
    await waitFor(() => expect(nav()).toContain("Members"));
    expect(nav()).not.toContain("Groups");
    cleanup();

    renderDashboard("/groups?workspace=beta", server);
    expect(await screen.findByText("Only admins manage groups")).toBeTruthy();
    cleanup();

    renderDashboard("/groups", server);
    expect(await screen.findByText("Groups belong to a workspace")).toBeTruthy();
    expect(requested()).toEqual([]);
  });

  it("shows a directory group as the directory's, without the controls that change it", async () => {
    withDesign("admin");
    const acme = server.workspaces.acme;
    if (!acme) throw new Error("no workspace");
    acme.groups = acme.groups.map((group) => ({ ...group, directory: true }));
    acme.members = acme.members.map((member) => ({ ...member, directoryRole: true }));
    const { container } = renderDashboard("/groups?workspace=acme", server);
    const card = (await screen.findByRole("heading", { name: /Design/ })).closest(
      "li",
    ) as HTMLElement;
    expect(within(card).getByText("Managed by your directory")).toBeTruthy();
    expect(card.textContent).toContain("change its name and members there");
    expect(within(card).queryByRole("button", { name: "Rename Design" })).toBeNull();
    expect(within(card).queryByRole("button", { name: "Delete Design" })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Members" }));
    await within(card).findByText("Ada");
    expect(within(card).queryByRole("button", { name: /^Remove/ })).toBeNull();
    expect(within(card).queryByRole("combobox")).toBeNull();
    await themes(container);
    cleanup();
    renderDashboard("/members?workspace=acme", server);
    expect(await screen.findByText("In a directory group with a role")).toBeTruthy();
  });

  it("stops syncing a directory group after a confirmation, making it an ordinary group", async () => {
    withDesign("admin");
    const acme = server.workspaces.acme;
    if (!acme) throw new Error("no workspace");
    acme.groups = acme.groups.map((group) => ({ ...group, directory: true }));
    acme.scim.editorGroup = DESIGN;
    const { container } = renderDashboard("/groups?workspace=acme", server);
    const card = (await screen.findByRole("heading", { name: /Design/ })).closest(
      "li",
    ) as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Stop syncing Design" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Stop syncing Design from your directory?",
    });
    expect(dialog.textContent).toContain(
      "If the directory pushes a group with the same name later, it is refused.",
    );
    await themes(container);
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop syncing" }));
    expect(await within(card).findByRole("button", { name: "Rename Design" })).toBeTruthy();
    expect(within(card).queryByText("Managed by your directory")).toBeNull();
    expect(acme.scim.editorGroup).toBeNull();
    expect(requested()).toContain(`POST /api/v1/workspaces/acme/groups/${DESIGN}/stop-sync`);
  });

  it("creates a group, adds and removes a member, renames and deletes it", async () => {
    server.workspaces.acme = workspace("acme", "admin", { name: "Acme" });
    const { container } = renderDashboard("/groups?workspace=acme", server);
    await screen.findByText("No groups yet");
    await themes(container);
    const form = screen
      .getByRole("button", { name: "Create group" })
      .closest("form") as HTMLElement;
    // A name of control characters is refused before any request.
    fireEvent.click(within(form).getByRole("button", { name: "Create group" }));
    expect(await within(form).findByText("Use one line of 1 to 80 characters.")).toBeTruthy();
    expect(requested()).toEqual(["GET /api/v1/workspaces/acme/groups"]);
    fireEvent.change(within(form).getByRole("textbox", { name: /^Name/ }), {
      target: { value: "Design" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Create group" }));
    const card = (await screen.findByRole("heading", { name: "Design" })).closest(
      "li",
    ) as HTMLElement;
    expect(within(card).getByText("0 members")).toBeTruthy();

    fireEvent.click(within(card).getByRole("button", { name: "Members" }));
    await within(card).findByText("Nobody is in this group yet.");
    choose("Add a member to Design", "Ada (ada@example.test)");
    fireEvent.click(within(card).getByRole("button", { name: "Add" }));
    await within(card).findByRole("list", { name: "Members of Design" });
    await waitFor(() => expect(within(card).getByText("1 member")).toBeTruthy());
    await themes(container);
    fireEvent.click(within(card).getByRole("button", { name: "Remove Ada from Design" }));
    await within(card).findByText("Nobody is in this group yet.");

    fireEvent.click(within(card).getByRole("button", { name: "Rename Design" }));
    fireEvent.change(within(card).getByRole("textbox", { name: /^New name for Design/ }), {
      target: { value: "Research" },
    });
    fireEvent.click(within(card).getByRole("button", { name: "Save name" }));
    const renamed = (await screen.findByRole("heading", { name: "Research" })).closest(
      "li",
    ) as HTMLElement;

    fireEvent.click(within(renamed).getByRole("button", { name: "Delete Research" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Research?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await screen.findByText("No groups yet");
    expect(requested()).toEqual(
      expect.arrayContaining([
        "POST /api/v1/workspaces/acme/groups",
        `POST /api/v1/workspaces/acme/groups/${"wg_".padEnd(34, "0")}1/members`,
        `PATCH /api/v1/workspaces/acme/groups/${"wg_".padEnd(34, "0")}1`,
        `DELETE /api/v1/workspaces/acme/groups/${"wg_".padEnd(34, "0")}1`,
      ]),
    );
  });

  it("says groups grant nothing while the plan lacks them, and offers no creation", async () => {
    withDesign("admin", false);
    renderDashboard("/groups?workspace=acme", server);
    expect(await screen.findByText("Groups are not in this workspace's plan")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Create group" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("groups in the sharing settings", () => {
  const groupsPanel = async () => {
    await screen.findByRole("region", { name: "Access" }, { timeout: 10_000 });
    return screen.findByRole("region", { name: "Groups" }, { timeout: 10_000 });
  };

  it("adds a group by name, sets its comment exception and removes it", async () => {
    withDesign("editor");
    const { container } = renderDashboard(`/artifacts/${ID}?workspace=acme`, server);
    const panel = await groupsPanel();
    await within(panel).findByText("No groups added.");
    choose("Add a group", "Design (1 member)");
    fireEvent.click(within(panel).getByRole("button", { name: "Add group" }));
    const list = await within(panel).findByRole("list", {
      name: "Groups that can open this artifact",
    });
    expect(within(list).getByText("Design")).toBeTruthy();
    expect(server.bodies.at(-1)).toEqual({ addGroups: [DESIGN] });
    await themes(container);

    // Showing every comment to a group waits for a confirmation.
    choose("Comments the group Design sees", "All comments");
    const dialog = await screen.findByRole("dialog", { name: "Show every comment to Design?" });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Show/ }));
    await waitFor(() =>
      expect(server.bodies.at(-1)).toEqual({
        groupCommentVisibility: [{ group: DESIGN, commentVisibility: "all" }],
      }),
    );

    fireEvent.click(within(list).getByRole("button", { name: "Remove the group Design" }));
    await within(panel).findByText("No groups added.");
    expect(server.bodies.at(-1)).toEqual({ removeGroups: [DESIGN] });
  });

  it("is not shown on a personal artifact and explains a lapsed plan", async () => {
    server.artifacts.push(artifact("p3p3p3p3p3", { name: "Mine" }));
    withDesign("admin", false);
    renderDashboard("/artifacts/p3p3p3p3p3", server);
    await screen.findByRole("region", { name: "Access" }, { timeout: 10_000 });
    await screen.findByRole("region", { name: "People you added" });
    expect(screen.queryByRole("region", { name: "Groups" })).toBeNull();
    cleanup();

    renderDashboard(`/artifacts/${ID}?workspace=acme`, server);
    const panel = await groupsPanel();
    expect(await within(panel).findByText("Groups are not in this workspace's plan")).toBeTruthy();
    expect(
      (within(panel).getByRole("button", { name: "Add group" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
