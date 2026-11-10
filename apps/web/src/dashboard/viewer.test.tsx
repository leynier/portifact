// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"enableIframePageLoading":true,"navigation":{"disableChildFrameNavigation":true}}}
// The frame never navigates in these tests: the bridge is played by messages from a stand-in
// window, and the frame's own page load is covered by the end-to-end tests.
import {
  BRIDGE_LIMITS,
  REVIEW_CHANNEL,
  REVIEW_PROTOCOL,
  type ViewerMessage,
} from "@portifact/bridge";
import type { AnnotationTarget, ReviewStart } from "@portifact/contracts";
import { axeViolations } from "@portifact/ui/testing";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HumanCheckWidget } from "../human-check/turnstile.ts";
import { BRIDGE_TIMEOUT_MS } from "./review/use-bridge.ts";
import { FRAME_SANDBOX, REVIEW_TAB_LINK_MS, SIDEBAR_STORAGE_KEY } from "./screens/viewer.tsx";
import {
  artifact,
  choose,
  type FakeServer,
  fakeMessage,
  fakeServer,
  fakeThread,
  renderDashboard,
  seedVersion,
  selectOptions,
} from "./test-support.tsx";

const ID = "k7d2qm4xab";
const ORIGIN = `https://${ID}.portifact.dev`;
const PATH = `/view/${ID}`;
const CODE_URL = `${ORIGIN}/__portifact/review?code=${"c".repeat(43)}`;
const SESSION_TAG = "s".repeat(22);

const START: ReviewStart = {
  artifactId: ID,
  name: "Launch plan",
  type: "site",
  url: CODE_URL,
  origin: ORIGIN,
  versionId: "v1",
  entrypoint: "index.html",
  sessionTag: SESSION_TAG,
  expiresAt: "2026-11-08T12:01:00.000Z",
};

const TEXT_TARGET: AnnotationTarget = {
  schema: 1,
  path: "index.html",
  anchor: {
    kind: "text",
    quote: { exact: "brave new world", prefix: "Hello ", suffix: "" },
    position: { start: 6, end: 21 },
  },
};

const ELEMENT_TARGET: AnnotationTarget = {
  schema: 1,
  path: "index.html",
  anchor: { kind: "element", selectors: ["#buy"], tagName: "button", fingerprint: "Buy now" },
};

/** The artifact frame's window, as the viewer sees it: it can only post to it. */
let frameWindow: { postMessage: ReturnType<typeof vi.fn> };
let server: FakeServer;

/** happy-dom lays nothing out: the frame's layer and what floats in it get these sizes. */
const LAYER = { width: 800, height: 600 };
const FLOATING = { width: 100, height: 32 };
const LAYOUT = {
  clientWidth: LAYER.width,
  clientHeight: LAYER.height,
  offsetWidth: FLOATING.width,
  offsetHeight: FLOATING.height,
};

beforeEach(() => {
  for (const [name, value] of Object.entries(LAYOUT)) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
  }
  frameWindow = { postMessage: vi.fn() };
  Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
    configurable: true,
    get: () => frameWindow,
  });
  server = fakeServer([artifact(ID, { name: "Launch plan" })]);
  server.email = "ada@example.test";
  server.reviews[ID] = START;
  server.annotations[ID] = {
    mode: "open",
    role: "owner",
    currentVersionId: "v1",
    threads: [
      {
        ...fakeThread("t1", {
          target: TEXT_TARGET,
          messages: [fakeMessage({ id: "m1", body: "Secret feedback for the owner" })],
        }),
        seq: 1,
      },
      { ...fakeThread("t2", { createdAt: "2026-11-08T12:05:00.000Z" }), seq: 2 },
    ],
    deleted: [],
    seq: 2,
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  Reflect.deleteProperty(HTMLIFrameElement.prototype, "contentWindow");
  for (const name of Object.keys(LAYOUT)) Reflect.deleteProperty(HTMLElement.prototype, name);
});

/** Delivers a message to the viewer as if `source` posted it from `origin`. */
function deliver(data: unknown, origin = ORIGIN, source: unknown = frameWindow) {
  const event = new MessageEvent("message", { data, origin });
  Object.defineProperty(event, "source", { value: source });
  act(() => {
    window.dispatchEvent(event);
  });
}

const sent = () =>
  frameWindow.postMessage.mock.calls.map(([message, origin]) => ({
    message: message as ViewerMessage,
    origin: origin as string,
  }));

/** Starts the handshake and returns the nonce the viewer gave the page. */
async function connect(page: { path: string; route?: string } = { path: "index.html" }) {
  deliver({
    channel: REVIEW_CHANNEL,
    v: REVIEW_PROTOCOL,
    type: "ready",
    page,
    sessionTag: SESSION_TAG,
  });
  await waitFor(() => expect(sent().some((s) => s.message.type === "init")).toBe(true));
  const init = sent().find((s) => s.message.type === "init");
  return init?.message.nonce as string;
}

/** The "Filter and export" disclosure of the sidebar. */
const filterTools = () =>
  screen.getByText(/^Filter and export/).closest("details") as HTMLDetailsElement;

const fromBridge = (nonce: string, body: Record<string, unknown>) =>
  deliver({ channel: REVIEW_CHANNEL, v: REVIEW_PROTOCOL, nonce, ...body });

const RECT = { x: 120, y: 200, width: 240, height: 18 };

/** The "Comment" control the viewer draws next to the reader's selection, once it is shown. */
const pill = () => screen.findByRole("button", { name: "Comment" });

/** Where a floating control was placed in the frame's layer, or null while it is hidden. */
function placement(element: HTMLElement): { x: number; y: number } | null {
  // The floating wrapper is the only element positioned at runtime.
  const floating = element.closest<HTMLElement>("[style]");
  if (!floating || floating.style.visibility !== "visible") return null;
  const match = /translate\((-?\d+)px, (-?\d+)px\)/.exec(floating.style.transform);
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
}

/** Selects text in the frame (as the bridge reports it) and opens the inline composer. */
async function commentInline(nonce: string, rect: Record<string, number> = RECT) {
  fromBridge(nonce, { type: "selection", target: TEXT_TARGET, rect });
  fireEvent.click(await pill());
  return screen.getByRole("region", { name: "Comment on the selection" });
}

/** Opens a menu by its button's name inside `scope` and chooses an item. */
function chooseFromMenu(scope: HTMLElement, menu: string | RegExp, item: string) {
  const [trigger] = within(scope).getAllByRole("button", { name: menu });
  fireEvent.click(trigger as HTMLElement);
  fireEvent.click(screen.getByRole("menuitem", { name: item }));
}

/** The items of a menu, by its button's name inside `scope`; the menu is closed again after. */
function menuItems(scope: HTMLElement, menu: string): string[] {
  const trigger = within(scope).getByRole("button", { name: menu });
  fireEvent.click(trigger);
  const items = screen.getAllByRole("menuitem").map((item) => item.textContent ?? "");
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  return items;
}

const OWN_MENU = "More actions for the message from You";

/** Opens a thread's replies, which rest folded behind their count. */
function openReplies(thread: HTMLElement) {
  fireEvent.click(within(thread).getByRole("button", { name: /^\d+ repl(y|ies)$/ }));
}

async function open() {
  const view = renderDashboard(PATH, server);
  await screen.findByRole("heading", { level: 1, name: "Launch plan" });
  await screen.findByRole("heading", { name: "Thread 1" });
  return view;
}

