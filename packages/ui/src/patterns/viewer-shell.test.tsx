// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations } from "../testing/axe.ts";
import { ViewerShell } from "./viewer-shell.tsx";

afterEach(cleanup);

function shell(withSidebar = true, onClose = vi.fn(), notice?: React.ReactNode) {
  return render(
    <ViewerShell
      notice={notice}
      skipLinkLabel="Skip to the artifact"
      brand={<a href="https://portifact.com">Portifact</a>}
      artifact={{ title: "Launch plan", details: <span>Version 3</span> }}
      actions={<button type="button">Copy link</button>}
      toggle={
        <button type="button" aria-pressed="true">
          Comments
        </button>
      }
      account={<a href="/">Your artifacts</a>}
      overflow={<button type="button">More</button>}
      frameLabel="Artifact"
      frame={<iframe title="Launch plan" src="about:blank" />}
      sidebar={
        withSidebar
          ? {
              id: "comments",
              label: "Comments",
              content: <h2>Comments</h2>,
              closeLabel: "Close comments",
              onClose,
            }
          : undefined
      }
    />,
  );
}

describe("ViewerShell", () => {
  it("shows a notice row in the bar, after its controls, only when given one", async () => {
    const { container } = shell(true, vi.fn(), <p>Powered by Portifact</p>);
    const bar = screen.getByRole("banner");
    const notice = screen.getByText("Powered by Portifact");
    // Inside the banner landmark, after the row of controls, never in the artifact.
    expect(bar.contains(notice)).toBe(true);
    expect(bar.lastElementChild).toBe(notice);
    expect(screen.getByRole("main").contains(notice)).toBe(false);
    expect(await axeViolations(container)).toEqual([]);
    cleanup();
    shell();
    expect(screen.queryByText("Powered by Portifact")).toBeNull();
  });

  it("names the artifact and its version in the bar, after the mark, as plain text", () => {
    shell();
    const bar = screen.getByRole("banner");
    expect(bar.textContent).toContain("Portifact");
    const heading = screen.getByRole("heading", { level: 1, name: "Launch plan" });
    expect(bar.contains(heading)).toBe(true);
    expect(heading.getAttribute("title")).toBe("Launch plan");
    expect(bar.textContent).toContain("Version 3");
    expect(within(bar).getByRole("button", { name: "Copy link" })).toBeTruthy();
    // The frame's panel holds only the frame: no caption row above it.
    const main = screen.getByRole("main", { name: "Artifact" });
    expect(main.textContent).toBe("");
    expect(within(main).getByTitle("Launch plan")).toBeTruthy();
  });

  it("skips to the focusable artifact region and labels the comments sidebar", () => {
    shell();
    const skip = screen.getByRole("link", { name: "Skip to the artifact" });
    expect(skip.getAttribute("href")).toBe("#artifact");
    const main = screen.getByRole("main", { name: "Artifact" });
    expect(main.id).toBe("artifact");
    expect(main.getAttribute("tabindex")).toBe("-1");
    expect(screen.getByRole("complementary", { name: "Comments" }).id).toBe("comments");
  });

  it("keeps the toggle at every width and puts the rest in an overflow menu on narrow screens", () => {
    shell();
    const bar = screen.getByRole("banner");
    const toggle = within(bar).getByRole("button", { name: "Comments" });
    const copy = within(bar).getByRole("button", { name: "Copy link" });
    const more = within(bar).getByRole("button", { name: "More" });
    const dashboard = within(bar).getByRole("link", { name: "Your artifacts" });
    // Breakpoint classes decide what shows; happy-dom has no layout, so check where each sits.
    expect(toggle.closest(".hidden")).toBeNull();
    expect(copy.closest(".hidden")).not.toBeNull();
    expect(dashboard.closest(".hidden")).not.toBeNull();
    expect(more.parentElement?.className).toContain("sm:hidden");
  });

  it("closes the sidebar, which covers the artifact on narrow screens, from its own button", () => {
    const onClose = vi.fn();
    shell(true, onClose);
    const sidebar = screen.getByRole("complementary", { name: "Comments" });
    expect(sidebar.getAttribute("tabindex")).toBe("-1");
    fireEvent.click(within(sidebar).getByRole("button", { name: "Close comments" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("leaves the sidebar out when there is none", () => {
    shell(false);
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("has no axe violations", async () => {
    const { container } = shell();
    expect(await axeViolations(container)).toEqual([]);
  });
});
