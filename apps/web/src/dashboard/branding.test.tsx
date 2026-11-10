// @vitest-environment happy-dom
// The Branding page (premium plan P9): the form, the logo and the preview of the bar in both
// themes, what an owner without the feature sees, and accessibility in each state.
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brandUpdate } from "./screens/branding.tsx";
import { type FakeServer, fakeServer, renderDashboard } from "./test-support.tsx";

afterEach(cleanup);

let server: FakeServer;
beforeEach(() => {
  server = fakeServer([]);
});

async function form() {
  const section = await screen.findByRole("region", { name: "Brand" });
  return section;
}

const field = (scope: HTMLElement, name: string) =>
  within(scope).getByRole("textbox", { name: new RegExp(`^${name}`) }) as HTMLInputElement;

describe("Branding page", () => {
  it("is in the navigation, saves the brand and previews it in both themes as it is typed", async () => {
    const { router, container } = renderDashboard("/", server);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    fireEvent.click(within(nav).getByRole("link", { name: "Branding" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/branding"));
    expect(await screen.findByRole("heading", { level: 1, name: "Branding" })).toBeTruthy();
    expect(document.title).toBe("Branding · Portifact");
    const section = await form();
    fireEvent.change(field(section, "Name"), { target: { value: "Acme <b>Labs</b>" } });
    fireEvent.change(field(section, "Link"), { target: { value: "https://acme.example.com" } });
    fireEvent.change(field(section, "Accent color"), { target: { value: "#0000FF" } });

    // The preview follows the form before saving, in a light and a dark copy of the bar.
    const preview = screen.getByRole("region", { name: "Preview" });
    const light = within(preview).getByRole("figure", { name: "Light theme" });
    const dark = within(preview).getByRole("figure", { name: "Dark theme" });
    expect(light.querySelector('[data-theme="light"]')).not.toBeNull();
    expect(dark.querySelector('[data-theme="dark"]')).not.toBeNull();
    for (const figure of [light, dark]) {
      expect(figure.textContent).toContain("Acme <b>Labs</b>");
      expect(figure.querySelector("b")).toBeNull();
      expect(figure.textContent).toContain("Powered by Portifact");
      const chip = within(figure).getByTitle("Acme <b>Labs</b>");
      expect(chip.style.getPropertyValue("--pf-brand-accent")).toBe("#0000ff");
      expect(chip.style.getPropertyValue("--pf-brand-ink")).toBe("var(--pf-neutral-0)");
    }
    expect(await axeViolations(container)).toEqual([]);

    fireEvent.click(within(section).getByRole("button", { name: "Save brand" }));
    await waitFor(() => expect(server.branding.brand?.name).toBe("Acme <b>Labs</b>"));
    expect(server.bodies.at(-1)).toEqual({
      name: "Acme <b>Labs</b>",
      link: "https://acme.example.com",
      accentColor: "#0000ff",
    });
    expect(await screen.findByText("Brand saved.")).toBeTruthy();
  });

  it("checks the fields before sending and explains a refusal in the page's words", async () => {
    renderDashboard("/branding", server);
    const section = await form();
    fireEvent.change(field(section, "Link"), { target: { value: "http://acme.co" } });
    fireEvent.change(field(section, "Accent color"), { target: { value: "blue" } });
    fireEvent.click(within(section).getByRole("button", { name: "Save brand" }));
    expect(await within(section).findByText("Enter the name to show.")).toBeTruthy();
    expect(within(section).getByText("Enter an address that starts with https://.")).toBeTruthy();
    expect(within(section).getByText("Use a color like #1a2b3c.")).toBeTruthy();
    expect(server.bodies).toEqual([]);

    fireEvent.change(field(section, "Name"), { target: { value: "Portifact" } });
    fireEvent.change(field(section, "Link"), { target: { value: "" } });
    fireEvent.change(field(section, "Accent color"), { target: { value: "" } });
    fireEvent.click(within(section).getByRole("button", { name: "Save brand" }));
    expect(
      await within(section).findByText(
        "Check the name and the link: the name cannot read as Portifact, and the link must be your own site's https address.",
      ),
    ).toBeTruthy();
  });

  it("adds a logo once the brand has a name, removes it, and deletes the brand after a confirmation", async () => {
    const { container } = renderDashboard("/branding", server);
    const logo = await screen.findByRole("region", { name: "Logo" });
    expect(within(logo).getByText("Save the brand's name first, then add a logo.")).toBeTruthy();
    const section = await form();
    fireEvent.change(field(section, "Name"), { target: { value: "Acme" } });
    fireEvent.click(within(section).getByRole("button", { name: "Save brand" }));
    await screen.findByText("No logo yet.");

    const input = logo.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([new Uint8Array(500)], "logo.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(await within(logo).findByText(/^PNG, 64 by 32 pixels/)).toBeTruthy();
    expect(server.logoUploads.at(-1)?.size).toBe(500);
    const preview = screen.getByRole("region", { name: "Preview" });
    expect(preview.querySelector("img[src^='/api/v1/account/branding/logo?v=']")).not.toBeNull();

    const svg = new File(["<svg/>"], "logo.png", { type: "image/svg+xml" });
    fireEvent.change(input, { target: { files: [svg] } });
    expect(
      await within(logo).findByText(/^Use a PNG, JPEG or WebP image of at most 100 KB/),
    ).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);

    fireEvent.click(within(logo).getByRole("button", { name: "Remove logo" }));
    expect(await within(logo).findByText("No logo yet.")).toBeTruthy();

    const danger = screen.getByRole("region", { name: "Delete brand" });
    fireEvent.click(within(danger).getByRole("button", { name: "Delete brand" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete the brand?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete brand" }));
    await waitFor(() => expect(server.branding.brand).toBeNull());
    expect(await screen.findByText("Brand deleted.")).toBeTruthy();
  });

  it("tells an owner without the feature that it is part of a paid plan, with no upgrade button", async () => {
    server.branding = {
      available: false,
      lowestPlan: "pro",
      suspended: false,
      brand: {
        name: "Kept",
        accentColor: null,
        link: null,
        logo: null,
        updatedAt: "2026-11-01T00:00:00.000Z",
      },
    };
    const { container } = renderDashboard("/branding", server);
    expect(await screen.findByText("Branding is part of a paid plan")).toBeTruthy();
    expect(
      screen.getByText(
        "Branding the viewer's bar is part of the Pro plan. Your artifacts show the default bar, and a brand you saved stays here for when your plan includes it again.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Brand" })).toBeNull();
    expect(screen.queryByRole("button", { name: /upgrade|buy|checkout/i })).toBeNull();
    // The kept brand still shows in the preview and can be deleted.
    expect(screen.getByRole("region", { name: "Preview" }).textContent).toContain("Kept");
    expect(screen.getByRole("region", { name: "Delete brand" })).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("says when the operator suspended the brand and keeps it from being deleted", async () => {
    server.branding = {
      available: true,
      lowestPlan: "pro",
      suspended: true,
      brand: {
        name: "Acme",
        accentColor: null,
        link: null,
        logo: null,
        updatedAt: "2026-11-01T00:00:00.000Z",
      },
    };
    renderDashboard("/branding", server);
    expect(await screen.findByText("Your brand is suspended")).toBeTruthy();
    const danger = screen.getByRole("region", { name: "Delete brand" });
    expect(
      (within(danger).getByRole("button", { name: "Delete brand" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("sends empty optional values as none", () => {
    expect(brandUpdate({ name: " Acme ", link: " ", accentColor: "" })).toEqual({
      name: "Acme",
      link: null,
      accentColor: null,
    });
    expect(brandUpdate({ name: "A", link: " https://a.co ", accentColor: "#ABCDEF" })).toEqual({
      name: "A",
      link: "https://a.co",
      accentColor: "#abcdef",
    });
  });
});
