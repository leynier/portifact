// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"enableIframePageLoading":false,"navigation":{"disableChildFrameNavigation":true}}}
// Suggest mode in the viewer (decision 0027). The bridge is played by messages from a stand-in
// window; the frame's own page load and the built preview are covered by the end-to-end tests.
import {
  type AnyViewerMessage,
  REVIEW_CHANNEL,
  REVIEW_PROTOCOL,
  REVIEW_PROTOCOL_EDIT,
} from "@portifact/bridge";
import {
  type ChangeItemView,
  Plan,
  type ReviewStart,
  type ShownEnvelope,
} from "@portifact/contracts";
import { axeViolations } from "@portifact/ui/testing";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  artifact,
  type FakeServer,
  fakeMessage,
  fakeServer,
  fakeSuggestion,
  fakeThread,
  renderDashboard,
} from "./test-support.tsx";

const ID = "k7d2qm4xab";
const ORIGIN = `https://${ID}.portifact.dev`;
const PATH = `/view/${ID}`;
const SESSION_TAG = "s".repeat(22);
const DIGEST = "d".repeat(64);

const START: ReviewStart = {
  artifactId: ID,
  name: "Launch plan",
  type: "site",
  url: `${ORIGIN}/__portifact/review?code=${"c".repeat(43)}`,
  origin: ORIGIN,
  versionId: "v1",
  entrypoint: "index.html",
  sessionTag: SESSION_TAG,
  expiresAt: "2026-11-08T12:01:00.000Z",
  suggestions: true,
};

const TEXT_TARGET = {
  schema: 1 as const,
  path: "index.html",
  anchor: {
    kind: "text" as const,
    quote: { exact: "brave new world", prefix: "Hello ", suffix: "" },
    position: { start: 6, end: 21 },
  },
};
const RECT = { x: 120, y: 200, width: 240, height: 18 };
const TYPED = "bold new world";

let frameWindow: { postMessage: ReturnType<typeof vi.fn> };
let server: FakeServer;

const LAYOUT = { clientWidth: 800, clientHeight: 600, offsetWidth: 100, offsetHeight: 32 };

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
    threads: [{ ...fakeThread("t1"), seq: 1 }],
    deleted: [],
    seq: 1,
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLIFrameElement.prototype, "contentWindow");
  for (const name of Object.keys(LAYOUT)) Reflect.deleteProperty(HTMLElement.prototype, name);
});

function deliver(data: unknown) {
  const event = new MessageEvent("message", { data, origin: ORIGIN });
  Object.defineProperty(event, "source", { value: frameWindow });
  act(() => {
    window.dispatchEvent(event);
  });
}

const sent = () =>
  frameWindow.postMessage.mock.calls.map(([message]) => message as AnyViewerMessage);

const ready = (v: number) => ({
  channel: REVIEW_CHANNEL,
  v,
  type: "ready",
  page: { path: "index.html" },
  sessionTag: SESSION_TAG,
  ...(v === REVIEW_PROTOCOL_EDIT ? { capabilities: ["edit"] } : {}),
});

/** Plays a bridge of protocol 3: both announcements, the newer first. */
async function connect(versions: number[] = [REVIEW_PROTOCOL_EDIT, REVIEW_PROTOCOL]) {
  for (const v of versions) deliver(ready(v));
  await waitFor(() => expect(sent().some((m) => m.type === "init")).toBe(true));
  const init = sent().find((m) => m.type === "init");
  return { nonce: init?.nonce as string, v: init?.v as number };
}

const fromBridge = (nonce: string, body: Record<string, unknown>, v = REVIEW_PROTOCOL_EDIT) =>
  deliver({ channel: REVIEW_CHANNEL, v, nonce, ...body });

async function open() {
  const view = renderDashboard(PATH, server);
  await screen.findByRole("heading", { level: 1, name: "Launch plan" });
  await screen.findByRole("heading", { name: "Thread 1" });
  return view;
}

const modeSwitch = () => screen.findByRole("group", { name: "Review mode" });

/** A floating control over the frame (not the mode switch's buttons), or null. */
const floating = (name: string) =>
  screen.queryAllByRole("button", { name }).find((button) => !button.closest("fieldset")) ?? null;

/** Turns Suggest mode on and returns the epoch the viewer sent. */
async function suggestMode() {
  fireEvent.click(within(await modeSwitch()).getByRole("button", { name: "Suggest mode" }));
  await waitFor(() => expect(sent().some((m) => m.type === "edit-mode")).toBe(true));
  const mode = sent()
    .filter((m) => m.type === "edit-mode")
    .at(-1);
  return mode?.type === "edit-mode" ? mode.epoch : 0;
}

