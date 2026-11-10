// @vitest-environment happy-dom
// The Service tokens page (premium plan T4, decision 0011): only a workspace's admins see and use
// it; creating shows the secret once, the list shows role, scopes, restriction, expiry and last
// use, revoking asks first, and without the feature in the plan nothing can be created.
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeServer, fakeServer, renderDashboard, workspace } from "./test-support.tsx";

afterEach(cleanup);

let server: FakeServer;
beforeEach(() => {
  server = fakeServer();
});

const nav = () =>
  within(screen.getAllByRole("navigation", { name: "Main", hidden: true })[0] as HTMLElement)
    .getAllByRole("link", { hidden: true })
    .map((link) => link.textContent);

const requested = () =>
  server.requests
    .filter((r) => r.path.includes("/service-tokens"))
    .map((r) => `${r.method} ${r.path}`);

const TOKEN = {
  id: `st_${"1".repeat(32)}`,
  label: "GitHub previews",
  role: "editor" as const,
  scopes: ["artifacts:read" as const, "artifacts:write" as const],
  restriction: { kind: "key" as const, prefix: "pr-" },
  createdAt: "2026-11-01T12:00:00.000Z",
  expiresAt: "2027-01-30T12:00:00.000Z",
  lastUsedAt: "2026-11-08T11:00:00.000Z",
  createdBy: { name: "Ada" },
  expired: false,
};

describe("the Service tokens page", () => {
  it("is offered to admins of a workspace only", async () => {
    server.workspaces.acme = workspace("acme", "admin", { name: "Acme" });
    server.workspaces.beta = workspace("beta", "editor", { name: "Beta" });
    const admin = renderDashboard("/?workspace=acme", server);
    await waitFor(() => expect(nav()).toContain("Service tokens"));
    admin.unmount();
    cleanup();

    renderDashboard("/?workspace=beta", server);
    await waitFor(() => expect(nav()).toContain("Members"));
    expect(nav()).not.toContain("Service tokens");
    cleanup();

    renderDashboard("/service-tokens?workspace=beta", server);
    expect(await screen.findByText("Only admins manage service tokens")).toBeTruthy();
    cleanup();

    renderDashboard("/service-tokens", server);
    expect(await screen.findByText("Service tokens belong to a workspace")).toBeTruthy();
    expect(requested()).toEqual([]);
  });

  it("lists tokens with their reach and last use, and revokes after a confirmation", async () => {
    server.workspaces.acme = workspace("acme", "admin", {
      name: "Acme",
      serviceTokens: [TOKEN],
    });
    const { container } = renderDashboard("/service-tokens?workspace=acme", server);
    const card = (await screen.findByRole("heading", { name: "GitHub previews" })).closest(
      "li",
    ) as HTMLElement;
    expect(within(card).getByText("Scopes: Read, Publish")).toBeTruthy();
    expect(within(card).getByText("Reaches only keys starting with pr-")).toBeTruthy();
    expect(within(card).getByText(/^Last used/)).toBeTruthy();
    expect(within(card).getByText(/^Created by Ada/)).toBeTruthy();
    for (const colorScheme of ["light", "dark"] as const) {
      document.documentElement.dataset.theme = colorScheme;
      expect(await axeViolations(container), colorScheme).toEqual([]);
    }
    delete document.documentElement.dataset.theme;

    fireEvent.click(within(card).getByRole("button", { name: "Revoke GitHub previews" }));
    const dialog = await screen.findByRole("dialog", { name: "Revoke GitHub previews?" });
    expect(requested()).toEqual(["GET /api/v1/workspaces/acme/service-tokens"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await screen.findByText("No service tokens yet");
    expect(requested()).toContain(`DELETE /api/v1/workspaces/acme/service-tokens/${TOKEN.id}`);
  });

  it("creates a token and shows its secret once, with a copy button", async () => {
    server.workspaces.acme = workspace("acme", "admin", { name: "Acme" });
    const { container } = renderDashboard("/service-tokens?workspace=acme", server);
    await screen.findByText("No service tokens yet");
    const form = (await screen.findByRole("button", { name: "Create token" })).closest(
      "form",
    ) as HTMLElement;
    // Nothing is sent without a label.
    fireEvent.click(within(form).getByRole("button", { name: "Create token" }));
    expect(await within(form).findByText("Enter a label of 1 to 80 characters.")).toBeTruthy();
    expect(requested()).toEqual(["GET /api/v1/workspaces/acme/service-tokens"]);

    fireEvent.change(within(form).getByRole("textbox", { name: /^Label/ }), {
      target: { value: "CI previews" },
    });
    // Share and delete are opt-in.
    const share = within(form).getByRole("checkbox", { name: /^Share/ }) as HTMLInputElement;
    const remove = within(form).getByRole("checkbox", { name: /^Delete/ }) as HTMLInputElement;
    expect(share.checked).toBe(false);
    expect(remove.checked).toBe(false);
    fireEvent.click(remove);
    fireEvent.click(within(form).getByRole("radio", { name: /^Artifacts with a key prefix/ }));
    fireEvent.change(within(form).getByRole("textbox", { name: /^Key prefix/ }), {
      target: { value: "pr-" },
    });
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.click(within(form).getByRole("button", { name: "Create token" }));

    const secret = await screen.findByText("Copy the token now");
    const callout = secret.closest("[role=status]") as HTMLElement;
    expect(within(callout).getByRole("button", { name: "Copy token" })).toBeTruthy();
    expect(callout.textContent).toContain("PORTIFACT_TOKEN");
    const created = server.workspaces.acme?.serviceTokens[0];
    expect(created).toMatchObject({
      label: "CI previews",
      role: "editor",
      scopes: ["artifacts:read", "artifacts:write", "artifacts:delete"],
      restriction: { kind: "key", prefix: "pr-" },
    });
    await screen.findByRole("heading", { name: "CI previews" });
    fireEvent.click(within(callout).getByRole("button", { name: "I saved it" }));
    await waitFor(() => expect(screen.queryByText("Copy the token now")).toBeNull());
  });

  it("says which plan includes tokens and offers no creation without it", async () => {
    server.workspaces.acme = workspace("acme", "admin", {
      name: "Acme",
      serviceTokensAvailable: false,
      serviceTokens: [TOKEN],
    });
    renderDashboard("/service-tokens?workspace=acme", server);
    expect(await screen.findByText("Service tokens are not in this workspace's plan")).toBeTruthy();
    expect(screen.getByText(/part of the Team plan/)).toBeTruthy();
    const submit = screen.getByRole("button", { name: "Create token" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    // Revoking stays possible.
    expect(
      (screen.getByRole("button", { name: "Revoke GitHub previews" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});
