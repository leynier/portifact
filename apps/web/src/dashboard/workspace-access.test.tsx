// @vitest-environment happy-dom
// Sharing with the workspace or its email domains (premium plan T2, decision 0010): the two modes
// in a workspace artifact's access settings with who they reach right now, what a lapsed plan
// says, and the Domains section of the Members page for admins.
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  artifact,
  type FakeServer,
  fakeServer,
  renderDashboard,
  workspace,
} from "./test-support.tsx";

afterEach(cleanup);

const ID = "w2w2w2w2w2";
let server: FakeServer;
beforeEach(() => {
  server = fakeServer([
    artifact("p2p2p2p2p2", { name: "Personal notes" }),
    artifact(ID, {
      name: "Team report",
      owner: { kind: "workspace", slug: "acme", name: "Acme" },
    }),
  ]);
  server.workspaces.acme = workspace("acme", "admin", { name: "Acme" });
});

const accessRegion = () => screen.findByRole("region", { name: "Access" }, { timeout: 10_000 });
const radio = (name: string) => screen.getByRole("radio", { name }) as HTMLInputElement;

const verifiedDomain = {
  id: `wd_${"1".repeat(32)}`,
  domain: "acme.com",
  unicode: null,
  state: "verified" as const,
  record: { name: "_portifact-email.acme.com", value: `portifact-email-verify=${"1".repeat(32)}` },
  createdAt: "2026-11-01T12:00:00.000Z",
  verifiedAt: "2026-11-01T12:00:00.000Z",
  checkedAt: "2026-11-09T12:00:00.000Z",
  expiresAt: null,
  failedChecks: 0,
  problem: null,
};

describe("the workspace modes in the access settings", () => {
  it("offers them only on workspace artifacts, with who they reach", async () => {
    const acme = server.workspaces.acme;
    if (acme) acme.domains = [verifiedDomain];
    const { container } = renderDashboard(`/artifacts/${ID}?workspace=acme`, server);
    const region = await accessRegion();
    await within(region).findByRole("group", { name: "Who can open this artifact" });
    expect(radio("Everyone in the workspace").disabled).toBe(false);
    expect(radio("The workspace and its email domains").disabled).toBe(false);
    expect(region.textContent).toContain("The 1 member of this workspace, after signing in");
    expect(region.textContent).toContain("verified address at acme.com");
    expect(region.textContent).toContain(
      "The people listed below can open it only while it is restricted.",
    );
    expect(await axeViolations(container)).toEqual([]);

    fireEvent.click(radio("The workspace and its email domains"));
    fireEvent.click(screen.getByRole("button", { name: "Save access" }));
    await waitFor(() => expect(server.bodies.at(-1)).toEqual({ mode: "domain" }));
  });

  it("does not offer them on a personal artifact", async () => {
    renderDashboard("/artifacts/p2p2p2p2p2", server);
    const region = await accessRegion();
    await within(region).findByRole("group", { name: "Who can open this artifact" });
    expect(within(region).queryByRole("radio", { name: "Everyone in the workspace" })).toBeNull();
  });

  it("keeps the domain mode unavailable until a domain is verified", async () => {
    renderDashboard(`/artifacts/${ID}?workspace=acme`, server);
    const region = await accessRegion();
    await within(region).findByRole("group", { name: "Who can open this artifact" });
    expect(radio("The workspace and its email domains").disabled).toBe(true);
    expect(region.textContent).toContain("No domain is verified yet");
  });

  it("says plainly when a lapsed plan leaves only members reading", async () => {
    const acme = server.workspaces.acme;
    if (acme) {
      acme.domains = [verifiedDomain];
      acme.domainsAvailable = false;
    }
    const target = server.artifacts.find((a) => a.id === ID);
    if (target) target.accessMode = "domain";
    const { container } = renderDashboard(`/artifacts/${ID}?workspace=acme`, server);
    const region = await accessRegion();
    expect(
      await within(region).findByText("Only members can open this artifact for now"),
    ).toBeTruthy();
    expect(radio("The workspace and its email domains").checked).toBe(true);
    expect(radio("Everyone in the workspace").disabled).toBe(true);
    expect(region.textContent).toContain("Part of the Team plan.");
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("the Domains section of the Members page", () => {
  const domains = () => screen.findByRole("region", { name: "Email domains" }, { timeout: 10_000 });

  it("adds a domain, shows the record to copy and verifies it", async () => {
    const { container } = renderDashboard("/members?workspace=acme", server);
    const region = await domains();
    expect(await within(region).findByText("No email domain yet.")).toBeTruthy();
    fireEvent.change(within(region).getByRole("textbox", { name: "Domain" }), {
      target: { value: "gmail.com" },
    });
    fireEvent.click(within(region).getByRole("button", { name: "Add domain" }));
    expect(await within(region).findByText(/This domain cannot be added/)).toBeTruthy();
    fireEvent.change(within(region).getByRole("textbox", { name: "Domain" }), {
      target: { value: "acme.com" },
    });
    fireEvent.click(within(region).getByRole("button", { name: "Add domain" }));
    const list = await within(region).findByRole("list", { name: "Email domains" });
    expect(within(list).getByText("Waiting for the DNS record")).toBeTruthy();
    expect(within(list).getByText("_portifact-email.acme.com")).toBeTruthy();
    expect(within(list).getAllByRole("button", { name: "Copy" }).length).toBeGreaterThan(0);
    expect(await axeViolations(container)).toEqual([]);

    fireEvent.click(within(list).getByRole("button", { name: "Verify acme.com" }));
    expect(await within(region).findByText("The change was not saved")).toBeTruthy();
    expect(region.textContent).toContain(
      "The TXT record was not found with this domain's value yet.",
    );
    const acme = server.workspaces.acme;
    if (acme) acme.dns["_portifact-email.acme.com"] = [`portifact-email-verify=${"0".repeat(31)}1`];
    fireEvent.click(within(list).getByRole("button", { name: "Verify acme.com" }));
    expect(await within(region).findByText("Verified")).toBeTruthy();
  });

  it("warns while a verified domain is failing and removes it after confirmation", async () => {
    const acme = server.workspaces.acme;
    if (acme) acme.domains = [{ ...verifiedDomain, failedChecks: 2, problem: "txt_missing" }];
    renderDashboard("/members?workspace=acme", server);
    const region = await domains();
    expect(await within(region).findByText("The DNS record is missing")).toBeTruthy();
    expect(region.textContent).toContain("After 1 more missed check the domain is removed.");
    fireEvent.click(within(region).getByRole("button", { name: "Remove acme.com" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove acme.com?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove domain" }));
    expect(await within(region).findByText("No email domain yet.")).toBeTruthy();
  });

  it("is shown to admins only", async () => {
    server.workspaces.acme = workspace("acme", "editor", { name: "Acme" });
    renderDashboard("/members?workspace=acme", server);
    await screen.findByRole("heading", { name: "Members" });
    await screen.findAllByRole("listitem");
    expect(screen.queryByRole("region", { name: "Email domains" })).toBeNull();
    expect(server.requests.some((r) => r.path.includes("/domains"))).toBe(false);
  });
});