async function openEditor(nonce: string, epoch: number) {
  fromBridge(nonce, { type: "selection", target: TEXT_TARGET, rect: RECT, epoch });
  fireEvent.click(await screen.findByRole("button", { name: "Suggest edit" }));
  return screen.findByRole("region", { name: "Suggest an edit to the selection" });
}

describe("Suggest mode's protocol", () => {
  it("answers a bridge of protocol 3 in version 3 and ignores its version 2 announcement", async () => {
    await open();
    const { v } = await connect();
    expect(v).toBe(REVIEW_PROTOCOL_EDIT);
    expect(sent().filter((m) => m.type === "init")).toHaveLength(1);
    await modeSwitch();
  });

  it("checks each new page load in the handshake's version, so the frame stays connected", async () => {
    await open();
    const { nonce } = await connect();
    fireEvent.load(screen.getByTitle("Launch plan, published with Portifact"));
    const ping = sent().find((m) => m.type === "ping");
    expect(ping).toMatchObject({ v: REVIEW_PROTOCOL_EDIT, nonce });
    fromBridge(nonce, { type: "pong" });
    // Still connected: Suggest mode stays offered and no notice says the frame is lost.
    await modeSwitch();
    expect(screen.queryByText("The frame stopped answering from the artifact")).toBeNull();
  });

  it("speaks version 2 to an older bridge and offers no Suggest mode", async () => {
    await open();
    const { v, nonce } = await connect([REVIEW_PROTOCOL]);
    expect(v).toBe(REVIEW_PROTOCOL);
    await waitFor(() => expect(sent().some((m) => m.type === "highlights")).toBe(true));
    expect(screen.queryByRole("group", { name: "Review mode" })).toBeNull();
    // Comments still work as before.
    fromBridge(nonce, { type: "selection", target: TEXT_TARGET, rect: RECT }, REVIEW_PROTOCOL);
    await screen.findByRole("button", { name: "Comment" });
    expect(sent().every((m) => m.v === REVIEW_PROTOCOL)).toBe(true);
  });

  it("runs exactly the version 2 protocol for comments while suggestions are off", async () => {
    server.reviews[ID] = { ...START, suggestions: false };
    await open();
    // A bridge of this build announces both versions; the viewer answers only version 2.
    const { v, nonce } = await connect();
    expect(v).toBe(REVIEW_PROTOCOL);
    expect(sent().filter((m) => m.type === "init")).toHaveLength(1);
    // A later page load is checked in version 2 and stays connected after the answer.
    fireEvent.load(screen.getByTitle("Launch plan, published with Portifact"));
    expect(sent().find((m) => m.type === "ping")).toMatchObject({ v: REVIEW_PROTOCOL, nonce });
    fromBridge(nonce, { type: "pong" }, REVIEW_PROTOCOL);
    // Selections offer a comment as before, and every message to the frame is version 2.
    fromBridge(nonce, { type: "selection", target: TEXT_TARGET, rect: RECT }, REVIEW_PROTOCOL);
    await waitFor(() => expect(floating("Comment")).not.toBeNull());
    expect(sent().every((m) => m.v === REVIEW_PROTOCOL)).toBe(true);
    expect(screen.queryByText("The frame stopped answering from the artifact")).toBeNull();
  });

  it("offers no Suggest mode while the API has suggestions switched off", async () => {
    server.reviews[ID] = { ...START, suggestions: false };
    await open();
    await connect();
    await waitFor(() => expect(sent().some((m) => m.type === "highlights")).toBe(true));
    expect(screen.queryByRole("group", { name: "Review mode" })).toBeNull();
    // Threads were listed without suggestion fields.
    expect(server.requests.some((r) => r.path.includes("fields=suggestion"))).toBe(false);
  });
});

