// @vitest-environment happy-dom
// The "Share links" group of the sharing settings (decision 0008): create with the URL shown once
// and a copy button, list without URLs, revoke after a confirmation, and an explanation instead
// of the form for an owner whose plan does not include share links.
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXPIRY_CHOICES, expiryFor } from "./screens/share-links.tsx";
import { artifact, type FakeServer, fakeServer, renderDashboard } from "./test-support.tsx";

afterEach(cleanup);

const ID = "k7d2qm4xab";
const PATH = `/artifacts/${ID}`;
const URL_SHOWN = `https://app.portifact.com/s#${"T".repeat(43)}`;

let server: FakeServer;
beforeEach(() => {
  server = fakeServer([artifact(ID, { name: "Launch plan" })]);
});

const region = () => screen.findByRole("region", { name: "Share links" }, { timeout: 10_000 });

describe("share links", () => {
  it("creates a link, shows its URL once with a copy button, and lists it without the URL", async () => {
    const { container } = renderDashboard(PATH, server);
    const panel = await region();
    await within(panel).findByText("No share links yet.");
    fireEvent.change(within(panel).getByRole("textbox", { name: "Label" }), {
      target: { value: "For the board" },
    });
    fireEvent.change(within(panel).getByLabelText("Password (optional)", { exact: false }), {
      target: { value: "correct horse" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Create link" }));

    await within(panel).findByText('Link "For the board" created');
    expect(panel.textContent).toContain(URL_SHOWN);
    expect(panel.textContent).toContain("it is shown only this once");
    expect(within(panel).getByRole("button", { name: "Copy link" })).toBeTruthy();
    const body = server.bodies.at(-1) as Record<string, unknown>;
    expect(body).toMatchObject({ label: "For the board", password: "correct horse" });
    expect(typeof body.expiresAt).toBe("string");

    const list = await within(panel).findByRole("list", { name: "Share links of this artifact" });
    expect(list.textContent).toContain("For the board");
    expect(list.textContent).toContain("Password");
    expect(list.textContent).not.toContain("#");
    expect(await axeViolations(container)).toEqual([]);

    fireEvent.click(within(panel).getByRole("button", { name: "Done" }));
    expect(panel.textContent).not.toContain(URL_SHOWN);
  });

  it("asks for a label and a long enough password before sending", async () => {
    renderDashboard(PATH, server);
    const panel = await region();
    await within(panel).findByText("No share links yet.");
    fireEvent.click(within(panel).getByRole("button", { name: "Create link" }));
    await within(panel).findByText("Give the link a label of 1 to 80 characters.");
    fireEvent.change(within(panel).getByRole("textbox", { name: "Label" }), {
      target: { value: "x" },
    });
    fireEvent.change(within(panel).getByLabelText("Password (optional)", { exact: false }), {
      target: { value: "short" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Create link" }));
    await within(panel).findByText("Use at least 8 characters, or leave it empty.");
    expect(server.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("revokes a link only after the confirmation", async () => {
    server.shareLinks[ID] = [
      {
        id: `sl_${"1".padStart(32, "0")}`,
        label: "Board",
        state: "active",
        hasPassword: false,
        createdAt: "2026-11-01T00:00:00.000Z",
        expiresAt: null,
        lastUsedOn: "2026-11-09",
      },
    ];
    renderDashboard(PATH, server);
    const panel = await region();
    const list = await within(panel).findByRole("list", { name: "Share links of this artifact" });
    expect(list.textContent).toContain("No expiry");
    expect(list.textContent).toContain("Last used");
    fireEvent.click(within(panel).getByRole("button", { name: "Revoke the link Board" }));
    const dialog = await screen.findByRole("dialog", { name: 'Revoke "Board"?' });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(server.requests.some((r) => r.method === "DELETE")).toBe(false);

    fireEvent.click(within(panel).getByRole("button", { name: "Revoke the link Board" }));
    const again = await screen.findByRole("dialog", { name: 'Revoke "Board"?' });
    fireEvent.click(within(again).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(server.requests.some((r) => r.method === "DELETE")).toBe(true));
    await within(panel).findByText("No share links yet.");
  });

  it("explains that share links are part of a paid plan, with no form and no upgrade button", async () => {
    server.shareLinksEnabled = false;
    renderDashboard(PATH, server);
    const panel = await region();
    await within(panel).findByText("Share links are part of a paid plan");
    expect(within(panel).queryByRole("button", { name: "Create link" })).toBeNull();
    expect(panel.textContent).not.toMatch(/upgrade|checkout/i);
  });

  it("says existing links are paused, not deleted, when the plan no longer has them", async () => {
    server.shareLinksEnabled = false;
    server.shareLinks[ID] = [
      {
        id: `sl_${"2".padStart(32, "0")}`,
        label: "Old",
        state: "active",
        hasPassword: true,
        createdAt: "2026-11-01T00:00:00.000Z",
        expiresAt: "2026-12-01T00:00:00.000Z",
        lastUsedOn: null,
      },
    ];
    renderDashboard(PATH, server);
    const panel = await region();
    await within(panel).findByText(/so these links do not open/);
    expect(panel.textContent).toContain("They are kept and work again");
    expect(within(panel).getByRole("button", { name: "Revoke the link Old" })).toBeTruthy();
  });
});

describe("expiryFor", () => {
  it("adds the chosen days, or none for never", () => {
    const now = Date.parse("2026-11-10T12:00:00Z");
    expect(expiryFor("never", now)).toBeUndefined();
    expect(expiryFor("7", now)).toBe("2026-11-17T12:00:00.000Z");
    expect(EXPIRY_CHOICES).toEqual(["never", "1", "7", "30", "90", "365"]);
  });
});
