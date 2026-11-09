// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { axeViolations } from "../testing/axe.ts";
import { AppShell, navLinkClasses, PageHeader } from "./app-shell.tsx";

afterEach(cleanup);

function shell() {
  return render(
    <AppShell
      skipLinkLabel="Skip to content"
      navigationLabel="Main"
      brand={<a href="/">portifact</a>}
      navigation={[
        <a key="a" href="/" aria-current="page" className={navLinkClasses}>
          Artifacts
        </a>,
      ]}
      account={<button type="button">Sign out</button>}
    >
      <PageHeader
        title="Artifacts"
        description="Everything you published"
        actions={<button type="button">Refresh</button>}
      />
    </AppShell>,
  );
}

describe("AppShell", () => {
  it("provides a skip link to the focusable main landmark", () => {
    shell();
    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(skip.getAttribute("href")).toBe("#main");
    const main = screen.getByRole("main");
    expect(main.id).toBe("main");
    expect(main.getAttribute("tabindex")).toBe("-1");
  });

  it("labels the primary navigation and marks the current page", () => {
    shell();
    const nav = screen.getByRole("navigation", { name: "Main" });
    const current = nav.querySelector('[aria-current="page"]');
    expect(current?.textContent).toBe("Artifacts");
    expect(screen.getByRole("banner").textContent).toContain("Sign out");
  });

  it("gives every screen one h1 with its description and actions", () => {
    shell();
    expect(screen.getByRole("heading", { level: 1, name: "Artifacts" })).toBeTruthy();
    expect(screen.getByText("Everything you published")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });

  it("renders a page header with only a title", () => {
    const { container } = render(<PageHeader title="Alone" />);
    expect(container.textContent).toBe("Alone");
  });

  it("has no axe violations", async () => {
    const { container } = shell();
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("AppShell with an aside and a full page header", () => {
  it("renders the account once, the aside in the banner and a header with back link and facts", async () => {
    const { container } = render(
      <AppShell
        skipLinkLabel="Skip to content"
        navigationLabel="Main"
        brand={<a href="/">portifact</a>}
        navigation={[
          <a key="a" href="/" className={navLinkClasses}>
            Artifacts
          </a>,
        ]}
        aside={<p>3 of 50 active artifacts</p>}
        account={<button type="button">Sign out</button>}
      >
        <PageHeader
          title="Launch plan"
          back={<a href="/">All artifacts</a>}
          meta={<span>Active</span>}
        />
      </AppShell>,
    );
    expect(screen.getAllByRole("button", { name: "Sign out" })).toHaveLength(1);
    expect(screen.getByRole("banner").textContent).toContain("3 of 50 active artifacts");
    const heading = screen.getByRole("heading", { level: 1, name: "Launch plan" });
    expect(screen.getByRole("link", { name: "All artifacts" })).toBeTruthy();
    expect(heading.parentElement?.textContent).toContain("Active");
    expect(await axeViolations(container)).toEqual([]);
  });
});