describe("suggesting an edit", () => {
  it("offers a selection of the current epoch only, and never sends the frame what is typed", async () => {
    const { container } = await open();
    const { nonce } = await connect();
    const epoch = await suggestMode();
    expect(
      sent()
        .filter((m) => m.type === "edit-mode")
        .at(-1),
    ).toMatchObject({
      active: true,
      kind: "text",
    });
    // A selection from before Suggest mode, or replayed with another epoch, offers nothing.
    fromBridge(nonce, { type: "selection", target: TEXT_TARGET, rect: RECT });
    fromBridge(nonce, { type: "selection", target: TEXT_TARGET, rect: RECT, epoch: epoch + 1 });
    expect(floating("Suggest edit")).toBeNull();
    expect(floating("Comment")).toBeNull();

    const editor = await openEditor(nonce, epoch);
    const field = within(editor).getByRole("textbox", { name: "New text" }) as HTMLInputElement;
    expect(field.value).toBe("brave new world");
    fireEvent.change(field, { target: { value: TYPED } });
    // The diff is drawn here with labels.
    const terms = within(editor)
      .getAllByRole("term")
      .map((term) => term.textContent);
    expect(terms).toEqual(["- Removed", "+ Added"]);
    expect(within(editor).getByText(TYPED)).toBeTruthy();
    // The frame got the mode and the epoch, never the typed text.
    expect(JSON.stringify(sent())).not.toContain(TYPED);
    expect(
      sent()
        .filter((m) => m.type === "edit-mode")
        .at(-1),
    ).toMatchObject({ active: false });
    Reflect.deleteProperty(HTMLIFrameElement.prototype, "contentWindow");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("ignores everything the frame sends while the editor is open", async () => {
    await open();
    const { nonce } = await connect();
    const epoch = await suggestMode();
    const editor = await openEditor(nonce, epoch);
    const field = within(editor).getByRole("textbox", { name: "New text" }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: TYPED } });
    fromBridge(nonce, {
      type: "selection",
      target: {
        ...TEXT_TARGET,
        anchor: { ...TEXT_TARGET.anchor, quote: { exact: "other", prefix: "", suffix: "" } },
      },
      rect: RECT,
      epoch,
    });
    fromBridge(nonce, { type: "selection-rect", rect: null });
    expect(field.value).toBe(TYPED);
    expect(screen.getByRole("region", { name: "Suggest an edit to the selection" })).toBe(editor);
  });

  it("reviews with Enter, saves the exact edit with the note and plans it", async () => {
    server.suggestions.plans.t2 = plan();
    await open();
    const { nonce } = await connect();
    const epoch = await suggestMode();
    const editor = await openEditor(nonce, epoch);
    const field = within(editor).getByRole("textbox", { name: "New text" });
    fireEvent.change(field, { target: { value: TYPED } });
    // The note is required, like a comment's body.
    fireEvent.keyDown(field, { key: "Enter" });
    expect(await within(editor).findByText("Write a comment.")).toBeTruthy();
    fireEvent.change(within(editor).getByRole("textbox", { name: "Note" }), {
      target: { value: "Shorter" },
    });
    fireEvent.keyDown(field, { key: "Enter" });
    await within(editor).findByRole("heading", { name: "Check your suggestion" });
    fireEvent.click(within(editor).getByRole("button", { name: "Save suggestion" }));
    await screen.findByText("Suggestion saved.");
    const post = server.requests.find(
      (r) => r.method === "POST" && r.path === `/api/v1/artifacts/${ID}/suggestions`,
    );
    expect(post).toBeTruthy();
    expect(server.bodies).toContainEqual({
      versionId: "v1",
      body: "Shorter",
      edit: { operations: [{ kind: "text", target: TEXT_TARGET, after: TYPED }] },
    });
    await waitFor(() =>
      expect(server.requests).toContainEqual({
        method: "POST",
        path: `/api/v1/artifacts/${ID}/suggestions/t2/plan`,
      }),
    );
    // The new thread is a suggestion, with its state in words.
    const thread = await screen.findByRole("region", { name: "Suggested edit" });
    expect(within(thread).getByText("Suggestion")).toBeTruthy();
    expect(within(thread).getByText("Waiting for a decision")).toBeTruthy();
  });

  it("cancels with Escape and discards the edit when the page changes", async () => {
    await open();
    const { nonce } = await connect();
    const epoch = await suggestMode();
    let editor = await openEditor(nonce, epoch);
    fireEvent.keyDown(within(editor).getByRole("textbox", { name: "New text" }), {
      key: "Escape",
    });
    expect(screen.queryByRole("region", { name: "Suggest an edit to the selection" })).toBeNull();
    const next = sent()
      .filter((m) => m.type === "edit-mode")
      .at(-1);
    expect(next).toMatchObject({ active: true, epoch: epoch + 1 });

    editor = await openEditor(nonce, epoch + 1);
    fireEvent.change(within(editor).getByRole("textbox", { name: "New text" }), {
      target: { value: TYPED },
    });
    fromBridge(nonce, { type: "location", page: { path: "other.html" } });
    await screen.findByText("The page changed, so the unsaved edit was discarded.");
    expect(screen.queryByRole("region", { name: "Suggest an edit to the selection" })).toBeNull();
  });

  it("goes back to comments when Suggest mode is turned off", async () => {
    await open();
    const { nonce } = await connect();
    const epoch = await suggestMode();
    fireEvent.click(within(await modeSwitch()).getByRole("button", { name: "Comment mode" }));
    expect(
      sent()
        .filter((m) => m.type === "edit-mode")
        .at(-1),
    ).toMatchObject({
      active: false,
      epoch,
    });
    fromBridge(nonce, { type: "selection", target: TEXT_TARGET, rect: RECT });
    await waitFor(() => expect(floating("Comment")).not.toBeNull());
  });
});

