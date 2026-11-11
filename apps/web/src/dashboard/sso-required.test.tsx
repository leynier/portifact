// @vitest-environment happy-dom
// "SSO required" in the dashboard (decision 0021): admins require single sign-on on the Policies
// page only once the provider works and their own session went through it, confirming the
// members it cuts off; members read it; nothing is shown without single sign-on; and a workspace
// that refuses this browser's sign-in shows one page whose action signs in through the provider
// and comes back.
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
const sso = () => within(screen.getByRole("group", { name: "Single sign-on" }));
const REQUIRED: WorkspacePolicy = { ...DEFAULT_POLICY, ssoRequired: true };

function acme(
  role: "admin" | "member",
  options: {
    policy?: WorkspacePolicy;
    ssoState?: { usable: boolean; yourSession: boolean } | null;
    ssoOutside?: number;
    blockedBy?: "sso" | null;
  } = {},
) {
  server.workspaces.acme = workspace("acme", role, {
    name: "Acme",
    policy: options.policy ?? DEFAULT_POLICY,
    blocked: (options.blockedBy ?? null) !== null,
    blockedBy: options.blockedBy ?? null,
    ssoState:
      options.ssoState === undefined ? { usable: true, yourSession: true } : options.ssoState,
    ssoOutside: options.ssoOutside ?? 0,
  });
}

describe("SSO required on the Policies page", () => {
  it("lets an admin who signed in through the provider require it after confirming who it cuts off", async () => {
    acme("admin", { ssoOutside: 2 });
    const { container } = renderDashboard("/policies?workspace=acme", server);
    await screen.findByRole("group", { name: "Single sign-on" });
    expect(screen.getAllByText(/Admins are bound too/).length).toBeGreaterThan(0);
    fireEvent.click(sso().getByRole("radio", { name: /Only through single sign-on/ }));
    await themes(container);
    fireEvent.click(screen.getByRole("button", { name: "Save policies" }));
    const dialog = await screen.findByRole("dialog", { name: "Require single sign-on?" });
    expect(dialog.textContent).toContain(
      "2 members' addresses are not at a domain the provider serves",
    );
    expect(dialog.textContent).toContain("Nobody is signed out");
    await themes(container);
    expect(puts()).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Require single sign-on" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(server.bodies.at(-1)).toEqual({
      policy: REQUIRED,
      revision: 0,
      confirmedOutsideProvider: 2,
    });
  });

  it("offers the sign-in through the provider before an admin may require it", async () => {
    acme("admin", { ssoState: { usable: true, yourSession: false } });
    const { container } = renderDashboard("/policies?workspace=acme", server);
    await screen.findByRole("group", { name: "Single sign-on" });
    const only = sso().getByRole("radio", {
      name: /Only through single sign-on/,
    }) as HTMLInputElement;
    expect(only.disabled).toBe(true);
    const action = screen.getByRole("link", { name: "Sign in with single sign-on" });
    const target = new URL(action.getAttribute("href") ?? "", "https://app.portifact.com");
    expect(target.pathname).toBe("/login");
    expect(target.searchParams.get("reauth")).toBe("sso");
    expect(target.searchParams.get("next")).toBe("/policies?workspace=acme");
    await themes(container);
  });

  it("explains that a provider is needed first, and that a lapsed one suspends it", async () => {
    acme("admin", { ssoState: { usable: false, yourSession: false } });
    renderDashboard("/policies?workspace=acme", server);
    await screen.findByRole("group", { name: "Single sign-on" });
    expect(screen.getByText(/Set up single sign-on first/)).toBeTruthy();
    cleanup();
    acme("admin", { policy: REQUIRED, ssoState: { usable: false, yourSession: false } });
    const { container } = renderDashboard("/policies?workspace=acme", server);
    await screen.findByRole("group", { name: "Single sign-on" });
    expect(screen.getByText(/the requirement is not applied until it can/)).toBeTruthy();
    // It can always be lifted, without a confirmation.
    fireEvent.click(sso().getByRole("radio", { name: "Any sign-in" }));
    fireEvent.click(screen.getByRole("button", { name: "Save policies" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(server.bodies.at(-1)).toEqual({ policy: DEFAULT_POLICY, revision: 0 });
    await themes(container);
  });

  it("shows nothing about it where single sign-on is off, and members only read it", async () => {
    acme("admin", { ssoState: null });
    renderDashboard("/policies?workspace=acme", server);
    await screen.findByRole("group", { name: "Session length" });
    expect(screen.queryByRole("group", { name: "Single sign-on" })).toBeNull();
    cleanup();
    acme("member", { policy: REQUIRED, ssoState: null });
    const { container } = renderDashboard("/policies?workspace=acme", server);
    expect(
      await screen.findByText(
        "People sign in through this workspace's single sign-on to act on it.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /Only through single sign-on/ })).toBeNull();
    await themes(container);
  });
});

describe("a workspace that requires signing in through its single sign-on", () => {
  it("shows one page whose action signs in through the provider and comes back", async () => {
    acme("member", { policy: REQUIRED, ssoState: null, blockedBy: "sso" });
    const { container } = renderDashboard("/?workspace=acme", server);
    expect(
      await screen.findByRole("heading", { name: "Sign in with single sign-on to continue" }),
    ).toBeTruthy();
    expect(container.textContent).toContain("Acme requires signing in through its single sign-on");
    expect(container.textContent).toContain("your other spaces keep working");
    const action = screen.getByRole("link", { name: "Sign in with single sign-on" });
    const target = new URL(action.getAttribute("href") ?? "", "https://app.portifact.com");
    expect(target.pathname).toBe("/login");
    expect(target.searchParams.get("reauth")).toBe("sso");
    expect(target.searchParams.get("next")).toBe("/?workspace=acme");
    expect(screen.getByRole("link", { name: "Go to your personal space" })).toBeTruthy();
    expect(server.requests.some((r) => r.path.startsWith("/api/v1/artifacts"))).toBe(false);
    await themes(container);
  });
});

describe("how each session and app signed in", () => {
  it("shows the method beside each browser and connected app", async () => {
    const { container } = renderDashboard("/profile", server);
    const table = await screen.findByRole("table", { name: "Browsers signed in to your account" });
    expect(within(table).getAllByText("Email code").length).toBeGreaterThan(0);
    await themes(container);
  });
});
