// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HostingNotice, ViewerBarPreview } from "../patterns/viewer-shell.tsx";
import { axeViolations } from "../testing/axe.ts";
import { BrandMark } from "./brand-mark.tsx";
import { ColorField } from "./fields.tsx";

afterEach(cleanup);

describe("BrandMark", () => {
  it("links to the brand's home in a new tab without an opener or referrer", async () => {
    const { container } = render(
      <BrandMark
        name="Acme"
        href="https://acme.example.com/"
        newTabLabel="(opens in a new tab)"
        accent="#0000ff"
        logo={{ src: "https://a1.portifact.dev/__portifact/brand/x", width: 64, height: 32 }}
      />,
    );
    const link = screen.getByRole("link", { name: "Acme (opens in a new tab)" });
    expect(link.getAttribute("href")).toBe("https://acme.example.com/");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    const image = container.querySelector("img");
    expect(image?.getAttribute("alt")).toBe("");
    expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
    // The accent reaches only this element, as custom properties; the ink is a neutral token.
    expect(link.style.getPropertyValue("--pf-brand-accent")).toBe("#0000ff");
    expect(link.style.getPropertyValue("--pf-brand-ink")).toBe("var(--pf-neutral-0)");
    expect(link.style.getPropertyValue("color")).toBe("");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("renders a hostile name as text and never as markup", () => {
    const name = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const { container } = render(<BrandMark name={name} newTabLabel="(new tab)" accent={null} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.textContent).toBe(name);
    // Without a link it is plain text, and without an accent the chip is neutral.
    expect(screen.queryByRole("link")).toBeNull();
    const chip = container.firstElementChild as HTMLElement;
    expect(chip.style.getPropertyValue("--pf-brand-accent")).toBe("");
  });

  it("ignores an accent that is not one color, so nothing reaches the CSS", () => {
    const { container, rerender } = render(
      <BrandMark name="Acme" newTabLabel="x" accent="#123456" />,
    );
    const chip = container.firstElementChild as HTMLElement;
    expect(chip.style.getPropertyValue("--pf-brand-accent")).toBe("#123456");
    rerender(<BrandMark name="Acme" newTabLabel="x" accent="red; background: url(x)" />);
    expect(chip.style.getPropertyValue("--pf-brand-accent")).toBe("");
    expect(chip.style.getPropertyValue("--pf-brand-ink")).toBe("");
  });

  it("leaves out a logo that does not load", () => {
    const { container } = render(
      <BrandMark name="Acme" newTabLabel="x" logo={{ src: "/missing", width: 16, height: 16 }} />,
    );
    const image = container.querySelector("img");
    if (!image) throw new Error("no image");
    fireEvent.error(image);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("Acme");
  });
});

describe("HostingNotice and ViewerBarPreview", () => {
  it("keeps Portifact, the origin and the report link in view", async () => {
    const { container } = render(
      <HostingNotice
        mark={<span />}
        poweredBy="Powered by Portifact"
        originLabel="Published at"
        origin="a1b2c3.portifact.dev"
        report={{ href: "/report?artifact=a1b2c3", label: "Report this artifact" }}
      />,
    );
    expect(container.textContent).toContain("Powered by Portifact");
    expect(container.textContent).toContain("Published at");
    expect(container.textContent).toContain("a1b2c3.portifact.dev");
    expect(screen.getByRole("link", { name: "Report this artifact" }).getAttribute("href")).toBe(
      "/report?artifact=a1b2c3",
    );
    expect(await axeViolations(container)).toEqual([]);
  });

  it("leaves the report link out when none is given", () => {
    render(<HostingNotice mark={null} poweredBy="P" originLabel="O" origin="x" />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("draws the bar in the theme it is given, captioned", async () => {
    const { container } = render(
      <ViewerBarPreview
        caption="Dark theme"
        theme="dark"
        title="Quarterly report"
        brand={<BrandMark name="Acme" newTabLabel="x" />}
      />,
    );
    expect(screen.getByRole("figure", { name: "Dark theme" })).toBeTruthy();
    expect(container.querySelector('[data-theme="dark"]')?.textContent).toContain(
      "Quarterly report",
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("ColorField", () => {
  it("is a labelled text box with a picker that fills it", async () => {
    let value = "#1a2b3c";
    const { container, rerender } = render(
      <ColorField
        label="Accent color"
        description="A color like #1a2b3c"
        pickerLabel="Pick the accent color"
        value={value}
        onChange={(next) => {
          value = next;
        }}
      />,
    );
    const box = screen.getByRole("textbox", { name: "Accent color" }) as HTMLInputElement;
    expect(box.value).toBe("#1a2b3c");
    const picker = screen.getByLabelText("Pick the accent color") as HTMLInputElement;
    expect(picker.type).toBe("color");
    fireEvent.change(picker, { target: { value: "#ff0000" } });
    expect(value).toBe("#ff0000");
    fireEvent.change(box, { target: { value: "#00ff" } });
    expect(value).toBe("#00ff");
    // While the text is not a color yet, the picker keeps the last valid one.
    rerender(
      <ColorField
        label="Accent color"
        pickerLabel="Pick the accent color"
        value="#00ff"
        error="Use a color like #1a2b3c."
        onChange={() => {}}
      />,
    );
    expect(picker.value).toBe("#1a2b3c");
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(await axeViolations(container)).toEqual([]);
  });
});