function plan(): Plan {
  return Plan.parse(planBody());
}

function planBody() {
  const envelope = {
    format: 1 as const,
    status: "listed" as const,
    reason: "spans_nodes",
    operation: { kind: "text" as const, before: "brave new world", after: TYPED },
    binding: {
      artifactId: ID,
      versionId: "v1",
      path: "index.html",
      fileSha256: "a".repeat(64),
      renderer: "html",
      route: null,
      subject: "t2",
      revision: 0,
    },
    people: { submitter: true, acceptor: true },
    location: { unresolved: true as const },
    context: null,
    destinations: [],
    destinationsKnown: false,
  };
  return {
    format: 1,
    binding: envelope.binding,
    kind: "html",
    applied: [],
    listed: [envelope],
    output: null,
    lines: ["file: index.html", "listed (spans_nodes): brave new world → bold new world"],
    digest: DIGEST,
  };
}

function withSuggestion(own: boolean, role: "owner" | "participant" = "owner") {
  const edit = { operations: [{ kind: "text", target: TEXT_TARGET, after: TYPED }] };
  server.annotations[ID] = {
    mode: "open",
    role,
    currentVersionId: "v1",
    threads: [
      {
        ...fakeThread("t1", {
          target: TEXT_TARGET,
          own,
          messages: [fakeMessage({ body: "Shorter", own })],
        }),
        seq: 1,
        kind: "suggestion",
        suggestion: fakeSuggestion("t1", { edit, revision: 3 }),
      },
    ],
    deleted: [],
    seq: 1,
  };
  server.suggestions.plans.t1 = plan();
}

