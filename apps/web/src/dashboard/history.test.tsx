// @vitest-environment happy-dom
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { unzipSync } from "fflate";
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
const PATH = `/artifacts/${ID}/history`;

let server: FakeServer;
beforeEach(async () => {
  server = fakeServer([artifact(ID, { name: "Launch plan" })]);
  await seedVersion(server, ID, [
    { path: "index.html", text: "<h1>v1</h1>" },
    { path: "src.zip", text: "zip bytes", kind: "source", contentType: "application/zip" },
  ]);
  await seedVersion(server, ID, [
    { path: "index.html", text: "<h1>v2</h1>" },
    { path: "app.js", text: "1", contentType: "text/javascript" },
  ]);
});

const rows = async () => {
  const table = await screen.findByRole("table", { name: "Versions, newest first" });
  return within(table).getAllByRole("row").slice(1);
};
const status = () =>
  screen
    .getAllByRole("status")
    .map((node) => node.textContent)
    .join(" | ");

describe("version history", () => {
  it("lists versions with the current one marked, their files and how long they are kept", async () => {
    const { container } = renderDashboard(PATH, server);
    await screen.findByRole("heading", { level: 1, name: "History of Launch plan" });
    const [current, previous] = await rows();
    expect(current?.textContent).toContain("Version 2");
    expect(current?.textContent).toContain("Current");
    expect(current?.textContent).toContain("2 files, 12 bytes");
    expect(current?.textContent).toContain("While current");
    expect(previous?.textContent).toContain("Version 1");
    expect(previous?.textContent).toContain("1 source, 9 bytes");
    expect(previous?.textContent).not.toContain("Current");
    expect(
      within(current as HTMLElement).queryByRole("button", { name: "Roll back to version 2" }),
    ).toBeNull();
    expect(
      within(current as HTMLElement).queryByRole("button", {
        name: "Download the sources of version 2",
      }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Download the sources of version 1" })).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("downloads several files as a checked ZIP and a single file as itself", async () => {
    const { saved } = renderDashboard(PATH, server);
    fireEvent.click(await screen.findByRole("button", { name: "Download the files of version 2" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]?.fileName).toBe("Launch plan-v2.zip");
    const zip = saved[0]?.blob as Blob;
    const files = unzipSync(new Uint8Array(await zip.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(["app.js", "index.html"]);
    expect(status()).toContain("Launch plan-v2.zip is ready.");

    fireEvent.click(screen.getByRole("button", { name: "Download the sources of version 1" }));
    await waitFor(() => expect(saved).toHaveLength(2));
    expect(saved[1]?.fileName).toBe("src.zip");
    expect(await saved[1]?.blob.text()).toBe("zip bytes");
  });

  it("refuses to save a download that does not match its checksum", async () => {
    const { saved } = renderDashboard(PATH, server);
    server.storage.fail({ corrupt: true });
    fireEvent.click(
      await screen.findByRole("button", { name: "Download the sources of version 1" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The download did not finish");
    expect(alert.textContent).toContain("src.zip did not match its checksum");
    expect(saved).toEqual([]);
  });

  it("rolls back after a confirmation, as a new version", async () => {
    const { container } = renderDashboard(PATH, server);
    fireEvent.click(await screen.findByRole("button", { name: "Roll back to version 1" }));
    const dialog = await screen.findByRole("dialog", { name: "Roll back to version 1?" });
    expect(dialog.textContent).toContain("Who can open the artifact does not change.");
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.requests.some((r) => r.path.endsWith("/rollback"))).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Roll back to version 1" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Roll back" }),
    );
    await waitFor(() => expect(status()).toContain("Version 1 is published again as version 3."));
    expect(server.bodies.at(-1)).toEqual({ versionId: `ver${ID}1`, baseVersionId: `ver${ID}2` });
    const [first] = await rows();
    await waitFor(() => expect(first?.isConnected && first.textContent).toContain("Version 3"));
  });

  it("reports a rollback refused because the artifact changed meanwhile", async () => {
    renderDashboard(PATH, server);
    fireEvent.click(await screen.findByRole("button", { name: "Roll back to version 1" }));
    await seedVersion(server, ID, [{ path: "index.html", text: "elsewhere" }]);
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Roll back" }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "The artifact changed meanwhile",
    );
  });

  it("shows an empty history and retries a failed load", async () => {
    server.versions[ID] = [];
    renderDashboard(PATH, server);
    expect(await screen.findByText("No versions yet")).toBeTruthy();
    cleanup();
    server.fail("GET", `/api/v1/artifacts/${ID}/versions`, { status: 500 }, 2);
    renderDashboard(PATH, server);
    const alert = await screen.findByRole("alert", {}, { timeout: 3000 });
    expect(alert.textContent).toContain("Versions could not be loaded");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No versions yet")).toBeTruthy();
  });

  it("pages through older versions", async () => {
    server.pageSize = 1;
    renderDashboard(PATH, server);
    expect(await rows()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Load older versions" }));
    await waitFor(async () => expect(await rows()).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Load older versions" })).toBeNull();
  });
});

describe("archive view", () => {
  beforeEach(() => {
    Object.assign(server.artifacts[0] ?? {}, {
      state: "archived",
      archivedAt: "2026-11-01T12:00:00.000Z",
      purgeAt: "2027-05-01T12:00:00.000Z",
    });
  });

  it("shows the purge date and offers restore and delete, but not rollback", async () => {
    const { container } = renderDashboard(PATH, server);
    const region = await screen.findByRole("region", { name: "Archived" });
    expect(region.textContent).toContain("It is deleted for good on May 1, 2027");
    expect(screen.queryByRole("button", { name: /Roll back to/ })).toBeNull();
    expect(
      await screen.findByText("Rollback is available while the artifact is active."),
    ).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);

    fireEvent.click(within(region).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(status()).toContain("Artifact restored."));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Archived" })).toBeNull());
  });

  it("deletes only after a confirmation, then returns to the list", async () => {
    const { router } = renderDashboard(PATH, server);
    const region = await screen.findByRole("region", { name: "Archived" });
    fireEvent.click(within(region).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Launch plan?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete artifact" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(server.artifacts).toEqual([]);
  });

  it("explains a failed restore and an archive without a purge date", async () => {
    Object.assign(server.artifacts[0] ?? {}, { purgeAt: null });
    server.fail("POST", `/api/v1/artifacts/${ID}/restore`, { status: 429, code: "quota_exceeded" });
    renderDashboard(PATH, server);
    const region = await screen.findByRole("region", { name: "Archived" });
    expect(region.textContent).toContain("deleted for good after six months");
    fireEvent.click(within(region).getByRole("button", { name: "Restore" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "You reached the limit of active artifacts",
    );
  });

  it("shows a missing artifact like the detail page", async () => {
    renderDashboard("/artifacts/zzzzzzzzzz/history", server);
    expect(
      await screen.findByRole("heading", { name: "Artifact not found" }, { timeout: 3000 }),
    ).toBeTruthy();
  });
});
