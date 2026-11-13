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

  it("says when nothing was shared", async () => {
    renderDashboard("/shared-data", fakeServer());
    expect(await screen.findByText("Nothing shared yet")).toBeTruthy();
  });
});
