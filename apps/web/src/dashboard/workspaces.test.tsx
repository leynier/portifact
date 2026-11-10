// @vitest-environment happy-dom
// Workspaces in the dashboard (premium plan T1): the space menu and the URL that names the space,
// the screens that follow it, the role in it deciding what is offered, the owner's plan deciding
// the plan notes, the Members page, transfers and the account's workspaces.
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  artifact,
  type FakeServer,
  fakeServer,
  renderDashboard,
  usageView,
  workspace,
} from "./test-support.tsx";

afterEach(cleanup);

let server: FakeServer;
beforeEach(() => {
  server = fakeServer([
    artifact("p2p2p2p2p2", { name: "Personal notes" }),
    artifact("w2w2w2w2w2", {
      name: "Team report",
      owner: { kind: "workspace", slug: "acme", name: "Acme" },
    }),
  ]);
});

const nav = () =>
  within(screen.getAllByRole("navigation", { name: "Main", hidden: true })[0] as HTMLElement)
    .getAllByRole("link", { hidden: true })
    .map((link) => link.textContent);

const requested = (prefix: string) =>
  server.requests.filter((r) => r.path.startsWith(prefix)).map((r) => `${r.method} ${r.path}`);

const teamPlan = (features: string[]) =>
  usageView({
    plan: {
      name: "team",
      validUntil: null,
      seats: 5,
      limits: { ...usageView().plan.limits },
      features: features as never,
    },
  });

const spaceButton = async (name: RegExp) =>
  (await screen.findAllByRole("button", { name, hidden: true }))[0] as HTMLElement;

