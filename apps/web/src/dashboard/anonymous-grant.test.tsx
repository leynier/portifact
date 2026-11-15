// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"enableIframePageLoading":true,"navigation":{"disableChildFrameNavigation":true}}}
// The consent control for visitors without an account (decision 0026, delivery 9): the grant page
// and the viewer's frame draw it signed out where the artifact is open to anyone, run the human
// check only once the visitor chose Allow, after Portifact's notice and the statement beside it,
// send its token with the code's request, and ask to sign in otherwise.
import type { AnonymousDataGrantControl, DataGrantControl } from "@portifact/contracts";
import { axeViolations } from "@portifact/ui/testing";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { HumanCheckWidget } from "../human-check/turnstile.ts";
import { DataGrantPanel, useDataGrant } from "./review/data-grant.tsx";
import {
  type FakeServer,
  fakeServer,
  renderDashboard,
  renderInDashboard,
} from "./test-support.tsx";

const ID = "k7d2qm4xab";
const HOST = `${ID}.portifact.dev`;
const ORIGIN = `https://${HOST}`;
const NONCE = "n".repeat(43);

const ANONYMOUS: AnonymousDataGrantControl = {
  artifactId: ID,
  artifactName: "Board",
  host: HOST,
  owner: { kind: "user", name: "Owner" },
  grantDays: 7,
};

const PERSON: DataGrantControl = {
  artifactId: ID,
  artifactName: "Board",
  host: HOST,
  owner: { kind: "user", name: "Owner" },
  displayName: "Rea Der",
  grantDays: 30,
};

/** A widget that solves at once with `token`, or never runs when `token` is null. */
function widget(token: string | null): HumanCheckWidget & { rendered: number } {
  const fake = {
    rendered: 0,
    render(
      _container: HTMLElement,
      callbacks: Parameters<HumanCheckWidget["render"]>[1],
      options: Parameters<HumanCheckWidget["render"]>[2],
    ) {
      fake.rendered += 1;
      expect(options?.appearance).toBe("interaction-only");
      if (token === null) queueMicrotask(() => callbacks.onError?.());
      else queueMicrotask(() => callbacks.onToken(token));
      return () => {};
    },
  };
  return fake;
}

function signedOut(): FakeServer {
  const server = fakeServer();
  server.email = null;
  return server;
}

/** Portifact's notice with the Privacy Policy, and the statement beside Allow that describes it. */
function expectGrantLegal(control: HTMLElement) {
  const link = (name: string) => within(control).getByRole("link", { name });
  for (const [name, href] of [
    ["Privacy Policy", "https://portifact.com/privacy"],
    ["Terms of Service", "https://portifact.com/terms"],
    ["Acceptable Use Policy", "https://portifact.com/acceptable-use"],
  ] as const) {
    expect(link(name).getAttribute("href")).toBe(href);
    expect(link(name).getAttribute("target")).toBe("_blank");
    expect(link(name).getAttribute("rel")).toBe("noopener");
  }
  expect(
    within(control).getByText(/Portifact hosts this page and draws this control/),
  ).toBeTruthy();
  const allow = within(control).getByRole("button", { name: "Allow" });
  const statement = document.getElementById(allow.getAttribute("aria-describedby") ?? "");
  expect(statement?.textContent).toBe(
    "By choosing Allow, you confirm that you are 18 or older and you agree to the Terms of Service and the Acceptable Use Policy for what you save here. The links open in a new tab.",
  );
  expect(statement && control.contains(statement)).toBe(true);
}

afterEach(cleanup);

