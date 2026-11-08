// @vitest-environment happy-dom
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  artifact,
  type FakeServer,
  fakeServer,
  renderDashboard,
  seedVersion,
} from "./test-support.tsx";

afterEach(cleanup);

const ID = "k7d2qm4xab";

let server: FakeServer;
const prototype = HTMLInputElement.prototype as unknown as Record<string, unknown>;
const hadFolders = "webkitdirectory" in prototype;
beforeEach(() => {
  server = fakeServer([artifact(ID, { name: "Launch plan", accessMode: "authenticated" })]);
  if (!hadFolders) prototype.webkitdirectory = false;
});
afterEach(() => {
  if (!hadFolders) delete prototype.webkitdirectory;
});

function file(path: string, text: string | Uint8Array, folder = false): File {
  const name = path.split("/").pop() as string;
  const created = new File([text as BlobPart], name);
  if (folder) Object.defineProperty(created, "webkitRelativePath", { value: path });
  return created;
}

async function pick(label: string, files: File[]) {
  const input = await screen.findByLabelText(label);
  Object.defineProperty(input, "files", { value: files, configurable: true });
  fireEvent.change(input);
}

const status = () =>
  screen
    .getAllByRole("status")
    .map((node) => node.textContent)
    .join(" | ");
const publishes = () =>
  server.requests.filter((r) => r.method === "POST" && r.path === "/api/v1/publishes");

async function review() {
  return screen.findByRole("heading", { name: "Review before publishing" });
}

