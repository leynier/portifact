import { AnchorDocument, type AnchorElement } from "@portifact/anchors";
import type { AnnotationTarget } from "@portifact/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Bridge,
  type BridgeWindow,
  currentRoute,
  REDRAW_SETTLE_MS,
  ROUTE_POLL_MS,
  SELECTION_SETTLE_MS,
  startBridge,
} from "./bridge.ts";
import { viewerEnvelope } from "./channel.ts";
import type { BridgeMessage, ViewerBody } from "./protocol.ts";

const VIEWER = "https://app.portifact.com";
const NONCE = "abcdefghijklmnopqrstuv";
const SESSION_TAG = "Ses5ionTag_0123456789-";

interface Parent {
  sent: { message: BridgeMessage; origin: string }[];
  postMessage(message: unknown, origin: string): void;
}

let parent: Parent;
let bridge: Bridge | undefined;

function fakeParent(): Parent {
  const sent: Parent["sent"] = [];
  return {
    sent,
    postMessage(message, origin) {
      sent.push({ message: message as BridgeMessage, origin });
    },
  };
}

/** Dispatches a message event as the browser would, with an origin and a source window. */
function deliver(data: unknown, origin = VIEWER, source: unknown = parent) {
  const event = new MessageEvent("message", { data, origin });
  Object.defineProperty(event, "source", { value: source });
  window.dispatchEvent(event);
}

const fromViewer = (body: ViewerBody, nonce = NONCE) => deliver(viewerEnvelope(nonce, body));

function start(html: string, path = "index.html") {
  document.body.innerHTML = html;
  bridge = startBridge(window as unknown as BridgeWindow, parent, {
    appOrigin: VIEWER,
    path,
    sessionTag: SESSION_TAG,
  });
  return bridge;
}

const sentOf = <T extends BridgeMessage["type"]>(type: T) =>
  parent.sent
    .map((entry) => entry.message)
    .filter((message): message is Extract<BridgeMessage, { type: T }> => message.type === type);

// Content hashes use crypto.subtle, which resolves on another thread whenever it is done, so no
// fixed real wait is long enough on a loaded machine. Every digest the bridge starts is tracked
// and settle waits for all of them instead.
const digests = new Set<Promise<ArrayBuffer>>();

function trackDigests() {
  const subtle = globalThis.crypto.subtle;
  const digest = subtle.digest.bind(subtle);
  return vi.spyOn(subtle, "digest").mockImplementation((...args) => {
    const pending = digest(...args);
    digests.add(pending);
    const done = () => digests.delete(pending);
    pending.then(done, done);
    return pending;
  });
}

/** Advances the fake clock, then waits until every content hash and the work after it is done. */
async function settle(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  do {
    await Promise.allSettled([...digests]);
    // A macrotask runs only once every microtask queued after the digests has run.
    await new Promise((resolve) => setImmediate(resolve));
  } while (digests.size > 0);
}

function select(node: Node, start: number, endNode: Node, end: number) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(endNode, end);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

const textOf = (selector: string) => document.querySelector(selector)?.firstChild as Node;

async function textTarget(quote: string): Promise<AnnotationTarget> {
  const doc = new AnchorDocument(document.body as unknown as AnchorElement);
  const start = doc.text.value.indexOf(quote);
  const anchor = {
    kind: "text" as const,
    quote: {
      exact: quote,
      prefix: doc.text.value.slice(Math.max(0, start - 8), start),
      suffix: doc.text.value.slice(start + quote.length, start + quote.length + 8),
    },
    position: { start, end: start + quote.length },
  };
  return { schema: 1, path: "index.html", anchor };
}

let digestSpy: ReturnType<typeof trackDigests>;

beforeEach(() => {
  digestSpy = trackDigests();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  parent = fakeParent();
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  bridge?.stop();
  bridge = undefined;
  window.getSelection()?.removeAllRanges();
  vi.useRealTimers();
  digestSpy.mockRestore();
});

