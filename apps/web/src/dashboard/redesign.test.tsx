// @vitest-environment happy-dom
// Flows added with the dashboard redesign: the first-publish guide, copying links, the toast that
// reports results, the publishing steps and dropping a folder to publish.
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { artifact, type FakeServer, fakeServer, renderDashboard } from "./test-support.tsx";

const ID = "k7d2qm4xab";
let server: FakeServer;
const writeText = vi.fn((_text: string) => Promise.resolve());

beforeEach(() => {
  server = fakeServer([artifact(ID, { name: "Launch plan" })]);
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(cleanup);

const toast = () =>
  screen
    .getAllByRole("status")
    .map((node) => node.textContent)
    .join(" | ");

describe("first publish guide", () => {
  it("teaches the browser upload, the CLI and the MCP server URL on an empty list", async () => {
    server.artifacts = [];
    const { container } = renderDashboard("/", server);
    const empty = (await screen.findByRole("heading", { name: "No artifacts yet" }))
      .parentElement as HTMLElement;
    const ways = within(empty)
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);
    expect(ways).toEqual([
      "Upload in the browser",
      "Publish from your terminal",
      "Let your agent publish",
    ]);
    expect(
      within(empty).getByRole("link", { name: "Publish from the browser" }).getAttribute("href"),
    ).toBe("/publish");
    expect(within(empty).getByText("curl -fsSL https://portifact.com/install | bash")).toBeTruthy();
    expect(within(empty).getByText("portifact publish ./report.html")).toBeTruthy();
    const mcp = `${window.location.origin}/mcp`;
    expect(within(empty).getByText(mcp)).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);

    fireEvent.click(within(empty).getByRole("button", { name: "Copy URL" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(mcp));
    await waitFor(() => expect(toast()).toContain("Copied to the clipboard"));
  });
});

describe("artifact page link", () => {
  it("copies the link, reports it in a toast that can be dismissed, and opens it", async () => {
    renderDashboard(`/artifacts/${ID}`, server);
    await screen.findByRole("heading", { level: 1, name: "Launch plan" });
    expect(screen.getByRole("link", { name: "Open" }).getAttribute("href")).toBe(
      `https://${ID}.portifact.dev/`,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`https://${ID}.portifact.dev/`));
    await waitFor(() => expect(toast()).toContain("Link copied"));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss message" }));
    expect(screen.queryByRole("button", { name: "Dismiss message" })).toBeNull();
  });

  it("explains a clipboard the browser refused", async () => {
    writeText.mockImplementationOnce(() => Promise.reject(new Error("denied")));
    renderDashboard(`/artifacts/${ID}`, server);
    fireEvent.click(await screen.findByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(toast()).toContain("The browser blocked the clipboard"));
  });
});

/** A folder dropped from the desktop, as the entries API hands it over. */
function droppedFolder(name: string, files: Record<string, string>): DataTransfer {
  let read = false;
  const children = Object.entries(files).map(([path, text]) => ({
    isFile: true,
    isDirectory: false,
    fullPath: `/${name}/${path}`,
    file: (resolve: (file: File) => void) => resolve(new File([text], path)),
  }));
  const folder = {
    isFile: false,
    isDirectory: true,
    fullPath: `/${name}`,
    createReader: () => ({
      readEntries: (resolve: (entries: unknown[]) => void) => {
        resolve(read ? [] : children);
        read = true;
      },
    }),
  };
  return {
    types: ["Files"],
    files: [],
    items: [{ webkitGetAsEntry: () => folder }],
  } as unknown as DataTransfer;
}

describe("publishing steps and dropping files", () => {
  it("publishes a dropped folder and moves through the steps", async () => {
    const { container } = renderDashboard("/publish", server);
    const steps = await screen.findByRole("list", { name: "Publishing steps" });
    const current = () => steps.querySelector('[aria-current="step"]')?.textContent ?? "";
    expect(current()).toContain("Choose");

    const zone = screen.getByText("Drag files, a folder or a ZIP here, or choose them")
      .parentElement as HTMLElement;
    const data = droppedFolder("pitch", { "index.html": "<h1>Pitch</h1>", "app.js": "1" });
    fireEvent.dragEnter(zone, { dataTransfer: data });
    expect(screen.getByText("Drop to choose these files")).toBeTruthy();
    fireEvent.drop(zone, { dataTransfer: data });

    await screen.findByRole("heading", { name: "Review before publishing" });
    expect(current()).toContain("Review");
    const table = screen.getByRole("table", { name: "Files to publish" });
    expect(
      within(table)
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.firstChild?.textContent)
        .sort(),
    ).toEqual(["app.js", "index.html"]);
    // A dropped folder names the artifact like a picked one.
    expect(screen.getByText("pitch")).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(await screen.findByText("Published version 1")).toBeTruthy();
    expect(steps.querySelector('[aria-current="step"]')).toBeNull();
    expect(steps.textContent).toContain("Publish, done");
    const created = server.artifacts.at(-1);
    expect(screen.getByRole("link", { name: "Review and comment" }).getAttribute("href")).toBe(
      `/review/${created?.id}`,
    );
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
  });

  it("reads one dropped ZIP as an archive", async () => {
    renderDashboard("/publish", server);
    const zone = (await screen.findByText("Drag files, a folder or a ZIP here, or choose them"))
      .parentElement as HTMLElement;
    const data = {
      types: ["Files"],
      files: [new File(["not a zip"], "site.zip")],
      items: [{}],
    } as unknown as DataTransfer;
    fireEvent.drop(zone, { dataTransfer: data });
    // Not a real archive: the ZIP reader refuses it and says why, so it was read as one.
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