describe("the space menu", () => {
  it("lists Personal and each workspace with the role, and switching puts the space in the URL", async () => {
    server.workspaces.acme = workspace("acme", "editor", { name: "Acme" });
    server.workspaces.beta = workspace("beta", "member", { name: "Beta" });
    const { container, router } = renderDashboard("/", server);
    await screen.findByRole("link", { name: "Personal notes" });
    fireEvent.click(await spaceButton(/^Space Personal/));
    const list = screen.getAllByRole("list", { name: "Space", hidden: true })[0] as HTMLElement;
    const links = within(list).getAllByRole("link", { hidden: true });
    expect(links.map((link) => link.hasAttribute("aria-current"))).toEqual([true, false, false]);
    expect(within(list).getByRole("link", { name: "Acme Editor", hidden: true })).toBeTruthy();
    expect(within(list).getByRole("link", { name: "Beta Member", hidden: true })).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);

    fireEvent.click(within(list).getByRole("link", { name: "Acme Editor", hidden: true }));
    await waitFor(() => expect(router.state.location.search).toEqual({ workspace: "acme" }));
    expect(await screen.findByRole("link", { name: "Team report" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Personal notes" })).toBeNull();
    expect(requested("/api/v1/artifacts?")).toContain("GET /api/v1/artifacts?workspace=acme");
  });

  it("keeps the space on every link, and leaves it for the personal space", async () => {
    server.workspaces.acme = workspace("acme", "admin", { name: "Acme" });
    const { router } = renderDashboard("/?workspace=acme", server);
    await screen.findByRole("link", { name: "Team report" });
    fireEvent.click(screen.getAllByRole("link", { name: "Usage", hidden: true })[0] as HTMLElement);
    await waitFor(() => expect(router.state.location.pathname).toBe("/usage"));
    expect(router.state.location.search).toEqual({ workspace: "acme" });
    await waitFor(() =>
      expect(requested("/api/v1/usage")).toContain("GET /api/v1/usage?workspace=acme"),
    );

    fireEvent.click(await spaceButton(/^Space Acme/));
    fireEvent.click(
      screen.getAllByRole("link", {
        name: "Personal Your own space",
        hidden: true,
      })[0] as HTMLElement,
    );
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(router.state.location.pathname).toBe("/usage");
  });

  it("answers a workspace the user is not in like a missing page", async () => {
    server.workspaces.acme = workspace("acme", "admin");
    const { container } = renderDashboard("/?workspace=elsewhere", server);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Workspace not found" }),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Team report" })).toBeNull();
    expect(requested("/api/v1/artifacts")).toEqual([]);
    expect(screen.getByRole("link", { name: "Go to your personal space" })).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("offers each role only the pages it can use", async () => {
    server.workspaces.a = workspace("a", "admin");
    server.workspaces.e = workspace("e", "editor");
    server.workspaces.m = workspace("m", "member");
    const cases: [string, string[]][] = [
      [
        "/",
        [
          "Artifacts",
          "Publish",
          "Apps",
          "Usage",
          "Plan",
          "Webhooks",
          "Branding",
          "Audit log",
          "Settings",
        ],
      ],
      [
        "/?workspace=a",
        [
          "Artifacts",
          "Publish",
          "Apps",
          "Usage",
          "Plan",
          "Webhooks",
          "Branding",
          "Members",
          "Groups",
          "Policies",
          "Audit log",
          "Service tokens",
          "Settings",
        ],
      ],
      [
        "/?workspace=e",
        ["Artifacts", "Publish", "Apps", "Usage", "Plan", "Members", "Policies", "Settings"],
      ],
      // Every role compares the plans and reads the policies that bind it; the page decides
      // what it shows and offers.
      ["/?workspace=m", ["Artifacts", "Apps", "Plan", "Members", "Policies", "Settings"]],
    ];
    for (const [path, expected] of cases) {
      renderDashboard(path, server);
      await waitFor(() => expect(nav()).toEqual(expected));
      cleanup();
    }
  });

  it("tells a member why the workspace's list, publishing, usage and brand are not theirs", async () => {
    server.workspaces.m = workspace("m", "member", { name: "Mia team" });
    for (const [path, text] of [
      ["/?workspace=m", /As a member of Mia team, you read and comment/],
      ["/publish?workspace=m", /Publishing to Mia team needs the editor or admin role/],
      ["/usage?workspace=m", /The usage of Mia team is shown to its editors and admins/],
      ["/branding?workspace=m", /Only the admins of Mia team set its brand/],
    ] as const) {
      const { container } = renderDashboard(path, server);
      expect(await screen.findByText(text)).toBeTruthy();
      expect(screen.getByRole("link", { name: "Back to artifacts" })).toBeTruthy();
      expect(await axeViolations(container)).toEqual([]);
      cleanup();
    }
    // Nothing the role cannot read was asked for.
    expect(requested("/api/v1/artifacts")).toEqual([]);
    expect(requested("/api/v1/usage?workspace=m")).toEqual([]);
    expect(requested("/api/v1/account/branding?workspace=m")).toEqual([]);
  });

  it("manages a workspace's webhooks for its admins, in both themes", async () => {
    server.workspaces.acme = workspace("acme", "admin", { name: "Acme" });
    const { container } = renderDashboard("/webhooks?workspace=acme", server);
    await waitFor(() => expect(nav()).toContain("Webhooks"));
    await screen.findByText("No webhooks yet");
    expect(requested("/api/v1/webhooks")).toEqual(["GET /api/v1/webhooks?workspace=acme"]);
    const form = screen.getByRole("region", { name: "Add a webhook" });
    fireEvent.change(within(form).getByLabelText(/^URL/), {
      target: { value: "https://hooks.example.com/in" },
    });
    fireEvent.click(within(form).getByLabelText("Reviews approved or with changes requested"));
    fireEvent.click(within(form).getByRole("button", { name: "Add webhook" }));
    await screen.findByText("Copy the signing secret now");
    expect(requested("/api/v1/webhooks")).toContain("POST /api/v1/webhooks?workspace=acme");
    expect(server.bodies.at(-1)).toMatchObject({
      events: ["comment.created", "thread.resolved", "review.completed"],
    });
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.dataset.theme = theme;
      expect(await axeViolations(container), theme).toEqual([]);
    }
    delete document.documentElement.dataset.theme;
  });

  it("tells editors and members that only admins manage a workspace's webhooks", async () => {
    server.workspaces.beta = workspace("beta", "editor", { name: "Beta" });
    renderDashboard("/?workspace=beta", server);
    await waitFor(() => expect(nav()).toContain("Members"));
    expect(nav()).not.toContain("Webhooks");
    cleanup();
    const { container } = renderDashboard("/webhooks?workspace=beta", server);
    expect(await screen.findByText("Only admins manage webhooks")).toBeTruthy();
    expect(screen.getByText(/only the admins of Beta can see and manage them/)).toBeTruthy();
    expect(requested("/api/v1/webhooks")).toEqual([]);
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.dataset.theme = theme;
      expect(await axeViolations(container), theme).toEqual([]);
    }
    delete document.documentElement.dataset.theme;
  });

  it("shows an empty workspace's first publish with the CLI command for it", async () => {
    server.workspaces.empty = workspace("empty", "editor", { name: "Empty" });
    renderDashboard("/?workspace=empty", server);
    expect(
      await screen.findByText("portifact publish ./report.html --workspace empty"),
    ).toBeTruthy();
  });

  it("announces pending invitations on every screen with a link to them", async () => {
    server.incoming = [
      {
        id: `inv_${"1".repeat(32)}`,
        workspace: { slug: "acme", name: "Acme" },
        role: "editor",
        invitedBy: "Grace",
        expiresAt: "2026-11-15T12:00:00.000Z",
      },
    ];
    renderDashboard("/usage", server);
    expect(await screen.findByText("You have 1 pending invitation.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "See invitations" }).getAttribute("href")).toBe(
      "/invitations",
    );
  });
});