describe("handshake", () => {
  it("announces itself to the viewer's exact origin and waits for a nonce", () => {
    start("<p>Hello</p>");
    expect(parent.sent).toEqual([
      {
        origin: VIEWER,
        message: {
          channel: "portifact-review",
          v: 1,
          type: "ready",
          page: { path: "index.html", route: "/" },
          sessionTag: SESSION_TAG,
        },
      },
    ]);
  });

  it("answers the viewer's check once bound, and only with its nonce", () => {
    start("<p>Hello</p>");
    fromViewer({ type: "ping" });
    expect(sentOf("pong")).toHaveLength(0);
    fromViewer({ type: "init" });
    fromViewer({ type: "ping" }, "x".repeat(22));
    fromViewer({ type: "ping" });
    expect(sentOf("pong")).toEqual([
      { channel: "portifact-review", v: 1, nonce: NONCE, type: "pong" },
    ]);
  });

  it("ignores every message until init, and init from anyone but the viewer", () => {
    start("<p>Hello</p>");
    fromViewer({ type: "focus", id: "t1" });
    deliver(viewerEnvelope(NONCE, { type: "init" }), "https://k7d2qm4xab.portifact.dev");
    deliver(viewerEnvelope(NONCE, { type: "init" }), VIEWER, window);
    expect(parent.sent).toHaveLength(1);
    fromViewer({ type: "init" });
    expect(sentOf("location")).toEqual([
      {
        channel: "portifact-review",
        v: 1,
        nonce: NONCE,
        type: "location",
        page: { path: "index.html", route: "/" },
      },
    ]);
  });

  it("ignores messages with another nonce once bound", async () => {
    start("<p>Hello</p>");
    fromViewer({ type: "init" });
    const other = "zyxwvutsrqponmlkjihgfe";
    fromViewer({ type: "init" }, other);
    fromViewer({ type: "markers", markers: [], active: null }, other);
    expect(sentOf("resolved")).toHaveLength(0);
    fromViewer({ type: "markers", markers: [], active: null });
    expect(sentOf("resolved")).toHaveLength(1);
    expect(parent.sent.every((entry) => entry.origin === VIEWER)).toBe(true);
    expect(
      parent.sent
        .slice(1)
        .every((entry) => "nonce" in entry.message && entry.message.nonce === NONCE),
    ).toBe(true);
  });
});

