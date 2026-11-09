// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axeViolations } from "../testing/axe.ts";
import {
  AppShell,
  type AppShellNavItem,
  PageHeader,
  readSidebar,
  SIDEBAR_WIDTH,
  SidebarAccount,
} from "./app-shell.tsx";

const KEY = "pf.test.sidebar";

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const labels = {
  skipLink: "Skip to content",
  navigation: "Main",
  openNavigation: "Open navigation",
  closeNavigation: "Close navigation",
  collapseSidebar: "Collapse sidebar",
  expandSidebar: "Expand sidebar",
  resizeSidebar: "Resize sidebar",
};

const item = (key: string, label: string, current = false): AppShellNavItem => ({
  key,
  label,
  icon: <svg />,
  render: ({ className, children }) => (
    <a
      href={`/${key}`}
      className={className}
      {...(current ? { "aria-current": "page" as const } : {})}
    >
      {children}
    </a>
  ),
});

function shell(storageKey: string | null = KEY) {
  return render(
    <AppShell
      labels={labels}
      brand={<a href="/">portifact</a>}
      compactBrand={<a href="/">p</a>}
      navigation={[item("artifacts", "Artifacts", true), item("usage", "Usage")]}
      account={
        <SidebarAccount
          name=""
          email="ada@example.com"
          profileLabel="Profile"
          renderProfileLink={(props) => <a href="/profile" {...props} />}
          signOutLabel="Sign out"
          onSignOut={() => {}}
        />
      }
      {...(storageKey ? { storageKey } : {})}
    >
      <PageHeader
        title="Artifacts"
        description="Everything you published"
        actions={<button type="button">Refresh</button>}
      />
    </AppShell>,
  );
}

const sidebarNav = () => screen.getByRole("banner").querySelector("nav") as HTMLElement;

