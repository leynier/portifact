// @vitest-environment happy-dom

import { THEME_STORAGE_KEY } from "@portifact/contracts/theme";
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultsChange } from "./screens/settings.tsx";
import { type FakeServer, fakeServer, renderDashboard } from "./test-support.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

let server: FakeServer;
beforeEach(() => {
  server = fakeServer([]);
  window.localStorage.removeItem(THEME_STORAGE_KEY);
  document.documentElement.removeAttribute("data-theme");
});

const radio = (scope: HTMLElement, name: string) =>
  within(scope).getByRole("radio", { name }) as HTMLInputElement;

const BUILT_IN = {
  defaultAccessMode: "restricted",
  defaultAnnotations: "off",
  defaultCommentVisibility: "owner",
  defaultBar: true,
  expiryNotices: true,
  commentNotices: true,
  locale: null,
} as const;

const { expiryNotices: _, commentNotices: __, ...DEFAULTS } = BUILT_IN;

async function notices() {
  const section = await screen.findByRole("region", { name: "Email notices" });
  await within(section).findByRole("button", { name: "Save email notices" });
  return section;
}

const expiryBox = (section: HTMLElement) =>
  within(section).getByRole("checkbox", {
    name: "Email me before my artifacts expire",
  }) as HTMLInputElement;

async function defaults() {
  const section = await screen.findByRole("region", { name: "Defaults for new artifacts" });
  await within(section).findByRole("button", { name: "Save defaults" });
  return section;
}