describe("selection", () => {
  it("reports a selection across elements as a text target, and never posts anything else", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    start("<h1>Review notes</h1><p>Plain <b>bold</b> text</p>");
    fromViewer({ type: "init" });
    select(textOf("h1"), 7, textOf("b"), 2);
    await settle(SELECTION_SETTLE_MS);
    const [message] = sentOf("selection");
    expect(message?.target).toMatchObject({
      schema: 1,
      path: "index.html",
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      anchor: {
        kind: "text",
        quote: { exact: "notes Plain bo", prefix: "Review ", suffix: "ld text" },
        position: { start: 7, end: 21 },
      },
    });
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("reports when the selection is gone, once", async () => {
    start("<p>Hello world</p>");
    fromViewer({ type: "init" });
    select(textOf("p"), 0, textOf("p"), 5);
    await settle(SELECTION_SETTLE_MS);
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    await settle(SELECTION_SETTLE_MS);
    document.dispatchEvent(new Event("selectionchange"));
    await settle(SELECTION_SETTLE_MS);
    expect(sentOf("selection").map((m) => m.target?.anchor.kind ?? null)).toEqual(["text", null]);
  });

  it("does not report selections before the handshake", async () => {
    start("<p>Hello world</p>");
    select(textOf("p"), 0, textOf("p"), 5);
    await settle(SELECTION_SETTLE_MS);
    expect(parent.sent).toHaveLength(1);
  });

  it("refuses a quote over the limit instead of truncating it", async () => {
    start(`<p>${"word ".repeat(400)}</p>`);
    fromViewer({ type: "init" });
    const text = textOf("p");
    select(text, 0, text, 1_600);
    await settle(SELECTION_SETTLE_MS);
    expect(sentOf("selection")).toHaveLength(0);
    expect(sentOf("refused")).toMatchObject([{ reason: "quote_too_long" }]);
  });

  it("clears the page's selection when the viewer asks", async () => {
    start("<p>Hello world</p>");
    fromViewer({ type: "init" });
    select(textOf("p"), 0, textOf("p"), 5);
    fromViewer({ type: "clear-selection" });
    expect(window.getSelection()?.rangeCount).toBe(0);
  });
});

describe("element mode", () => {
  it("picks the clicked element without letting the page see the click", async () => {
    start('<main><button id="buy" type="button">Buy now</button></main>');
    const pageClick = vi.fn();
    document.querySelector("#buy")?.addEventListener("click", pageClick);
    fromViewer({ type: "init" });
    fromViewer({ type: "pick", active: true, hint: "Click an element" });
    const button = document.querySelector("#buy") as HTMLElement;
    button.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle(0);
    expect(pageClick).not.toHaveBeenCalled();
    expect(sentOf("pick-ended")).toHaveLength(1);
    // The element comes before the end of the pick, so the viewer is still waiting for it.
    const order = parent.sent.map((entry) => entry.message.type);
    expect(order.indexOf("element")).toBeLessThan(order.indexOf("pick-ended"));
    expect(sentOf("element")[0]?.target).toMatchObject({
      path: "index.html",
      anchor: { kind: "element", tagName: "button", fingerprint: "Buy now" },
    });
    expect(sentOf("element")[0]?.target.anchor).toMatchObject({
      selectors: expect.arrayContaining(["#buy"]),
    });
  });

  it("picks the focused element with Enter and ends with Escape", async () => {
    start('<main><a id="docs" href="#x">Docs</a><p>Body</p></main>');
    fromViewer({ type: "init" });
    fromViewer({ type: "pick", active: true, hint: "Pick" });
    (document.querySelector("#docs") as HTMLElement).focus();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    await settle(0);
    expect(sentOf("element")).toHaveLength(1);

    fromViewer({ type: "pick", active: true, hint: "Pick" });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    document.querySelector("p")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle(0);
    expect(sentOf("pick-ended")).toHaveLength(2);
    expect(sentOf("element")).toHaveLength(1);
  });

  it("does nothing with keys or clicks outside element mode, or on the page itself", async () => {
    start("<p>Body</p>");
    fromViewer({ type: "init" });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    document.querySelector("p")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    fromViewer({ type: "pick", active: true, hint: "Pick" });
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    fromViewer({ type: "pick", active: false, hint: "Pick" });
    await settle(0);
    expect(sentOf("element")).toHaveLength(0);
    expect(bridge?.overlay.querySelector(".hint")).toBeNull();
  });

  it("shows the viewer's hint while picking", () => {
    start("<p>Body</p>");
    fromViewer({ type: "init" });
    fromViewer({ type: "pick", active: true, hint: "Click an element to comment on it" });
    expect(bridge?.overlay.querySelector('[role="status"]')?.textContent).toBe(
      "Click an element to comment on it",
    );
  });

  it("refuses an element no stable selector can find again", async () => {
    start("<div><span>a</span></div>");
    fromViewer({ type: "init" });
    fromViewer({ type: "pick", active: true, hint: "Pick" });
    const outside = document.createElement("span");
    document.documentElement.append(outside);
    outside.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle(0);
    expect(sentOf("refused")).toMatchObject([{ reason: "outside_root" }]);
    outside.remove();
  });
});

describe("markers", () => {
  it("draws markers with labels from the viewer and reports where each was found", async () => {
    start('<p id="intro">Hello brave new world</p><p>Second paragraph</p>');
    fromViewer({ type: "init" });
    const text = await textTarget("brave new");
    const element: AnnotationTarget = {
      schema: 1,
      path: "index.html",
      anchor: {
        kind: "element",
        selectors: ["#intro"],
        tagName: "p",
        fingerprint: "Hello brave new world",
      },
    };
    const lost: AnnotationTarget = {
      ...text,
      anchor: {
        kind: "text",
        quote: { exact: "not on this page", prefix: "", suffix: "" },
        position: { start: 0, end: 16 },
      },
    };
    const general: AnnotationTarget = {
      schema: 1,
      path: "index.html",
      anchor: { kind: "document" },
    };
    const elsewhere: AnnotationTarget = { ...text, path: "about.html" };
    fromViewer({
      type: "markers",
      active: "t2",
      markers: [
        { id: "t1", label: "1", name: "Open thread 1", target: text },
        { id: "t2", label: "2", name: "Open thread 2", target: element },
        { id: "t3", label: "3", name: "Open thread 3", target: lost },
        { id: "t4", label: "4", name: "Open thread 4", target: general },
        { id: "t5", label: "5", name: "Open thread 5", target: elsewhere },
      ],
    });
    expect(sentOf("resolved")[0]?.results).toEqual([
      { id: "t1", confidence: "exact" },
      { id: "t2", confidence: "exact" },
      { id: "t3", confidence: "orphaned", reason: "not_found" },
      { id: "t4", confidence: "exact" },
    ]);
    const buttons = [...(bridge?.overlay.querySelectorAll("button") ?? [])];
    expect(buttons.map((b) => [b.textContent, b.getAttribute("aria-label")])).toEqual([
      ["1", "Open thread 1"],
      ["2", "Open thread 2"],
    ]);
    expect(buttons[1]?.getAttribute("aria-current")).toBe("true");
    expect(bridge?.overlay.querySelectorAll(".highlight").length).toBeGreaterThan(0);
    expect(bridge?.overlay.querySelectorAll(".element")).toHaveLength(1);

    buttons[0]?.click();
    expect(sentOf("activate")).toMatchObject([{ id: "t1" }]);
  });

  it("orphans markers recorded on another SPA route", async () => {
    window.history.replaceState(null, "", "/app#/settings");
    start("<p>Hello brave new world</p>");
    fromViewer({ type: "init" });
    expect(sentOf("location")[0]?.page).toEqual({ path: "index.html", route: "/app#/settings" });
    const text = { ...(await textTarget("brave")), route: "/app#/home" };
    fromViewer({
      type: "markers",
      active: null,
      markers: [{ id: "t1", label: "1", name: "Open thread 1", target: text }],
    });
    expect(sentOf("resolved")[0]?.results).toEqual([
      { id: "t1", confidence: "orphaned", reason: "route_mismatch" },
    ]);
  });

  it("follows route changes and redraws after the page changes", async () => {
    start("<p>Hello brave new world</p>");
    fromViewer({ type: "init" });
    const text = await textTarget("brave");
    fromViewer({
      type: "markers",
      active: null,
      markers: [{ id: "t1", label: "1", name: "Open thread 1", target: text }],
    });
    document.querySelector("p")?.replaceChildren("Something else entirely");
    await settle(REDRAW_SETTLE_MS);
    expect(sentOf("resolved").at(-1)?.results).toEqual([
      { id: "t1", confidence: "orphaned", reason: "not_found" },
    ]);

    window.history.pushState(null, "", "/next");
    await settle(ROUTE_POLL_MS + REDRAW_SETTLE_MS);
    expect(sentOf("location").at(-1)?.page).toEqual({ path: "index.html", route: "/next" });
  });

  it("records the route the page is on when the reader selects or picks, before the route poll", async () => {
    window.history.replaceState(null, "", "/shop");
    start('<p>Copper kettle</p><button id="add" type="button">Add</button>');
    fromViewer({ type: "init" });
    // A client-side router moves on, and the reader acts before the next route poll.
    window.history.replaceState(null, "", "/shop#/kettle");
    select(textOf("p"), 0, textOf("p"), 6);
    await settle(SELECTION_SETTLE_MS);
    expect(sentOf("selection")[0]?.target?.route).toBe("/shop#/kettle");
    expect(sentOf("location").at(-1)?.page).toEqual({
      path: "index.html",
      route: "/shop#/kettle",
    });

    window.history.replaceState(null, "", "/shop#/cart");
    fromViewer({ type: "pick", active: true, hint: "Pick" });
    document
      .querySelector("#add")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle(0);
    expect(sentOf("element")[0]?.target.route).toBe("/shop#/cart");
  });

  it("resolves markers against the route the page is on when they arrive", async () => {
    window.history.replaceState(null, "", "/shop#/home");
    start("<p>Hello brave new world</p>");
    fromViewer({ type: "init" });
    const text = { ...(await textTarget("brave")), route: "/shop#/about" };
    window.history.replaceState(null, "", "/shop#/about");
    fromViewer({
      type: "markers",
      active: null,
      markers: [{ id: "t1", label: "1", name: "Open thread 1", target: text }],
    });
    expect(sentOf("resolved")[0]?.results).toEqual([{ id: "t1", confidence: "exact" }]);
  });

  it("focuses a marker the viewer asks for", async () => {
    start("<p>Hello brave new world</p>");
    fromViewer({ type: "init" });
    const text = await textTarget("brave");
    fromViewer({
      type: "markers",
      active: null,
      markers: [{ id: "t1", label: "1", name: "Open thread 1", target: text }],
    });
    fromViewer({ type: "focus", id: "t1" });
    const button = bridge?.overlay.querySelector("button");
    expect(button?.getAttribute("aria-current")).toBe("true");
    fromViewer({ type: "focus", id: "missing" });
    expect(bridge?.overlay.querySelector('[aria-current="true"]')).toBeNull();
  });
});

describe("lifecycle", () => {
  it("removes its overlay and stops listening when stopped", () => {
    start("<p>Hello</p>");
    const stopped = bridge;
    stopped?.stop();
    bridge = undefined;
    expect(document.querySelector("portifact-review")).toBeNull();
    fromViewer({ type: "init" });
    expect(parent.sent).toHaveLength(1);
  });

  it("keeps the overlay out of the text that anchors see", () => {
    start("<p>Hello</p>");
    const host = document.querySelector("portifact-review");
    expect(host?.hasAttribute("data-portifact-ignore")).toBe(true);
    expect(host?.parentElement).toBe(document.documentElement);
  });
});

describe("routes", () => {
  it("accepts same-origin paths only", () => {
    expect(currentRoute({ pathname: "/a/b", hash: "#c" })).toBe("/a/b#c");
    expect(currentRoute({ pathname: "/a b", hash: "" })).toBeUndefined();
    expect(currentRoute({ pathname: `/${"a".repeat(3000)}`, hash: "" })).toBeUndefined();
  });
});
