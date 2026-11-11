// @vitest-environment happy-dom
// A workspace's sign-in policies in the dashboard (decision 0021): admins set a maximum session
// age and the kinds of app allowed to act on the Policies page and confirm who they bind, every
// member reads them, and a workspace that asks this browser to sign in again shows one page with
// the action that does it and comes back.
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
  blockedBy: "session_age" | null = null,
) {
  server.workspaces.acme = workspace("acme", role, {
    name: "Acme",
    policy,
    blocked: blockedBy !== null,
    blockedBy,
  });
}

describe("the sign-in policies on the Policies page", () => {
  it("lets an admin set a session length after seeing who it binds", async () => {
    acme("admin");
    const { container } = renderDashboard("/policies?workspace=acme", server);
    await screen.findByRole("group", { name: "Session length" });
    expect(screen.getByText(/You signed in 3 hours ago/)).toBeTruthy();
    expect(screen.getByText(/Service tokens have no sign-in and are not bound/)).toBeTruthy();
    fireEvent.click(group("Session length").getByRole("radio", { name: "Ask for a new sign-in" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Hours after signing in" }), {
      target: { value: "12" },
    });
    await themes(container);
    fireEvent.click(screen.getByRole("button", { name: "Save policies" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Change how people sign in to this workspace?",
    });
    expect(dialog.textContent).toMatch(/\d+ members? will be bound/);
    expect(dialog.textContent).toContain("1 member has no sign-in younger than the limit");
    expect(dialog.textContent).toContain("Nobody is signed out");
    await themes(container);
    expect(puts()).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(server.bodies.at(-1)).toEqual({
      policy: { ...DEFAULT_POLICY, sessionMaxHours: 12 },
      revision: 0,
    });
  });

  it("checks the hours before any request", async () => {
    acme("admin");
    renderDashboard("/policies?workspace=acme", server);
    await screen.findByRole("group", { name: "Session length" });
    fireEvent.click(group("Session length").getByRole("radio", { name: "Ask for a new sign-in" }));
    for (const value of ["0", "721", "1.5", ""]) {
      fireEvent.change(screen.getByRole("textbox", { name: "Hours after signing in" }), {
        target: { value },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save policies" }));
      expect(
        await screen.findByText("Write a whole number of hours between 1 and 720."),
      ).toBeTruthy();
    }
    expect(server.requests.some((r) => r.path.endsWith("/policies/preview"))).toBe(false);
  });

  it("lets an admin allow only the CLI, keeping the dashboard always on", async () => {
    acme("admin");
    const { container } = renderDashboard("/policies?workspace=acme", server);
    await screen.findByRole("group", { name: "Apps that may act" });
    expect(screen.getByText(/never by name/)).toBeTruthy();
    fireEvent.click(
      group("Apps that may act").getByRole("radio", { name: "Only the apps chosen here" }),
    );
    const dashboard = screen.getByRole("checkbox", { name: "The dashboard (always allowed)" });
    expect((dashboard as HTMLInputElement).checked).toBe(true);
    expect((dashboard as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Other connected apps" }));
    await themes(container);
    fireEvent.click(screen.getByRole("button", { name: "Save policies" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Change how people sign in to this workspace?",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(server.bodies.at(-1)).toEqual({
      policy: { ...DEFAULT_POLICY, allowedClients: ["cli"] },
      revision: 0,
    });
  });

  it("saves loosening without a confirmation", async () => {
    acme("admin", { ...DEFAULT_POLICY, sessionMaxHours: 8, allowedClients: [] });
    renderDashboard("/policies?workspace=acme", server);
    await screen.findByRole("group", { name: "Session length" });
    fireEvent.click(group("Session length").getByRole("radio", { name: "No limit" }));
    fireEvent.click(group("Apps that may act").getByRole("radio", { name: "Every app" }));
    fireEvent.click(screen.getByRole("button", { name: "Save policies" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(server.bodies.at(-1)).toEqual({ policy: DEFAULT_POLICY, revision: 0 });
  });

  it("shows them read-only to other members, without the admin's own sign-in", async () => {
    acme("member", { ...DEFAULT_POLICY, sessionMaxHours: 8, allowedClients: ["cli"] });
    const { container } = renderDashboard("/policies?workspace=acme", server);
    await screen.findByRole("group", { name: "Session length" });
    expect(
      (screen.getByRole("textbox", { name: "Hours after signing in" }) as HTMLInputElement).value,
    ).toBe("8");
    expect(
      (screen.getByRole("checkbox", { name: "The Portifact CLI" }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(screen.queryByText(/You signed in/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Save policies" })).toBeNull();
    await themes(container);
  });
});

describe("a workspace that asks this browser to sign in again", () => {
  it("shows one page whose action signs in again and comes back", async () => {
    acme("member", { ...DEFAULT_POLICY, sessionMaxHours: 8 }, "session_age");
    const { container } = renderDashboard("/?workspace=acme", server);
    expect(await screen.findByRole("heading", { name: "Sign in again to continue" })).toBeTruthy();
    expect(container.textContent).toContain("Acme asks for a new sign-in after a while");
    const action = screen.getByRole("link", { name: "Sign in again" });
    const target = new URL(action.getAttribute("href") ?? "", "https://app.portifact.com");
    expect(target.pathname).toBe("/login");
    expect(target.searchParams.get("reauth")).toBe("session_age");
    expect(target.searchParams.get("next")).toBe("/?workspace=acme");
    expect(screen.getByRole("link", { name: "Go to your personal space" })).toBeTruthy();
    expect(server.requests.some((r) => r.path.startsWith("/api/v1/artifacts"))).toBe(false);
    await themes(container);
  });
});
