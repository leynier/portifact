// @vitest-environment happy-dom
// A workspace's network allowlists in the dashboard (decision 0020): admins edit them on the
// Policies page and confirm who they bind, other members learn only that one exists, and a
// workspace whose network policy refuses this browser shows one clear page.
import { DEFAULT_POLICY, type WorkspacePolicy } from "@portifact/contracts";
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeServer, fakeServer, renderDashboard, workspace } from "./test-support.tsx";

afterEach(cleanup);

let server: FakeServer;
beforeEach(() => {
  server = fakeServer([]);
});

async function themes(container: HTMLElement) {
  for (const colorScheme of ["light", "dark"] as const) {
    document.documentElement.dataset.theme = colorScheme;
    expect(await axeViolations(container), colorScheme).toEqual([]);
  }
  delete document.documentElement.dataset.theme;
}

const puts = () =>
  server.requests.filter((r) => r.method === "PUT" && r.path.endsWith("/policies"));
const group = (name: string) => within(screen.getByRole("group", { name }));

function acme(
  role: "admin" | "editor" | "member",
  policy: WorkspacePolicy = DEFAULT_POLICY,
  blocked = false,
) {
  server.workspaces.acme = workspace("acme", role, { name: "Acme", policy, blocked });
}

describe("the network allowlists on the Policies page", () => {
  it("lets an admin limit people to networks after seeing who it binds", async () => {
    acme("admin");
    const { container } = renderDashboard("/policies?workspace=acme", server);
    await screen.findByRole("group", { name: "Networks for people" });
    expect(
      screen.getByText(
        "Your current address is 192.0.2.10. The list must include it, or saving it would lock you out.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/never stores it/)).toBeTruthy();
    fireEvent.click(
      group("Networks for people").getByRole("radio", { name: "Only these networks" }),
    );
    const ranges = screen.getByRole("textbox", { name: "Allowed IP addresses and ranges" });
    fireEvent.change(ranges, { target: { value: "192.0.2.0/24\n2001:db8::/32" } });
    await themes(container);
    fireEvent.click(screen.getByRole("button", { name: "Save policies" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Limit the networks that reach this workspace?",
    });
    expect(dialog.textContent).toMatch(
      /\d+ members? will reach the workspace only from the allowed networks/,
    );
    expect(dialog.textContent).toContain("Portifact keeps nobody's address");
    await themes(container);
    expect(puts()).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Limit networks" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    // No artifact changes: nothing to confirm, so no `confirmed`.
    expect(server.bodies.at(-1)).toEqual({
      policy: { ...DEFAULT_POLICY, ipAllowlist: ["192.0.2.0/24", "2001:db8::/32"] },
      revision: 0,
    });
  });

  it("refuses ranges that do not parse before asking the API", async () => {
    acme("admin");
    renderDashboard("/policies?workspace=acme", server);
    await screen.findByRole("group", { name: "Networks for service tokens" });
    fireEvent.click(
      group("Networks for service tokens").getByRole("radio", { name: "Only these networks" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Allowed IP addresses and ranges" }), {
      target: { value: "0.0.0.0/0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save policies" }));
    expect(await screen.findByText(/A range of every address \(\/0\) is not allowed/)).toBeTruthy();
    expect(server.requests.some((r) => r.path.endsWith("/policies/preview"))).toBe(false);
  });

  it("tells other members only that an allowlist exists", async () => {
    acme("member", {
      ...DEFAULT_POLICY,
      ipAllowlist: ["192.0.2.0/24"],
      tokenIpAllowlist: ["203.0.113.0/24"],
    });
    const { container } = renderDashboard("/policies?workspace=acme", server);
    expect(
      await screen.findByText(
        "People reach this workspace only from approved networks. Its admins see the list.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Service tokens work only from approved networks. The workspace's admins see the list.",
      ),
    ).toBeTruthy();
    expect(container.textContent).not.toContain("192.0.2");
    expect(container.textContent).not.toContain("203.0.113");
    expect(screen.queryByText(/Your current address/)).toBeNull();
    await themes(container);
  });
});

describe("a workspace this network cannot reach", () => {
  it("shows one clear page and keeps the other spaces reachable", async () => {
    acme("member", { ...DEFAULT_POLICY, ipAllowlist: ["192.0.2.0/24"] }, true);
    const { container } = renderDashboard("/?workspace=acme", server);
    expect(
      await screen.findByRole("heading", { name: "Not reachable from this network" }),
    ).toBeTruthy();
    expect(container.textContent).toContain(
      "Acme only allows access from its approved networks, and this network is not one of them.",
    );
    expect(screen.getByRole("link", { name: "Go to your personal space" })).toBeTruthy();
    // Nothing of the workspace is asked for while it refuses this network.
    expect(server.requests.some((r) => r.path.startsWith("/api/v1/artifacts"))).toBe(false);
    await themes(container);
  });
});

describe("after the review (decision 0020)", () => {
  it("confirms a list covering one address family, and sends exactly that", async () => {
    acme("admin");
    const { container } = renderDashboard("/policies?workspace=acme", server);
    await screen.findByRole("group", { name: "Networks for people" });
    fireEvent.click(
      group("Networks for people").getByRole("radio", { name: "Only these networks" }),
    );
    expect(screen.getByText(/Networks that use both IPv4 and IPv6 need both ranges/)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Allowed IP addresses and ranges" }), {
      target: { value: "192.0.2.0/24" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save policies" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Limit the networks that reach this workspace?",
    });
    expect(dialog.textContent).toContain(
      "The list for people names only IPv4 ranges: requests that arrive over IPv6 will be refused, also from these networks",
    );
    await themes(container);
    fireEvent.click(within(dialog).getByRole("button", { name: "I understand, save" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(server.bodies.at(-1)).toEqual({
      policy: { ...DEFAULT_POLICY, ipAllowlist: ["192.0.2.0/24"] },
      revision: 0,
      confirmedSingleFamily: { people: "ipv4", tokens: null },
    });
  });

  it("warns that service tokens keep working from anywhere with only a people list", async () => {
    acme("admin");
    const w = server.workspaces.acme;
    if (!w) throw new Error("no workspace");
    w.serviceTokens = [{} as never, {} as never];
    renderDashboard("/policies?workspace=acme", server);
    await screen.findByRole("group", { name: "Networks for people" });
    expect(screen.queryByText(/keep working from any network/)).toBeNull();
    fireEvent.click(
      group("Networks for people").getByRole("radio", { name: "Only these networks" }),
    );
    expect(
      screen.getByText(
        "2 service tokens keep working from any network. Set a list for service tokens to limit them too",
      ),
    ).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Allowed IP addresses and ranges" }), {
      target: { value: "192.0.2.0/24\n2001:db8::/32" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save policies" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("2 service tokens keep working from any network");
  });
});
