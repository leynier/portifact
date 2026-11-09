// @vitest-environment happy-dom

import { LOCALE_COOKIE } from "@portifact/contracts/preferences";
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCALE_STORAGE_KEY } from "../i18n/preference.ts";
import { CATALOG_LOADERS } from "./i18n/i18n.ts";
import { type FakeServer, fakeServer, localeStorage, renderDashboard } from "./test-support.tsx";

afterEach(() => {
  cleanup();
  document.documentElement.lang = "en";
});

let server: FakeServer;
beforeEach(() => {
  server = fakeServer([]);
});

async function languageSection() {
  return screen.findByRole("region", { name: "Language" });
}

function chooseIn(container: HTMLElement, option: string) {
  fireEvent.click(within(container).getByRole("combobox"));
  fireEvent.click(screen.getByRole("option", { name: option }));
}

describe("choosing the language", () => {
  it("offers every language by its own name, marked with its language", async () => {
    const { container } = renderDashboard("/settings", server);
    const section = await languageSection();
    fireEvent.click(within(section).getByRole("combobox", { name: "Language" }));
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "English",
      "Español",
      "Português (Brasil)",
      "Français",
      "Deutsch",
      "Русский",
      "日本語",
      "简体中文",
    ]);
    expect(options.map((option) => option.getAttribute("lang"))).toEqual([
      "en",
      "es",
      "pt-BR",
      "fr",
      "de",
      "ru",
      "ja",
      "zh-CN",
    ]);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("switches the dashboard to Spanish, keeps the choice and saves it in the account", async () => {
    const storage = localeStorage();
    renderDashboard("/settings", server, { locale: { storage: storage.source } });
    chooseIn(await languageSection(), "Español");
    expect(await screen.findByRole("heading", { level: 1, name: "Configuración" })).toBeTruthy();
    expect(document.documentElement.lang).toBe("es");
    expect(document.title).toBe("Configuración · Portifact");
    expect(storage.values.get(LOCALE_STORAGE_KEY)).toBe("es");
    // The landing follows the same choice through the shared cookie.
    expect(document.cookie).toContain(`${LOCALE_COOKIE}=es`);
    await waitFor(() => expect(server.settings.locale).toBe("es"));
    expect(server.requests).toContainEqual({
      method: "PATCH",
      path: "/api/v1/account/settings",
    });
    expect(server.bodies.at(-1)).toEqual({ locale: "es" });
    // The navigation follows, and the result is announced in the new language.
    const nav = screen.getByRole("navigation", { name: "Principal" });
    expect(within(nav).getByRole("link", { name: "Configuración" })).toBeTruthy();
    expect(await screen.findByText("El panel ahora está en español.")).toBeTruthy();
  });

  it("still switches when the browser blocks storage", async () => {
    renderDashboard("/settings", server, { locale: { storage: localeStorage(true).source } });
    chooseIn(await languageSection(), "Español");
    expect(await screen.findByRole("heading", { level: 1, name: "Configuración" })).toBeTruthy();
    await waitFor(() => expect(server.settings.locale).toBe("es"));
  });

  it("keeps the current language and says so when the catalog cannot load", async () => {
    renderDashboard("/settings", server, {
      locale: {
        storage: localeStorage().source,
        loaders: { ...CATALOG_LOADERS, es: () => Promise.reject(new Error("offline")) },
      },
    });
    chooseIn(await languageSection(), "Español");
    expect(
      await screen.findByText(
        "The language could not be loaded. Check your connection and try again.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
    expect(server.settings.locale).toBeNull();
  });

  it("follows the language saved in the account on another device", async () => {
    server.settings = { ...server.settings, locale: "es" };
    const storage = localeStorage();
    renderDashboard("/", server, { locale: { storage: storage.source } });
    expect(await screen.findByRole("heading", { level: 1, name: "Artifacts" })).toBeTruthy();
    await waitFor(() => expect(document.documentElement.lang).toBe("es"));
    expect(storage.values.get(LOCALE_STORAGE_KEY)).toBe("es");
    // The account's language becomes this browser's shared choice, so the landing follows it.
    expect(document.cookie).toContain(`${LOCALE_COOKIE}=es`);
    // Nothing is sent back: the account already holds the choice.
    expect(server.bodies.some((body) => JSON.stringify(body).includes("locale"))).toBe(false);
  });

  it("is offered beside the account in the sidebar too", async () => {
    renderDashboard("/", server);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const sidebar = nav.closest("aside") ?? document.body;
    const choice = await within(sidebar).findByRole("combobox", { name: /Language/ });
    fireEvent.click(choice);
    fireEvent.click(screen.getByRole("option", { name: "Español" }));
    await waitFor(() => expect(document.documentElement.lang).toBe("es"));
    await waitFor(() => expect(server.settings.locale).toBe("es"));
  });
});
