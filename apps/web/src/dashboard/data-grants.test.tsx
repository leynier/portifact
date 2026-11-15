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

  it.each(["download", "delete"] as const)(
    "refuses an incomplete %s when more pages remain",
    async (action) => {
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
      const fetch = server.fetch.bind(server);
      let pages = 0;
      let deletes = 0;
      server.fetch = async (input, init) => {
        if (input.includes(`/data-grants/${ID}/mine`)) {
          pages += 1;
          return Response.json({
            rows: [{ collection: "votes", id: "a".repeat(16), body: '{"choice":"a"}' }],
            next: `votes:${String(pages).padStart(16, "0")}`,
            revision: 1,
          });
        }
        if (init?.method === "DELETE") deletes += 1;
        return fetch(input, init);
      };
      const view = renderDashboard("/shared-data", server);
      if (action === "download") {
        fireEvent.click(
          await screen.findByRole("button", { name: "Download what you saved in Board" }),
        );
        expect(await screen.findByText("The download did not finish")).toBeTruthy();
      } else {
        fireEvent.click(
          await screen.findByRole("button", { name: "Delete what you saved in Board" }),
        );
        const dialog = await screen.findByRole("dialog", {
          name: "Delete what you saved in Board?",
        });
        fireEvent.click(within(dialog).getByRole("button", { name: "Delete what I saved" }));
        expect(await screen.findByText("Deleting did not finish")).toBeTruthy();
      }
      expect(pages).toBe(200);
      expect(view.saved).toEqual([]);
      expect(deletes).toBe(0);
    },
  );

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
  });

  it("says when nothing was shared", async () => {
    renderDashboard("/shared-data", fakeServer());
    expect(await screen.findByText("Nothing shared yet")).toBeTruthy();
  });
});
