// @vitest-environment happy-dom
import { LIMITS } from "@portifact/contracts";
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256OfBlob } from "./publish/hash.ts";
import {
  artifact,
  type FakeServer,
  fakeServer,
  renderDashboard,
  seedVersion,
} from "./test-support.tsx";

afterEach(cleanup);

const ID = "k7d2qm4xab";
const PATH = `/artifacts/${ID}/edit`;
const MD = "text/markdown; charset=utf-8";

let server: FakeServer;
beforeEach(async () => {
  server = fakeServer([artifact(ID, { name: "Plan", type: "markdown" })]);
  await seedVersion(server, ID, [
    { path: "plan.md", text: "# Plan\n", contentType: MD },
    { path: "img/logo.png", text: "png", contentType: "image/png" },
    { path: "notes.zip", text: "zip", kind: "source", contentType: "application/zip" },
  ]);
});

const editor = () =>
  screen.findByRole("textbox", { name: "Markdown" }) as Promise<HTMLTextAreaElement>;
const status = () =>
  screen
    .getAllByRole("status")
    .map((node) => node.textContent)
    .join(" | ");

describe("document editor", () => {
  it("loads the published source, checked against its manifest", async () => {
    const { container } = renderDashboard(PATH, server);
    await screen.findByRole("heading", { level: 1, name: "Edit Plan" });
    const area = await editor();
    expect(area.value).toBe("# Plan\n");
    expect(screen.getByText("plan.md, up to 5 MB.")).toBeTruthy();
    expect(screen.getByText("Choose Preview to see the rendered document.")).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("previews the server's rendering of unsaved text in a sandboxed frame", async () => {
    const { container } = renderDashboard(PATH, server);
    fireEvent.change(await editor(), { target: { value: "# New <b>" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const frame = await waitFor(() => {
      const found = container.querySelector("iframe");
      expect(found).toBeTruthy();
      return found as HTMLIFrameElement;
    });
    expect(frame.getAttribute("title")).toBe("Preview of Plan");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("# New &#60;b&#62;");
    expect(server.bodies.at(-1)).toEqual({ type: "markdown", name: "Plan", source: "# New <b>" });
    expect(await axeViolations(container)).toEqual([]);

    fireEvent.change(await editor(), { target: { value: "# Newer" } });
    expect(await screen.findByText("The text changed since this preview.")).toBeTruthy();
  });

  it("explains a preview the server refused", async () => {
    server.fail("POST", "/api/v1/documents/preview", { status: 429, code: "rate_limited" });
    renderDashboard(PATH, server);
    await editor();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The preview could not be rendered");
    expect(alert.textContent).toContain("Too many requests");
  });

  it("saves as a new version on the current one, uploading only the new text", async () => {
    renderDashboard(PATH, server);
    fireEvent.change(await editor(), { target: { value: "# Plan v2\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and publish" }));
    await waitFor(() => expect(status()).toContain("Saved as version 2."));
    const request = server.uploads[0]?.request;
    expect(request?.artifactId).toBe(ID);
    expect(request?.baseVersionId).toBe(`ver${ID}1`);
    expect(request?.entrypoint).toBe("plan.md");
    const newHash = await sha256OfBlob(new Blob(["# Plan v2\n"]));
    expect(request?.files.map((f) => [f.path, f.kind])).toEqual([
      ["plan.md", "published"],
      ["img/logo.png", "published"],
      ["notes.zip", "source"],
    ]);
    expect(request?.files[0]).toMatchObject({ sha256: newHash, size: 10, contentType: MD });
    expect(server.storage.puts.map((p) => p.size)).toEqual([10]);
    await waitFor(async () => expect((await editor()).value).toBe("# Plan v2\n"));
  });

  it("does not publish an unchanged document", async () => {
    renderDashboard(PATH, server);
    await editor();
    fireEvent.click(screen.getByRole("button", { name: "Save and publish" }));
    await waitFor(() => expect(status()).toContain("Nothing to save: the document is unchanged."));
    expect(server.uploads).toEqual([]);
  });

  it("refuses text over 5 MB before sending it", async () => {
    renderDashboard(PATH, server);
    const area = await editor();
    fireEvent.change(area, { target: { value: "é".repeat(LIMITS.documentBytes / 2 + 1) } });
    fireEvent.click(screen.getByRole("button", { name: "Save and publish" }));
    await waitFor(() => expect(area.getAttribute("aria-invalid")).toBe("true"));
    expect(screen.getByText("Documents are limited to 5 MB.")).toBeTruthy();
    expect(server.uploads).toEqual([]);
  });

  it("reports a version published elsewhere and reloads the latest one", async () => {
    renderDashboard(PATH, server);
    fireEvent.change(await editor(), { target: { value: "mine" } });
    await seedVersion(server, ID, [{ path: "plan.md", text: "theirs", contentType: MD }]);
    fireEvent.click(screen.getByRole("button", { name: "Save and publish" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("A newer version was published meanwhile");
    fireEvent.click(within(alert).getByRole("button", { name: "Load the latest version" }));
    await waitFor(async () => expect((await editor()).value).toBe("theirs"));
  });

  it("refuses a source whose bytes do not match the manifest, and retries", async () => {
    server.storage.fail({ corrupt: true });
    renderDashboard(PATH, server);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The document could not be loaded");
    expect(alert.textContent).toContain("plan.md did not match its checksum");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect((await editor()).value).toBe("# Plan\n");
  });

  it("is only for active Markdown and text artifacts", async () => {
    server.artifacts[0] = artifact(ID, { name: "Site", type: "site" });
    renderDashboard(PATH, server);
    expect(
      await screen.findByText(/Only Markdown and text artifacts can be edited here/),
    ).toBeTruthy();
    cleanup();
    server.artifacts[0] = artifact(ID, { name: "Old", type: "text", state: "archived" });
    renderDashboard(PATH, server);
    expect(await screen.findByText(/Restore it first if it is archived/)).toBeTruthy();
    cleanup();
    renderDashboard("/artifacts/zzzzzzzzzz/edit", server);
    expect(await screen.findByRole("alert", {}, { timeout: 3000 })).toBeTruthy();
  });

  it("edits text documents with the text label", async () => {
    server.artifacts[0] = artifact(ID, { name: "Notes", type: "text" });
    server.versions[ID] = [];
    await seedVersion(server, ID, [
      { path: "notes.txt", text: "plain", contentType: "text/plain" },
    ]);
    renderDashboard(PATH, server);
    expect(
      ((await screen.findByRole("textbox", { name: "Text" })) as HTMLTextAreaElement).value,
    ).toBe("plain");
  });
});

describe("links to the new screens", () => {
  it("offers publishing from the list and the content actions on the artifact page", async () => {
    const { router } = renderDashboard("/", server);
    // The navigation and the list's header both lead to publishing.
    await screen.findByRole("heading", { level: 1, name: "Artifacts" });
    const publish = screen.getAllByRole("link", { name: "Publish" });
    expect(publish.map((link) => link.getAttribute("href"))).toEqual(["/publish", "/publish"]);
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Publish" })).toBe(publish[0]);
    await router.navigate({ to: "/artifacts/$artifactId", params: { artifactId: ID } });
    const region = await screen.findByRole("region", { name: "Content" });
    // A new version is the page's main content action, in its header.
    expect(screen.getByRole("link", { name: "Publish a new version" }).getAttribute("href")).toBe(
      `/artifacts/${ID}/publish`,
    );
    expect(within(region).getByRole("link", { name: "Edit document" }).getAttribute("href")).toBe(
      `/artifacts/${ID}/edit`,
    );
    expect(within(region).getByRole("link", { name: "Version history" }).getAttribute("href")).toBe(
      `/artifacts/${ID}/history`,
    );
  });

  it("offers only the history for archived sites", async () => {
    server.artifacts[0] = artifact(ID, { type: "site", state: "archived" });
    renderDashboard(`/artifacts/${ID}`, server);
    const region = await screen.findByRole("region", { name: "Content" });
    expect(
      within(region)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Version history"]);
  });
});
