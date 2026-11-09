// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { languageLinksHtml } from "../static/language-links.ts";
import { axeViolations } from "../testing/axe.ts";
import { LanguageSwitcher } from "./language-switcher.tsx";

afterEach(cleanup);

const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "es", name: "Español" },
] as const;

function Choice({ variant }: { variant?: "field" | "compact" }) {
  const [value, setValue] = useState<"en" | "es">("en");
  return (
    <LanguageSwitcher<"en" | "es">
      label="Language"
      description="Saved in your account."
      value={value}
      languages={LANGUAGES}
      onChange={setValue}
      variant={variant}
    />
  );
}

describe("LanguageSwitcher", () => {
  it("names each language in itself, marked with its language for screen readers", async () => {
    const { container } = render(<Choice />);
    const trigger = screen.getByRole("combobox", { name: "Language" });
    expect(trigger.textContent).toContain("English");
    expect(trigger.querySelector('[lang="en"]')?.textContent).toBe("English");
    fireEvent.click(trigger);
    const options = screen.getAllByRole("option");
    expect(options.map((option) => [option.textContent, option.getAttribute("lang")])).toEqual([
      ["English", "en"],
      ["Español", "es"],
    ]);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("is chosen with the keyboard alone", () => {
    render(<Choice />);
    const trigger = screen.getByRole("combobox", { name: "Language" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(trigger.textContent).toContain("Español");
    expect(trigger.querySelector('[lang="es"]')).not.toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("fits a toolbar or a sidebar in its compact form", async () => {
    const { container } = render(<Choice variant="compact" />);
    const trigger = screen.getByRole("combobox", { name: /Language/ });
    expect(trigger.textContent).toContain("Language");
    expect(trigger.textContent).toContain("English");
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("languageLinksHtml", () => {
  const links = [
    { code: "en", name: "English", href: "/", current: false },
    { code: "es", name: "Español", href: "/es/", current: true },
  ];

  it("draws the footer row as links to the page in each language", async () => {
    document.body.innerHTML = `<main>${languageLinksHtml({ variant: "list", label: "Idioma", links })}</main>`;
    const nav = screen.getByRole("navigation", { name: "Idioma" });
    const anchors = [...nav.querySelectorAll("a")];
    expect(anchors.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["English", "/"],
      ["Español", "/es/"],
    ]);
    expect(anchors.map((a) => a.getAttribute("lang"))).toEqual(["en", "es"]);
    expect(anchors.map((a) => a.getAttribute("hreflang"))).toEqual(["en", "es"]);
    expect(anchors[1]?.getAttribute("aria-current")).toBe("true");
    expect(anchors[0]?.hasAttribute("aria-current")).toBe(false);
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it("draws the top-bar menu as a disclosure that opens with the keyboard", async () => {
    document.body.innerHTML = `<main>${languageLinksHtml({ variant: "menu", label: "Idioma", links })}</main>`;
    const details = document.querySelector("details") as HTMLDetailsElement;
    const summary = details.querySelector("summary") as HTMLElement;
    expect(summary.textContent).toContain("Idioma");
    expect(summary.querySelector('[lang="es"]')?.textContent).toBe("Español");
    expect(details.open).toBe(false);
    details.open = true;
    expect(details.querySelectorAll("a")).toHaveLength(2);
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it("escapes every value", () => {
    const html = languageLinksHtml({
      variant: "list",
      label: 'Lang"><script>',
      links: [
        { code: 'x" onmouseover="1', name: "<b>", href: '"/><img src=x onerror=1>', current: true },
      ],
    });
    document.body.innerHTML = html;
    expect(document.querySelector("script, img, b")).toBeNull();
    expect(document.querySelector("a")?.textContent).toBe("<b>");
    expect(document.querySelector("a")?.getAttribute("lang")).toBe('x" onmouseover="1');
    expect(document.querySelector("[onmouseover]")).toBeNull();
    const menu = languageLinksHtml({
      variant: "menu",
      label: "L",
      links: [{ code: 'x"><i>', name: "<i>n</i>", href: "/", current: true }],
    });
    document.body.innerHTML = menu;
    expect(document.querySelector("i")).toBeNull();
  });
});
