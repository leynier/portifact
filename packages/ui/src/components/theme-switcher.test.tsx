// @vitest-environment happy-dom
import { THEME_STORAGE_KEY } from "@portifact/contracts/theme";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axeViolations } from "../testing/axe.ts";
import { ThemedImage, ThemeSwitcher } from "./theme-switcher.tsx";

const LABELS = { system: "System", light: "Light", dark: "Dark" };

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ThemeSwitcher", () => {
  it("is a named radio group with the current choice checked, and passes axe", async () => {
    document.documentElement.setAttribute("data-theme", "dark");
    const { container } = render(<ThemeSwitcher legend="Theme" labels={LABELS} />);
    const group = screen.getByRole("group", { name: "Theme" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("value"))).toEqual(["system", "light", "dark"]);
    expect((screen.getByRole("radio", { name: "Dark" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("radio", { name: "System" }) as HTMLInputElement).checked).toBe(false);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("applies and remembers a choice, and pictures follow it", () => {
    render(
      <>
        <ThemeSwitcher legend="Theme" labels={LABELS} />
        <ThemedImage src="light.svg" darkSrc="dark.svg" alt="Logo" width={10} height={10} />
      </>,
    );
    const source = document.querySelector("source");
    if (!source) throw new Error("no source");
    expect(source.getAttribute("media")).toBe("(prefers-color-scheme: dark)");
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect((screen.getByRole("radio", { name: "Light" }) as HTMLInputElement).checked).toBe(true);
    expect(source.getAttribute("media")).toBe("not all");
    fireEvent.click(screen.getByRole("radio", { name: "System" }));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("keeps every switcher on the page in step, each in its own radio group", () => {
    render(
      <>
        <ThemeSwitcher legend="Theme" labels={LABELS} />
        <ThemeSwitcher legend="Quick theme" labels={LABELS} compact />
      </>,
    );
    const [full, quick] = screen.getAllByRole("radio", { name: "Dark" });
    expect(full?.getAttribute("name")).not.toBe(quick?.getAttribute("name"));
    if (!full || !quick) throw new Error("missing radios");
    fireEvent.click(full);
    expect((quick as HTMLInputElement).checked).toBe(true);
  });

  it("follows a choice made in another tab", () => {
    render(<ThemeSwitcher legend="Theme" labels={LABELS} />);
    act(() => {
      window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
      window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
    });
    expect((screen.getByRole("radio", { name: "Dark" }) as HTMLInputElement).checked).toBe(true);
  });

  it("still switches for this page when storage is blocked", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    render(<ThemeSwitcher legend="Theme" labels={LABELS} />);
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect((screen.getByRole("radio", { name: "Dark" }) as HTMLInputElement).checked).toBe(true);
  });

  it("in compact form hides the names visually, shows them as tooltips and still passes axe", async () => {
    const { container } = render(
      <ThemeSwitcher legend="Theme" labels={LABELS} compact orientation="vertical" />,
    );
    const legend = container.querySelector("legend");
    expect(legend?.className).toContain("sr-only");
    expect(container.querySelector(".flex-col")).not.toBeNull();
    const light = screen.getByRole("radio", { name: "Light" });
    fireEvent.focus(light);
    expect(container.querySelector("[data-tooltip]")?.textContent).toBe("Light");
    expect(await axeViolations(container)).toEqual([]);
  });
});