describe("AppShell", () => {
  it("provides a skip link to the focusable main landmark", () => {
    shell();
    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(skip.getAttribute("href")).toBe("#main");
    const main = screen.getByRole("main");
    expect(main.id).toBe("main");
    expect(main.getAttribute("tabindex")).toBe("-1");
  });

  it("labels the primary navigation, marks the current page and puts the account in the banner", () => {
    shell();
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe("Artifacts");
    const banner = screen.getByRole("banner");
    expect(within(banner).getByRole("button", { name: "Sign out" })).toBeTruthy();
    // Without a name, the email's local part stands in for it.
    expect(
      within(banner).getByRole("link", { name: "Profile: ada, ada@example.com" }).textContent,
    ).toContain("ada@example.com");
  });

  it("gives every screen one h1 with its description and actions", () => {
    shell();
    expect(screen.getByRole("heading", { level: 1, name: "Artifacts" })).toBeTruthy();
    expect(screen.getByText("Everything you published")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });

  it("renders a page header with only a title, and one with a back link and facts", () => {
    const { container } = render(<PageHeader title="Alone" />);
    expect(container.textContent).toBe("Alone");
    cleanup();
    render(
      <PageHeader
        title="Launch plan"
        back={<a href="/">All artifacts</a>}
        meta={<span>Active</span>}
      />,
    );
    const heading = screen.getByRole("heading", { level: 1, name: "Launch plan" });
    expect(screen.getByRole("link", { name: "All artifacts" })).toBeTruthy();
    expect(heading.parentElement?.textContent).toContain("Active");
  });

  it("collapses the sidebar to icons with tooltips, expands it again and remembers it", () => {
    shell();
    const toggle = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe(sidebarNav().id);
    fireEvent.click(toggle);

    const expand = screen.getByRole("button", { name: "Expand sidebar" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    // The names stay for assistive technology, and a hover shows them.
    const usage = within(sidebarNav()).getByRole("link", { name: "Usage" });
    expect(usage.querySelector(".sr-only")?.textContent).toBe("Usage");
    fireEvent.focus(usage);
    expect(usage.parentElement?.querySelector("[data-tooltip]")?.textContent).toBe("Usage");
    // The account keeps the avatar and sign out.
    expect(screen.getByRole("link", { name: "Profile: ada, ada@example.com" })).toBeTruthy();
    expect(screen.queryByRole("separator")).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? "{}")).toMatchObject({
      collapsed: true,
    });

    cleanup();
    shell();
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy();
    expect(within(sidebarNav()).getByRole("link", { name: "Usage" }).textContent).toBe("Usage");
  });

  it("resizes the expanded sidebar from its edge and remembers the width", () => {
    const { container } = shell();
    const root = container.firstElementChild as HTMLElement;
    const handle = screen.getByRole("separator", { name: "Resize sidebar" });
    expect(handle.getAttribute("aria-valuenow")).toBe(String(SIDEBAR_WIDTH.initial));
    expect(root.style.getPropertyValue("--pf-sidebar-width")).toBe("240px");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle.getAttribute("aria-valuenow")).toBe("256");
    expect(root.style.getPropertyValue("--pf-sidebar-width")).toBe("256px");
    fireEvent.pointerDown(handle, { button: 0, clientX: 256 });
    fireEvent.pointerMove(handle, { clientX: 5000 });
    expect(handle.getAttribute("aria-valuenow")).toBe(String(SIDEBAR_WIDTH.max));
    fireEvent.pointerUp(handle);
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? "{}")).toEqual({
      collapsed: false,
      width: SIDEBAR_WIDTH.max,
    });
    cleanup();
    shell();
    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe(
      String(SIDEBAR_WIDTH.max),
    );
  });

  it("opens the navigation and the account in a drawer from the menu button", async () => {
    const { container } = shell();
    const menu = screen.getByRole("button", { name: "Open navigation" });
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    menu.focus();
    fireEvent.click(menu);
    const drawer = screen.getByRole("dialog", { name: "Open navigation" });
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    expect(menu.getAttribute("aria-controls")).toBe(drawer.id);
    expect(within(drawer).getByRole("link", { name: "Usage" }).textContent).toBe("Usage");
    expect(within(drawer).getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(await axeViolations(drawer)).toEqual([]);
    fireEvent.click(within(drawer).getByRole("link", { name: "Usage" }));
    expect((drawer as HTMLDialogElement).open).toBe(false);
    expect(document.activeElement).toBe(menu);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("works without storage, and without a key", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ collapsed: true, width: 300 }));
    const blocked = () => {
      throw new Error("blocked");
    };
    const getItem = vi.spyOn(window.localStorage, "getItem").mockImplementation(blocked);
    const setItem = vi.spyOn(window.localStorage, "setItem").mockImplementation(blocked);
    shell();
    expect(getItem).toHaveBeenCalledWith(KEY);
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeTruthy();
    expect(setItem).toHaveBeenCalled();
    cleanup();
    shell(null);
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy();
    // happy-dom's storage is a proxy that restoreAllMocks does not reach.
    getItem.mockRestore();
    setItem.mockRestore();
  });

  it("has no axe violations, expanded and collapsed", async () => {
    const { container } = shell();
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("readSidebar", () => {
  it("falls back to the initial sidebar for missing, invalid or out-of-range values", () => {
    const initial = { collapsed: false, width: SIDEBAR_WIDTH.initial };
    expect(readSidebar(undefined)).toEqual(initial);
    expect(readSidebar(KEY)).toEqual(initial);
    window.localStorage.setItem(KEY, "not json");
    expect(readSidebar(KEY)).toEqual(initial);
    window.localStorage.setItem(KEY, "null");
    expect(readSidebar(KEY)).toEqual(initial);
    window.localStorage.setItem(KEY, JSON.stringify({ collapsed: "yes", width: "wide" }));
    expect(readSidebar(KEY)).toEqual(initial);
    window.localStorage.setItem(KEY, JSON.stringify({ collapsed: true, width: 10 }));
    expect(readSidebar(KEY)).toEqual({ collapsed: true, width: SIDEBAR_WIDTH.min });
    window.localStorage.setItem(KEY, JSON.stringify({ width: 300.4 }));
    expect(readSidebar(KEY)).toEqual({ collapsed: false, width: 300 });
  });
});

describe("SidebarAccount", () => {
  it("shows the name over the email and reports a sign out in progress", () => {
    const onSignOut = vi.fn();
    render(
      <SidebarAccount
        name="Ada Lovelace"
        email="ada@example.com"
        profileLabel="Profile"
        renderProfileLink={(props) => <a href="/profile" {...props} />}
        signOutLabel="Sign out"
        signingOut
        onSignOut={onSignOut}
      />,
    );
    const link = screen.getByRole("link", { name: "Profile: Ada Lovelace, ada@example.com" });
    expect(link.textContent).toBe("ALAda Lovelaceada@example.com");
    expect(screen.getByRole("button", { name: "Sign out" }).getAttribute("aria-busy")).toBe("true");
  });
});
