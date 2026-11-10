// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { axeViolations } from "../testing/axe.ts";
import { AppShell } from "./app-shell.tsx";
import { SpaceSwitcher, type SpaceSwitcherOption } from "./space-switcher.tsx";

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

const option = (
  key: string,
  name: string,
  detail: string,
  current = false,
): SpaceSwitcherOption => ({
  key,
  name,
  detail,
  current,
  render: ({ className, children, onClick, ...rest }) => (
    <a href={`/?space=${key}`} className={className} onClick={onClick} {...rest}>
      {children}
    </a>
  ),
});

const OPTIONS = [
  option("personal", "Personal", "Your own space", true),
  option("acme", "Acme design", "Editor"),
];

function switcher(footer?: string) {
  return (
    <SpaceSwitcher
      label="Space"
      current={{ name: "Personal", detail: "Your own space" }}
      options={OPTIONS}
      {...(footer ? { footer: <a href="/invitations">{footer}</a> } : {})}
    />
  );
}

function inShell(collapsed: boolean) {
  window.localStorage.setItem("pf.space", JSON.stringify({ collapsed, width: 240 }));
  return render(
    <AppShell
      labels={{
        skipLink: "Skip",
        navigation: "Main",
        openNavigation: "Open navigation",
        closeNavigation: "Close navigation",
        collapseSidebar: "Collapse sidebar",
        expandSidebar: "Expand sidebar",
        resizeSidebar: "Resize sidebar",
      }}
      brand={<a href="/">portifact</a>}
      compactBrand={<a href="/">p</a>}
      navigation={[]}
      switcher={switcher()}
      account={<span>Ada</span>}
      storageKey="pf.space"
    >
      <p>Content</p>
    </AppShell>,
  );
}

describe("SpaceSwitcher", () => {
  it("shows the current space and opens a list of spaces with the current one marked", async () => {
    const { container } = render(switcher("2 invitations"));
    const button = screen.getByRole("button", { name: "Space Personal Your own space" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list", { name: "Space" })).toBeNull();
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByRole("list", { name: "Space" });
    const links = within(list).getAllByRole("link");
    expect(links).toEqual([
      within(list).getByRole("link", { name: "Personal Your own space" }),
      within(list).getByRole("link", { name: "Acme design Editor" }),
    ]);
    expect(links[0]?.getAttribute("aria-current")).toBe("true");
    expect(links[1]?.hasAttribute("aria-current")).toBe(false);
    expect(screen.getByRole("link", { name: "2 invitations" })).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("closes on Escape with focus back on the button, on a followed link and on a press outside", () => {
    render(
      <>
        {switcher()}
        <button type="button">Elsewhere</button>
      </>,
    );
    const button = screen.getByRole("button", { name: /^Space/ });
    fireEvent.click(button);
    const acme = screen.getByRole("link", { name: "Acme design Editor" });
    acme.focus();
    fireEvent.keyDown(acme, { key: "Escape" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);
    fireEvent.click(screen.getByRole("link", { name: "Acme design Editor" }));
    expect(button.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(button);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(button.getAttribute("aria-expanded")).toBe("false");
    // Escape while closed does nothing, so it can reach an enclosing drawer.
    fireEvent.keyDown(button, { key: "Escape" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("sits above the navigation in the sidebar and the drawer, and shrinks to an initial in the rail", async () => {
    const { container } = inShell(false);
    const sidebar = screen.getByRole("banner");
    const navigation = within(sidebar).getByRole("navigation", { name: "Main", hidden: true });
    const button = within(sidebar).getByRole("button", { name: /^Space Personal/, hidden: true });
    // Above the navigation, in document order.
    expect(
      button.compareDocumentPosition(navigation) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
    cleanup();
    inShell(true);
    const rail = screen.getAllByRole("button", {
      name: "Space: Personal, Your own space",
      hidden: true,
    });
    expect(rail.length).toBeGreaterThan(0);
    fireEvent.click(rail[0] as HTMLElement);
    expect(
      screen.getAllByRole("link", { name: "Acme design Editor", hidden: true }).length,
    ).toBeGreaterThan(0);
  });
});
