// @vitest-environment happy-dom
// The "Custom domain" group of the sharing settings (decision 0006): adding a hostname, the DNS
// records with copy buttons, the states and problems, "Check again", removal after a
// confirmation, the note about the Portifact bar with its offer to turn it off, and an
// explanation instead of the form for an owner whose plan does not include custom domains or a
// deployment that does not serve them yet.
import type { CustomDomainView } from "@portifact/contracts";
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { artifact, type FakeServer, fakeServer, renderDashboard } from "./test-support.tsx";

afterEach(cleanup);

const ID = "k7d2qm4xab";
const PATH = `/artifacts/${ID}`;
const TOKEN_VALUE = `portifact-verify=${"a".repeat(32)}`;

let server: FakeServer;
beforeEach(() => {
  server = fakeServer([artifact(ID, { name: "Launch plan" })]);
});

const region = () => screen.findByRole("region", { name: "Custom domain" }, { timeout: 10_000 });

function domain(overrides: Partial<CustomDomainView> = {}): CustomDomainView {
  return {
    hostname: "docs.example.com",
    artifactId: ID,
    state: "active",
    records: [
      { type: "TXT", name: "_portifact.docs.example.com", value: TOKEN_VALUE },
      { type: "CNAME", name: "docs.example.com", value: "domains.portifact.dev" },
    ],
    claimExpiresAt: null,
    verifiedAt: "2026-11-09T12:00:00.000Z",
    checkedAt: "2026-11-10T12:00:00.000Z",
    missedChecks: 0,
    problem: null,
    ...overrides,
  };
}

describe("custom domain", () => {
  it("adds a hostname with an idempotency key and shows the records to create with copy buttons", async () => {
    const { container } = renderDashboard(PATH, server);
    const panel = await region();
    fireEvent.change(await within(panel).findByRole("textbox", { name: "Hostname" }), {
      target: { value: " Docs.Example.com " },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Add domain" }));

    await within(panel).findByText("Waiting for DNS");
    expect(server.bodies.at(-1)).toEqual({ hostname: "Docs.Example.com" });
    expect(server.idempotencyKeys.at(-1)?.path).toBe(`/api/v1/artifacts/${ID}/domain`);
    expect(panel.textContent).toContain("Create the two records below");
    expect(panel.textContent).toContain("_portifact.docs.example.com");
    expect(panel.textContent).toContain(TOKEN_VALUE);
    expect(panel.textContent).toContain("domains.portifact.dev");
    expect(within(panel).getAllByRole("button", { name: "Copy" })).toHaveLength(4);
    // The bar is on by default: the note explains it and offers to turn it off.
    expect(panel.textContent).toContain("Visits open in the viewer while the Portifact bar is on");
    expect(within(panel).queryByRole("textbox", { name: "Hostname" })).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("checks a hostname's shape before sending", async () => {
    renderDashboard(PATH, server);
    const panel = await region();
    fireEvent.change(await within(panel).findByRole("textbox", { name: "Hostname" }), {
      target: { value: "https://docs" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Add domain" }));
    await within(panel).findByText("Type a hostname such as docs.example.com.");
    expect(server.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("shows what the check found and checks again", async () => {
    server.domains = [
      domain({
        state: "pending",
        problem: "txt_missing",
        verifiedAt: null,
        claimExpiresAt: "2026-11-17T12:00:00.000Z",
      }),
    ];
    renderDashboard(PATH, server);
    const panel = await region();
    await within(panel).findByText("The TXT record was not found");
    expect(panel.textContent).toContain("Add the records before");
    server.domains = [domain({ state: "provisioning", problem: "certificate_pending" })];
    fireEvent.click(within(panel).getByRole("button", { name: "Check again" }));
    await within(panel).findByText("The certificate is not ready yet");
    expect(
      server.requests.some(
        (r) => r.method === "POST" && r.path === "/api/v1/domains/docs.example.com/verify",
      ),
    ).toBe(true);
  });

  it("warns about missed daily checks on an active domain", async () => {
    server.domains = [domain({ problem: "txt_missing", missedChecks: 2 })];
    renderDashboard(PATH, server);
    const panel = await region();
    await within(panel).findByText(/missing at the last 2 daily checks/);
    expect(panel.textContent).toContain("_portifact.docs.example.com");
  });

  it("turns the bar off only when asked", async () => {
    server.domains = [domain()];
    renderDashboard(PATH, server);
    const panel = await region();
    await within(panel).findByText("Active");
    expect(server.requests.some((r) => r.method === "PATCH")).toBe(false);
    fireEvent.click(within(panel).getByRole("button", { name: "Turn off the bar" }));
    await waitFor(() => expect(server.bodies.at(-1)).toEqual({ bar: false }));
    await waitFor(() =>
      expect(
        within(panel).queryByText("Visits open in the viewer while the Portifact bar is on"),
      ).toBeNull(),
    );
  });

  it("removes the domain only after the confirmation", async () => {
    server.domains = [domain()];
    renderDashboard(PATH, server);
    const panel = await region();
    fireEvent.click(await within(panel).findByRole("button", { name: "Remove domain" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove docs.example.com?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(server.requests.some((r) => r.method === "DELETE")).toBe(false);
    fireEvent.click(within(panel).getByRole("button", { name: "Remove domain" }));
    const again = await screen.findByRole("dialog", { name: "Remove docs.example.com?" });
    fireEvent.click(within(again).getByRole("button", { name: "Remove domain" }));
    await within(panel).findByText("docs.example.com is being removed.");
    // Another hostname can be added while the old one is removed.
    expect(within(panel).getByRole("textbox", { name: "Hostname" })).toBeTruthy();
  });

  it("explains that custom domains are part of a paid plan, with no form and no upgrade button", async () => {
    server.domainsEnabled = false;
    renderDashboard(PATH, server);
    const panel = await region();
    await within(panel).findByText("Custom domains are part of a paid plan");
    expect(within(panel).queryByRole("button", { name: "Add domain" })).toBeNull();
    expect(panel.textContent).not.toMatch(/upgrade|checkout/i);
  });

  it("says custom domains are not available yet where the deployment does not serve them", async () => {
    server.domainsAvailable = false;
    renderDashboard(PATH, server);
    const panel = await region();
    await within(panel).findByText("Custom domains are not available yet");
    expect(within(panel).queryByRole("button", { name: "Add domain" })).toBeNull();
  });

  it("says when the plan's domains are all in use", async () => {
    server.domains = [domain({ artifactId: "abcdefghij" })];
    renderDashboard(PATH, server);
    const panel = await region();
    await within(panel).findByText("Your plan includes 1 custom domain, and it is in use.");
    expect(
      (within(panel).getByRole("button", { name: "Add domain" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