describe("publishing into a workspace", () => {
  it("opens the upload in the space shown, and the review says where and who can open it", async () => {
    server.workspaces.acme = workspace("acme", "editor", { name: "Acme" });
    const { container } = renderDashboard("/publish?workspace=acme", server);
    await screen.findByRole("heading", { level: 1, name: "Publish" });
    const input = await screen.findByLabelText("Choose files");
    Object.defineProperty(input, "files", {
      value: [new File(["<h1>Hi</h1>"], "index.html")],
      configurable: true,
    });
    fireEvent.change(input);
    await screen.findByRole("heading", { name: "Review before publishing" });
    expect(
      screen.getByText(
        "The admins and editors of Acme. After publishing, you can share it from the artifact page.",
      ),
    ).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(await screen.findByText("Published version 1")).toBeTruthy();
    expect(requested("/api/v1/publishes")[0]).toBe("POST /api/v1/publishes?workspace=acme");
    expect(server.artifacts.at(-1)?.owner).toEqual({
      kind: "workspace",
      slug: "acme",
      name: "Acme",
    });
    // The size checked before hashing is the workspace's plan.
    expect(requested("/api/v1/usage")).toContain("GET /api/v1/usage?workspace=acme");
  });
});

describe("the owner's plan decides the plan notes", () => {
  it("offers pinning on a Team workspace's artifact to a user whose own plan is free", async () => {
    server.workspaces.acme = workspace("acme", "editor", {
      name: "Acme",
      usage: teamPlan(["pin"]),
    });
    renderDashboard("/artifacts/w2w2w2w2w2", server);
    const details = await screen.findByRole("region", { name: "Details" });
    expect(await within(details).findByRole("button", { name: "Pin" })).toBeTruthy();
    expect(within(details).queryByText(/part of the Pro plan/)).toBeNull();
  });

  it("does not offer pinning on a free workspace's artifact to a user with a paid plan", async () => {
    server.usage = teamPlan(["pin"]);
    server.workspaces.acme = workspace("acme", "editor", { name: "Acme" });
    renderDashboard("/artifacts/w2w2w2w2w2", server);
    const details = await screen.findByRole("region", { name: "Details" });
    expect(
      await within(details).findByText(
        "Pinning keeps an artifact online with no expiry. It is part of the Pro plan.",
      ),
    ).toBeTruthy();
    expect(within(details).queryByRole("button", { name: "Pin" })).toBeNull();
  });

  it("brands a workspace from its own settings, not the personal space's", async () => {
    server.branding = { available: false, lowestPlan: "pro", suspended: false, brand: null };
    server.workspaces.acme = workspace("acme", "admin", { name: "Acme" });
    renderDashboard("/branding?workspace=acme", server);
    expect(await screen.findByRole("button", { name: "Save brand" })).toBeTruthy();
    expect(requested("/api/v1/account/branding")).toEqual([
      "GET /api/v1/account/branding?workspace=acme",
    ]);
  });
});

