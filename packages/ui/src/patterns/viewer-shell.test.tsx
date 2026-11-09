// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { axeViolations } from "../testing/axe.ts";
import { ViewerShell } from "./viewer-shell.tsx";

afterEach(cleanup);

function shell(withSidebar = true) {
  return render(
    <ViewerShell
      skipLinkLabel="Skip to the artifact"
      brand={<a href="https://portifact.com">Portifact</a>}
      artifact={{ title: "Launch plan", details: <span>Version 3</span> }}
      actions={<button type="button">Copy link</button>}
      frameLabel="Artifact"
      frame={<iframe title="Launch plan" src="about:blank" />}
      sidebar={
        withSidebar ? { id: "comments", label: "Comments", content: <h2>Comments</h2> } : undefined
      }
    />,
  );
}

describe("ViewerShell", () => {
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

  it("leaves the sidebar out when there is none", () => {
    shell(false);
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("has no axe violations", async () => {
    const { container } = shell();
    expect(await axeViolations(container)).toEqual([]);
  });
});
