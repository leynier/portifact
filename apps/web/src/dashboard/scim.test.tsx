// @vitest-environment happy-dom
// The Directory sync (SCIM) section of a workspace's Members page (premium plan E2, decision
// 0017): the base URL to paste, a token created with its secret shown once and revoked after
// confirmation, the invitation email setting, the plan note, pending directory people listed with
// the invitations, admins only, and nothing at all while switched off.
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeServer, fakeServer, renderDashboard, workspace } from "./test-support.tsx";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

let server: FakeServer;
beforeEach(() => {
  server = fakeServer([]);
  server.workspaces.acme = workspace("acme", "admin", {
    name: "Acme",
    scim: { enabled: true, available: true, tokens: [], invitationEmails: false, lastSyncAt: null },
    invitations: [
      {
        id: `inv_${"7".repeat(32)}`,
        email: "new@acme.com",
        role: "member",
        invitedBy: null,
        createdAt: "2026-11-10T12:00:00.000Z",
        expiresAt: "2027-02-08T12:00:00.000Z",
        source: "directory",
      },
    ],
  });
});

const region = () =>
  screen.findByRole("region", { name: "Directory sync (SCIM)" }, { timeout: 10_000 });

describe("the Directory sync section", () => {
  it.each(["light", "dark"])(
    "creates a token, shows its secret once and revokes it (%s theme)",
    async (theme) => {
      document.documentElement.dataset.theme = theme;
      const { container } = renderDashboard("/members?workspace=acme", server);
      const panel = await region();
      expect(panel.textContent).toContain("https://app.portifact.com/scim/v2");
      expect(panel.textContent).toContain("The directory has not called yet.");
      expect(panel.textContent).toContain("1 person, listed with the pending invitations");
      expect(panel.textContent).toContain("No token yet.");
      expect(await axeViolations(container)).toEqual([]);

      fireEvent.click(within(panel).getByRole("button", { name: "Create a SCIM token" }));
      expect(
        await within(panel).findByText("Enter a label of at most 80 characters."),
      ).toBeTruthy();
      fireEvent.change(within(panel).getByRole("textbox", { name: "Label" }), {
        target: { value: "Okta" },
      });
      fireEvent.click(within(panel).getByRole("button", { name: "Create a SCIM token" }));
      expect(await within(panel).findByText("Copy the token now")).toBeTruthy();
      await waitFor(() =>
        expect(server.bodies.at(-1)).toEqual({ label: "Okta", expiresInDays: 365 }),
      );
      expect(within(panel).getByRole("button", { name: "Copy token" })).toBeTruthy();
      expect(await axeViolations(container)).toEqual([]);
      fireEvent.click(within(panel).getByRole("button", { name: "I saved it" }));
      await waitFor(() => expect(within(panel).queryByText("Copy the token now")).toBeNull());

      fireEvent.click(await within(panel).findByRole("button", { name: "Revoke: Okta" }));
      const dialog = await screen.findByRole("dialog", { name: "Revoke Okta?" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Revoke token" }));
      expect(await within(panel).findByText("No token yet.")).toBeTruthy();
    },
  );

  it("turns the invitation emails on and lists provisioned people as from the directory", async () => {
    renderDashboard("/members?workspace=acme", server);
    const panel = await region();
    const box = within(panel).getByRole("checkbox", {
      name: /Email the invitation to people the directory provisions/,
    }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(server.bodies.at(-1)).toEqual({ invitationEmails: true }));
    await waitFor(() => expect(box.checked).toBe(true));
    const pending = await screen.findByRole("list", { name: "Pending invitations" });
    expect(within(pending).getByText("From the directory")).toBeTruthy();
    expect(pending.textContent).toContain("provisioned by the directory: joins at first sign-in");
  });

  it("explains the plan and the token limit", async () => {
    const acme = server.workspaces.acme;
    if (!acme) throw new Error("no workspace");
    acme.scim.available = false;
    acme.scim.lastSyncAt = "2026-11-10T12:00:00.000Z";
    acme.scim.tokens = [1, 2].map((n) => ({
      id: `sc_${String(n).padStart(32, "0")}`,
      label: `Token ${n}`,
      createdAt: "2026-11-01T12:00:00.000Z",
      expiresAt: "2026-11-05T12:00:00.000Z",
      lastUsedAt: n === 1 ? "2026-11-04T12:00:00.000Z" : null,
      createdBy: null,
      expired: n === 1,
    }));
    renderDashboard("/members?workspace=acme", server);
    const panel = await region();
    expect(panel.textContent).toContain("Directory sync needs the Enterprise plan.");
    expect(panel.textContent).toContain("A workspace has at most 2 SCIM tokens");
    expect(panel.textContent).toContain("Expired on");
    expect(panel.textContent).toContain("never used");
    expect(panel.textContent).not.toContain("The directory has not called yet.");
    expect(
      (within(panel).getByRole("button", { name: "Create a SCIM token" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("says when an action fails", async () => {
    const acme = server.workspaces.acme;
    if (!acme) throw new Error("no workspace");
    renderDashboard("/members?workspace=acme", server);
    const panel = await region();
    acme.scim.tokens = [];
    acme.scim.available = false;
    fireEvent.change(within(panel).getByRole("textbox", { name: "Label" }), {
      target: { value: "Okta" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Create a SCIM token" }));
    expect(await within(panel).findByText("The change was not saved")).toBeTruthy();
  });

  it("is hidden while switched off, and from editors", async () => {
    const acme = server.workspaces.acme;
    if (acme) acme.scim.enabled = false;
    renderDashboard("/members?workspace=acme", server);
    await screen.findByRole("region", { name: "Email domains" }, { timeout: 10_000 });
    await waitFor(() => expect(server.requests.some((r) => r.path.endsWith("/scim"))).toBe(true));
    expect(screen.queryByRole("region", { name: "Directory sync (SCIM)" })).toBeNull();
    cleanup();

    server = fakeServer([]);
    server.workspaces.acme = workspace("acme", "editor", {
      name: "Acme",
      scim: {
        enabled: true,
        available: true,
        tokens: [],
        invitationEmails: false,
        lastSyncAt: null,
      },
    });
    renderDashboard("/members?workspace=acme", server);
    await screen.findByRole("heading", { name: "Members" });
    await screen.findAllByRole("listitem");
    expect(screen.queryByRole("region", { name: "Directory sync (SCIM)" })).toBeNull();
    expect(server.requests.some((r) => r.path.endsWith("/scim"))).toBe(false);
  });
});