describe("review viewer", () => {
  it("remembers in this browser whether the reader keeps the comments open", async () => {
    window.localStorage.removeItem(SIDEBAR_STORAGE_KEY);
    try {
      await open();
      const toggle = () => screen.getByRole("button", { name: /^Comments/ });
      expect(toggle().getAttribute("aria-pressed")).toBe("true");
      fireEvent.click(toggle());
      expect(toggle().getAttribute("aria-pressed")).toBe("false");
      expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("closed");

      // A reload keeps them closed.
      cleanup();
      renderDashboard(PATH, server);
      await screen.findByTitle("Launch plan, published with Portifact");
      expect(toggle().getAttribute("aria-pressed")).toBe("false");
      expect(screen.queryByRole("heading", { name: "Thread 1" })).toBeNull();

      fireEvent.click(toggle());
      await screen.findByRole("heading", { name: "Thread 1" });
      expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("open");
    } finally {
      window.localStorage.removeItem(SIDEBAR_STORAGE_KEY);
    }
  });

  it("opens the comments when storage is unavailable", async () => {
    // Blocked site data: reading `localStorage` itself throws.
    const storage = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    await open();
    const toggle = screen.getByRole("button", { name: /^Comments/ });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(storage).toHaveBeenCalled();
  });

  it("opens the artifact isolated in a sandboxed frame and lists its threads", async () => {
    const { container } = await open();
    expect(server.requests).toContainEqual({
      method: "POST",
      path: `/api/v1/artifacts/${ID}/review`,
    });
    const frame = screen.getByTitle("Launch plan, published with Portifact") as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(CODE_URL);
    expect(frame.getAttribute("sandbox")).toBe(FRAME_SANDBOX);
    expect(FRAME_SANDBOX).not.toContain("allow-top-navigation");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(document.title).toBe("Launch plan · Portifact");
    expect(screen.getByText("2 comment threads")).toBeTruthy();
    expect(screen.getByText("Secret feedback for the owner")).toBeTruthy();
    expect(screen.getByText("brave new world")).toBeTruthy();
    expect(screen.getByText("General comment on index.html")).toBeTruthy();
    expect(screen.getByText("Connecting to the page")).toBeTruthy();
    // axe would message the frame; the stand-in window cannot answer it.
    Reflect.deleteProperty(HTMLIFrameElement.prototype, "contentWindow");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("answers the bridge's handshake with a nonce and sends only the targets to highlight", async () => {
    await open();
    const nonce = await connect();
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    await waitFor(() => expect(sent().some((s) => s.message.type === "highlights")).toBe(true));
    expect(sent().every((s) => s.origin === ORIGIN)).toBe(true);
    const highlights = sent().find((s) => s.message.type === "highlights")?.message;
    expect(highlights).toEqual({
      channel: REVIEW_CHANNEL,
      v: REVIEW_PROTOCOL,
      nonce,
      type: "highlights",
      highlights: [{ id: "t1", target: TEXT_TARGET }],
      selected: [],
    });
    const everything = JSON.stringify(sent());
    expect(everything).not.toContain("Secret feedback");
    expect(everything).not.toContain("ada@example.test");
    expect(everything).not.toContain("Bea");
  });

  it("ignores forged messages: other origins, other windows, other nonces and oversized ones", async () => {
    await open();
    const nonce = await connect();
    const selection = { type: "selection", target: TEXT_TARGET };
    deliver(
      { channel: REVIEW_CHANNEL, v: REVIEW_PROTOCOL, nonce, ...selection },
      "https://p3n5wq7yzc.portifact.dev",
    );
    deliver({ channel: REVIEW_CHANNEL, v: REVIEW_PROTOCOL, nonce, ...selection }, ORIGIN, window);
    deliver({ channel: REVIEW_CHANNEL, v: REVIEW_PROTOCOL, nonce: "x".repeat(22), ...selection });
    deliver({
      channel: REVIEW_CHANNEL,
      v: REVIEW_PROTOCOL,
      nonce,
      ...selection,
      extra: "x".repeat(BRIDGE_LIMITS.bridgeMessageMaxBytes),
    });
    deliver({ channel: REVIEW_CHANNEL, v: REVIEW_PROTOCOL, nonce, type: "post", body: "spam" });
    // A forged "ready" from another window cannot take over the handshake either.
    deliver(
      {
        channel: REVIEW_CHANNEL,
        v: REVIEW_PROTOCOL,
        type: "ready",
        page: { path: "index.html" },
        sessionTag: SESSION_TAG,
      },
      ORIGIN,
      window,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
    expect(sent().filter((s) => s.message.type === "init")).toHaveLength(1);
    expect(server.requests.some((r) => r.path.endsWith("/threads"))).toBe(false);
  });

  it("turns a selection into a comment only after the reader writes and saves it", async () => {
    await open();
    const nonce = await connect();
    fromBridge(nonce, { type: "selection", target: TEXT_TARGET, rect: RECT });
    const offer = await pill();
    // Next to the selection: below it, aligned with its left edge, inside the frame.
    expect(placement(offer)).toEqual({ x: 120, y: 224 });
    expect(server.requests.some((r) => r.path.endsWith("/threads"))).toBe(false);
    // Focus stays in the artifact; the control is announced, not focused.
    expect(document.activeElement).not.toBe(offer);
    expect(await screen.findByText(/Use the Comment button after the artifact/)).toBeTruthy();

    fireEvent.click(offer);
    expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
    const panel = screen.getByRole("region", { name: "Comment on the selection" });
    expect(placement(panel)).toEqual({ x: 120, y: 224 });
    expect(within(panel).getByText("brave new world")).toBeTruthy();
    const form = within(panel).getByRole("form", { name: "New comment" });
    const box = within(form).getByRole("textbox", { name: "Comment" });
    expect(document.activeElement).toBe(box);
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await within(form).findByText("Write a comment.");
    expect(server.requests.some((r) => r.path.endsWith("/threads"))).toBe(false);

    fireEvent.change(box, { target: { value: "Rename this" } });
    // Shift+Enter is a new line, Enter saves.
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(server.requests.some((r) => r.path.endsWith("/threads"))).toBe(false);
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByText("3 comment threads");
    expect(screen.getByText("Rename this")).toBeTruthy();
    expect(server.bodies.at(-1)).toEqual({
      versionId: "v1",
      target: TEXT_TARGET,
      body: "Rename this",
    });
    expect(screen.queryByRole("form", { name: "New comment" })).toBeNull();
    expect(sent().some((s) => s.message.type === "clear-selection")).toBe(true);
    // Back in the artifact, and the new thread is the current one in the sidebar and the page.
    expect(document.activeElement?.tagName).toBe("IFRAME");
    await waitFor(() => expect(sent().at(-1)?.message).toMatchObject({ type: "highlights" }));
    const last = sent().at(-1)?.message as Extract<ViewerMessage, { type: "highlights" }>;
    expect(last.selected).toEqual([last.highlights.at(-1)?.id]);
  });

  it("cancels the inline comment with Escape or Cancel, and returns to the artifact", async () => {
    await open();
    const nonce = await connect();
    let panel = await commentInline(nonce);
    fireEvent.change(within(panel).getByRole("textbox", { name: "Comment" }), {
      target: { value: "Never mind" },
    });
    fireEvent.keyDown(within(panel).getByRole("textbox", { name: "Comment" }), { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Comment on the selection" })).toBeNull();
    expect(document.activeElement?.tagName).toBe("IFRAME");
    expect(sent().at(-1)?.message).toMatchObject({ type: "clear-selection" });

    panel = await commentInline(nonce);
    // Escape works from its buttons too.
    const cancel = within(panel).getByRole("button", { name: "Cancel" });
    cancel.focus();
    fireEvent.keyDown(cancel, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Comment on the selection" })).toBeNull();

    panel = await commentInline(nonce);
    fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("region", { name: "Comment on the selection" })).toBeNull();
    expect(server.requests.some((r) => r.path.endsWith("/threads"))).toBe(false);
  });

  it("keeps the Comment control inside the frame whatever rectangle the page reports", async () => {
    await open();
    const nonce = await connect();
    const select = (rect: unknown) =>
      fromBridge(nonce, { type: "selection", target: TEXT_TARGET, rect });
    // Partly outside: clamped to the frame's visible box.
    select({ x: -400, y: -50, width: 500, height: 80 });
    expect(placement(await pill())).toEqual({ x: 0, y: 36 });
    // Near the bottom right: above it, never past the frame's edges.
    select({ x: 790, y: 590, width: 300, height: 300 });
    await waitFor(async () => expect(placement(await pill())).toEqual({ x: 700, y: 552 }));
    // Wholly outside the frame (scrolled away, or a lie): hidden.
    select({ x: 10, y: 5_000, width: 10, height: 10 });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Comment" })).toBeNull());
    // Values the protocol refuses drop the message: the last offer stays as it was.
    for (const rect of [
      { x: Number.NaN, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: -1, height: 1 },
      { x: 0, y: 2_000_000, width: 1, height: 1 },
    ]) {
      fromBridge(nonce, { type: "selection-rect", rect });
    }
    expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
    // A selection reported without a rectangle still gets the control, in the frame's corner.
    fromBridge(nonce, { type: "selection", target: TEXT_TARGET });
    expect(placement(await pill())).toEqual({ x: 688, y: 556 });
  });

  it("follows the selection as the frame scrolls, hides it once it is gone, and never moves an open comment", async () => {
    await open();
    const nonce = await connect();
    // A rectangle without an offer does nothing.
    fromBridge(nonce, { type: "selection-rect", rect: RECT });
    expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();

    fromBridge(nonce, { type: "selection", target: TEXT_TARGET, rect: RECT });
    await pill();
    fromBridge(nonce, { type: "selection-rect", rect: { ...RECT, y: 40 } });
    await waitFor(async () => expect(placement(await pill())).toEqual({ x: 120, y: 64 }));
    fromBridge(nonce, { type: "selection-rect", rect: null });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Comment" })).toBeNull());
    fromBridge(nonce, { type: "selection-rect", rect: { ...RECT, y: 300 } });
    expect(placement(await pill())).toEqual({ x: 120, y: 324 });
    fromBridge(nonce, { type: "selection", target: null });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Comment" })).toBeNull());

    const panel = await commentInline(nonce);
    expect(placement(panel)).toEqual({ x: 120, y: 224 });
    fromBridge(nonce, { type: "selection-rect", rect: { ...RECT, y: 10 } });
    fromBridge(nonce, { type: "selection", target: null });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(placement(panel)).toEqual({ x: 120, y: 224 });
    expect(screen.getByRole("region", { name: "Comment on the selection" })).toBe(panel);
  });

  it("writes the inline comment in a bottom sheet on narrow screens", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query.includes("max-width"),
          media: query,
          addEventListener() {},
          removeEventListener() {},
        }) as unknown as MediaQueryList,
    );
    // The sidebar starts closed on a narrow screen; the bar and the frame are there.
    const { container } = renderDashboard(PATH, server);
    await screen.findByTitle("Launch plan, published with Portifact");
    await waitFor(() =>
      expect(server.requests.some((r) => r.path.endsWith("/annotations"))).toBe(true),
    );
    const nonce = await connect();
    const panel = await commentInline(nonce);
    const sheet = panel.closest<HTMLElement>("[style]");
    expect(sheet?.style.transform).toBe("");
    expect(sheet?.style.visibility).toBe("visible");
    fireEvent.change(within(panel).getByRole("textbox", { name: "Comment" }), {
      target: { value: "From my phone" },
    });
    Reflect.deleteProperty(HTMLIFrameElement.prototype, "contentWindow");
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(server.bodies.at(-1)).toMatchObject({ body: "From my phone", target: TEXT_TARGET }),
    );
  });

  it("writes in a bottom sheet when the composer does not fit beside the selection", async () => {
    await open();
    const nonce = await connect();
    fromBridge(nonce, { type: "selection", target: TEXT_TARGET, rect: RECT });
    const offer = await pill();
    // Taller than the frame: there is no place for it next to the selection.
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get: () => LAYER.height + 100,
    });
    fireEvent.click(offer);
    const panel = screen.getByRole("region", { name: "Comment on the selection" });
    await waitFor(() =>
      expect(panel.closest<HTMLElement>("[style]")?.style.visibility).toBe("visible"),
    );
    expect(panel.closest<HTMLElement>("[style]")?.style.transform).toBe("");
    expect(document.activeElement).toBe(within(panel).getByRole("textbox", { name: "Comment" }));
  });

  it("posts general comments on the page the frame shows, with an idempotency key", async () => {
    const fetch = vi.spyOn(server, "fetch");
    await open();
    const nonce = await connect();
    fromBridge(nonce, {
      type: "location",
      page: { path: "docs/about.html", route: "/docs/about.html" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Comment on the page" }));
    expect(screen.getByText("General comment on docs/about.html")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), {
      target: { value: "Typo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
    await screen.findByText("3 comment threads");
    const post = fetch.mock.calls.find(
      ([path, init]) => path.endsWith("/threads") && init?.method === "POST",
    );
    const headers = (post?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(server.bodies.at(-1)).toMatchObject({
      target: { path: "docs/about.html", anchor: { kind: "document" } },
    });
  });

  it("picks an element in sites and comments on it", async () => {
    await open();
    const nonce = await connect();
    const pick = screen.getByRole("button", { name: "Select an element" });
    expect(pick.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(pick);
    expect(pick.getAttribute("aria-pressed")).toBe("true");
    expect(sent().at(-1)?.message).toMatchObject({ type: "pick", active: true });
    fromBridge(nonce, { type: "element", target: ELEMENT_TARGET, rect: RECT });
    fromBridge(nonce, { type: "pick-ended" });
    fireEvent.click(await pill());
    await screen.findByRole("form", { name: "New comment" });
    expect(screen.getByText("Element button")).toBeTruthy();
    expect(screen.getByText("Buy now")).toBeTruthy();
    expect(pick.getAttribute("aria-pressed")).toBe("false");
  });

  it("ignores an element the reader did not pick", async () => {
    await open();
    const nonce = await connect();
    fromBridge(nonce, { type: "element", target: ELEMENT_TARGET });
    // A pick that ended without an element does not leave the door open either.
    fireEvent.click(screen.getByRole("button", { name: "Select an element" }));
    fromBridge(nonce, { type: "pick-ended" });
    fromBridge(nonce, { type: "element", target: ELEMENT_TARGET });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
    expect(screen.queryByRole("form", { name: "New comment" })).toBeNull();
    expect(screen.queryByText("Element button")).toBeNull();
    expect(document.activeElement?.tagName).not.toBe("TEXTAREA");
  });

  it("keeps the target of an open comment when the page sends another one", async () => {
    await open();
    const nonce = await connect();
    await commentInline(nonce);
    const form = screen.getByRole("form", { name: "New comment" });
    fireEvent.change(within(form).getByRole("textbox", { name: "Comment" }), {
      target: { value: "Rename this" },
    });
    // The page cannot swap the target under the reader's text, whatever it sends.
    fireEvent.click(screen.getByRole("button", { name: "Select an element" }));
    fromBridge(nonce, { type: "element", target: ELEMENT_TARGET });
    fromBridge(nonce, { type: "selection", target: { ...TEXT_TARGET, path: "other.html" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText("Element button")).toBeNull();
    expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await screen.findByText("3 comment threads");
    expect(server.bodies.at(-1)).toEqual({
      versionId: "v1",
      target: TEXT_TARGET,
      body: "Rename this",
    });
  });

  it("sends the frame only the threads of the page it shows", async () => {
    server.annotations[ID]?.threads.push({
      ...fakeThread("t3", {
        target: { ...TEXT_TARGET, path: "other.html" },
        createdAt: "2026-11-08T12:09:00.000Z",
      }),
      seq: 3,
    });
    await open();
    const nonce = await connect();
    await waitFor(() => expect(sent().some((s) => s.message.type === "highlights")).toBe(true));
    const ids = () => {
      const last = sent()
        .map((s) => s.message)
        .filter((message) => message.type === "highlights")
        .at(-1);
      return last?.highlights.map((highlight) => highlight.id);
    };
    expect(ids()).toEqual(["t1"]);
    fromBridge(nonce, { type: "location", page: { path: "other.html" } });
    await waitFor(() => expect(ids()).toEqual(["t3"]));
  });

  it("shows threads the page cannot locate as without location, and others as on another page", async () => {
    server.annotations[ID]?.threads.push({
      ...fakeThread("t3", {
        target: { ...TEXT_TARGET, path: "other.html" },
        createdAt: "2026-11-08T12:09:00.000Z",
      }),
      seq: 3,
    });
    await open();
    const nonce = await connect();
    fromBridge(nonce, {
      type: "resolved",
      results: [{ id: "t1", confidence: "orphaned", reason: "not_found" }],
    });
    const first = screen.getByRole("article", { name: "Thread 1" });
    await within(first).findByText("Without location");
    expect(within(first).queryByRole("button", { name: "Show in the artifact" })).toBeNull();
    const third = screen.getByRole("article", { name: "Thread 3" });
    expect(within(third).getByText("On other.html")).toBeTruthy();

    fromBridge(nonce, { type: "resolved", results: [{ id: "t1", confidence: "exact" }] });
    fireEvent.click(await within(first).findByRole("button", { name: "Show in the artifact" }));
    expect(sent().map((s) => s.message)).toContainEqual(
      expect.objectContaining({ type: "focus", id: "t1" }),
    );
  });

  it("ignores results and selections for threads it did not send to the page", async () => {
    server.annotations[ID]?.threads.push({
      ...fakeThread("t3", {
        target: { ...TEXT_TARGET, path: "other.html" },
        createdAt: "2026-11-08T12:09:00.000Z",
      }),
      seq: 3,
    });
    await open();
    const nonce = await connect();
    fromBridge(nonce, { type: "location", page: { path: "other.html" } });
    fromBridge(nonce, { type: "location", page: { path: "index.html" } });
    fromBridge(nonce, { type: "resolved", results: [{ id: "t3", confidence: "orphaned" }] });
    // t2 is a general comment (never highlighted), t3 is on another page, "nope" is unknown.
    fromBridge(nonce, { type: "select", ids: ["t2", "t3", "nope"] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const name of ["Thread 1", "Thread 2", "Thread 3"]) {
      const card = screen.getByRole("article", { name });
      expect(card.getAttribute("aria-current")).toBeNull();
      expect(card.hasAttribute("data-selected")).toBe(false);
    }
    expect(screen.queryByRole("region", { name: /on the text you clicked/ })).toBeNull();
  });

  it("selects the thread a reader clicks in the page without taking focus from the artifact", async () => {
    await open();
    const nonce = await connect();
    await waitFor(() => expect(sent().some((s) => s.message.type === "highlights")).toBe(true));
    const frame = screen.getByTitle("Launch plan, published with Portifact");
    frame.focus();
    fromBridge(nonce, { type: "select", ids: ["t1"] });
    const thread = screen.getByRole("article", { name: "Thread 1" });
    await waitFor(() => expect(thread.getAttribute("aria-current")).toBe("true"));
    expect(document.activeElement).toBe(frame);
    await screen.findByText("Thread 1 selected.");
    await waitFor(() =>
      expect(sent().at(-1)?.message).toMatchObject({ type: "highlights", selected: ["t1"] }),
    );
    // A click outside every highlight clears what the page selected.
    fromBridge(nonce, { type: "select", ids: [] });
    await waitFor(() => expect(thread.getAttribute("aria-current")).toBeNull());
  });

  it("shows every thread on the clicked text together, the innermost first, and outlines the one pointed at", async () => {
    const inner: AnnotationTarget = {
      ...TEXT_TARGET,
      anchor: {
        kind: "text",
        quote: { exact: "new", prefix: "Hello brave ", suffix: " world" },
        position: { start: 12, end: 15 },
      },
    };
    server.annotations[ID]?.threads.push({
      ...fakeThread("t3", {
        target: inner,
        createdAt: "2026-11-08T12:09:00.000Z",
        messages: [fakeMessage({ id: "m3", body: "Inner remark" })],
      }),
      seq: 3,
    });
    const { container } = await open();
    const nonce = await connect();
    await waitFor(() => expect(sent().some((s) => s.message.type === "highlights")).toBe(true));
    fromBridge(nonce, { type: "select", ids: ["t3", "t1"] });
    const group = await screen.findByRole("region", { name: "2 threads on the text you clicked" });
    const cards = within(group).getAllByRole("article");
    expect(cards.map((card) => card.getAttribute("aria-labelledby"))).toEqual([
      "thread-t3-title",
      "thread-t1-title",
    ]);
    expect(cards[0]?.getAttribute("aria-current")).toBe("true");
    expect(cards[1]?.hasAttribute("data-selected")).toBe(true);
    await screen.findByText("Threads 3, 1 selected.");
    await waitFor(() =>
      expect(sent().at(-1)?.message).toMatchObject({ type: "highlights", selected: ["t3", "t1"] }),
    );
    Reflect.deleteProperty(HTMLIFrameElement.prototype, "contentWindow");
    expect(await axeViolations(container)).toEqual([]);
    Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
      configurable: true,
      get: () => frameWindow,
    });

    // Pointing at a thread outlines its text in the page; general comments outline nothing.
    fireEvent.pointerEnter(cards[1] as HTMLElement);
    expect(sent().at(-1)?.message).toMatchObject({ type: "hover", id: "t1" });
    fireEvent.pointerLeave(cards[1] as HTMLElement);
    expect(sent().at(-1)?.message).toMatchObject({ type: "hover", id: null });
    fireEvent.pointerEnter(screen.getByRole("article", { name: "Thread 2" }));
    expect(sent().at(-1)?.message).toMatchObject({ type: "hover", id: null });

    // Clicking a card selects it alone, in place, and shows it in the page once it has a place.
    fromBridge(nonce, {
      type: "resolved",
      results: [
        { id: "t1", confidence: "exact" },
        { id: "t3", confidence: "exact" },
      ],
    });
    await within(cards[1] as HTMLElement).findByRole("button", { name: "Show in the artifact" });
    fireEvent.click(within(cards[1] as HTMLElement).getByText("Secret feedback for the owner"));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: /on the text you clicked/ })).toBeNull(),
    );
    expect(screen.getByRole("article", { name: "Thread 1" }).getAttribute("aria-current")).toBe(
      "true",
    );
    expect(sent().map((s) => s.message)).toContainEqual(
      expect.objectContaining({ type: "focus", id: "t1" }),
    );

    fromBridge(nonce, { type: "select", ids: ["t1", "t3"] });
    const again = await screen.findByRole("region", { name: "2 threads on the text you clicked" });
    fireEvent.click(within(again).getByRole("button", { name: "Show all threads" }));
    expect(screen.queryByRole("region", { name: /on the text you clicked/ })).toBeNull();
  });

  it("refreshes incrementally with the cursor", async () => {
    const { queryClient } = await open();
    const store = server.annotations[ID];
    const second = store?.threads[1];
    if (!store || !second) throw new Error("missing");
    second.messages.push(fakeMessage({ body: "Second opinion" }));
    store.seq += 1;
    second.seq = store.seq;
    await act(() => queryClient.invalidateQueries({ queryKey: ["annotations", ID] }));
    const thread = screen.getByRole("article", { name: "Thread 2" });
    // The new reply arrives folded behind the thread's reply count.
    fireEvent.click(await within(thread).findByRole("button", { name: "1 reply" }));
    expect(within(thread).getByText("Second opinion")).toBeTruthy();
    expect(server.requests.at(-1)?.path).toBe(`/api/v1/artifacts/${ID}/annotations?cursor=2`);
  });

  it("starts over when the caller's comment scope changes, dropping threads it no longer shows", async () => {
    const { queryClient } = await open();
    const store = server.annotations[ID];
    if (!store) throw new Error("missing");
    expect(screen.getByText("Secret feedback for the owner")).toBeTruthy();
    // The owner narrowed who sees comments: the server lists fewer threads and a new scope.
    store.commentScope = "own";
    store.threads.splice(0, 1);
    store.seq += 1;
    await act(() => queryClient.invalidateQueries({ queryKey: ["annotations", ID] }));
    await waitFor(() => expect(screen.queryByText("Secret feedback for the owner")).toBeNull());
    expect(server.requests.at(-1)?.path).toBe(`/api/v1/artifacts/${ID}/annotations`);
  });

  it.each([
    [
      "participant",
      "The owner of this artifact can read it; the owner chooses whether other readers can too.",
    ],
    ["owner", "Everyone who can open this artifact can read it."],
  ] as const)("tells the %s who can read a new comment", async (role, note) => {
    const store = server.annotations[ID];
    if (!store) throw new Error("missing");
    store.role = role;
    await open();
    const nonce = await connect();
    // In the inline composer next to the selection, and in the sidebar's general comment.
    const panel = await commentInline(nonce);
    expect(within(panel).getByRole("form", { name: "New comment" }).textContent).toContain(note);
    fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Comment on the page" }));
    expect(screen.getByRole("form", { name: "New comment" }).textContent).toContain(note);
  });

  it("renders bodies and quotes as text, never as markup", async () => {
    const store = server.annotations[ID];
    store?.threads.push({
      ...fakeThread("t9", {
        createdAt: "2026-11-08T12:10:00.000Z",
        messages: [fakeMessage({ body: '<img src=x onerror="alert(1)">' })],
      }),
      seq: 9,
    });
    const { container } = await open();
    expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeTruthy();
    expect(container.querySelector("img[onerror]")).toBeNull();
  });
});

describe("comment notices in the viewer", () => {
  it("mutes the artifact's comment emails from the comments, when the owner's plan has them", async () => {
    server.commentNotices[ID] = { available: true, muted: false };
    const { container } = await open();
    const box = (await screen.findByRole("checkbox", {
      name: "Email me about new comments on this artifact",
    })) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(await screen.findByText("Comment emails for this artifact turned off.")).toBeTruthy();
    expect(server.requests).toContainEqual({
      method: "PUT",
      path: `/api/v1/account/comment-notices/${ID}`,
    });
    expect(server.bodies.at(-1)).toEqual({ muted: true });
    await waitFor(() => expect(box.checked).toBe(false));
    Reflect.deleteProperty(HTMLIFrameElement.prototype, "contentWindow");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("offers nothing when the owner's plan has no comment notices", async () => {
    await open();
    await waitFor(() =>
      expect(server.requests).toContainEqual({
        method: "GET",
        path: `/api/v1/account/comment-notices/${ID}`,
      }),
    );
    expect(screen.queryByRole("checkbox", { name: /new comments on this artifact/ })).toBeNull();
    expect(screen.queryByText(/part of the Pro plan/)).toBeNull();
  });
});

describe("thread actions", () => {
  it("shows only the first message, folds the replies behind their count and no state badge", async () => {
    const store = server.annotations[ID];
    store?.threads[0]?.messages.push(
      fakeMessage({ id: "r1", body: "First reply" }),
      fakeMessage({ id: "r2", body: "Second reply" }),
    );
    await open();
    const thread = screen.getByRole("article", { name: "Thread 1" });
    expect(within(thread).getByText("Secret feedback for the owner")).toBeTruthy();
    expect(within(thread).queryByText("First reply")).toBeNull();
    expect(within(thread).queryByText("Open")).toBeNull();
    const toggle = within(thread).getByRole("button", { name: "2 replies" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // Replying needs no unfolding first.
    expect(within(thread).getByRole("button", { name: "Reply" })).toBeTruthy();

    fireEvent.click(toggle);
    expect(within(thread).getByText("First reply")).toBeTruthy();
    expect(within(thread).getByText("Second reply")).toBeTruthy();
    const hide = within(thread).getByRole("button", { name: "Hide replies" });
    expect(hide.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(hide);
    expect(within(thread).queryByText("First reply")).toBeNull();

    // Selecting the thread opens its replies.
    fireEvent.click(within(thread).getByText("Secret feedback for the owner"));
    await within(thread).findByText("First reply");
  });

  it("replies, resolves and reopens a thread", async () => {
    await open();
    const thread = screen.getByRole("article", { name: "Thread 1" });
    fireEvent.click(within(thread).getByRole("button", { name: "Reply" }));
    const form = within(thread).getByRole("form", { name: "Reply to thread 1" });
    fireEvent.change(within(form).getByRole("textbox", { name: "Reply" }), {
      target: { value: "Done" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Post reply" }));
    await waitFor(() => expect(within(thread).queryByRole("form")).toBeNull());
    expect(within(thread).getByText("Done")).toBeTruthy();

    fireEvent.click(within(thread).getByRole("button", { name: "Resolve" }));
    await within(thread).findByText("Resolved");
    fireEvent.click(within(thread).getByRole("button", { name: "Reopen" }));
    await within(thread).findByRole("button", { name: "Resolve" });
  });

  it("opens the reply box in place from the thread's reply field and closes it back there", async () => {
    const { container } = await open();
    const thread = screen.getByRole("article", { name: "Thread 1" });
    const field = within(thread).getByRole("button", { name: "Reply" });
    Reflect.deleteProperty(HTMLIFrameElement.prototype, "contentWindow");
    expect(await axeViolations(thread)).toEqual([]);
    fireEvent.click(field);
    const box = within(thread).getByRole("textbox", { name: "Reply" });
    expect(document.activeElement).toBe(box);
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.keyDown(box, { key: "Escape" });
    expect(within(thread).queryByRole("form")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(within(thread).getByRole("button", { name: "Reply" })),
    );
    // Clicking inside the reply box never selects or moves the thread.
    fireEvent.click(within(thread).getByRole("button", { name: "Reply" }));
    fireEvent.click(within(thread).getByRole("textbox", { name: "Reply" }));
    expect(thread.getAttribute("aria-current")).toBeNull();
  });

  it("folds resolved threads, dimmed, until the reader opens or selects them", async () => {
    const store = server.annotations[ID];
    const first = store?.threads[0];
    if (first) first.state = "resolved";
    await open();
    const thread = screen.getByRole("article", { name: "Thread 1" });
    expect(within(thread).getByText("Resolved")).toBeTruthy();
    expect(within(thread).queryByText("Secret feedback for the owner")).toBeNull();
    expect(within(thread).queryByRole("button", { name: "Reply" })).toBeNull();
    const unfold = within(thread).getByRole("button", { name: "Show the comment" });
    expect(unfold.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(unfold);
    expect(within(thread).getByText("Secret feedback for the owner")).toBeTruthy();
    fireEvent.click(within(thread).getByRole("button", { name: "Fold the comments" }));
    expect(within(thread).queryByText("Secret feedback for the owner")).toBeNull();
    // Selecting it, here or in the page, opens it.
    fireEvent.click(within(thread).getByText("brave new world"));
    await within(thread).findByText("Secret feedback for the owner");
    expect(thread.getAttribute("aria-current")).toBe("true");
  });

  it("says in the reply box when every reader sees the thread: the owner started it", async () => {
    const store = server.annotations[ID];
    if (!store) throw new Error("missing");
    store.role = "participant";
    const first = store.threads[0];
    if (first) first.byOwner = true;
    await open();
    const ownerThread = screen.getByRole("article", { name: "Thread 1" });
    fireEvent.click(within(ownerThread).getByRole("button", { name: "Reply" }));
    const form = within(ownerThread).getByRole("form", { name: "Reply to thread 1" });
    expect(within(form).getByRole("textbox", { name: "Reply" })).toBeTruthy();
    expect(form.textContent).toContain(
      "The owner started this thread, so everyone who can see the comments sees your reply.",
    );
    const other = screen.getByRole("article", { name: "Thread 2" });
    fireEvent.click(within(other).getByRole("button", { name: "Reply" }));
    expect(
      within(other).getByRole("form", { name: "Reply to thread 2" }).textContent,
    ).not.toContain("The owner started this thread");
  });

  it("edits your own message in place, marks it edited and sends the revision it started from", async () => {
    const store = server.annotations[ID];
    const own = fakeMessage({ id: "m-own", own: true, body: "Frist draft", revision: 2 });
    store?.threads[0]?.messages.push(own);
    const { container } = await open();
    const thread = screen.getByRole("article", { name: "Thread 1" });
    openReplies(thread);
    // Only your own messages can be edited; the owner moderates other people's.
    expect(menuItems(thread, OWN_MENU)).toEqual(["Edit"]);
    expect(menuItems(thread, "More actions for the message from Bea")).toEqual(["Hide", "Delete"]);
    chooseFromMenu(thread, OWN_MENU, "Edit");
    const form = within(thread).getByRole("form", { name: "Edit your message" });
    const box = within(form).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    expect(box.value).toBe("Frist draft");
    expect(document.activeElement).toBe(box);
    Reflect.deleteProperty(HTMLIFrameElement.prototype, "contentWindow");
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.change(box, { target: { value: "First draft" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await within(thread).findByText("First draft");
    expect(server.requests).toContainEqual({
      method: "PATCH",
      path: `/api/v1/artifacts/${ID}/annotations/messages/m-own`,
    });
    expect(server.bodies.at(-1)).toEqual({ body: "First draft", revision: 2 });
    expect(within(thread).getByText(/Edited/)).toBeTruthy();
    await screen.findByText("Message edited.");
    await waitFor(() =>
      expect(document.activeElement).toBe(within(thread).getByRole("button", { name: OWN_MENU })),
    );
  });

  it("drops the thread when an edit lands in a thread the reader no longer sees", async () => {
    const store = server.annotations[ID];
    if (!store) throw new Error("missing");
    store.role = "participant";
    store.threads[0]?.messages.push(fakeMessage({ id: "m-own", own: true, body: "Mine" }));
    // The owner narrowed who sees comments after the viewer loaded the thread.
    store.outOfScope = [store.threads[0]?.id ?? ""];
    await open();
    const thread = screen.getByRole("article", { name: "Thread 1" });
    openReplies(thread);
    chooseFromMenu(thread, OWN_MENU, "Edit");
    const form = within(thread).getByRole("form", { name: "Edit your message" });
    fireEvent.change(within(form).getByRole("textbox", { name: "Message" }), {
      target: { value: "Redacted" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await screen.findByText(
      "Your message was saved. You no longer see its thread: the owner changed who sees comments.",
    );
    await waitFor(() => expect(screen.queryByText("Secret feedback for the owner")).toBeNull());
    expect(server.bodies.at(-1)).toEqual({ body: "Redacted", revision: 1 });
  });

  it("cancels an edit, and reloads the message when it changed elsewhere meanwhile", async () => {
    const store = server.annotations[ID];
    const own = fakeMessage({ id: "m-own", own: true, body: "Old text", revision: 1 });
    store?.threads[0]?.messages.push(own);
    await open();
    const thread = screen.getByRole("article", { name: "Thread 1" });
    openReplies(thread);
    chooseFromMenu(thread, OWN_MENU, "Edit");
    fireEvent.click(within(thread).getByRole("button", { name: "Cancel" }));
    expect(within(thread).queryByRole("form", { name: "Edit your message" })).toBeNull();
    expect(within(thread).getByText("Old text")).toBeTruthy();

    chooseFromMenu(thread, OWN_MENU, "Edit");
    // Edited from the CLI meanwhile.
    own.body = "Text from the CLI";
    own.revision = 2;
    if (store?.threads[0]) {
      store.seq += 1;
      store.threads[0].seq = store.seq;
    }
    const form = within(thread).getByRole("form", { name: "Edit your message" });
    fireEvent.change(within(form).getByRole("textbox", { name: "Message" }), {
      target: { value: "My text" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await within(thread).findByText(/changed somewhere else meanwhile/);
    expect(server.bodies.at(-1)).toEqual({ body: "My text", revision: 1 });
    // The conflict loads the latest version, and saving again starts from it.
    await waitFor(() =>
      expect(server.requests.filter((r) => r.path.includes("/annotations?cursor"))).not.toEqual([]),
    );
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.bodies.at(-1)).toEqual({ body: "My text", revision: 2 }));
    await within(thread).findByText("My text");
  });

  it("offers no edit on hidden messages, other versions or while comments are locked", async () => {
    const store = server.annotations[ID];
    if (!store) throw new Error("missing");
    store.threads[0]?.messages.push(
      fakeMessage({ id: "m-hidden", own: true, state: "hidden", body: "Hidden mine" }),
    );
    store.threads[1]?.messages.push(fakeMessage({ id: "m-own2", own: true, body: "Mine" }));
    store.mode = "locked";
    await open();
    expect(screen.queryByRole("button", { name: OWN_MENU })).toBeNull();
  });

  it("lets the owner hide and delete other people's messages, and delete threads after confirming", async () => {
    await open();
    const thread = screen.getByRole("article", { name: "Thread 1" });
    const bea = "More actions for the message from Bea";
    chooseFromMenu(thread, bea, "Hide");
    await within(thread).findByText("Hidden by the owner");
    expect(server.bodies.at(-1)).toEqual({ action: "hide" });
    expect(menuItems(thread, bea)).toEqual(["Show again", "Delete"]);

    chooseFromMenu(thread, "More actions for thread 1", "Delete thread");
    const dialog = await screen.findByRole("dialog", { name: "Delete thread 1?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete thread" }));
    await screen.findByText("1 comment thread");
    expect(screen.queryByText("Secret feedback for the owner")).toBeNull();
    expect(server.requests).toContainEqual({
      method: "DELETE",
      path: `/api/v1/artifacts/${ID}/annotations/threads/t1`,
    });
  });

  it("offers a visitor no moderation, and resolving only on their own threads", async () => {
    const store = server.annotations[ID];
    if (!store) throw new Error("missing");
    store.role = "participant";
    const own = store.threads[1];
    if (own) own.own = true;
    await open();
    const first = screen.getByRole("article", { name: "Thread 1" });
    expect(within(first).queryByRole("button", { name: /More actions/ })).toBeNull();
    expect(within(first).queryByRole("button", { name: "Resolve" })).toBeNull();
    const second = screen.getByRole("article", { name: "Thread 2" });
    expect(within(second).getByRole("button", { name: "Resolve" })).toBeTruthy();
  });

  it("shows why an action failed", async () => {
    await open();
    server.fail("POST", `/api/v1/artifacts/${ID}/annotations/threads/t1/resolve`, {
      status: 409,
      code: "version_conflict",
    });
    const thread = screen.getByRole("article", { name: "Thread 1" });
    fireEvent.click(within(thread).getByRole("button", { name: "Resolve" }));
    const alert = await within(thread).findByRole("alert");
    expect(alert.textContent).toContain("The artifact changed meanwhile");
  });
});

describe("comment filters and export", () => {
  const headings = () =>
    screen
      .queryAllByRole("article")
      .map((article) => article.getAttribute("aria-labelledby"))
      .map((id) => (id ? document.getElementById(id)?.textContent : null));
  const lastMarkers = () =>
    sent()
      .map((s) => s.message)
      .filter((message) => message.type === "highlights")
      .at(-1)
      ?.highlights.map((highlight) => highlight.id);

  beforeEach(() => {
    const store = server.annotations[ID];
    if (!store) throw new Error("missing");
    store.threads.push(
      {
        ...fakeThread("t3", {
          target: TEXT_TARGET,
          state: "resolved",
          author: { id: "u-cy", name: "Cy", image: null },
          createdAt: "2026-11-08T12:07:00.000Z",
        }),
        seq: 3,
      },
      {
        ...fakeThread("t4", {
          own: true,
          author: { id: "u-ada", name: "Ada", image: null },
          createdAt: "2026-11-08T12:08:00.000Z",
        }),
        seq: 4,
      },
    );
    store.seq = 4;
  });

  it("filters by status and author without renumbering, and marks only what it shows", async () => {
    const { container } = await open();
    await connect();
    await waitFor(() => expect(lastMarkers()).toEqual(["t1", "t3"]));
    // Collapsed by default, so the threads come first in the sidebar.
    const tools = filterTools();
    expect(tools.open).toBe(false);
    fireEvent.click(within(tools).getByText("Filter and export"));
    expect(tools.open).toBe(true);
    expect(selectOptions("Author").options).toEqual(["Everyone", "You", "Bea", "Cy"]);
    expect(await axeViolations(container)).toEqual([]);

    choose("Status", "Resolved");
    expect(headings()).toEqual(["Thread 3"]);
    // The summary says filters are on while the disclosure is closed.
    expect(within(tools).getByText("Filter and export (filters on)")).toBeTruthy();
    expect(screen.getByText("Showing 1 of 4 comment threads").getAttribute("role")).toBe("status");
    await waitFor(() => expect(lastMarkers()).toEqual(["t3"]));

    choose("Status", "Open and resolved");
    choose("Author", "You");
    expect(headings()).toEqual(["Thread 4"]);
    await waitFor(() => expect(lastMarkers()).toEqual([]));

    choose("Author", "Bea");
    expect(headings()).toEqual(["Thread 1", "Thread 2"]);
    choose("Status", "Resolved");
    expect(headings()).toEqual([]);
    expect(screen.getByText("No comment threads match the filters.")).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("lets the owner list another version's threads, which get no place in the page", async () => {
    await seedVersion(server, ID, [{ path: "index.html", text: "<p>old</p>" }], { id: "v0" });
    await seedVersion(server, ID, [{ path: "index.html", text: "<p>new</p>" }], { id: "v1" });
    server.annotations[ID]?.threads.push({
      ...fakeThread("t0", {
        versionId: "v0",
        current: false,
        target: TEXT_TARGET,
        createdAt: "2026-11-01T12:00:00.000Z",
      }),
      seq: 5,
    });
    await open();
    await connect();
    expect(headings()).toEqual(["Thread 1", "Thread 2", "Thread 3", "Thread 4"]);
    await waitFor(() =>
      expect(selectOptions("Version").options).toEqual([
        "Current version",
        "All versions",
        "Version 1",
      ]),
    );

    choose("Version", "All versions");
    await waitFor(() =>
      expect(headings()).toEqual(["Thread 1", "Thread 2", "Thread 3", "Thread 4", "Thread 5"]),
    );
    expect(server.requests.map((r) => r.path)).toContain(
      `/api/v1/artifacts/${ID}/annotations?version=all`,
    );
    const earlier = screen.getByRole("article", { name: "Thread 1" });
    expect(within(earlier).getByText("Earlier version")).toBeTruthy();
    expect(within(earlier).queryByRole("button", { name: "Show in the artifact" })).toBeNull();
    expect(within(earlier).queryByRole("button", { name: "Reply" })).toBeNull();
    await waitFor(() => expect(lastMarkers()).toEqual(["t1", "t3"]));

    choose("Version", "Version 1");
    await waitFor(() => expect(headings()).toEqual(["Thread 1"]));
    expect(server.requests.map((r) => r.path)).toContain(
      `/api/v1/artifacts/${ID}/annotations?version=v0`,
    );
  });

  it("offers a visitor no version choice", async () => {
    const store = server.annotations[ID];
    if (store) store.role = "participant";
    await open();
    expect(screen.getByRole("combobox", { name: "Status" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Version" })).toBeNull();
    expect(server.requests.some((r) => r.path.endsWith("/versions"))).toBe(false);
  });

  it("exports the chosen version and status as JSON or Markdown", async () => {
    const { saved } = await open();
    fireEvent.click(screen.getByRole("button", { name: "Export as JSON" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]?.fileName).toBe(`${ID}-annotations.json`);
    const exported = JSON.parse((await saved[0]?.blob.text()) ?? "");
    expect(exported.threads.map((t: { id: string }) => t.id)).toEqual(["t1", "t2", "t3", "t4"]);

    choose("Status", "Open");
    fireEvent.click(screen.getByRole("button", { name: "Export as Markdown" }));
    await waitFor(() => expect(saved).toHaveLength(2));
    expect(saved[1]?.fileName).toBe(`${ID}-annotations.md`);
    expect(await saved[1]?.blob.text()).toBe("# Launch plan\n\n3 threads\n");
    expect(server.requests.filter((r) => r.path.includes("/export")).map((r) => r.path)).toEqual([
      `/api/v1/artifacts/${ID}/annotations/export?format=json&version=current`,
      `/api/v1/artifacts/${ID}/annotations/export?format=markdown&version=current&state=open`,
    ]);
  });

  it("shows why an export failed", async () => {
    const { saved } = await open();
    server.fail("GET", `/api/v1/artifacts/${ID}/annotations/export`, {
      status: 503,
      code: "capacity_unavailable",
    });
    fireEvent.click(screen.getByRole("button", { name: "Export as JSON" }));
    const tools = filterTools();
    expect((await within(tools).findByRole("alert")).textContent).toContain(
      "Portifact is at capacity right now",
    );
    expect(saved).toHaveLength(0);
  });
});

describe("review states", () => {
  it("says when the browser cannot keep the review cookie, and keeps general comments", async () => {
    await open();
    deliver({ channel: REVIEW_CHANNEL, v: REVIEW_PROTOCOL, type: "status", status: "unavailable" });
    await screen.findByText("Review tools are not available in this browser");
    expect(screen.getByRole("button", { name: "Comment on the page" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Select an element" })).toBeNull();
  });

  it("offers a review tab where the frame cannot keep the cookie, through a one-use link", async () => {
    await open();
    expect(screen.queryByRole("heading", { name: "Review in a separate tab" })).toBeNull();
    deliver({ channel: REVIEW_CHANNEL, v: REVIEW_PROTOCOL, type: "status", status: "unavailable" });
    const offer = (
      await screen.findByRole("heading", { name: "Review in a separate tab" })
    ).closest("section") as HTMLElement;
    expect(within(offer).getByText(/ends after 15 minutes/)).toBeTruthy();
    // The frame can force this offer, so the tab is presented as the artifact, not Portifact.
    expect(
      within(offer).getByText(/shows the artifact itself, written by its author/),
    ).toBeTruthy();
    fireEvent.click(within(offer).getByRole("button", { name: "Prepare a review tab" }));
    const link = await within(offer).findByRole("link", { name: "Open the review tab" });
    expect(server.requests.filter((r) => r.path.endsWith("/review/tab"))).toHaveLength(1);
    expect(link.getAttribute("href")).toBe(
      `${ORIGIN}/__portifact/review/tab?code=${"1".padStart(43, "t")}`,
    );
    // No opener for the artifact to navigate, and only the app's origin as Referer.
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener");
    expect(link.getAttribute("referrerpolicy")).toBe("origin");
    await waitFor(() => expect(document.activeElement).toBe(link));
    expect(await axeViolations(document.body)).toEqual([]);

    // The code is used once: after opening, the link goes away.
    const stop = (event: Event) => event.preventDefault();
    document.addEventListener("click", stop);
    fireEvent.click(link);
    document.removeEventListener("click", stop);
    await within(offer).findByText(/The review tab opened/);
    expect(within(offer).queryByRole("link", { name: "Open the review tab" })).toBeNull();
    expect(within(offer).getByRole("button", { name: "Prepare a review tab" })).toBeTruthy();
    // General comments stay in the viewer.
    expect(screen.getByRole("button", { name: "Comment on the page" })).toBeTruthy();
  });

  it("withdraws a prepared review tab link before its code expires", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open();
    fireEvent.load(screen.getByTitle("Launch plan, published with Portifact"));
    await act(() => vi.advanceTimersByTimeAsync(BRIDGE_TIMEOUT_MS));
    await screen.findByText("The page does not answer the review tools");
    fireEvent.click(screen.getByRole("button", { name: "Prepare a review tab" }));
    await screen.findByRole("link", { name: "Open the review tab" });
    await act(() => vi.advanceTimersByTimeAsync(REVIEW_TAB_LINK_MS));
    await screen.findByText("The link expired before it was opened. Prepare a new one.");
    expect(screen.queryByRole("link", { name: "Open the review tab" })).toBeNull();
  });

  it("shows why a review tab could not be prepared", async () => {
    await open();
    deliver({ channel: REVIEW_CHANNEL, v: REVIEW_PROTOCOL, type: "status", status: "unavailable" });
    delete server.reviews[ID];
    fireEvent.click(await screen.findByRole("button", { name: "Prepare a review tab" }));
    await screen.findByText("The action did not finish");
    expect(screen.queryByRole("link", { name: "Open the review tab" })).toBeNull();
  });

  it("offers to reload when the review session ends, with a new code", async () => {
    await open();
    deliver({ channel: REVIEW_CHANNEL, v: REVIEW_PROTOCOL, type: "status", status: "ended" });
    fireEvent.click(await screen.findByRole("button", { name: "Reload the review" }));
    await waitFor(() =>
      expect(server.requests.filter((r) => r.path.endsWith("/review"))).toHaveLength(2),
    );
    await screen.findByText("Connecting to the page");
  });

  it("refuses a frame that runs a review session it did not start", async () => {
    await open();
    deliver({
      channel: REVIEW_CHANNEL,
      v: REVIEW_PROTOCOL,
      type: "ready",
      page: { path: "index.html" },
      sessionTag: "a".repeat(22),
    });
    await screen.findByText("The frame is not running your review session");
    expect(sent().some((s) => s.message.type === "init")).toBe(false);
    expect(screen.queryByRole("button", { name: "Select an element" })).toBeNull();
    expect(screen.getByRole("button", { name: "Comment on the page" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload the review" }));
    await waitFor(() =>
      expect(server.requests.filter((r) => r.path.endsWith("/review"))).toHaveLength(2),
    );
  });

  it("warns when the frame stops answering from the artifact's origin", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open();
    const nonce = await connect();
    const frame = screen.getByTitle("Launch plan, published with Portifact");
    // A new page of the artifact answers the viewer's check: still connected.
    fireEvent.load(frame);
    const ping = sent().at(-1)?.message;
    expect(ping).toMatchObject({ type: "ping", nonce });
    fromBridge(nonce, { type: "pong" });
    await act(() => vi.advanceTimersByTimeAsync(BRIDGE_TIMEOUT_MS));
    expect(screen.getByRole("button", { name: "Select an element" })).toBeTruthy();
    // Then the frame shows something that never answers from this origin.
    fireEvent.load(frame);
    await act(() => vi.advanceTimersByTimeAsync(BRIDGE_TIMEOUT_MS));
    await screen.findByText("The frame stopped answering from the artifact");
    expect(screen.queryByRole("button", { name: "Select an element" })).toBeNull();
    expect(screen.getByRole("button", { name: "Comment on the page" })).toBeTruthy();
  });

  it("keeps comments working when the page claims the session ended", async () => {
    await open();
    await connect();
    deliver({ channel: REVIEW_CHANNEL, v: REVIEW_PROTOCOL, type: "status", status: "ended" });
    await screen.findByText("This review session ended");
    expect(screen.getByRole("button", { name: "Comment on the page" })).toBeTruthy();
    expect(screen.getByRole("article", { name: "Thread 1" })).toBeTruthy();
    // The viewer asks the API for the real state instead of trusting the page.
    await waitFor(() =>
      expect(server.requests.filter((r) => r.path.includes("/annotations")).length).toBeGreaterThan(
        1,
      ),
    );
  });

  it("stops waiting for a page that never answers", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open();
    fireEvent.load(screen.getByTitle("Launch plan, published with Portifact"));
    await act(() => vi.advanceTimersByTimeAsync(BRIDGE_TIMEOUT_MS));
    await screen.findByText("The page does not answer the review tools");
  });

  it("tells the reader a newer version exists and reviews it on request", async () => {
    const store = server.annotations[ID];
    if (store) store.currentVersionId = "v2";
    await open();
    await screen.findByText("A newer version was published");
    expect(screen.queryByRole("button", { name: "Comment on the page" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review the new version" }));
    await waitFor(() =>
      expect(server.requests.filter((r) => r.path.endsWith("/review"))).toHaveLength(2),
    );
  });

  it("lets the owner turn comments on, and tells visitors they are off", async () => {
    const store = server.annotations[ID];
    if (!store) throw new Error("missing");
    store.mode = "off";
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Turn on comments" }));
    await screen.findByRole("button", { name: "Comment on the page" });
    expect(server.bodies.at(-1)).toEqual({ mode: "open" });

    // Readers get no sidebar while comments are off; the bar and the artifact stay.
    cleanup();
    store.mode = "off";
    store.role = "participant";
    server.requests.length = 0;
    renderDashboard(PATH, server);
    await screen.findByTitle("Launch plan, published with Portifact");
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Comments/ })).toBeNull();
    expect(server.requests.some((r) => r.path.includes("/annotations"))).toBe(false);
  });

  it("shows locked comments as read-only", async () => {
    const store = server.annotations[ID];
    if (store) {
      store.mode = "locked";
      store.role = "participant";
    }
    await open();
    expect(screen.getByText("Comments are locked")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Comment on the page" })).toBeNull();
  });

  it("says an artifact cannot be opened like a missing one", async () => {
    delete server.reviews[ID];
    const view = renderDashboard(PATH, server);
    await screen.findByRole("heading", { level: 1, name: "This artifact cannot be opened" });
    expect(view.left).toEqual([]);
  });

  it("links to the viewer from the artifact page", async () => {
    renderDashboard(`/artifacts/${ID}`, server);
    const link = await screen.findByRole("link", { name: "Review and comment" });
    expect(link.getAttribute("href")).toBe(PATH);
  });

  describe("human check of a visitor's first comments", () => {
    /** A widget that records its instances and lets the test solve them or ask for interaction. */
    function fakeWidget() {
      const instances: {
        appearance: string | undefined;
        solve(token: string): void;
        reset(): void;
        interact(visible: boolean): void;
        removed: boolean;
      }[] = [];
      const widget: HumanCheckWidget = {
        render(container, callbacks, options) {
          const marker = document.createElement("p");
          marker.textContent = "Turnstile challenge";
          marker.hidden = true;
          container.append(marker);
          const instance = {
            appearance: options?.appearance,
            solve: callbacks.onToken,
            reset: callbacks.onReset,
            interact(visible: boolean) {
              marker.hidden = !visible;
              callbacks.onInteractive?.(visible);
            },
            removed: false,
          };
          instances.push(instance);
          return () => {
            instance.removed = true;
            marker.remove();
          };
        },
      };
      return { widget, instances };
    }

    function asVisitor(checks: number) {
      const store = server.annotations[ID];
      if (!store) throw new Error("missing");
      store.role = "participant";
      store.humanChecks = checks;
    }

    function startComment(text: string) {
      fireEvent.click(screen.getByRole("button", { name: "Comment on the page" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), {
        target: { value: text },
      });
    }

    const post = () => fireEvent.click(screen.getByRole("button", { name: "Post comment" }));

    const threadKeys = () =>
      server.idempotencyKeys.filter((k) => k.path.endsWith("/threads")).map((k) => k.key);

    it("runs the check invisibly while the visitor writes and posts with its token", async () => {
      asVisitor(1);
      const fake = fakeWidget();
      renderDashboard(PATH, server, { humanCheck: fake.widget });
      await screen.findByRole("heading", { name: "Thread 1" });
      startComment("First note");
      await waitFor(() => expect(fake.instances).toHaveLength(1));
      expect(fake.instances[0]?.appearance).toBe("interaction-only");
      act(() => fake.instances[0]?.solve("solved-1"));
      // Nothing about the check shows on the normal path.
      expect(screen.queryByText(/quick check that you are human/)).toBeNull();
      expect(screen.getByText("Turnstile challenge").hidden).toBe(true);
      post();
      await screen.findByText("3 comment threads");
      expect(server.bodies.at(-1)).toMatchObject({
        body: "First note",
        turnstileToken: "solved-1",
      });
      expect(threadKeys()).toHaveLength(1);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(fake.instances[0]?.removed).toBe(true);
    });

    it("shows the challenge in the composer only when Cloudflare asks, and posts once it is solved", async () => {
      asVisitor(1);
      const fake = fakeWidget();
      const { container } = renderDashboard(PATH, server, { humanCheck: fake.widget });
      await screen.findByRole("heading", { name: "Thread 1" });
      const nonce = await connect();
      const panel = await commentInline(nonce);
      fireEvent.change(within(panel).getByRole("textbox", { name: "Comment" }), {
        target: { value: "Inline note" },
      });
      await waitFor(() => expect(fake.instances).toHaveLength(1));
      act(() => fake.instances[0]?.interact(true));
      expect(within(panel).getByText(/quick check that you are human/)).toBeTruthy();
      expect(within(panel).getByText("Turnstile challenge").hidden).toBe(false);
      Reflect.deleteProperty(HTMLIFrameElement.prototype, "contentWindow");
      expect(await axeViolations(container)).toEqual([]);

      // Saving waits for the visitor; nothing is sent until the challenge is solved.
      const before = server.requests.length;
      fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(server.requests.length).toBe(before);
      act(() => {
        fake.instances[0]?.interact(false);
        fake.instances[0]?.solve("solved-2");
      });
      await screen.findByText("3 comment threads");
      expect(server.bodies.at(-1)).toMatchObject({
        body: "Inline note",
        turnstileToken: "solved-2",
      });
      expect(screen.queryByRole("region", { name: "Comment on the selection" })).toBeNull();
    });

    it("starts the check and retries once with a new key when the API asks for one unexpectedly", async () => {
      asVisitor(0);
      const fake = fakeWidget();
      renderDashboard(PATH, server, { humanCheck: fake.widget });
      await screen.findByRole("heading", { name: "Thread 1" });
      expect(fake.instances).toEqual([]);
      // The hint said no check; the server decides otherwise when the comment is posted.
      const store = server.annotations[ID];
      if (store) store.humanChecks = 1;
      startComment("Surprise");
      post();
      await waitFor(() => expect(fake.instances).toHaveLength(1));
      act(() => fake.instances[0]?.solve("solved-3"));
      await screen.findByText("3 comment threads");
      const [refused, accepted] = threadKeys();
      expect(accepted).toMatch(/^[0-9a-f-]{36}$/);
      expect(accepted).not.toBe(refused);
      expect(server.bodies.at(-1)).toMatchObject({ body: "Surprise", turnstileToken: "solved-3" });
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("says calmly when the check did not go through, and lets the visitor save again", async () => {
      asVisitor(1);
      const fake = fakeWidget();
      renderDashboard(PATH, server, { humanCheck: fake.widget });
      await screen.findByRole("heading", { name: "Thread 1" });
      startComment("First note");
      await waitFor(() => expect(fake.instances).toHaveLength(1));
      act(() => fake.instances[0]?.solve("rejected-1"));
      post();
      await waitFor(() => expect(fake.instances.length).toBeGreaterThan(1));
      act(() => fake.instances.at(-1)?.solve("rejected-2"));
      expect(await screen.findByText(/did not go through/)).toBeTruthy();
      expect(screen.queryByText("The action did not finish")).toBeNull();
      expect(server.bodies.slice(-2)).toMatchObject([
        { turnstileToken: "rejected-1" },
        { turnstileToken: "rejected-2" },
      ]);
      // Saving again runs a fresh challenge.
      post();
      await waitFor(() => expect(fake.instances.length).toBeGreaterThan(2));
      act(() => fake.instances.at(-1)?.solve("solved-4"));
      await screen.findByText("3 comment threads");
    });

    it("sends the token with a reply too, and says when the check cannot load", async () => {
      asVisitor(1);
      renderDashboard(PATH, server, { humanCheck: null });
      const thread = await screen.findByRole("article", { name: "Thread 1" });
      fireEvent.click(within(thread).getByRole("button", { name: "Reply" }));
      const form = within(thread).getByRole("form", { name: "Reply to thread 1" });
      fireEvent.change(within(form).getByRole("textbox", { name: "Reply" }), {
        target: { value: "Agreed" },
      });
      fireEvent.click(within(form).getByRole("button", { name: "Post reply" }));
      expect(await within(form).findByText(/could not load/)).toBeTruthy();
    });

    it("never runs the check for the owner, or for a visitor past their first comments", async () => {
      const fake = fakeWidget();
      renderDashboard(PATH, server, { humanCheck: fake.widget });
      await screen.findByRole("heading", { name: "Thread 1" });
      startComment("Owner note");
      post();
      await screen.findByText("3 comment threads");
      cleanup();
      asVisitor(0);
      renderDashboard(PATH, server, { humanCheck: fake.widget });
      await screen.findByRole("heading", { name: "Thread 1" });
      startComment("Later note");
      post();
      await screen.findByText("4 comment threads");
      expect(fake.instances).toEqual([]);
      expect(server.bodies.at(-1)).not.toHaveProperty("turnstileToken");
    });
  });

  it("links a visitor to the report form with the artifact filled in, never the owner", async () => {
    await open();
    expect(screen.queryByRole("link", { name: "Report this artifact" })).toBeNull();
    cleanup();
    const store = server.annotations[ID];
    if (store) store.role = "participant";
    await open();
    const link = screen.getByRole("link", { name: "Report this artifact" });
    expect(link.getAttribute("href")).toBe(`/report?artifact=${ID}`);
  });
});

describe("the viewer's bar and visitors", () => {
  function makePublic() {
    const listed = server.artifacts.find((a) => a.id === ID);
    if (listed) listed.accessMode = "public";
  }

  it("names the artifact and its version in the bar and copies its link, with no caption row", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await open();
    const bar = screen.getByRole("banner");
    expect(within(bar).getByRole("heading", { level: 1, name: "Launch plan" })).toBeTruthy();
    expect(within(bar).getByText("Version 1")).toBeTruthy();
    expect(within(bar).getByRole("link", { name: "Manage" }).getAttribute("href")).toBe(
      `/artifacts/${ID}`,
    );
    expect(within(bar).queryByRole("link", { name: "Report this artifact" })).toBeNull();
    // One button copies the artifact's own link; the link itself is not shown as a field.
    fireEvent.click(within(bar).getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${ORIGIN}/`));
    await screen.findByText("Link copied.");
    const region = screen.getByRole("main", { name: "Artifact" });
    expect(within(region).queryByText(`${ORIGIN}/`)).toBeNull();
    expect(within(region).queryByRole("heading")).toBeNull();
    expect(screen.queryByText("Published by a user, not by Portifact")).toBeNull();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("shows the link in the toast when the browser refuses the clipboard", async () => {
    const writeText = vi.fn(() => Promise.reject(new Error("denied")));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await open();
    fireEvent.click(within(screen.getByRole("banner")).getByRole("button", { name: "Copy link" }));
    expect(await screen.findByText(`The link could not be copied: ${ORIGIN}/`)).toBeTruthy();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("collapses and reopens the comments sidebar from the bar", async () => {
    await open();
    // A toggle that says how many threads are open.
    const toggle = screen.getByRole("button", { name: "Comments (2 open threads)" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe("viewer-comments");
    expect(screen.getByRole("complementary", { name: "Comments" }).id).toBe("viewer-comments");
    fireEvent.click(toggle);
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.hasAttribute("aria-controls")).toBe(false);
    fireEvent.click(toggle);
    expect(screen.getByRole("complementary", { name: "Comments" })).toBeTruthy();
  });

  it("keeps the toggle and an overflow menu on narrow screens, and opens comments over the artifact", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query.includes("max-width"),
          media: query,
          addEventListener() {},
          removeEventListener() {},
        }) as unknown as MediaQueryList,
    );
    const { container } = renderDashboard(PATH, server);
    await screen.findByTitle("Launch plan, published with Portifact");
    const bar = screen.getByRole("banner");
    const toggle = await within(bar).findByRole("button", { name: "Comments (2 open threads)" });
    // Narrow screens start with the artifact, not the comments.
    expect(screen.queryByRole("complementary")).toBeNull();
    const more = within(bar).getByRole("button", { name: "More" });
    fireEvent.click(more);
    const menu = screen.getByRole("menu", { name: "More" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Copy link", "Manage", "Your artifacts", "Your account"]);
    expect(within(menu).getByRole("menuitem", { name: "Your account" }).getAttribute("href")).toBe(
      "/account",
    );
    Reflect.deleteProperty(HTMLIFrameElement.prototype, "contentWindow");
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.keyDown(menu, { key: "Escape" });

    // The sidebar covers the artifact and takes focus; its close button returns to the toggle.
    fireEvent.click(toggle);
    const sidebar = await screen.findByRole("complementary", { name: "Comments" });
    await waitFor(() => expect(document.activeElement).toBe(sidebar));
    fireEvent.click(within(sidebar).getByRole("button", { name: "Close comments" }));
    expect(screen.queryByRole("complementary")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(toggle));
  });

  it("offers anonymous visitors sign-in in the overflow menu", async () => {
    const listed = server.artifacts.find((a) => a.id === ID);
    if (listed) listed.accessMode = "public";
    server.email = null;
    renderDashboard(PATH, server);
    await screen.findByTitle("Launch plan, published with Portifact");
    const bar = screen.getByRole("banner");
    fireEvent.click(within(bar).getByRole("button", { name: "More" }));
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Copy link",
      "Report this artifact",
      "Sign in",
    ]);
  });

  it("opens review on the page and fragment the link names, and only on the artifact", async () => {
    renderDashboard(`${PATH}?path=${encodeURIComponent("/docs/a.html?x=1")}#intro`, server);
    const frame = (await screen.findByTitle(
      "Launch plan, published with Portifact",
    )) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(`${CODE_URL}&to=%2Fdocs%2Fa.html%3Fx%3D1#intro`);
    cleanup();
    for (const path of ["//evil.example/", "/__portifact/review/end", "https://evil.example/"]) {
      renderDashboard(`${PATH}?path=${encodeURIComponent(path)}`, server);
      const safe = (await screen.findByTitle(
        "Launch plan, published with Portifact",
      )) as HTMLIFrameElement;
      expect(safe.getAttribute("src"), path).toBe(CODE_URL);
      cleanup();
    }
  });

  it("shows a reader the report link instead of the owner's settings", async () => {
    const store = server.annotations[ID];
    if (store) store.role = "participant";
    await open();
    const bar = screen.getByRole("banner");
    expect(within(bar).queryByRole("link", { name: "Manage" })).toBeNull();
    expect(
      within(bar).getByRole("link", { name: "Report this artifact" }).getAttribute("href"),
    ).toBe(`/report?artifact=${ID}`);
  });

  it("shows anonymous visitors of a public artifact the artifact itself and asks them to sign in", async () => {
    makePublic();
    server.email = null;
    const { container } = renderDashboard(
      `${PATH}?path=${encodeURIComponent("/docs/")}#part`,
      server,
    );
    const frame = (await screen.findByTitle(
      "Launch plan, published with Portifact",
    )) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(`${ORIGIN}/docs/#part`);
    expect(frame.getAttribute("sandbox")).toBe(FRAME_SANDBOX);
    const sidebar = screen.getByRole("complementary", { name: "Comments" });
    const signIn = within(sidebar).getByRole("link", { name: "Sign in to comment" });
    expect(signIn.getAttribute("href")).toBe(
      `/login?${new URLSearchParams({ next: `${PATH}?path=%2Fdocs%2F` })}`,
    );
    expect(within(screen.getByRole("banner")).getByRole("link", { name: "Sign in" })).toBeTruthy();
    // No review session, no threads: nothing names an anonymous visitor.
    expect(server.requests.some((r) => r.path.includes("/review"))).toBe(false);
    expect(server.requests.some((r) => r.path.includes("/annotations"))).toBe(false);
    expect(screen.queryByText("Secret feedback for the owner")).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("hides the sidebar from anonymous visitors while comments are off", async () => {
    makePublic();
    server.email = null;
    const store = server.annotations[ID];
    if (store) store.mode = "off";
    renderDashboard(PATH, server);
    await screen.findByTitle("Launch plan, published with Portifact");
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Comments/ })).toBeNull();
  });

  it("sends anonymous visitors of an artifact they cannot see to sign in, back to the same view", async () => {
    server.email = null;
    const view = renderDashboard(`${PATH}?path=%2Fdocs`, server);
    await waitFor(() =>
      expect(view.left).toEqual([
        `/login?${new URLSearchParams({ next: `${PATH}?path=%2Fdocs` })}`,
      ]),
    );
  });

  it("offers the artifact without the bar where the frame keeps no review session", async () => {
    renderDashboard(`${PATH}?path=${encodeURIComponent("/docs/a.html?x=1")}#intro`, server);
    await screen.findByTitle("Launch plan, published with Portifact");
    deliver({ channel: REVIEW_CHANNEL, v: REVIEW_PROTOCOL, type: "status", status: "unavailable" });
    const link = await screen.findByRole("link", { name: "Open without the Portifact bar" });
    expect(link.getAttribute("href")).toBe(
      `${ORIGIN}/__portifact/raw?to=%2Fdocs%2Fa.html%3Fx%3D1#intro`,
    );
  });

  it("shows a public artifact as it is where the browser keeps no review session in the frame", async () => {
    makePublic();
    await open();
    deliver({ channel: REVIEW_CHANNEL, v: REVIEW_PROTOCOL, type: "status", status: "unavailable" });
    const frame = screen.getByTitle("Launch plan, published with Portifact") as HTMLIFrameElement;
    await waitFor(() => expect(frame.getAttribute("src")).toBe(`${ORIGIN}/`));
    expect(screen.getByText("Review tools are not available in this browser")).toBeTruthy();
  });
});

describe("when the review session cannot start", () => {
  it("still shows a public artifact as it is, with a retry, and a protected one only the notice", async () => {
    server.fail("POST", `/api/v1/artifacts/${ID}/review`, { status: 429, code: "rate_limited" }, 2);
    const listed = server.artifacts.find((a) => a.id === ID);
    if (listed) listed.accessMode = "public";
    renderDashboard(PATH, server);
    await screen.findByText("Comments could not be connected to the artifact");
    const frame = screen.getByTitle("Launch plan, published with Portifact") as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(`${ORIGIN}/`);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    cleanup();

    if (listed) listed.accessMode = "restricted";
    renderDashboard(PATH, server);
    await screen.findByText("Comments could not be connected to the artifact");
    expect(screen.queryByTitle("Launch plan, published with Portifact")).toBeNull();
    // The bar is not a security boundary: the artifact itself stays one click away.
    const raw = screen.getByRole("link", { name: "Open without the Portifact bar" });
    expect(raw.getAttribute("href")).toBe(`${ORIGIN}/__portifact/raw`);
  });
});

describe("the owner's brand on the bar", () => {
  const BRAND = {
    name: 'Acme <img src=x onerror="alert(1)">',
    accentColor: "#0000ff",
    link: "https://acme.example.com/",
    logo: { url: `${ORIGIN}/__portifact/brand/${"b".repeat(64)}`, width: 64, height: 32 },
  };

  function branded(role: "owner" | "reader") {
    server.viewers[ID] = {
      artifactId: ID,
      name: "Launch plan",
      type: "site",
      origin: ORIGIN,
      versionNumber: 1,
      accessMode: "restricted",
      annotations: "open",
      role,
      brand: BRAND,
    };
    const store = server.annotations[ID];
    if (store && role === "reader") store.role = "participant";
  }

  it("shows a reader the owner's brand, with Portifact, the real origin and the report link kept", async () => {
    branded("reader");
    const { container } = await open();
    const bar = screen.getByRole("banner");
    const home = within(bar).getByRole("link", { name: `${BRAND.name} (opens in a new tab)` });
    expect(home.getAttribute("href")).toBe("https://acme.example.com/");
    expect(home.getAttribute("target")).toBe("_blank");
    expect(home.getAttribute("rel")).toBe("noopener noreferrer");
    // The name is text: the markup in it never becomes an element.
    expect(home.querySelectorAll("img")).toHaveLength(1);
    expect(home.querySelector("img")?.getAttribute("src")).toBe(BRAND.logo.url);
    expect(home.textContent).toContain(BRAND.name);
    // Portifact's mark is not the bar's home any more, but Portifact stays named under it.
    expect(within(bar).queryByRole("link", { name: "Portifact" })).toBeNull();
    const notice = screen.getByText("Powered by Portifact").parentElement as HTMLElement;
    expect(bar.contains(notice)).toBe(true);
    expect(notice.textContent).toContain("Published at");
    expect(notice.textContent).toContain(`${ID}.portifact.dev`);
    expect(
      within(notice).getByRole("link", { name: "Report this artifact" }).getAttribute("href"),
    ).toBe(`/report?artifact=${ID}`);
    // The bar's own report link is still there too.
    expect(within(bar).getAllByRole("link", { name: "Report this artifact" })).toHaveLength(2);
    // Review mode is never branded: the sidebar and the comments carry no brand.
    const sidebar = screen.getByRole("complementary", { name: "Comments" });
    expect(sidebar.textContent).not.toContain("Acme");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("shows the owner the brand without a report link in the notice", async () => {
    branded("owner");
    await open();
    expect(screen.getByText("Powered by Portifact")).toBeTruthy();
    const notice = screen.getByText("Powered by Portifact").parentElement as HTMLElement;
    expect(within(notice).queryByRole("link")).toBeNull();
  });

  it("keeps the default bar, with no notice, when the API returns no brand", async () => {
    await open();
    const bar = screen.getByRole("banner");
    expect(within(bar).getByRole("link", { name: "Portifact" })).toBeTruthy();
    expect(screen.queryByText("Powered by Portifact")).toBeNull();
  });
});

describe("approval reviews in the viewer", () => {
  const reviewerView = (verdict: "approve" | "changes" | null = null) => ({
    artifactId: ID,
    role: "reviewer" as const,
    available: true,
    review: {
      status: verdict === "approve" ? ("approved" as const) : ("pending" as const),
      reviewers: 1,
      required: 1,
      approvals: verdict === "approve" ? 1 : 0,
      changesRequested: 0,
    },
    request: {
      id: `ar_${"1".repeat(32)}`,
      versionId: "v1",
      requiredApprovals: null,
      showStatus: false,
      requestedAt: "2026-11-08T12:00:00.000Z",
      updatedAt: "2026-11-08T12:00:00.000Z",
      requestedBy: "Owner",
      reviewers: [
        {
          id: `rvw_${"0".repeat(24)}`,
          name: "Ada",
          email: null,
          active: true,
          you: true,
          verdict,
          note: null,
          decidedAt: verdict ? "2026-11-08T12:10:00.000Z" : null,
        },
      ],
      history: [],
    },
  });

  it("shows a requested reviewer the status and the two verdict actions, and sends the version", async () => {
    server.approvals[ID] = reviewerView();
    const { container } = await open();
    const panel = await screen.findByRole("region", { name: "Your review" });
    expect(within(screen.getByRole("banner")).getByText("Review pending")).toBeTruthy();
    fireEvent.change(within(panel).getByRole("textbox", { name: "Note (optional)" }), {
      target: { value: "<b>Ship it</b>" },
    });
    server.approvalReply = reviewerView("approve");
    fireEvent.click(within(panel).getByRole("button", { name: "Approve" }));
    await screen.findByText("Verdict saved");
    expect(server.bodies.at(-1)).toEqual({
      verdict: "approve",
      note: "<b>Ship it</b>",
      versionId: "v1",
    });
    await within(panel).findByText(/Your verdict: Approved/);
    Reflect.deleteProperty(HTMLIFrameElement.prototype, "contentWindow");
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.dataset.theme = theme;
      expect(await axeViolations(container)).toEqual([]);
    }
    delete document.documentElement.dataset.theme;
  });

  it("says a newer version exists when the API refuses the verdict for it", async () => {
    server.approvals[ID] = reviewerView();
    await open();
    const panel = await screen.findByRole("region", { name: "Your review" });
    server.approvalReply = { error: "version_conflict", status: 409 };
    fireEvent.click(within(panel).getByRole("button", { name: "Request changes" }));
    await within(panel).findByText("There is a newer version. Reload the page to review it.");
  });

  it("shows other readers nothing when the review hides its status", async () => {
    await open();
    expect(screen.queryByRole("region", { name: "Your review" })).toBeNull();
    expect(screen.queryByText("Review pending")).toBeNull();
  });
});