describe("the artifact page", () => {
  it("shows where the artifact lives", async () => {
    server.workspaces.acme = workspace("acme", "editor", { name: "Acme" });
    renderDashboard("/artifacts/w2w2w2w2w2", server);
    await screen.findByRole("heading", { level: 1, name: "Team report" });
    const details = screen.getByRole("region", { name: "Details" });
    const term = within(details).getAllByRole("term")[0] as HTMLElement;
    expect(term.textContent).toBe("Space");
    expect(term.nextElementSibling?.textContent).toBe("Acme");
  });
});

describe("moving an artifact", () => {
  const panel = () => screen.findByRole("region", { name: "Move to another space" });
  const moveButton = async (section: HTMLElement) =>
    within(section).findByRole("button", { name: "Move artifact" });

  it("moves a personal artifact into a workspace where the user publishes, after saying what moves", async () => {
    server.workspaces.acme = workspace("acme", "editor", { name: "Acme" });
    server.workspaces.view = workspace("view", "member", { name: "Viewers" });
    const { container, router } = renderDashboard("/artifacts/p2p2p2p2p2", server);
    const section = await panel();
    await moveButton(section);
    const select = within(section).getByRole("combobox", { name: "Destination" });
    fireEvent.click(select);
    // A workspace where the user is only a member is not a destination.
    expect(
      within(screen.getByRole("listbox", { name: "Destination" }))
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Acme (Editor)"]);
    fireEvent.keyDown(select, { key: "Escape" });
    expect(await axeViolations(container)).toEqual([]);

    fireEvent.click(await moveButton(section));
    const dialog = await screen.findByRole("dialog", { name: "Move Personal notes to Acme?" });
    expect(dialog.textContent).toContain("its ID, its link, its versions");
    expect(dialog.textContent).toContain("see who opened it, also before the move");
    expect(dialog.textContent).toContain("Pins and share links follow the plan of Acme");
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Move" }));
    expect(await screen.findByText("Personal notes moved to Acme.")).toBeTruthy();
    expect(server.bodies).toContainEqual({ workspace: "acme" });
    await waitFor(() => expect(router.state.location.search).toEqual({ workspace: "acme" }));
  });

  it("moves a workspace's artifact out as its admin", async () => {
    server.workspaces.acme = workspace("acme", "admin", { name: "Acme" });
    renderDashboard("/artifacts/w2w2w2w2w2?workspace=acme", server);
    const section = await panel();
    fireEvent.click(await moveButton(section));
    // A restricted artifact keeps its mode: nothing to warn about.
    expect((await screen.findByRole("dialog")).textContent).not.toContain("becomes restricted");
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Move" }),
    );
    expect(await screen.findByText("Team report moved to Personal.")).toBeTruthy();
    expect(server.bodies).toContainEqual({ workspace: null });
  });

  it("says a workspace-shared artifact becomes restricted when it moves", async () => {
    server.workspaces.acme = workspace("acme", "admin", { name: "Acme" });
    const shared = server.artifacts.find((a) => a.id === "w2w2w2w2w2");
    if (shared) shared.accessMode = "domain";
    renderDashboard("/artifacts/w2w2w2w2w2?workspace=acme", server);
    fireEvent.click(await moveButton(await panel()));
    expect((await screen.findByRole("dialog")).textContent).toContain(
      "so it becomes restricted: only the people on its reader list keep reading it.",
    );
  });

  it("says an editor cannot take a workspace's artifact out, and offers no move", async () => {
    server.workspaces.acme = workspace("acme", "editor", { name: "Acme" });
    renderDashboard("/artifacts/w2w2w2w2w2", server);
    const section = await panel();
    expect(
      await within(section).findByText("Only an admin of Acme can move its artifacts out of it."),
    ).toBeTruthy();
    expect(within(section).queryByRole("button", { name: "Move artifact" })).toBeNull();
  });

  it("explains the API's refusal in the page's words", async () => {
    server.workspaces.acme = workspace("acme", "editor", { name: "Acme" });
    server.fail("POST", "/api/v1/artifacts/p2p2p2p2p2/transfer", {
      status: 400,
      code: "quota_exceeded",
    });
    renderDashboard("/artifacts/p2p2p2p2p2", server);
    const section = await panel();
    fireEvent.click(await moveButton(section));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Move" }),
    );
    expect(
      await within(section).findByText(
        "Acme has no room for this artifact. Free an active slot or storage there first.",
      ),
    ).toBeTruthy();
  });

  it("says when there is nowhere to move it", async () => {
    renderDashboard("/artifacts/p2p2p2p2p2", server);
    const section = await panel();
    expect(
      await within(section).findByText(/There is no other space you can move it to/),
    ).toBeTruthy();
  });
});

