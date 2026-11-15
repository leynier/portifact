// @vitest-environment happy-dom
// The consent control of artifact data and "Data you shared" (decision 0026, "The grant").
import type { DataGrantControl } from "@portifact/contracts";
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { fakeServer, renderDashboard } from "./test-support.tsx";

const ID = "k7d2qm4xab";
const HOST = `${ID}.portifact.dev`;
const NONCE = "n".repeat(43);

const CONTROL: DataGrantControl = {
  artifactId: ID,
  artifactName: "Board",
  host: HOST,
  owner: { kind: "workspace", name: "Acme" },
  displayName: "Rea Der",
  grantDays: 30,
};

afterEach(cleanup);

describe("the consent control page", () => {
  it("says what the page learns and sends the browser to the artifact with the code on Allow", async () => {
    const server = fakeServer();
    server.dataGrantControls[ID] = CONTROL;
    const view = renderDashboard(`/data/grant?artifact=${ID}&nonce=${NONCE}`, server);
    const heading = await screen.findByRole("heading", {
      name: `Let ${HOST} save what you enter?`,
    });
    const control = heading.closest("section") as HTMLElement;
    expect(within(control).getByText("Published by the workspace Acme")).toBeTruthy();
    expect(within(control).getByText(/know you as Rea Der/)).toBeTruthy();
    expect(within(control).getByText(/never learns your email/)).toBeTruthy();
    expect(await axeViolations(view.container)).toEqual([]);

    fireEvent.click(within(control).getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(view.left).toHaveLength(1));
    const url = new URL(view.left[0] as string);
    expect(url.origin).toBe(`https://${HOST}`);
    expect(url.pathname).toBe("/__portifact/data/grant");
    expect(url.searchParams.get("flow")).toBe("top");
    expect(server.bodies.at(-1)).toEqual({
      artifactId: ID,
      nonceHash: NONCE,
      host: null,
      flow: "top",
    });
  });

  it("returns to the artifact on Not now, without asking for a code", async () => {
    const server = fakeServer();
    server.dataGrantControls[ID] = CONTROL;
    const view = renderDashboard(`/data/grant?artifact=${ID}&nonce=${NONCE}`, server);
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(view.left).toEqual([`https://${HOST}/`]);
    expect(server.bodies).toEqual([]);
  });

  it("refuses a malformed request or an artifact the person cannot open", async () => {
    const server = fakeServer();
    renderDashboard(`/data/grant?artifact=${ID}&nonce=short`, server);
    expect(await screen.findByText("This request cannot be used")).toBeTruthy();
    cleanup();
    renderDashboard(`/data/grant?artifact=${ID}&nonce=${NONCE}`, server);
    expect(await screen.findByText("This request cannot be used")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });
});

describe("Data you shared", () => {
  it("lists the artifacts and revokes after a confirmation", async () => {
    const server = fakeServer();
    server.dataGrants = [
      {
        artifactId: ID,
        artifactName: "Board",
        host: HOST,
        openGrants: 2,
        firstGrantedAt: "2026-11-01T10:00:00.000Z",
        lastGrantedAt: "2026-11-10T10:00:00.000Z",
        expiresAt: "2026-12-10T10:00:00.000Z",
      },
      {
        artifactId: "p3n5wq7yzc",
        artifactName: null,
        host: "p3n5wq7yzc.portifact.dev",
        openGrants: 0,
        firstGrantedAt: "2026-10-01T10:00:00.000Z",
        lastGrantedAt: "2026-10-01T10:00:00.000Z",
        expiresAt: null,
      },
    ];
    const view = renderDashboard("/shared-data", server);
    expect(await screen.findByText("Board")).toBeTruthy();
    expect(screen.getByText("Artifact no longer available")).toBeTruthy();
    expect(screen.getByText("Ended")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Revoke/ })).toHaveLength(1);
    expect(await axeViolations(view.container)).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Revoke Board" }));
    const dialog = await screen.findByRole("dialog", { name: "Revoke Board?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(screen.getAllByText("Ended")).toHaveLength(2));
    expect(server.dataGrants[0]?.openGrants).toBe(0);
  });

  it("reaches every artifact through Show more", async () => {
    const server = fakeServer();
    server.dataGrants = ["a", "b", "c"].map((letter, n) => ({
      artifactId: `${letter.repeat(9)}2`,
      artifactName: `Board ${letter}`,
      host: `${letter.repeat(9)}2.portifact.dev`,
      openGrants: 1,
      firstGrantedAt: "2026-11-01T10:00:00.000Z",
      lastGrantedAt: `2026-11-0${n + 1}T10:00:00.000Z`,
      expiresAt: "2026-12-10T10:00:00.000Z",
    }));
    renderDashboard("/shared-data", server);
    expect(await screen.findByText("Board a")).toBeTruthy();
    expect(screen.queryByText("Board c")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(await screen.findByText("Board c")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("downloads and deletes what the person saved, after a confirmation", async () => {
    const server = fakeServer();
    server.dataGrants = [
      {
        artifactId: ID,
        artifactName: "Board",
        host: HOST,
        openGrants: 0,
        firstGrantedAt: "2026-11-01T10:00:00.000Z",
        lastGrantedAt: "2026-11-01T10:00:00.000Z",
        expiresAt: null,
      },
    ];
    server.ownData[ID] = [
      { collection: "votes", id: "a".repeat(16), body: '{"choice":"a"}' },
      { collection: "votes", id: "b".repeat(16), body: '{"choice":"b"}' },
    ];
    const view = renderDashboard("/shared-data", server);
    fireEvent.click(
      await screen.findByRole("button", { name: "Download what you saved in Board" }),
    );
    await waitFor(() => expect(view.saved).toHaveLength(1));
    const file = view.saved[0];
    expect(file?.fileName).toBe("Board-my-data.jsonl");
    expect((await file?.blob.text())?.trim().split("\n")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Delete what you saved in Board" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete what you saved in Board?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete what I saved" }));
    await waitFor(() => expect(server.ownData[ID]).toEqual([]));
    // A closed grant offers no Revoke, but the person's documents stay theirs to take or delete.
    expect(screen.queryByRole("button", { name: "Revoke Board" })).toBeNull();
  });

  it("pauses a download when the day's allowance is spent, keeps the part and the cursor, and continues", async () => {
    localStorage.clear();
    const server = fakeServer();
    server.dataGrants = [
      {
        artifactId: ID,
        artifactName: "Board",
        host: HOST,
        openGrants: 0,
        firstGrantedAt: "2026-11-01T10:00:00.000Z",
        lastGrantedAt: "2026-11-01T10:00:00.000Z",
        expiresAt: null,
      },
    ];
    // 501 documents and an allowance of 500 charged rows, as on Free: one page a day.
    server.ownData[ID] = Array.from({ length: 501 }, (_, n) => ({
      collection: "votes",
      id: String(n).padStart(16, "0"),
      body: `{"n":${n}}`,
    }));
    server.ownDataAllowance = 500;
    const first = renderDashboard("/shared-data", server);
    fireEvent.click(
      await screen.findByRole("button", { name: "Download what you saved in Board" }),
    );
    expect(await screen.findByText("Download paused")).toBeTruthy();
    expect(screen.getAllByText(/500 documents downloaded so far/).length).toBeGreaterThan(0);
    expect(first.saved.map((file) => file.fileName)).toEqual(["Board-my-data-part-1.jsonl"]);
    expect((await first.saved[0]?.blob.text())?.trim().split("\n")).toHaveLength(500);
    cleanup();

    // The next day, in a new page: the download continues from where it stopped.
    server.ownDataAllowance = 500;
    const second = renderDashboard("/shared-data", server);
    fireEvent.click(
      await screen.findByRole("button", { name: "Continue downloading what you saved in Board" }),
    );
    await waitFor(() => expect(second.saved).toHaveLength(1));
    expect(second.saved[0]?.fileName).toBe("Board-my-data-part-2.jsonl");
    const rest = (await second.saved[0]?.blob.text())?.trim().split("\n") ?? [];
    expect(rest.map((line) => (JSON.parse(line) as { id: string }).id)).toEqual([
      String(500).padStart(16, "0"),
    ]);
    expect(
      await screen.findByRole("button", { name: "Download what you saved in Board" }),
    ).toBeTruthy();
    expect(localStorage.getItem(`portifact.sharedData.download.${ID}`)).toBeNull();
  });

  it("starts a paused download over on request", async () => {
    localStorage.setItem(
      `portifact.sharedData.download.${ID}`,
      JSON.stringify({ after: "votes:zzzz", part: 3, saved: 1000 }),
    );
    const server = fakeServer();
    server.dataGrants = [
      {
        artifactId: ID,
        artifactName: "Board",
        host: HOST,
        openGrants: 0,
        firstGrantedAt: "2026-11-01T10:00:00.000Z",
        lastGrantedAt: "2026-11-01T10:00:00.000Z",
        expiresAt: null,
      },
    ];
    server.ownData[ID] = [{ collection: "votes", id: "a".repeat(16), body: '{"choice":"a"}' }];
    const view = renderDashboard("/shared-data", server);
    fireEvent.click(
      await screen.findByRole("button", { name: "Start the download of Board over" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Download what you saved in Board" }),
    );
    await waitFor(() => expect(view.saved).toHaveLength(1));
    expect(view.saved[0]?.fileName).toBe("Board-my-data.jsonl");
  });

  it("deletes in small batches, pauses when the allowance is spent and continues without exporting everything", async () => {
    localStorage.clear();
    const server = fakeServer();
    server.dataGrants = [
      {
        artifactId: ID,
        artifactName: "Board",
        host: HOST,
        openGrants: 0,
        firstGrantedAt: "2026-11-01T10:00:00.000Z",
        lastGrantedAt: "2026-11-01T10:00:00.000Z",
        expiresAt: null,
      },
    ];
    server.ownData[ID] = Array.from({ length: 45 }, (_, n) => ({
      collection: "votes",
      id: String(n).padStart(16, "0"),
    }));
    // The first batch reads 20 (21 charged), then 9 deletes spend the rest.
    server.ownDataAllowance = 30;
    renderDashboard("/shared-data", server);
    fireEvent.click(await screen.findByRole("button", { name: "Delete what you saved in Board" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete what you saved in Board?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete what I saved" }));
    expect(await within(dialog).findByText("Deleting paused")).toBeTruthy();
    expect(within(dialog).getByText(/9 documents deleted so far/)).toBeTruthy();
    expect(server.ownData[ID]).toHaveLength(36);
    const pages = server.requests.filter((request) => request.path.includes("/mine"));
    expect(pages.map((request) => request.path)).toEqual([
      `/api/v1/account/data-grants/${ID}/mine?take=20`,
    ]);

    server.ownDataAllowance = 1000;
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue deleting" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.ownData[ID]).toEqual([]);
    expect(
      server.requests
        .filter((request) => request.path.includes("/mine"))
        .every((request) => request.path.endsWith("?take=20")),
    ).toBe(true);
  });

  it("says a download failed when nothing came", async () => {
    localStorage.clear();
    const server = fakeServer();
    server.dataGrants = [
      {
        artifactId: ID,
        artifactName: "Board",
        host: HOST,
        openGrants: 0,
        firstGrantedAt: "2026-11-01T10:00:00.000Z",
        lastGrantedAt: "2026-11-01T10:00:00.000Z",
        expiresAt: null,
      },
    ];
    server.fail("GET", `/api/v1/account/data-grants/${ID}/mine`, { status: 500 });
    const view = renderDashboard("/shared-data", server);
    fireEvent.click(
      await screen.findByRole("button", { name: "Download what you saved in Board" }),
    );
    expect(await screen.findByText("The download did not finish")).toBeTruthy();
    expect(view.saved).toEqual([]);
  });

  it("sends a request to the people who manage the artifact", async () => {
    const server = fakeServer();
    server.dataGrants = [
      {
        artifactId: ID,
        artifactName: "Board",
        host: HOST,
        openGrants: 0,
        firstGrantedAt: "2026-11-01T10:00:00.000Z",
        lastGrantedAt: "2026-11-01T10:00:00.000Z",
        expiresAt: null,
      },
    ];
    renderDashboard("/shared-data", server);
    fireEvent.click(await screen.findByRole("button", { name: "Ask the people who manage Board" }));
    const dialog = await screen.findByRole("dialog", { name: "Ask about what you saved in Board" });
    expect(within(dialog).getByText(/never by your name or email/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("radio", { name: "Erase what I saved" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Send the request" }));
    await waitFor(() => expect(server.bodies.at(-1)).toEqual({ kind: "erasure" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Received and kept, not yet emailed: the job delivers it.
    expect(await screen.findByText(/Your request about Board was received/)).toBeTruthy();
  });

  it("says when nothing was shared", async () => {
    renderDashboard("/shared-data", fakeServer());
    expect(await screen.findByText("Nothing shared yet")).toBeTruthy();
  });
});