describe("a suggestion in its thread", () => {
  it("shows the change, checks what applies, previews it and accepts by the plan's digest", async () => {
    withSuggestion(false);
    const { container } = await open();
    const block = await screen.findByRole("region", { name: "Suggested edit" });
    expect(
      within(block)
        .getAllByRole("definition")
        .map((d) => d.textContent),
    ).toEqual(["brave new world", TYPED]);
    // An undecided suggestion is never resolved, only decided.
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
    expect(within(block).queryByRole("button", { name: "Withdraw" })).toBeNull();
    fireEvent.click(within(block).getByRole("button", { name: "Check what applies" }));
    const lines = await within(block).findByRole("list", {
      name: "What accepting does, line by line",
    });
    expect(within(lines).getAllByRole("listitem")).toHaveLength(2);
    expect(
      within(block).getByText(
        "The selection crosses formatting or a link, so it goes to the change list.",
      ),
    ).toBeTruthy();
    expect(
      within(block).getByText(/0 changes apply automatically; 1 goes to the change list/),
    ).toBeTruthy();

    // The preview is a tab; each showing asks for a new one-use code.
    fireEvent.click(within(block).getByRole("tab", { name: "Preview" }));
    const frame = (await within(block).findByTitle(
      "Preview of the suggested edit",
    )) as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("src")).toMatch(/^https:\/\/preview\.portifact\.dev\/p\//);
    fireEvent.click(within(block).getByRole("tab", { name: "What applies" }));
    fireEvent.click(within(block).getByRole("tab", { name: "Preview" }));
    await waitFor(() => expect(server.suggestions.previews).toBe(2));

    Reflect.deleteProperty(HTMLIFrameElement.prototype, "contentWindow");
    expect(await axeViolations(container)).toEqual([]);

    fireEvent.click(within(block).getByRole("button", { name: "Accept" }));
    const dialog = await screen.findByRole("dialog", { name: "Accept this suggestion?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Accept and publish" }));
    await screen.findByText("Accepting the suggestion. The new version appears when it is ready.");
    expect(server.bodies).toContainEqual({ digest: DIGEST });
    await within(await screen.findByRole("region", { name: "Suggested edit" })).findByText(
      "Being applied",
    );
  });

  it("says why a preview is unavailable instead of showing the unchanged page", async () => {
    withSuggestion(false);
    server.suggestions.preview = { state: "unavailable", reasons: ["not_text", "css_too_complex"] };
    await open();
    const block = await screen.findByRole("region", { name: "Suggested edit" });
    fireEvent.click(within(block).getByRole("button", { name: "Check what applies" }));
    fireEvent.click(await within(block).findByRole("tab", { name: "Preview" }));
    await within(block).findByText("No preview:");
    expect(within(block).getByText("The page's styles are too complex to preview.")).toBeTruthy();
    expect(within(block).queryByTitle("Preview of the suggested edit")).toBeNull();
  });

  it("lets the owner side reject at the revision it saw", async () => {
    withSuggestion(false);
    await open();
    const block = await screen.findByRole("region", { name: "Suggested edit" });
    fireEvent.click(within(block).getByRole("button", { name: "Reject" }));
    const dialog = await screen.findByRole("dialog", { name: "Reject this suggestion?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reject" }));
    await screen.findByText("Suggestion rejected.");
    expect(server.bodies).toContainEqual({ revision: 3 });
    await within(await screen.findByRole("region", { name: "Suggested edit" })).findByText(
      "Rejected",
    );
  });

  it("lets its author withdraw it, and a reader neither accepts nor rejects", async () => {
    withSuggestion(true, "participant");
    await open();
    const block = await screen.findByRole("region", { name: "Suggested edit" });
    expect(within(block).queryByRole("button", { name: "Reject" })).toBeNull();
    fireEvent.click(within(block).getByRole("button", { name: "Check what applies" }));
    await within(block).findByRole("tab", { name: "Preview" });
    expect(within(block).queryByRole("button", { name: "Accept" })).toBeNull();
    fireEvent.click(within(block).getByRole("button", { name: "Withdraw" }));
    const dialog = await screen.findByRole("dialog", { name: "Withdraw your suggestion?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Withdraw" }));
    await screen.findByText("Suggestion withdrawn.");
    await within(await screen.findByRole("region", { name: "Suggested edit" })).findByText(
      "The edit was withdrawn.",
    );
  });

  it("shows an invisible character in an edit as a chip, never as the character itself", async () => {
    withSuggestion(false);
    const thread = server.annotations[ID]?.threads[0];
    if (thread?.suggestion) {
      thread.suggestion.edit = {
        operations: [{ kind: "text", target: TEXT_TARGET, after: "pay‮us" }],
      };
    }
    await open();
    const block = await screen.findByRole("region", { name: "Suggested edit" });
    const [, added] = within(block).getAllByRole("definition");
    expect(added?.textContent).toBe("paycharacter U+202Eus");
  });
});

function item(state: string, overrides: Partial<ChangeItemView> = {}): ChangeItemView {
  const envelope: ShownEnvelope = {
    ...(plan().listed[0] as ShownEnvelope),
    provenance: { submittedBy: "Bea", acceptedBy: "Ada" },
  };
  return {
    id: `ci_${state}`,
    artifactId: ID,
    origin: "suggestion",
    threadId: "t1",
    versionId: "v1",
    path: "index.html",
    route: null,
    envelope,
    reason: "spans_nodes",
    state,
    createdAt: 0,
    closedAt: null,
    closedVersionId: null,
    revision: 1,
    ...overrides,
  };
}

describe("the change list", () => {
  it("lists what the owner side accepted and marks it applied", async () => {
    server.suggestions.changes[ID] = [item("open"), item("applied")];
    await open();
    const list = screen.getByText("Change list");
    fireEvent.click(list);
    const card = (await screen.findByText("Suggested by Bea, accepted by Ada")).closest("li");
    if (!card) throw new Error("no item");
    expect(within(card).getByText("Open")).toBeTruthy();
    // Only open items at first.
    expect(screen.queryByText("Applied")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Mark applied" }));
    await screen.findByText("Change list updated.");
    expect(server.bodies).toContainEqual({ state: "applied", baseRevision: 1 });
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(screen.getAllByText("Applied")).toHaveLength(2));
  });

  it("is not offered to readers", async () => {
    server.annotations[ID] = {
      mode: "open",
      role: "participant",
      currentVersionId: "v1",
      threads: [{ ...fakeThread("t1"), seq: 1 }],
      deleted: [],
      seq: 1,
    };
    await open();
    expect(screen.queryByText("Change list")).toBeNull();
  });
});