describe("settings page", () => {
  it("is reachable from the navigation and holds the defaults, the data export and the danger zone", async () => {
    const { router, container } = renderDashboard("/", server);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Artifacts", "Publish", "Apps", "Usage", "Settings"]);
    fireEvent.click(within(nav).getByRole("link", { name: "Settings" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
    expect(document.title).toBe("Settings · Portifact");
    await defaults();
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent),
    ).toEqual([
      "Language",
      "Appearance",
      "Defaults for new artifacts",
      "Email notices",
      "Your data",
      "Danger zone",
    ]);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("shows the saved defaults and says they apply only to new artifacts", async () => {
    server.settings = { ...BUILT_IN, defaultAnnotations: "open", defaultBar: false };
    renderDashboard("/settings", server);
    const section = await defaults();
    expect(section.textContent).toContain("Artifacts you already have keep their own settings");
    const access = within(section).getByRole("group", {
      name: "Who can open a new artifact",
    });
    expect(
      (
        within(access).getByRole("radio", {
          name: /Only you and the people you add/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    const comments = within(section).getByRole("group", { name: "Comments on a new artifact" });
    expect(
      (within(comments).getByRole("radio", { name: /Open/ }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (
        within(section).getByRole("checkbox", {
          name: "Show the Portifact bar on new artifacts",
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
  });

  it("saves only what changed and announces it", async () => {
    renderDashboard("/settings", server);
    const section = await defaults();
    fireEvent.click(within(section).getByRole("radio", { name: /Anyone signed in to Portifact/ }));
    fireEvent.click(within(section).getByRole("radio", { name: /Open/ }));
    fireEvent.click(
      within(section).getByRole("checkbox", { name: "Show the Portifact bar on new artifacts" }),
    );
    fireEvent.click(within(section).getByRole("button", { name: "Save defaults" }));
    expect(await screen.findByText("Defaults saved. New artifacts start this way.")).toBeTruthy();
    expect(server.requests).toContainEqual({ method: "PATCH", path: "/api/v1/account/settings" });
    expect(server.bodies.at(-1)).toEqual({
      defaultAccessMode: "authenticated",
      defaultAnnotations: "open",
      defaultBar: false,
    });
    expect(server.settings).toMatchObject({ defaultAccessMode: "authenticated" });
  });

  it("sends nothing when nothing changed", async () => {
    renderDashboard("/settings", server);
    const section = await defaults();
    fireEvent.click(within(section).getByRole("button", { name: "Save defaults" }));
    expect(
      await screen.findByText("Nothing to save: your defaults are already set this way."),
    ).toBeTruthy();
    expect(server.requests.some((r) => r.method === "PATCH")).toBe(false);
  });

  it("keeps public unavailable while the account is new, with the date it opens", async () => {
    server.createdAt = new Date(Date.now() - 60_000).toISOString();
    renderDashboard("/settings", server);
    const section = await defaults();
    const publicOption = within(section).getByRole("radio", {
      name: /Public: anyone with the link/,
    }) as HTMLInputElement;
    expect(publicOption.disabled).toBe(true);
    expect(section.textContent).toContain("New accounts wait 15 minutes");
  });

  it("explains a refusal of a public default in the terms of the rule", async () => {
    server.fail("PATCH", "/api/v1/account/settings", {
      status: 403,
      code: "account_too_new_for_public",
    });
    renderDashboard("/settings", server);
    const section = await defaults();
    fireEvent.click(within(section).getByRole("radio", { name: /Public: anyone with the link/ }));
    fireEvent.click(within(section).getByRole("button", { name: "Save defaults" }));
    const alert = await within(section).findByRole("alert");
    expect(alert.textContent).toContain("Your defaults were not saved");
    expect(alert.textContent).toContain("New accounts can make an artifact public 15 minutes");
    expect(server.settings.defaultAccessMode).toBe("restricted");
  });

  it("shows other failures with their message", async () => {
    server.fail("PATCH", "/api/v1/account/settings", { status: 429, code: "rate_limited" });
    renderDashboard("/settings", server);
    const section = await defaults();
    fireEvent.click(within(section).getByRole("radio", { name: /Open/ }));
    fireEvent.click(within(section).getByRole("button", { name: "Save defaults" }));
    expect((await within(section).findByRole("alert")).textContent).toContain("Too many requests");
  });

  it("offers a retry when the defaults cannot load", async () => {
    server.fail("GET", "/api/v1/account/settings", { status: 0, network: true }, 2);
    renderDashboard("/settings", server);
    const section = await screen.findByRole("region", { name: "Defaults for new artifacts" });
    const alert = await within(section).findByRole("alert", {}, { timeout: 3000 });
    expect(alert.textContent).toContain("Your settings could not be loaded");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await within(section).findByRole("button", { name: "Save defaults" })).toBeTruthy();
  });
});

describe("email notices", () => {
  it("shows expiry notices on by default and explains when they come", async () => {
    const { container } = renderDashboard("/settings", server);
    const section = await notices();
    expect(expiryBox(section).checked).toBe(true);
    expect(section.textContent).toContain("At most one email a day");
    expect(section.textContent).toContain("30 days after you last publish or renew");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("turns them off with only that change, and keeps the defaults form as it was", async () => {
    renderDashboard("/settings", server);
    const section = await notices();
    const defaultsSection = await defaults();
    fireEvent.click(within(defaultsSection).getByRole("radio", { name: /Open/ }));
    fireEvent.click(expiryBox(section));
    fireEvent.click(within(section).getByRole("button", { name: "Save email notices" }));
    expect(await screen.findByText("Email notices saved.")).toBeTruthy();
    expect(server.bodies.at(-1)).toEqual({ expiryNotices: false });
    expect(server.settings.expiryNotices).toBe(false);
    expect(expiryBox(await notices()).checked).toBe(false);
    const comments = within(await defaults()).getByRole("group", {
      name: "Comments on a new artifact",
    });
    expect(
      (within(comments).getByRole("radio", { name: /Open/ }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("turns comment notices off on their own", async () => {
    renderDashboard("/settings", server);
    const section = await notices();
    const box = within(section).getByRole("checkbox", {
      name: "Email me about new comments",
    }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    fireEvent.click(within(section).getByRole("button", { name: "Save email notices" }));
    expect(await screen.findByText("Email notices saved.")).toBeTruthy();
    expect(server.bodies.at(-1)).toEqual({ commentNotices: false });
    expect(server.settings).toMatchObject({ commentNotices: false, expiryNotices: true });
  });

  it("shows them off when saved off, and turns them back on", async () => {
    server.settings = { ...BUILT_IN, expiryNotices: false };
    renderDashboard("/settings", server);
    const section = await notices();
    expect(expiryBox(section).checked).toBe(false);
    fireEvent.click(expiryBox(section));
    fireEvent.click(within(section).getByRole("button", { name: "Save email notices" }));
    expect(await screen.findByText("Email notices saved.")).toBeTruthy();
    expect(server.bodies.at(-1)).toEqual({ expiryNotices: true });
  });

  it("sends nothing when nothing changed", async () => {
    renderDashboard("/settings", server);
    const section = await notices();
    fireEvent.click(within(section).getByRole("button", { name: "Save email notices" }));
    expect(
      await screen.findByText("Nothing to save: your email notices are already set this way."),
    ).toBeTruthy();
    expect(server.requests.some((r) => r.method === "PATCH")).toBe(false);
  });

  it("shows a failure with its message", async () => {
    server.fail("PATCH", "/api/v1/account/settings", { status: 429, code: "rate_limited" });
    renderDashboard("/settings", server);
    const section = await notices();
    fireEvent.click(expiryBox(section));
    fireEvent.click(within(section).getByRole("button", { name: "Save email notices" }));
    const alert = await within(section).findByRole("alert");
    expect(alert.textContent).toContain("Your email notices were not saved");
    expect(alert.textContent).toContain("Too many requests");
    expect(server.settings.expiryNotices).toBe(true);
  });
});

describe("defaultsChange", () => {
  it("keeps only the fields that differ", () => {
    expect(defaultsChange(DEFAULTS, DEFAULTS)).toBeUndefined();
    expect(defaultsChange(DEFAULTS, { ...DEFAULTS, defaultBar: false })).toEqual({
      defaultBar: false,
    });
    expect(
      defaultsChange(DEFAULTS, {
        ...DEFAULTS,
        defaultAccessMode: "public",
        defaultCommentVisibility: "everyone",
      }),
    ).toEqual({ defaultAccessMode: "public", defaultCommentVisibility: "everyone" });
  });
});

describe("appearance", () => {
  it("chooses the theme for this browser, and the sidebar's quick switch and the logo follow", async () => {
    const { container } = renderDashboard("/settings", server);
    const section = await screen.findByRole("region", { name: "Appearance" });
    expect(section.textContent).toContain("Artifacts keep the look their creators gave them");
    const group = within(section).getByRole("group", { name: "Theme" });
    expect(radio(group, "System").checked).toBe(true);

    fireEvent.click(radio(group, "Dark"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    const groups = screen.getAllByRole("group", { name: "Theme" });
    expect(groups.length).toBeGreaterThanOrEqual(2);
    for (const each of groups) expect(radio(each, "Dark").checked).toBe(true);
    // The logo shows its dark version whatever the operating system prefers.
    for (const source of container.querySelectorAll("picture source")) {
      expect(source.getAttribute("media")).toBe("all");
    }

    fireEvent.click(radio(group, "System"));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("switches from the sidebar too, also when the browser blocks storage", async () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    renderDashboard("/", server);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(nav).toBeTruthy();
    const [quick] = screen.getAllByRole("group", { name: "Theme" });
    if (!quick) throw new Error("no quick theme switch");
    fireEvent.click(radio(quick, "Light"));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(radio(quick, "Light").checked).toBe(true);
  });
});