describe("the Members page", () => {
  const memberList = () => screen.findByRole("list", { name: /^Members of / });
  const JOINED = "2026-11-01T00:00:00.000Z";

  it("says the personal space has no members", async () => {
    const { container } = renderDashboard("/members", server);
    expect(await screen.findByText("Your personal space has no members")).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("lets an admin change roles and remove members, but never leave the workspace without one", async () => {
    server.workspaces.acme = workspace("acme", "admin", {
      name: "Acme",
      members: [
        {
          userId: "u_ada",
          name: "Ada",
          email: "ada@example.test",
          role: "admin",
          joinedAt: JOINED,
          you: true,
          directoryRole: false,
        },
        {
          userId: "u_ed",
          name: "Ed",
          email: "ed@example.test",
          role: "editor",
          joinedAt: JOINED,
          you: false,
          directoryRole: false,
        },
      ],
      seats: 5,
    });
    const { container } = renderDashboard("/members?workspace=acme", server);
    const list = await memberList();
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("meter", { name: "Seats in use" })).toBeTruthy();
    expect(screen.getByText("2 of 5 (40%)")).toBeTruthy();
    // The only admin: their own role and leaving are disabled, with the reason.
    const adaRole = () =>
      screen.getByRole("combobox", { name: "Role of Ada" }) as HTMLButtonElement;
    expect(adaRole().disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Leave workspace" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/The only admin: make another member an admin/)).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);

    fireEvent.click(screen.getByRole("combobox", { name: "Role of Ed" }));
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "Role of Ed" })).getByRole("option", {
        name: "Admin",
      }),
    );
    expect(await screen.findByText("Ed is now Admin.")).toBeTruthy();
    expect(server.bodies).toContainEqual({ role: "admin" });
    await waitFor(() => expect(adaRole().disabled).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: "Remove Ed" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Ed from Acme?" });
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove member" }));
    expect(await screen.findByText("Ed was removed.")).toBeTruthy();
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(1));
  });

  it("invites by email with a role, and revokes and resends pending invitations", async () => {
    server.workspaces.acme = workspace("acme", "admin", { name: "Acme" });
    const { container } = renderDashboard("/members?workspace=acme", server);
    const invite = await screen.findByRole("region", { name: "Invite someone" });
    const email = () => within(invite).getByRole("textbox", { name: "Email" });
    const send = () =>
      fireEvent.click(within(invite).getByRole("button", { name: "Send invitation" }));
    fireEvent.change(email(), { target: { value: "not an email" } });
    send();
    expect(
      await within(invite).findByText("Enter an email address, like name@example.com."),
    ).toBeTruthy();
    fireEvent.change(email(), { target: { value: "ada@example.test" } });
    send();
    expect(await within(invite).findByText("ada@example.test is already a member.")).toBeTruthy();

    fireEvent.change(email(), { target: { value: "New@Example.test" } });
    fireEvent.click(within(invite).getByRole("combobox", { name: "Role" }));
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "Role" })).getByRole("option", { name: "Editor" }),
    );
    send();
    expect(await screen.findByText("Invitation sent to new@example.test.")).toBeTruthy();
    expect(server.bodies).toContainEqual({ email: "new@example.test", role: "editor" });
    const pending = await screen.findByRole("list", { name: "Pending invitations" });
    expect(await within(pending).findByText("new@example.test")).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Invite again: new@example.test" }));
    expect(
      await screen.findByText(
        "A new invitation was sent to new@example.test. The earlier link no longer works.",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Revoke: new@example.test" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Revoke the invitation of new@example.test?",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke invitation" }));
    expect(await screen.findByText("The invitation of new@example.test was revoked.")).toBeTruthy();
    expect(await screen.findByText("No pending invitations.")).toBeTruthy();
  });

  it("disables inviting when every seat is taken and says so", async () => {
    server.workspaces.acme = workspace("acme", "admin", { name: "Acme", seats: 1 });
    const { container } = renderDashboard("/members?workspace=acme", server);
    const invite = await screen.findByRole("region", { name: "Invite someone" });
    expect(within(invite).getByText("No free seat")).toBeTruthy();
    expect(
      (within(invite).getByRole("button", { name: "Send invitation" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("explains refusals: rate limits, a role changed meanwhile and no free seat", async () => {
    server.workspaces.acme = workspace("acme", "admin", { name: "Acme" });
    renderDashboard("/members?workspace=acme", server);
    const invite = await screen.findByRole("region", { name: "Invite someone" });
    fireEvent.change(within(invite).getByRole("textbox", { name: "Email" }), {
      target: { value: "x@example.test" },
    });
    const cases = [
      [429, "rate_limited", /Too many invitations for now/],
      [403, "forbidden", /Your role changed meanwhile/],
      [409, "seats_exhausted", /The workspace uses all of its seats/],
    ] as const;
    for (const [status, code, text] of cases) {
      server.fail("POST", "/api/v1/workspaces/acme/invitations", { status, code });
      fireEvent.click(within(invite).getByRole("button", { name: "Send invitation" }));
      expect(await within(invite).findByText(text)).toBeTruthy();
    }
  });

  it("shows a member the list without managing it, and lets them leave", async () => {
    server.workspaces.acme = workspace("acme", "member", { name: "Acme" });
    const { container, router } = renderDashboard("/members?workspace=acme", server);
    const list = await memberList();
    expect(within(list).getByText("Grace Admin")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: /^Role of/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
    expect(screen.queryByRole("region", { name: "Invite someone" })).toBeNull();
    expect(requested("/api/v1/workspaces/acme/invitations")).toEqual([]);
    expect(await axeViolations(container)).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Leave workspace" }));
    const dialog = await screen.findByRole("dialog", { name: "Leave Acme?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Leave workspace" }));
    expect(await screen.findByText("You left Acme.")).toBeTruthy();
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(router.state.location.search).toEqual({});
  });
});

describe("the account's workspaces", () => {
  it("lists them in Settings with the role and leaving, and explains the last admin's refusal", async () => {
    server.workspaces.acme = workspace("acme", "admin", { name: "Acme" });
    server.workspaces.beta = workspace("beta", "editor", { name: "Beta" });
    const { container } = renderDashboard("/settings", server);
    const section = await screen.findByRole("region", { name: "Workspaces" });
    const list = await within(section).findByRole("list", { name: "Workspaces" });
    expect(within(list).getByRole("link", { name: "Acme" }).getAttribute("href")).toBe(
      "/?workspace=acme",
    );
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(await axeViolations(container)).toEqual([]);

    fireEvent.click(within(section).getByRole("button", { name: "Leave Acme" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Leave Acme?" })).getByRole("button", {
        name: "Leave workspace",
      }),
    );
    expect(await within(section).findByText(/A workspace must keep an admin/)).toBeTruthy();

    fireEvent.click(within(section).getByRole("button", { name: "Leave Beta" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Leave Beta?" })).getByRole("button", {
        name: "Leave workspace",
      }),
    );
    expect(await screen.findByText("You left Beta.")).toBeTruthy();
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(1));
  });

  it("says when the account belongs to no workspace", async () => {
    renderDashboard("/settings", server);
    const section = await screen.findByRole("region", { name: "Workspaces" });
    expect(await within(section).findByText(/You do not belong to any workspace/)).toBeTruthy();
  });

  it("explains that the only admin of a workspace cannot delete the account, and what to do", async () => {
    server.workspaces.acme = workspace("acme", "admin", { name: "Acme" });
    server.fail("POST", "/api/v1/account/delete", { status: 409, code: "sole_workspace_admin" });
    const { container } = renderDashboard("/settings", server);
    const danger = await screen.findByRole("region", { name: "Danger zone" });
    fireEvent.change(within(danger).getByRole("textbox"), {
      target: { value: "ada@example.test" },
    });
    fireEvent.click(within(danger).getByRole("button", { name: "Delete account" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete my account" }));
    expect(await within(danger).findByText("You are the only admin of a workspace")).toBeTruthy();
    const link = await within(danger).findByRole("link", { name: "Members of Acme" });
    expect(link.getAttribute("href")).toBe("/members?workspace=acme");
    expect(await axeViolations(container)).toEqual([]);
  });
});