describe("the grant page without a session", () => {
  it("draws the anonymous control and leaves with the code after the human check", async () => {
    const server = signedOut();
    server.anonymousGrantControls[ID] = ANONYMOUS;
    const check = widget("solved-token");
    const view = renderDashboard(`/data/grant?artifact=${ID}&nonce=${NONCE}`, server, {
      humanCheck: check,
    });
    const heading = await screen.findByRole("heading", {
      name: `Let ${HOST} save what you enter, without an account?`,
    });
    const control = heading.closest("section") as HTMLElement;
    expect(within(control).getByText(/no name, no email and no account/)).toBeTruthy();
    expect(within(control).getByText(/lasts 7 days/)).toBeTruthy();
    const signIn = within(control).getByRole("link", { name: "Sign in instead" });
    expect(
      new URL(signIn.getAttribute("href") as string, "https://app.test").searchParams.get("next"),
    ).toBe(`/data/grant?artifact=${ID}&nonce=${NONCE}`);
    expectGrantLegal(control);
    // Nothing reaches Cloudflare while the visitor only reads.
    expect(check.rendered).toBe(0);
    expect(await axeViolations(view.container)).toEqual([]);

    fireEvent.click(within(control).getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(view.left).toHaveLength(1));
    expect(check.rendered).toBe(1);
    const url = new URL(view.left[0] as string);
    expect(url.origin).toBe(ORIGIN);
    expect(url.searchParams.get("anon")).toBe("1");
    expect(server.bodies.at(-1)).toEqual({
      artifactId: ID,
      nonceHash: NONCE,
      host: null,
      flow: "top",
      turnstileToken: "solved-token",
    });
    // Nothing about the session's own grants was asked.
    expect(server.requests.some((request) => request.path.includes("/account/data-grants"))).toBe(
      false,
    );
  });

  it("says when the server refused the human check, and asks nothing without a token", async () => {
    const server = signedOut();
    server.anonymousGrantControls[ID] = ANONYMOUS;
    const view = renderDashboard(`/data/grant?artifact=${ID}&nonce=${NONCE}`, server, {
      humanCheck: widget("stale-token"),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    expect(
      await screen.findByText("The check that you are human did not pass. Try Allow again."),
    ).toBeTruthy();
    expect(view.left).toEqual([]);
    cleanup();

    const quiet = signedOut();
    quiet.anonymousGrantControls[ID] = ANONYMOUS;
    renderDashboard(`/data/grant?artifact=${ID}&nonce=${NONCE}`, quiet, {
      humanCheck: widget(null),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    expect(await screen.findByText(/could not run in this browser/)).toBeTruthy();
    expect(quiet.bodies).toEqual([]);
  });

  it("offers signing in where the artifact is not open to people without an account", async () => {
    const server = signedOut();
    renderDashboard(`/data/grant?artifact=${ID}&nonce=${NONCE}`, server);
    expect(await screen.findByText(/saves only for people who sign in/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in instead" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("keeps the person's control when signed in", async () => {
    const server = fakeServer();
    server.dataGrantControls[ID] = PERSON;
    server.anonymousGrantControls[ID] = ANONYMOUS;
    renderDashboard(`/data/grant?artifact=${ID}&nonce=${NONCE}`, server);
    expect(
      await screen.findByRole("heading", { name: `Let ${HOST} save what you enter?` }),
    ).toBeTruthy();
    expect(screen.queryByText(/without an account/)).toBeNull();
  });
});

function Harness() {
  const frame = useRef<HTMLIFrameElement>(null);
  const grant = useDataGrant({ artifactId: ID, origin: ORIGIN, frame, anonymous: true });
  return (
    <div>
      <DataGrantPanel artifactId={ID} origin={ORIGIN} grant={grant} signInPath={`/view/${ID}`} />
      <iframe ref={frame} title="artifact" data-testid="frame" />
    </div>
  );
}

function post(frame: HTMLIFrameElement, data: unknown) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data,
        origin: ORIGIN,
        source: frame.contentWindow as MessageEventSource,
      }),
    );
  });
}

describe("the viewer's frame for a visitor without an account", () => {
  it("runs the frame flow with the anonymous code and the human check's token", async () => {
    const server = signedOut();
    server.anonymousGrantControls[ID] = ANONYMOUS;
    const check = widget("solved-frame");
    const view = renderInDashboard(<Harness />, server, { humanCheck: check });
    const frame = screen.getByTestId("frame") as HTMLIFrameElement;
    post(frame, { type: "portifact:data-grant-request", to: "/board" });
    const allow = await screen.findByRole("button", { name: "Allow" });
    expectGrantLegal(allow.closest("section") as HTMLElement);
    expect(check.rendered).toBe(0);
    expect(await axeViolations(view.container)).toEqual([]);
    fireEvent.click(allow);
    await waitFor(() =>
      expect(frame.getAttribute("src") ?? frame.src).toContain("/grant/begin?flow=frame"),
    );
    expect(server.bodies).toEqual([]);
    post(frame, { type: "portifact:data-grant-begin", nonceHash: NONCE });
    await waitFor(() => expect(frame.src).toContain("anon=1"));
    expect(server.bodies).toEqual([
      {
        artifactId: ID,
        nonceHash: NONCE,
        host: null,
        flow: "frame",
        turnstileToken: "solved-frame",
      },
    ]);
  });

  it("asks to sign in where the artifact is not open to anyone", async () => {
    const server = signedOut();
    renderInDashboard(<Harness />, server);
    const frame = screen.getByTestId("frame") as HTMLIFrameElement;
    post(frame, { type: "portifact:data-grant-request" });
    expect(await screen.findByText("Sign in to save")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Sign in instead" });
    expect(link.getAttribute("href")).toBe(`/login?next=%2Fview%2F${ID}`);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByText("Sign in to save")).toBeNull();
  });

  it("says why when the server refuses the human check", async () => {
    const server = signedOut();
    server.anonymousGrantControls[ID] = ANONYMOUS;
    renderInDashboard(<Harness />, server, { humanCheck: widget("stale") });
    const frame = screen.getByTestId("frame") as HTMLIFrameElement;
    post(frame, { type: "portifact:data-grant-request" });
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    await waitFor(() => expect(frame.src).toContain("/grant/begin"));
    post(frame, { type: "portifact:data-grant-begin", nonceHash: NONCE });
    expect(await screen.findByText(/did not pass/)).toBeTruthy();
  });
});