describe("publishing a new artifact", () => {
  it("publishes a folder after showing what is published, what is left out and who can open it", async () => {
    const { container } = renderDashboard("/publish", server);
    await screen.findByRole("heading", { level: 1, name: "Publish" });
    expect(screen.getByRole("group", { name: "Type" })).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Q3 report" },
    });
    await pick("Choose a folder", [
      file("report/index.html", "<h1>Q3</h1>", true),
      file("report/assets/app.js", "1", true),
      file("report/.git/config", "[core]", true),
      file("report/.env", "TOKEN=1", true),
    ]);
    await review();
    expect(server.requests.some((r) => r.path === "/api/v1/publishes")).toBe(false);
    const table = screen.getByRole("table", { name: "Files to publish" });
    expect(
      within(table)
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.firstChild?.textContent),
    ).toEqual(["index.html", "assets/app.js"]);
    expect(screen.getByText("2 entries left out")).toBeTruthy();
    expect(screen.getByText(".git").parentElement?.textContent).toBe(
      ".git: version control, dependencies or caches",
    );
    expect(screen.getByText(".env").parentElement?.textContent).toBe(".env: may hold secrets");
    expect(screen.getByText(/Only you\. After publishing, you can share it/)).toBeTruthy();
    expect(screen.getByText("Q3 report")).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(await screen.findByText("Published version 1")).toBeTruthy();
    const created = server.artifacts.at(-1);
    expect(created?.name).toBe("Q3 report");
    expect(
      screen.getByText(new RegExp(`It is live at https://${created?.id}\\.portifact\\.dev/`)),
    ).toBeTruthy();
    expect(server.uploads[0]?.request.files.map((f) => f.path)).toEqual([
      "index.html",
      "assets/app.js",
    ]);
    expect(server.uploads[0]?.request.baseVersionId).toBeNull();
    expect(server.storage.puts).toHaveLength(2);
    expect(status()).toContain("Published version 1 of Q3 report.");
    const link = screen.getByRole("link", { name: "Open the artifact page" });
    expect(link.getAttribute("href")).toBe(`/artifacts/${created?.id}`);
    expect(await axeViolations(container)).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Publish something else" }));
    expect(await screen.findByRole("group", { name: "Type" })).toBeTruthy();
  });

  it("names the artifact after the source and uploads only objects the account does not store", async () => {
    await seedVersion(server, ID, [{ path: "index.html", text: "<h1>Same</h1>" }]);
    renderDashboard("/publish", server);
    const bytes = zipSync({
      "site/index.html": strToU8("<h1>Same</h1>"),
      "site/new.css": strToU8("b{}"),
    });
    await pick("Choose a ZIP file", [file("site.zip", bytes)]);
    await review();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await screen.findByText("Published version 1");
    expect(server.artifacts.at(-1)?.name).toBe("site");
    expect(server.storage.puts.map((p) => p.size)).toEqual([3]);
    expect(status()).toBeTruthy();
  });

  it("offers a ZIP instead of a folder where the browser cannot pick folders", async () => {
    if (!hadFolders) delete prototype.webkitdirectory;
    renderDashboard("/publish", server);
    await screen.findByLabelText("Choose a ZIP file");
    expect(screen.queryByLabelText("Choose a folder")).toBeNull();
    expect(screen.getByText(/This browser cannot choose folders/)).toBeTruthy();
  });

  it("publishes pasted Markdown, asking for text first", async () => {
    const { container } = renderDashboard("/publish", server);
    fireEvent.click(await screen.findByRole("radio", { name: "Markdown" }));
    const text = await screen.findByRole("textbox", { name: "Or write it here" });
    expect(
      screen.getByText("Paste or type the document. It is published as document.md."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review this text" }));
    await waitFor(() => expect(text.getAttribute("aria-invalid")).toBe("true"));
    expect(screen.getByText("Write or paste the document first.")).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);

    fireEvent.change(text, { target: { value: "# Notes\n\nHello" } });
    fireEvent.click(screen.getByRole("button", { name: "Review this text" }));
    await review();
    expect(screen.getByText("Untitled")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await screen.findByText("Published version 1");
    expect(server.uploads[0]?.request).toMatchObject({
      type: "markdown",
      name: "Untitled",
      entrypoint: "document.md",
      files: [{ path: "document.md", contentType: "text/markdown; charset=utf-8" }],
    });
  });

  it("publishes a picked text file", async () => {
    renderDashboard("/publish", server);
    fireEvent.click(await screen.findByRole("radio", { name: "Text" }));
    await pick("Choose a file", [file("notes.txt", "plain")]);
    await review();
    expect(screen.getByText("notes.txt", { selector: "td code" })).toBeTruthy();
  });

  it("explains why a source cannot be published and stays on the first step", async () => {
    renderDashboard("/publish", server);
    await pick("Choose a ZIP file", [file("broken.zip", "not a zip")]);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("These files cannot be published");
    expect(alert.textContent).toContain("This is not a ZIP file, or it is damaged.");
    expect(screen.getByRole("group", { name: "Type" })).toBeTruthy();
    await pick("Choose files", [file("about.html", "a"), file("b.css", "b")]);
    expect(
      await screen.findByText(/The entry page index\.html is not among the files/),
    ).toBeTruthy();
  });

  it("resumes the same upload after storage could not be reached", async () => {
    renderDashboard("/publish", server);
    server.storage.fail({ network: true }, 3);
    await pick("Choose files", [file("page.html", "<p>x</p>")]);
    await review();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    const alert = await screen.findByRole("alert", {}, { timeout: 8000 });
    expect(alert.textContent).toContain("Storage could not be reached");
    fireEvent.click(screen.getByRole("button", { name: "Resume upload" }));
    await screen.findByText("Published version 1");
    expect(publishes()).toHaveLength(1);
    expect(
      server.requests.some((r) => r.method === "GET" && r.path === "/api/v1/publishes/up1"),
    ).toBe(true);
  }, 20_000);

  it("does not offer resuming when storage refuses the bytes, and starts over", async () => {
    renderDashboard("/publish", server);
    server.storage.fail({ status: 400 });
    await pick("Choose files", [file("page.html", "<p>x</p>")]);
    await review();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("index.html did not arrive intact");
    expect(screen.queryByRole("button", { name: "Resume upload" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect(await screen.findByRole("group", { name: "Type" })).toBeTruthy();
  });

  it("explains quota refusals in the terms of the limits", async () => {
    server.fail("POST", "/api/v1/publishes", { status: 429, code: "quota_exceeded" });
    renderDashboard("/publish", server);
    await pick("Choose files", [file("page.html", "<p>x</p>")]);
    await review();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "This does not fit your account's limits",
    );
  });

  it("cancels an upload, releasing it, and returns to the review", async () => {
    renderDashboard("/publish", server);
    await pick("Choose files", [file("page.html", "<p>x</p>")]);
    await review();
    server.storage.hold();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(await screen.findByRole("progressbar")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(status()).toContain("Upload cancelled. Nothing was published."));
    expect(
      server.requests.some((r) => r.method === "DELETE" && r.path === "/api/v1/publishes/up1"),
    ).toBe(true);
    expect(screen.getByRole("button", { name: "Publish" })).toBeTruthy();
    expect(server.uploads[0]?.state).toBe("aborted");
  });
});

describe("publishing a new version", () => {
  it("publishes on the current version and says access does not change", async () => {
    const first = await seedVersion(server, ID, [{ path: "index.html", text: "<h1>v1</h1>" }]);
    const { container } = renderDashboard(`/artifacts/${ID}/publish`, server);
    await screen.findByRole("heading", { level: 1, name: "New version of Launch plan" });
    expect(screen.queryByRole("group", { name: "Type" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
    await pick("Choose files", [file("v2.html", "<h1>v2</h1>")]);
    await review();
    expect(
      screen.getByText(
        "Anyone signed in to Portifact. Publishing a new version never changes who can open it.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await screen.findByText("Published version 2");
    expect(server.uploads[0]?.request).toMatchObject({
      artifactId: ID,
      baseVersionId: first.id,
      name: "Launch plan",
    });
    expect(screen.queryByRole("button", { name: "Publish something else" })).toBeNull();
  });

  it("reports a version published elsewhere meanwhile as a conflict", async () => {
    await seedVersion(server, ID, [{ path: "index.html", text: "<h1>v1</h1>" }]);
    renderDashboard(`/artifacts/${ID}/publish`, server);
    await pick("Choose files", [file("v2.html", "<h1>v2</h1>")]);
    await review();
    await seedVersion(server, ID, [{ path: "index.html", text: "<h1>elsewhere</h1>" }]);
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "A newer version was published meanwhile",
    );
    expect(screen.queryByRole("button", { name: "Resume upload" })).toBeNull();
  });

  it("refuses new versions of archived artifacts and explains a missing one", async () => {
    server.artifacts[0] = artifact(ID, { name: "Old", state: "archived" });
    renderDashboard(`/artifacts/${ID}/publish`, server);
    expect(await screen.findByText(/Restore it first if it is archived/)).toBeTruthy();
    cleanup();
    renderDashboard("/artifacts/zzzzzzzzzz/publish", server);
    expect(await screen.findByRole("alert", {}, { timeout: 3000 })).toBeTruthy();
  });
});
