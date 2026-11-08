// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { axeViolations } from "../testing/axe.ts";
import { ViewerShell } from "./viewer-shell.tsx";

afterEach(cleanup);

function shell(withSidebar = true) {
  return render(
    <ViewerShell
      skipLinkLabel="Skip to the artifact"
      brand={<a href="https://portifact.com">Portifact</a>}
      title="Launch plan"
      details={<span>Version 3</span>}
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
  it("shows the bar with the artifact's name as the only h1 and its controls", () => {
    shell();
    expect(screen.getByRole("banner").textContent).toContain("Portifact");
    expect(screen.getByRole("heading", { level: 1, name: "Launch plan" })).toBeTruthy();
    expect(screen.getByText("Version 3")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
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
