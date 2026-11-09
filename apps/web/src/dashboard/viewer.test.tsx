// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"enableIframePageLoading":true,"navigation":{"disableChildFrameNavigation":true}}}
// The frame never navigates in these tests: the bridge is played by messages from a stand-in
// window, and the frame's own page load is covered by the end-to-end tests.
import { BRIDGE_LIMITS, REVIEW_CHANNEL, type ViewerMessage } from "@portifact/bridge";
import type { AnnotationTarget, ReviewStart } from "@portifact/contracts";
import { axeViolations } from "@portifact/ui/testing";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HumanCheckWidget } from "../human-check/turnstile.ts";
import { BRIDGE_TIMEOUT_MS } from "./review/use-bridge.ts";
import { FRAME_SANDBOX, REVIEW_TAB_LINK_MS } from "./screens/viewer.tsx";
import {
  artifact,
  type FakeServer,
  fakeMessage,
  fakeServer,
  fakeThread,
  renderDashboard,
  seedVersion,
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

beforeEach(() => {
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
  deliver({ channel: REVIEW_CHANNEL, v: 1, type: "ready", page, sessionTag: SESSION_TAG });
  await waitFor(() => expect(sent().some((s) => s.message.type === "init")).toBe(true));
  const init = sent().find((s) => s.message.type === "init");
  return init?.message.nonce as string;
}

const fromBridge = (nonce: string, body: Record<string, unknown>) =>
  deliver({ channel: REVIEW_CHANNEL, v: 1, nonce, ...body });

async function open() {
  const view = renderDashboard(PATH, server);
  await screen.findByRole("heading", { level: 1, name: "Launch plan" });
  await screen.findByRole("heading", { name: "Thread 1" });
  return view;
}

describe("review viewer", () => {
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

  it("answers the bridge's handshake with a nonce and sends only targets and labels", async () => {
    await open();
    const nonce = await connect();
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    await waitFor(() => expect(sent().some((s) => s.message.type === "markers")).toBe(true));
    expect(sent().every((s) => s.origin === ORIGIN)).toBe(true);
    const markers = sent().find((s) => s.message.type === "markers")?.message;
    expect(markers).toMatchObject({
      nonce,
      markers: [{ id: "t1", label: "1", name: "Open thread 1", target: TEXT_TARGET }],
      active: null,
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
      { channel: REVIEW_CHANNEL, v: 1, nonce, ...selection },
      "https://p3n5wq7yzc.portifact.dev",
    );
    deliver({ channel: REVIEW_CHANNEL, v: 1, nonce, ...selection }, ORIGIN, window);
    deliver({ channel: REVIEW_CHANNEL, v: 1, nonce: "x".repeat(22), ...selection });
    deliver({
      channel: REVIEW_CHANNEL,
      v: 1,
      nonce,
      ...selection,
      extra: "x".repeat(BRIDGE_LIMITS.bridgeMessageMaxBytes),
    });
    deliver({ channel: REVIEW_CHANNEL, v: 1, nonce, type: "post", body: "spam" });
    // A forged "ready" from another window cannot take over the handshake either.
    deliver(
      {
        channel: REVIEW_CHANNEL,
        v: 1,
        type: "ready",
        page: { path: "index.html" },
        sessionTag: SESSION_TAG,
      },
      ORIGIN,
      window,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("button", { name: "Comment on the selection" })).toBeNull();
    expect(sent().filter((s) => s.message.type === "init")).toHaveLength(1);
    expect(server.requests.some((r) => r.path.endsWith("/threads"))).toBe(false);
  });

  it("turns a selection into a comment only after the reader writes and confirms it", async () => {
    await open();
    const nonce = await connect();
    fromBridge(nonce, { type: "selection", target: TEXT_TARGET });
    const offer = await screen.findByRole("button", { name: "Comment on the selection" });
    expect(server.requests.some((r) => r.path.endsWith("/threads"))).toBe(false);

    fireEvent.click(offer);
    const form = screen.getByRole("form", { name: "New comment" });
    fireEvent.click(within(form).getByRole("button", { name: "Post comment" }));
    await within(form).findByText("Write a comment.");
    expect(server.requests.some((r) => r.path.endsWith("/threads"))).toBe(false);

    fireEvent.change(within(form).getByRole("textbox", { name: "Comment" }), {
      target: { value: "Rename this" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Post comment" }));
    await screen.findByText("3 comment threads");
    expect(screen.getByText("Rename this")).toBeTruthy();
    expect(server.bodies.at(-1)).toEqual({
      versionId: "v1",
      target: TEXT_TARGET,
      body: "Rename this",
    });
    expect(screen.queryByRole("form", { name: "New comment" })).toBeNull();
    expect(
      sent().at(-1)?.message.type === "markers" ||
        sent().some((s) => s.message.type === "clear-selection"),
    ).toBe(true);
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
    fromBridge(nonce, { type: "element", target: ELEMENT_TARGET });
    fromBridge(nonce, { type: "pick-ended" });
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
    expect(screen.queryByRole("form", { name: "New comment" })).toBeNull();
    expect(screen.queryByText("Element button")).toBeNull();
    expect(document.activeElement?.tagName).not.toBe("TEXTAREA");
  });

  it("keeps the target of an open comment when the page sends another one", async () => {
    await open();
    const nonce = await connect();
    fromBridge(nonce, { type: "selection", target: TEXT_TARGET });
    fireEvent.click(await screen.findByRole("button", { name: "Comment on the selection" }));
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
    fireEvent.click(within(form).getByRole("button", { name: "Post comment" }));
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
    await waitFor(() => expect(sent().some((s) => s.message.type === "markers")).toBe(true));
    const ids = () => {
      const last = sent()
        .map((s) => s.message)
        .filter((message) => message.type === "markers")
        .at(-1);
      return last?.markers.map((marker) => marker.id);
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

  it("ignores results and activations for threads it did not send to the page", async () => {
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
    fromBridge(nonce, { type: "activate", id: "t2" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = screen.getByRole("article", { name: "Thread 2" });
    expect(second.getAttribute("aria-current")).toBeNull();
    expect(document.activeElement).not.toBe(second);
  });

  it("moves focus to the thread a reader activates in the page", async () => {
    await open();
    const nonce = await connect();
    fromBridge(nonce, { type: "activate", id: "t1" });
    const thread = screen.getByRole("article", { name: "Thread 1" });
    await waitFor(() => expect(document.activeElement).toBe(thread));
    expect(thread.getAttribute("aria-current")).toBe("true");
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
    await screen.findByText("Second opinion");
    expect(server.requests.at(-1)?.path).toBe(`/api/v1/artifacts/${ID}/annotations?cursor=2`);
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

describe("thread actions", () => {
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

  it("lets the owner hide and delete other people's messages, and delete threads after confirming", async () => {
    await open();
    const thread = screen.getByRole("article", { name: "Thread 1" });
    fireEvent.click(within(thread).getByRole("button", { name: "Hide" }));
    await within(thread).findByRole("button", { name: "Show again" });
    expect(server.bodies.at(-1)).toEqual({ action: "hide" });

    fireEvent.click(within(thread).getByRole("button", { name: "Delete thread" }));
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
    expect(within(first).queryByRole("button", { name: "Hide" })).toBeNull();
    expect(within(first).queryByRole("button", { name: "Delete thread" })).toBeNull();
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
  const choose = (name: string, value: string) =>
    fireEvent.change(screen.getByRole("combobox", { name }), { target: { value } });
  const lastMarkers = () =>
    sent()
      .map((s) => s.message)
      .filter((message) => message.type === "markers")
      .at(-1)
      ?.markers.map((marker) => marker.id);

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
    const tools = screen.getByRole("region", { name: "Filter and export" });
    expect(
      within(tools)
        .getAllByRole("option")
        .slice(3, 7)
        .map((option) => option.textContent),
    ).toEqual(["Everyone", "You", "Bea", "Cy"]);
    expect(await axeViolations(container)).toEqual([]);

    choose("Status", "resolved");
    expect(headings()).toEqual(["Thread 3"]);
    expect(screen.getByText("Showing 1 of 4 comment threads").getAttribute("role")).toBe("status");
    await waitFor(() => expect(lastMarkers()).toEqual(["t3"]));

    choose("Status", "all");
    choose("Author", "own");
    expect(headings()).toEqual(["Thread 4"]);
    await waitFor(() => expect(lastMarkers()).toEqual([]));

    choose("Author", "id:u-bea");
    expect(headings()).toEqual(["Thread 1", "Thread 2"]);
    choose("Status", "resolved");
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
    const versions = screen.getByRole("combobox", { name: "Version" });
    await waitFor(() =>
      expect(
        within(versions)
          .getAllByRole("option")
          .map((o) => o.textContent),
      ).toEqual(["Current version", "All versions", "Version 1"]),
    );

    choose("Version", "all");
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

    choose("Version", "v0");
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

    choose("Status", "open");
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
    const tools = screen.getByRole("region", { name: "Filter and export" });
    expect((await within(tools).findByRole("alert")).textContent).toContain(
      "Portifact is at capacity right now",
    );
    expect(saved).toHaveLength(0);
  });
});

describe("review states", () => {
  it("says when the browser cannot keep the review cookie, and keeps general comments", async () => {
    await open();
    deliver({ channel: REVIEW_CHANNEL, v: 1, type: "status", status: "unavailable" });
    await screen.findByText("Review tools are not available in this browser");
    expect(screen.getByRole("button", { name: "Comment on the page" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Select an element" })).toBeNull();
  });

  it("offers a review tab where the frame cannot keep the cookie, through a one-use link", async () => {
    await open();
    expect(screen.queryByRole("heading", { name: "Review in a separate tab" })).toBeNull();
    deliver({ channel: REVIEW_CHANNEL, v: 1, type: "status", status: "unavailable" });
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
    deliver({ channel: REVIEW_CHANNEL, v: 1, type: "status", status: "unavailable" });
    delete server.reviews[ID];
    fireEvent.click(await screen.findByRole("button", { name: "Prepare a review tab" }));
    await screen.findByText("The action did not finish");
    expect(screen.queryByRole("link", { name: "Open the review tab" })).toBeNull();
  });

  it("offers to reload when the review session ends, with a new code", async () => {
    await open();
    deliver({ channel: REVIEW_CHANNEL, v: 1, type: "status", status: "ended" });
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
      v: 1,
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
    deliver({ channel: REVIEW_CHANNEL, v: 1, type: "status", status: "ended" });
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
    expect(screen.queryByRole("button", { name: "Comments" })).toBeNull();
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
    const link = await screen.findByRole("link", { name: "Open in the viewer" });
    expect(link.getAttribute("href")).toBe(PATH);
  });

  describe("human check of a visitor's first comments", () => {
    /** A widget that records its instances and lets the test solve them. */
    function fakeWidget() {
      const instances: { solve(token: string): void; reset(): void; removed: boolean }[] = [];
      const widget: HumanCheckWidget = {
        render(container, callbacks) {
          const marker = document.createElement("p");
          marker.textContent = "Turnstile challenge";
          container.append(marker);
          const instance = { solve: callbacks.onToken, reset: callbacks.onReset, removed: false };
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

    async function writeComment(text: string) {
      fireEvent.click(screen.getByRole("button", { name: "Comment on the page" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), {
        target: { value: text },
      });
      fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
    }

    const threadKeys = () =>
      server.idempotencyKeys.filter((k) => k.path.endsWith("/threads")).map((k) => k.key);

    it("shows the check when the API asks for it, then posts with the token and a new key", async () => {
      asVisitor(1);
      const fake = fakeWidget();
      const { container } = renderDashboard(PATH, server, { humanCheck: fake.widget });
      await screen.findByRole("heading", { name: "Thread 1" });
      await writeComment("First note");
      const group = await screen.findByRole("group", { name: "Confirm you are human" });
      expect(within(group).getByText("Turnstile challenge")).toBeTruthy();
      expect(screen.getByText(/need a quick check that you are human/)).toBeTruthy();
      expect(fake.instances).toHaveLength(1);

      // Posting before solving it says what is missing and sends nothing.
      const sentBefore = server.requests.length;
      fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
      expect(await within(group).findByRole("alert")).toBeTruthy();
      expect(server.requests.length).toBe(sentBefore);

      act(() => fake.instances[0]?.solve("solved-1"));
      await waitFor(() => expect(within(group).queryByRole("alert")).toBeNull());
      Reflect.deleteProperty(HTMLIFrameElement.prototype, "contentWindow");
      expect(await axeViolations(container)).toEqual([]);
      fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
      await screen.findByText("3 comment threads");
      expect(server.bodies.at(-1)).toMatchObject({
        body: "First note",
        turnstileToken: "solved-1",
      });
      const [refused, accepted] = threadKeys();
      expect(refused).toMatch(/^[0-9a-f-]{36}$/);
      expect(accepted).toMatch(/^[0-9a-f-]{36}$/);
      expect(accepted).not.toBe(refused);
      expect(fake.instances[0]?.removed).toBe(true);
    });

    it("offers a fresh challenge when a solved token is refused or expires", async () => {
      asVisitor(1);
      const fake = fakeWidget();
      renderDashboard(PATH, server, { humanCheck: fake.widget });
      await screen.findByRole("heading", { name: "Thread 1" });
      await writeComment("First note");
      await screen.findByRole("group", { name: "Confirm you are human" });
      act(() => fake.instances[0]?.solve("rejected-token"));
      fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
      await waitFor(() => expect(fake.instances).toHaveLength(2));
      expect(fake.instances[0]?.removed).toBe(true);
      expect(server.bodies.at(-1)).toMatchObject({ turnstileToken: "rejected-token" });

      act(() => {
        fake.instances[1]?.solve("solved-2");
        fake.instances[1]?.reset();
      });
      fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
      expect(await screen.findByText("Complete the check first, then post again.")).toBeTruthy();
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
      const group = await within(form).findByRole("group", { name: "Confirm you are human" });
      expect(within(group).getByText(/could not load/)).toBeTruthy();
    });

    it("posts a visitor's later comments without any check", async () => {
      asVisitor(0);
      const fake = fakeWidget();
      renderDashboard(PATH, server, { humanCheck: fake.widget });
      await screen.findByRole("heading", { name: "Thread 1" });
      await writeComment("Later note");
      await screen.findByText("3 comment threads");
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

  it("shows the bar and caption: the version, sharing and the owner's settings", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await open();
    const bar = screen.getByRole("banner");
    expect(
      within(screen.getByRole("main", { name: "Artifact" })).getByText("Version 1"),
    ).toBeTruthy();
    expect(within(bar).getByRole("link", { name: "Manage" }).getAttribute("href")).toBe(
      `/artifacts/${ID}`,
    );
    expect(within(bar).queryByRole("link", { name: "Report this artifact" })).toBeNull();
    fireEvent.click(within(bar).getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${ORIGIN}/`));
    await screen.findByText("Link copied.");
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("says whose page it is: the artifact's origin and a user-content notice by the frame, not the bar", async () => {
    await open();
    expect(within(screen.getByRole("banner")).queryByText("Launch plan")).toBeNull();
    const region = screen.getByRole("main", { name: "Artifact" });
    expect(within(region).getByRole("heading", { level: 1, name: "Launch plan" })).toBeTruthy();
    expect(within(region).getByText(`${ID}.portifact.dev`)).toBeTruthy();
    expect(within(region).getByText("Published by a user, not by Portifact")).toBeTruthy();
  });

  it("collapses and reopens the comments sidebar from the bar", async () => {
    await open();
    const toggle = screen.getByRole("button", { name: "Comments" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe("viewer-comments");
    expect(screen.getByRole("complementary", { name: "Comments" }).id).toBe("viewer-comments");
    fireEvent.click(toggle);
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByRole("complementary", { name: "Comments" })).toBeTruthy();
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
    expect(screen.queryByRole("button", { name: "Comments" })).toBeNull();
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
    deliver({ channel: REVIEW_CHANNEL, v: 1, type: "status", status: "unavailable" });
    const link = await screen.findByRole("link", { name: "Open without the Portifact bar" });
    expect(link.getAttribute("href")).toBe(
      `${ORIGIN}/__portifact/raw?to=%2Fdocs%2Fa.html%3Fx%3D1#intro`,
    );
  });

  it("shows a public artifact as it is where the browser keeps no review session in the frame", async () => {
    makePublic();
    await open();
    deliver({ channel: REVIEW_CHANNEL, v: 1, type: "status", status: "unavailable" });
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
