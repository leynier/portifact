// @vitest-environment happy-dom
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultsChange } from "./screens/settings.tsx";
import { type FakeServer, fakeServer, renderDashboard } from "./test-support.tsx";

afterEach(cleanup);

let server: FakeServer;
beforeEach(() => {
  server = fakeServer([]);
});

const BUILT_IN = {
  defaultAccessMode: "restricted",
  defaultAnnotations: "off",
  defaultCommentVisibility: "owner",
  defaultBar: true,
  locale: null,
} as const;

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
    ).toEqual(["Language", "Defaults for new artifacts", "Your data", "Danger zone"]);
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

describe("defaultsChange", () => {
  it("keeps only the fields that differ", () => {
    expect(defaultsChange(BUILT_IN, BUILT_IN)).toBeUndefined();
    expect(defaultsChange(BUILT_IN, { ...BUILT_IN, defaultBar: false })).toEqual({
      defaultBar: false,
    });
    expect(
      defaultsChange(BUILT_IN, {
        ...BUILT_IN,
        defaultAccessMode: "public",
        defaultCommentVisibility: "everyone",
      }),
    ).toEqual({ defaultAccessMode: "public", defaultCommentVisibility: "everyone" });
  });
});
