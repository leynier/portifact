// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"enableIframePageLoading":true,"navigation":{"disableChildFrameNavigation":true}}}
// The viewer's side of the frame grant flow (decision 0026, "The grant", flow 1): the page's ask
// is only a hint, nothing happens before Allow, messages count only from the frame's window and
// the artifact's origin and only in the step that expects them, and a refused cookie offers a tab.
import type { DataGrantControl } from "@portifact/contracts";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { DataGrantPanel, useDataGrant } from "./review/data-grant.tsx";
import { type FakeServer, fakeServer, renderInDashboard } from "./test-support.tsx";

const ID = "k7d2qm4xab";
const ORIGIN = `https://${ID}.portifact.dev`;
const NONCE_HASH = "h".repeat(43);

const CONTROL: DataGrantControl = {
  artifactId: ID,
  artifactName: "Board",
  host: `${ID}.portifact.dev`,
  owner: { kind: "user", name: "Owner" },
  displayName: "Rea Der",
  grantDays: 30,
};

function Harness() {
  const frame = useRef<HTMLIFrameElement>(null);
  const grant = useDataGrant({ artifactId: ID, origin: ORIGIN, frame });
  return (
    <div>
      <DataGrantPanel artifactId={ID} origin={ORIGIN} grant={grant} />
      <iframe ref={frame} title="artifact" data-testid="frame" />
    </div>
  );
}

function setup(): { server: FakeServer; frame: HTMLIFrameElement } {
  const server = fakeServer();
  server.dataGrantControls[ID] = CONTROL;
  renderInDashboard(<Harness />, server);
  return { server, frame: screen.getByTestId("frame") as HTMLIFrameElement };
}

function post(frame: HTMLIFrameElement, data: unknown, origin = ORIGIN, source?: unknown) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data,
        origin,
        source: (source ?? frame.contentWindow) as MessageEventSource,
      }),
    );
  });
}

afterEach(cleanup);

describe("the viewer's frame grant", () => {
  it("draws the control on the page's ask and runs the flow only after Allow", async () => {
    const { server, frame } = setup();
    // A nonce before any Allow is ignored: nothing is issued.
    post(frame, { type: "portifact:data-grant-begin", nonceHash: NONCE_HASH });
    post(frame, { type: "portifact:data-grant-request", to: "/board" });
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    expect(frame.getAttribute("src") ?? frame.src).toBe(
      `${ORIGIN}/__portifact/data/grant/begin?flow=frame&to=%2Fboard`,
    );
    expect(server.bodies).toEqual([]);
    post(frame, { type: "portifact:data-grant-begin", nonceHash: NONCE_HASH });
    await waitFor(() => expect(frame.src).toContain("/__portifact/data/grant?flow=frame&code="));
    expect(server.bodies).toEqual([
      { artifactId: ID, nonceHash: NONCE_HASH, host: null, flow: "frame" },
    ]);
    post(frame, { type: "portifact:data-granted", to: "/board" });
    await waitFor(() => expect(screen.queryByText("Saving your choice")).toBeNull());
  });

  it("ignores messages from another origin or another window", async () => {
    const { frame } = setup();
    post(frame, { type: "portifact:data-grant-request" }, "https://evil.portifact.dev");
    post(frame, { type: "portifact:data-grant-request" }, ORIGIN, window);
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("offers the artifact in its own tab when the frame cannot keep the grant", async () => {
    const { frame } = setup();
    post(frame, { type: "portifact:data-grant-request", to: "/board" });
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    post(frame, { type: "portifact:data-grant-begin", nonceHash: NONCE_HASH });
    await waitFor(() => expect(frame.src).toContain("code="));
    post(frame, { type: "portifact:data-grant-unavailable", to: "/board" });
    const link = await screen.findByRole("link", { name: "Open in a new tab" });
    expect(link.getAttribute("href")).toBe(`${ORIGIN}/board`);
  });

  it("does nothing on Not now", async () => {
    const { server, frame } = setup();
    post(frame, { type: "portifact:data-grant-request" });
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(frame.src).toBe("");
    expect(server.bodies).toEqual([]);
  });

  it("shows an open grant and stops it from the viewer", async () => {
    const server = fakeServer();
    server.dataGrantControls[ID] = CONTROL;
    server.dataGrants = [
      {
        artifactId: ID,
        artifactName: "Board",
        host: `${ID}.portifact.dev`,
        openGrants: 1,
        firstGrantedAt: "2026-11-01T10:00:00.000Z",
        lastGrantedAt: "2026-11-01T10:00:00.000Z",
        expiresAt: "2026-12-01T10:00:00.000Z",
      },
    ];
    renderInDashboard(<Harness />, server);
    expect(await screen.findByText("This page saves what you enter")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop saving as me" }));
    await waitFor(() => expect(screen.queryByText("This page saves what you enter")).toBeNull());
    expect(server.dataGrants[0]?.openGrants).toBe(0);
  });

  it("shows nothing when the person has no open grant", async () => {
    setup();
    await waitFor(() => expect(screen.queryByText("This page saves what you enter")).toBeNull());
  });
});
