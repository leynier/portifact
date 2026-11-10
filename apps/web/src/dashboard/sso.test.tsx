// @vitest-environment happy-dom
// The Single sign-on section of a workspace's Members page (premium plan E1, decision 0016): set
// up with the redirect URI to register, the issuer check in plain words, the plan note, a lapsed
// domain, removal after confirmation, admins only, and nothing at all while switched off.
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeServer, fakeServer, renderDashboard, workspace } from "./test-support.tsx";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

const verified = (domain: string) => ({
  id: `wd_${"1".repeat(32)}`,
  domain,
  unicode: null,
  state: "verified" as const,
  record: { name: `_portifact-email.${domain}`, value: `portifact-email-verify=${"1".repeat(32)}` },
  createdAt: "2026-11-01T12:00:00.000Z",
  verifiedAt: "2026-11-01T12:00:00.000Z",
  checkedAt: "2026-11-09T12:00:00.000Z",
  expiresAt: null,
  failedChecks: 0,
  problem: null,
});

let server: FakeServer;
beforeEach(() => {
  server = fakeServer([]);
  server.workspaces.acme = workspace("acme", "admin", {
    name: "Acme",
    domains: [verified("acme.com")],
    sso: { enabled: true, available: true, provider: null },
  });
});

const region = () => screen.findByRole("region", { name: "Single sign-on" }, { timeout: 10_000 });

describe("the Single sign-on section", () => {
  it.each(["light", "dark"])(
    "sets up a provider, checks the issuer and shows the redirect URI (%s theme)",
    async (theme) => {
      document.documentElement.dataset.theme = theme;
      const { container } = renderDashboard("/members?workspace=acme", server);
      const panel = await region();
      expect(within(panel).getByText("Not set up")).toBeTruthy();
      expect(panel.textContent).toContain(
        "Someone an admin removes cannot rejoin through single sign-on until an admin invites them again",
      );
      expect(panel.textContent).toContain("https://app.portifact.com/api/auth/sso/callback/<id>");
      expect(await axeViolations(container)).toEqual([]);

      fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
      expect(await within(panel).findByText("Enter the issuer URL.")).toBeTruthy();

      fireEvent.change(within(panel).getByRole("textbox", { name: "Issuer URL" }), {
        target: { value: "https://broken.example.com" },
      });
      fireEvent.click(within(panel).getByRole("button", { name: "Check the issuer" }));
      expect(await within(panel).findByText("Discovery failed")).toBeTruthy();
      expect(panel.textContent).toContain("The discovery document names a different issuer.");

      fireEvent.change(within(panel).getByRole("textbox", { name: "Issuer URL" }), {
        target: { value: "https://login.acme.com" },
      });
      fireEvent.click(within(panel).getByRole("button", { name: "Check the issuer" }));
      expect(await within(panel).findByText("Discovery works")).toBeTruthy();
      fireEvent.change(within(panel).getByRole("textbox", { name: "Client ID" }), {
        target: { value: "portifact" },
      });
      fireEvent.change(within(panel).getByLabelText("Client secret"), {
        target: { value: "s3cret" },
      });
      fireEvent.click(within(panel).getByRole("checkbox", { name: "acme.com" }));
      fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
      expect(await within(panel).findByText("On")).toBeTruthy();
      await waitFor(() =>
        expect(server.bodies.at(-1)).toEqual({
          issuer: "https://login.acme.com",
          clientId: "portifact",
          clientSecret: "s3cret",
          domains: ["acme.com"],
        }),
      );
      expect(panel.textContent).toContain(
        `https://app.portifact.com/api/auth/sso/callback/sso_${"5".repeat(32)}`,
      );
      expect((within(panel).getByLabelText("Client secret") as HTMLInputElement).value).toBe("");
      expect(await axeViolations(container)).toEqual([]);
    },
  );

  it("says what a refused save means", async () => {
    renderDashboard("/members?workspace=acme", server);
    const panel = await region();
    fireEvent.change(within(panel).getByRole("textbox", { name: "Issuer URL" }), {
      target: { value: "https://broken.example.com" },
    });
    fireEvent.change(within(panel).getByRole("textbox", { name: "Client ID" }), {
      target: { value: "c" },
    });
    fireEvent.change(within(panel).getByLabelText("Client secret"), { target: { value: "s" } });
    fireEvent.click(within(panel).getByRole("checkbox", { name: "acme.com" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
    expect(await within(panel).findByText("The change was not saved")).toBeTruthy();
    expect(panel.textContent).toContain("Check the issuer, the client and the domains.");
  });

  it("explains the plan, a lapsed domain, and removes the provider after confirmation", async () => {
    const acme = server.workspaces.acme;
    if (!acme) throw new Error("no workspace");
    acme.sso.available = false;
    acme.domains = [];
    acme.sso.provider = {
      id: `sso_${"5".repeat(32)}`,
      issuer: "https://login.acme.com",
      clientId: "portifact",
      domains: ["acme.com"],
      lapsedDomains: [],
      hasClientSecret: true,
      redirectUri: `https://app.portifact.com/api/auth/sso/callback/sso_${"5".repeat(32)}`,
      createdAt: "2026-11-01T12:00:00.000Z",
      updatedAt: "2026-11-01T12:00:00.000Z",
    };
    renderDashboard("/members?workspace=acme", server);
    const panel = await region();
    expect(within(panel).getByText("Paused: not on this plan")).toBeTruthy();
    expect(panel.textContent).toContain("Single sign-on is part of the Enterprise plan.");
    expect(panel.textContent).toContain("acme.com is no longer verified");
    expect(within(panel).getByText("Verify an email domain above first.")).toBeTruthy();
    expect(
      (within(panel).getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(within(panel).getByRole("button", { name: "Remove single sign-on" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove single sign-on?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await within(panel).findByText("Not set up")).toBeTruthy();
  });

  it("is hidden while switched off, and from editors", async () => {
    const acme = server.workspaces.acme;
    if (acme) acme.sso.enabled = false;
    renderDashboard("/members?workspace=acme", server);
    await screen.findByRole("region", { name: "Email domains" }, { timeout: 10_000 });
    await waitFor(() => expect(server.requests.some((r) => r.path.endsWith("/sso"))).toBe(true));
    expect(screen.queryByRole("region", { name: "Single sign-on" })).toBeNull();
    cleanup();

    server = fakeServer([]);
    server.workspaces.acme = workspace("acme", "editor", {
      name: "Acme",
      sso: { enabled: true, available: true, provider: null },
    });
    renderDashboard("/members?workspace=acme", server);
    await screen.findByRole("heading", { name: "Members" });
    await screen.findAllByRole("listitem");
    expect(screen.queryByRole("region", { name: "Single sign-on" })).toBeNull();
    expect(server.requests.some((r) => r.path.endsWith("/sso"))).toBe(false);
  });
});
