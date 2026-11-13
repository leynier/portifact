// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"enableIframePageLoading":false,"navigation":{"disableChildFrameNavigation":true}}}
// Suggest mode in the viewer (decision 0027). The bridge is played by messages from a stand-in
// window; the frame's own page load and the built preview are covered by the end-to-end tests.

import { AnchorDocument, type AnchorElement, createTextAnchor } from "@portifact/anchors";
import {
  type AnyViewerMessage,
  REVIEW_CHANNEL,
  REVIEW_PROTOCOL,
  REVIEW_PROTOCOL_EDIT,
} from "@portifact/bridge";
import {
  type ChangeItemView,
  type PageText,
  Plan,
  type ReviewStart,
  type ShownEnvelope,
} from "@portifact/contracts";
import { newWork, servedPageText } from "@portifact/domain/suggestions";
import { axeViolations } from "@portifact/ui/testing";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findMatches, pageText, targetOf } from "./review/text-search.ts";
import {
  artifact,
  type FakeAnnotations,
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
    const sentence = (await screen.findByText("Suggested by", { exact: false })).closest("p");
    expect(sentence?.textContent).toBe("Suggested by Bea, accepted by Ada");
    const card = sentence?.closest("li");
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

describe("review findings (pf268)", () => {
  it("withdraws an offer when the real v3 bridge sends its null selection", async () => {
    await open();
    const { nonce } = await connect();
    const epoch = await suggestMode();
    fromBridge(nonce, { type: "selection", target: TEXT_TARGET, rect: RECT, epoch });
    expect(floating("Suggest edit")).not.toBeNull();
    // bridge.ts reportSelection's no-range branch emits exactly this (without epoch).
    fromBridge(nonce, { type: "selection", target: null });
    expect(floating("Suggest edit")).toBeNull();
  });

  it("renegotiates when a later page has the previous release's bridge", async () => {
    await open();
    await connect();
    // The same frame navigates and loads a cached v2-only bridge.
    fireEvent.load(screen.getByTitle("Launch plan, published with Portifact"));
    deliver(ready(REVIEW_PROTOCOL));
    const inits = sent().filter((m) => m.type === "init");
    expect(inits).toHaveLength(2);
    expect(inits.at(-1)?.v).toBe(REVIEW_PROTOCOL);
  });

  it("does not upgrade a pending rejection to a revision refreshed behind its dialog", async () => {
    withSuggestion(false);
    const { queryClient } = await open();
    const block = await screen.findByRole("region", { name: "Suggested edit" });
    fireEvent.click(within(block).getByRole("button", { name: "Reject" }));
    const dialog = await screen.findByRole("dialog", { name: "Reject this suggestion?" });
    const store = server.annotations[ID];
    const thread = store?.threads[0];
    if (!store || !thread?.suggestion) throw new Error("missing suggestion");
    // A carry updates suggestion_revision while the confirmation is open.
    thread.suggestion.revision = 4;
    store.seq += 1;
    thread.seq = store.seq;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["annotations", ID] });
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reject" }));
    await waitFor(() =>
      expect(server.requests.some((r) => r.path.endsWith("/t1/reject"))).toBe(true),
    );
    expect(server.bodies.at(-1)).toEqual({ revision: 3 });
  });

  it("renders provenance's hidden characters through the typed display", async () => {
    const change = item("open");
    change.envelope = {
      ...(change.envelope as ShownEnvelope),
      provenance: {
        submittedBy: "Bea\u202e",
        acceptedBy: "Ada\u200b",
      },
    };
    server.suggestions.changes[ID] = [change];
    await open();
    fireEvent.click(screen.getByText("Change list"));
    // The sentence holds each name as its own typed field.
    const label = await screen.findByText("Suggested by", { exact: false });
    const provenance = label.closest("p") as HTMLElement;
    expect(provenance.textContent).not.toMatch(/[\u202e\u200b]/u);
    expect(provenance.textContent).toContain("U+202E");
    expect(provenance.textContent).toContain("U+200B");
  });

  it("keeps acceptance bound to the displayed digest after the server replaces the plan", async () => {
    withSuggestion(false);
    await open();
    const block = await screen.findByRole("region", { name: "Suggested edit" });
    fireEvent.click(within(block).getByRole("button", { name: "Check what applies" }));
    await within(block).findByRole("tab", { name: "What applies" });
    fireEvent.click(within(block).getByRole("button", { name: "Accept" }));
    const dialog = await screen.findByRole("dialog", { name: "Accept this suggestion?" });
    server.suggestions.plans.t1 = { ...plan(), digest: "e".repeat(64), lines: ["REPLACED"] };
    fireEvent.click(within(dialog).getByRole("button", { name: "Accept and publish" }));
    await waitFor(() =>
      expect(server.requests.some((r) => r.path.endsWith("/t1/accept"))).toBe(true),
    );
    expect(server.bodies.at(-1)).toEqual({ digest: DIGEST });
    expect(server.annotations[ID]?.threads[0]?.suggestion?.state).toBe("pending");
  });
});

describe("the opener (pf268)", () => {
  it("never submits a different same-text target introduced at the opener click", async () => {
    await open();
    const { nonce } = await connect();
    const epoch = await suggestMode();
    fromBridge(nonce, { type: "selection", target: TEXT_TARGET, rect: RECT, epoch });
    const opener = await screen.findByRole("button", { name: "Suggest edit" });
    // The user has chosen the visible offer. A queued artifact message precedes the click's
    // reducer action; both are processed before React commits another visible frame.
    const replacement = { ...TEXT_TARGET, path: "other.html" };
    act(() => {
      fromBridge(nonce, { type: "selection", target: replacement, rect: RECT, epoch });
      fireEvent.click(opener);
    });
    const editor = await screen.findByRole("region", { name: "Suggest an edit to the selection" });
    // Both targets have the same quote; the editor and its confirmation reveal no path/context.
    expect(
      (within(editor).getByRole("textbox", { name: "New text" }) as HTMLInputElement).value,
    ).toBe(TEXT_TARGET.anchor.quote.exact);
    fireEvent.change(within(editor).getByRole("textbox", { name: "New text" }), {
      target: { value: TYPED },
    });
    fireEvent.change(within(editor).getByRole("textbox", { name: "Note" }), {
      target: { value: "Shorter" },
    });
    fireEvent.click(within(editor).getByRole("button", { name: "Review" }));
    fireEvent.click(await within(editor).findByRole("button", { name: "Save suggestion" }));
    await waitFor(() =>
      expect(
        server.requests.some(
          (r) => r.method === "POST" && r.path === `/api/v1/artifacts/${ID}/suggestions`,
        ),
      ).toBe(true),
    );
    expect(server.bodies).toContainEqual({
      versionId: "v1",
      body: "Shorter",
      edit: { operations: [{ kind: "text", target: TEXT_TARGET, after: TYPED }] },
    });
  });
});

describe("what the editor addresses (pf268)", () => {
  it("names the page and route of the target, typed, while editing and when reviewing", async () => {
    await open();
    const { nonce } = await connect();
    const epoch = await suggestMode();
    const routed = { ...TEXT_TARGET, path: "docs\u202e.html", route: "/guide" };
    fromBridge(nonce, { type: "selection", target: routed, rect: RECT, epoch });
    fireEvent.click(await screen.findByRole("button", { name: "Suggest edit" }));
    const editor = await screen.findByRole("region", { name: "Suggest an edit to the selection" });
    const where = () => within(editor).getByText("On").closest("p");
    expect(where()?.textContent).toBe("On docscharacter U+202E.html /guide");
    fireEvent.change(within(editor).getByRole("textbox", { name: "New text" }), {
      target: { value: TYPED },
    });
    fireEvent.change(within(editor).getByRole("textbox", { name: "Note" }), {
      target: { value: "Shorter" },
    });
    fireEvent.click(within(editor).getByRole("button", { name: "Review" }));
    await within(editor).findByRole("heading", { name: "Check your suggestion" });
    expect(where()?.textContent).toBe("On docscharacter U+202E.html /guide");
  });
});

describe("races at the frame and the decisions (pf268)", () => {
  it("discards an open edit on a new ready or a status, and ignores element picks in Suggest mode", async () => {
    await open();
    let { nonce } = await connect();
    let epoch = await suggestMode();
    fromBridge(nonce, {
      type: "element",
      target: {
        schema: 1,
        path: "index.html",
        anchor: { kind: "element", selectors: ["#b"], tagName: "b", fingerprint: "x" },
      },
      rect: RECT,
      epoch,
    });
    expect(floating("Suggest edit")).toBeNull();
    expect(floating("Comment")).toBeNull();
    await openEditor(nonce, epoch);
    // A new page announces itself: the edit is gone, and Suggest mode starts a new period.
    ({ nonce } = await connectAgain());
    expect(screen.queryByRole("region", { name: "Suggest an edit to the selection" })).toBeNull();
    epoch = (
      sent()
        .filter((m) => m.type === "edit-mode")
        .at(-1) as { epoch: number }
    ).epoch;
    await openEditor(nonce, epoch);
    deliver({ channel: REVIEW_CHANNEL, v: REVIEW_PROTOCOL_EDIT, type: "status", status: "ended" });
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Suggest an edit to the selection" })).toBeNull(),
    );
  });

  it("opens one editor for a double activation in one turn", async () => {
    await open();
    const { nonce } = await connect();
    const epoch = await suggestMode();
    fromBridge(nonce, { type: "selection", target: TEXT_TARGET, rect: RECT, epoch });
    const opener = await screen.findByRole("button", { name: "Suggest edit" });
    act(() => {
      fireEvent.click(opener);
      fireEvent.click(opener);
    });
    expect(
      await screen.findAllByRole("region", { name: "Suggest an edit to the selection" }),
    ).toHaveLength(1);
  });

  it("sends one acceptance for a double confirmation, and keeps its state through a refresh", async () => {
    withSuggestion(false);
    const { queryClient } = await open();
    const block = await screen.findByRole("region", { name: "Suggested edit" });
    fireEvent.click(within(block).getByRole("button", { name: "Check what applies" }));
    await within(block).findByRole("tab", { name: "What applies" });
    fireEvent.click(within(block).getByRole("button", { name: "Accept" }));
    const dialog = await screen.findByRole("dialog", { name: "Accept this suggestion?" });
    const confirm = within(dialog).getByRole("button", { name: "Accept and publish" });
    act(() => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });
    await within(block).findByText("Being applied");
    expect(server.requests.filter((r) => r.path.endsWith("/t1/accept"))).toHaveLength(1);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["annotations", ID] });
    });
    expect(
      within(await screen.findByRole("region", { name: "Suggested edit" })).getByText(
        "Being applied",
      ),
    ).toBeTruthy();
  });
});

/** A new page of the same frame announces itself (protocol 3 bridge), and the viewer answers. */
async function connectAgain() {
  const before = sent().filter((m) => m.type === "init").length;
  for (const v of [REVIEW_PROTOCOL_EDIT, REVIEW_PROTOCOL]) deliver(ready(v));
  await waitFor(() => expect(sent().filter((m) => m.type === "init").length).toBe(before + 1));
  const init = sent()
    .filter((m) => m.type === "init")
    .at(-1);
  return { nonce: init?.nonce as string };
}

describe("the owner's draft (decision 0027)", () => {
  const editMode = async () => {
    fireEvent.click(within(await modeSwitch()).getByRole("button", { name: "Edit mode" }));
    await waitFor(() =>
      expect(
        sent()
          .filter((m) => m.type === "edit-mode")
          .at(-1),
      ).toMatchObject({ active: true }),
    );
    const mode = sent()
      .filter((m) => m.type === "edit-mode")
      .at(-1);
    return mode?.type === "edit-mode" ? mode.epoch : 0;
  };
  const draftPanel = () => screen.getByRole("region", { name: "Your draft" });

  async function addToDraft(nonce: string, epoch: number, after: string) {
    const editor = await openEditor(nonce, epoch);
    expect(within(editor).getByRole("heading", { name: "Change the text" })).toBeTruthy();
    expect(within(editor).queryByRole("textbox", { name: "Note" })).toBeNull();
    const field = within(editor).getByRole("textbox", { name: "New text" });
    fireEvent.change(field, { target: { value: after } });
    fireEvent.keyDown(field, { key: "Enter" });
    await within(editor).findByRole("heading", { name: "Check your suggestion" });
    fireEvent.click(within(editor).getByRole("button", { name: "Add to draft" }));
    await screen.findByText("Added to your draft.");
  }

  it("is offered to the owner side only", async () => {
    server.annotations[ID] = {
      ...(server.annotations[ID] as FakeAnnotations),
      role: "participant",
    };
    await open();
    await connect();
    const group = await modeSwitch();
    expect(within(group).queryByRole("button", { name: "Edit mode" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Your draft" })).toBeNull();
  });

  it("adds an edit to a private draft, never posting it to the frame, and coalesces edits of the same text", async () => {
    const { container } = await open();
    const { nonce } = await connect();
    let epoch = await editMode();
    expect(within(draftPanel()).getByText(/Your changes stay private/)).toBeTruthy();
    await addToDraft(nonce, epoch, TYPED);
    expect(server.bodies).toContainEqual({
      baseVersionId: "v1",
      edit: { operations: [{ kind: "text", target: TEXT_TARGET, after: TYPED }] },
      baseRevision: null,
      baseIncarnation: null,
    });
    expect(JSON.stringify(sent())).not.toContain(TYPED);
    expect(within(draftPanel()).getByText("1 change")).toBeTruthy();
    // No suggestion was started.
    expect(server.requests.some((r) => r.path.endsWith("/suggestions"))).toBe(false);

    epoch = (
      sent()
        .filter((m) => m.type === "edit-mode")
        .at(-1) as { epoch: number }
    ).epoch;
    await addToDraft(nonce, epoch, "the bravest world");
    expect(server.bodies.at(-1)).toEqual({
      baseVersionId: "v1",
      edit: { operations: [{ kind: "text", target: TEXT_TARGET, after: "the bravest world" }] },
      baseRevision: 1,
      baseIncarnation: "i".repeat(22),
    });
    expect(within(draftPanel()).getByText("1 change")).toBeTruthy();
    Reflect.deleteProperty(HTMLIFrameElement.prototype, "contentWindow");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("checks what applies and publishes the confirmed plan once", async () => {
    server.suggestions.drafts[ID] = {
      artifactId: ID,
      baseVersionId: "v1",
      edit: { operations: [{ kind: "text", target: TEXT_TARGET, after: TYPED }] },
      revision: 2,
      incarnation: "i".repeat(22),
      publishing: false,
      attemptReason: null,
      updatedAt: 0,
    };
    server.suggestions.draftPlans[ID] = plan();
    await open();
    const panel = await screen.findByRole("region", { name: "Your draft" });
    fireEvent.click(await within(panel).findByRole("button", { name: "Check what applies" }));
    await within(panel).findByRole("list", { name: "What accepting does, line by line" });
    fireEvent.click(within(panel).getByRole("button", { name: "Publish" }));
    const dialog = await screen.findByRole("dialog", { name: "Publish this draft?" });
    const confirm = within(dialog).getByRole("button", { name: "Publish a new version" });
    act(() => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });
    await screen.findByText("Publishing your draft. The new version appears when it is ready.");
    expect(server.requests.filter((r) => r.path.endsWith("/draft/publish"))).toHaveLength(1);
    expect(server.bodies).toContainEqual({ digest: DIGEST });
    await within(panel).findByText("Publishing");
  });

  it("removes a change, discards the draft, and says when it was made on an earlier version", async () => {
    server.suggestions.drafts[ID] = {
      artifactId: ID,
      baseVersionId: "v0",
      edit: { operations: [{ kind: "text", target: TEXT_TARGET, after: TYPED }] },
      revision: 1,
      incarnation: "i".repeat(22),
      publishing: false,
      attemptReason: "plan_changed",
      updatedAt: 0,
    };
    await open();
    const panel = await screen.findByRole("region", { name: "Your draft" });
    await within(panel).findByText(/made on an earlier version/);
    expect(within(panel).getByText(/The last publish did not finish/)).toBeTruthy();
    // A stale draft is not published and takes no new change.
    expect(within(panel).queryByRole("button", { name: "Check what applies" })).toBeNull();
    const { nonce } = await connect();
    const epoch = await editMode();
    const editor = await openEditor(nonce, epoch);
    const field = within(editor).getByRole("textbox", { name: "New text" });
    fireEvent.change(field, { target: { value: "other" } });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.click(await within(editor).findByRole("button", { name: "Add to draft" }));
    await screen.findByText(/Discard it before editing the current version/);
    expect(server.requests.some((r) => r.method === "PUT")).toBe(false);

    fireEvent.click(within(panel).getByRole("button", { name: "Discard" }));
    const dialog = await screen.findByRole("dialog", { name: "Discard this draft?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    await screen.findByText("Draft discarded.");
    expect(server.suggestions.drafts[ID]).toBeUndefined();
    await within(panel).findByText(/Your changes stay private/);
  });

  it("removes one change at the revision held, and reloads a draft changed elsewhere", async () => {
    const second = {
      ...TEXT_TARGET,
      anchor: {
        ...TEXT_TARGET.anchor,
        quote: { exact: "Hello", prefix: "", suffix: " " },
        position: { start: 0, end: 5 },
      },
    };
    server.suggestions.drafts[ID] = {
      artifactId: ID,
      baseVersionId: "v1",
      edit: {
        operations: [
          { kind: "text", target: TEXT_TARGET, after: TYPED },
          { kind: "text", target: second, after: "Hi" },
          {
            kind: "text",
            target: {
              ...TEXT_TARGET,
              anchor: { ...TEXT_TARGET.anchor, position: { start: 30, end: 45 } },
            },
            after: "Third",
          },
        ],
      },
      revision: 3,
      incarnation: "i".repeat(22),
      publishing: false,
      attemptReason: null,
      updatedAt: 0,
    };
    await open();
    const panel = await screen.findByRole("region", { name: "Your draft" });
    await within(panel).findByText("3 changes");
    fireEvent.click(within(panel).getByRole("button", { name: "Remove change 1" }));
    await within(panel).findByText("2 changes");
    const saved = server.bodies.at(-1) as {
      baseRevision: number;
      edit: { operations: { after: string }[] };
    };
    expect(saved.baseRevision).toBe(3);
    expect(saved.edit.operations.map((o) => o.after)).toEqual(["Hi", "Third"]);

    // Another tab saved meanwhile: the save is refused and the panel shows the draft as it is.
    const stored = server.suggestions.drafts[ID];
    if (stored) stored.revision = 9;
    fireEvent.click(within(panel).getByRole("button", { name: "Remove change 1" }));
    await screen.findByText(/Your draft changed in another tab or window/);
  });
});

describe("previews of unsaved edits, rebasing and the text search (decision 0027)", () => {
  const draftOf = (baseVersionId: string, after = TYPED) => ({
    artifactId: ID,
    baseVersionId,
    edit: { operations: [{ kind: "text" as const, target: TEXT_TARGET, after }] },
    revision: 2,
    incarnation: "i".repeat(22),
    publishing: false,
    attemptReason: null,
    updatedAt: 0,
  });

  it("previews a suggestion before it is saved, from the edit itself", async () => {
    await open();
    const { nonce } = await connect();
    const epoch = await suggestMode();
    const editor = await openEditor(nonce, epoch);
    const field = within(editor).getByRole("textbox", { name: "New text" });
    fireEvent.change(field, { target: { value: TYPED } });
    fireEvent.change(within(editor).getByRole("textbox", { name: "Note" }), {
      target: { value: "Shorter" },
    });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.click(await within(editor).findByRole("tab", { name: "Preview" }));
    const frame = (await within(editor).findByTitle(
      "Preview of the suggested edit",
    )) as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(server.suggestions.previewRequests).toEqual([
      {
        unsaved: {
          versionId: "v1",
          as: "suggestion",
          edit: { operations: [{ kind: "text", target: TEXT_TARGET, after: TYPED }] },
        },
      },
    ]);
    // Nothing was saved, and the frame never got the text.
    expect(server.requests.some((r) => r.path.endsWith("/suggestions"))).toBe(false);
    expect(JSON.stringify(sent())).not.toContain(TYPED);
  });

  it("previews the whole draft with the change being made, and a saved draft by its plan", async () => {
    const other = {
      ...TEXT_TARGET,
      anchor: { ...TEXT_TARGET.anchor, position: { start: 40, end: 55 } },
    };
    server.suggestions.drafts[ID] = {
      ...draftOf("v1"),
      edit: { operations: [{ kind: "text", target: other, after: "kept" }] },
    };
    server.suggestions.draftPlans[ID] = plan();
    await open();
    const { nonce } = await connect();
    fireEvent.click(within(await modeSwitch()).getByRole("button", { name: "Edit mode" }));
    await waitFor(() =>
      expect(
        sent()
          .filter((m) => m.type === "edit-mode")
          .at(-1),
      ).toMatchObject({ active: true }),
    );
    const epoch = (
      sent()
        .filter((m) => m.type === "edit-mode")
        .at(-1) as { epoch: number }
    ).epoch;
    const editor = await openEditor(nonce, epoch);
    const field = within(editor).getByRole("textbox", { name: "New text" });
    fireEvent.change(field, { target: { value: TYPED } });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.click(await within(editor).findByRole("tab", { name: "Preview" }));
    await within(editor).findByTitle("Preview of the suggested edit");
    expect(server.suggestions.previewRequests.at(-1)).toEqual({
      unsaved: {
        versionId: "v1",
        as: "draft",
        edit: {
          operations: [
            { kind: "text", target: other, after: "kept" },
            { kind: "text", target: TEXT_TARGET, after: TYPED },
          ],
        },
      },
    });
    fireEvent.keyDown(field, { key: "Escape" });

    const panel = screen.getByRole("region", { name: "Your draft" });
    fireEvent.click(within(panel).getByRole("button", { name: "Check what applies" }));
    fireEvent.click(await within(panel).findByRole("tab", { name: "Preview" }));
    await within(panel).findByTitle("Preview of the suggested edit");
    expect(server.suggestions.previewRequests.at(-1)).toEqual({ digest: DIGEST });
  });

  it("moves a draft made on an earlier version and lists what it could not carry", async () => {
    server.suggestions.drafts[ID] = draftOf("v0");
    const lost = { kind: "text", target: TEXT_TARGET, after: "lost‮" };
    server.suggestions.rebased = {
      draft: { ...draftOf("v1"), revision: 3 },
      conflicts: [{ operation: lost, reason: "target_changed" }],
    };
    await open();
    const panel = await screen.findByRole("region", { name: "Your draft" });
    fireEvent.click(
      await within(panel).findByRole("button", { name: "Move the draft to the current version" }),
    );
    await screen.findByText(/1 change carried, 1 to make again/);
    expect(server.bodies.at(-1)).toEqual({ baseRevision: 2, baseIncarnation: "i".repeat(22) });
    // On the current version now: it can be checked and published again.
    await within(panel).findByRole("button", { name: "Check what applies" });
    expect(within(panel).queryByText(/made on an earlier version/)).toBeNull();
    const list = within(panel).getByRole("list", {
      name: "Changes that could not be moved, to make again",
    });
    // The author's own text, still typed: the bidirectional character is a chip.
    expect(list.textContent).toContain("U+202E");
    expect(list.textContent).not.toContain("\u202e");
    expect(list.textContent).toContain(
      "The text it changed is different or gone on the current version.",
    );
  });

  /** The page text the server gives for a page: its shown text as the anchors read it. */
  const pageTextOf = (html: string, versionId = "v1"): PageText => ({
    state: "ready",
    versionId,
    path: "index.html",
    text: servedPageText(html, newWork()),
  });
  const PAGE = `<!doctype html><html><head><script>x()</script></head><body><h1>Launch plan</h1><p>Hello brave new world. Say brave words.</p></body></html>`;

  /** Searches the sidebar for `query` and waits for the answer to be announced or shown. */
  async function searchFor(query: string) {
    const search = screen.getByRole("region", { name: "Suggest a text change" });
    fireEvent.change(within(search).getByRole("textbox", { name: "Text to find" }), {
      target: { value: query },
    });
    fireEvent.click(within(search).getByRole("button", { name: "Find" }));
    return search;
  }

  it("finds text in the page's text and opens the editor there, never reading the frame", async () => {
    server.suggestions.pageTexts[`${ID}:index.html`] = pageTextOf(PAGE);
    const { container } = await open();
    const { nonce } = await connect();
    await suggestMode();
    const search = await searchFor("brave");
    await within(search).findByText("2 places found.");
    // A second search reads nothing more: each read counts in the planning windows.
    fireEvent.click(within(search).getByRole("button", { name: "Find" }));
    await within(search).findByText("2 places found.");
    expect(server.requests.filter((r) => r.path.includes("/page-text"))).toEqual([
      { method: "GET", path: `/api/v1/artifacts/${ID}/page-text?path=index.html` },
    ]);
    Reflect.deleteProperty(HTMLIFrameElement.prototype, "contentWindow");
    expect(await axeViolations(container)).toEqual([]);
    Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
      configurable: true,
      get: () => frameWindow,
    });
    fireEvent.click(within(search).getByRole("button", { name: "Change the text at place 2" }));
    const editor = await screen.findByRole("region", { name: "Suggest an edit to the selection" });
    const field = within(editor).getByRole("textbox", { name: "New text" }) as HTMLInputElement;
    expect(field.value).toBe("brave");
    fireEvent.change(field, { target: { value: "bold" } });
    fireEvent.change(within(editor).getByRole("textbox", { name: "Note" }), {
      target: { value: "Bolder" },
    });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.click(await within(editor).findByRole("button", { name: "Save suggestion" }));
    await screen.findByText("Suggestion saved.");
    const posted = server.bodies.find(
      (b) => typeof b === "object" && b !== null && "edit" in b && "body" in b,
    ) as {
      edit: { operations: { target: { path: string; anchor: { quote: { exact: string } } } }[] };
    };
    expect(posted.edit.operations[0]?.target).toMatchObject({
      path: "index.html",
      anchor: { kind: "text", quote: { exact: "brave", suffix: " words." } },
    });
    expect(JSON.stringify(sent())).not.toContain("bold");
    expect(nonce).toBeTruthy();
  });

  it("lets a reviewer who may suggest search the page and save a suggestion there", async () => {
    server.annotations[ID] = {
      ...(server.annotations[ID] as FakeAnnotations),
      role: "participant",
    };
    server.suggestions.pageTexts[`${ID}:index.html`] = pageTextOf(PAGE);
    await open();
    const { nonce } = await connect();
    await suggestMode();
    const search = await searchFor("new world");
    await within(search).findByText("1 place found.");
    fireEvent.click(within(search).getByRole("button", { name: "Change the text at place 1" }));
    const editor = await screen.findByRole("region", { name: "Suggest an edit to the selection" });
    const field = within(editor).getByRole("textbox", { name: "New text" }) as HTMLInputElement;
    expect(field.value).toBe("new world");
    fireEvent.change(field, { target: { value: "new day" } });
    fireEvent.change(within(editor).getByRole("textbox", { name: "Note" }), {
      target: { value: "Brighter" },
    });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.click(await within(editor).findByRole("button", { name: "Save suggestion" }));
    await screen.findByText("Suggestion saved.");
    const posted = server.bodies.find(
      (b) => typeof b === "object" && b !== null && "edit" in b && "body" in b,
    ) as { edit: { operations: { target: { anchor: { quote: { exact: string } } } }[] } };
    expect(posted.edit.operations[0]?.target.anchor.quote.exact).toBe("new world");
    expect(nonce).toBeTruthy();
  });

  it("makes the target a selection of the same text in the frame would", async () => {
    // The anchors over the live page and over the server's text agree on text and positions.
    document.body.innerHTML = "<h1>Launch plan</h1><p>Hello brave new world. Say brave words.</p>";
    const live = new AnchorDocument(document.body as unknown as AnchorElement);
    const fromServer = pageText(servedPageText(PAGE, newWork()));
    expect(fromServer.value).toBe(live.text.value);
    const [match] = findMatches(fromServer, "brave words");
    if (!match) throw new Error("no match");
    const target = await targetOf(fromServer, match, "index.html");
    const created = createTextAnchor(live.text, match.start, match.end);
    expect(created.ok && target?.anchor).toEqual(created.ok ? created.value : null);
    document.body.innerHTML = "";
  });

  it("says when the server has no text for the page", async () => {
    server.suggestions.pageTexts[`${ID}:index.html`] = {
      state: "unavailable",
      reason: "too_large",
    };
    await open();
    await connect();
    await suggestMode();
    const search = await searchFor("x");
    expect(
      await within(search).findAllByText(
        "This page cannot be searched. Select the text in the artifact instead.",
      ),
    ).not.toHaveLength(0);
    expect(within(search).queryByRole("list", { name: "Places with the text" })).toBeNull();
  });

  it("never searches a newer version than the frame shows", async () => {
    server.suggestions.pageTexts[`${ID}:index.html`] = pageTextOf(PAGE, "v2");
    await open();
    await connect();
    await suggestMode();
    const search = await searchFor("brave");
    expect(
      await within(search).findAllByText(
        "The artifact has a newer version. Reload the page to search it.",
      ),
    ).not.toHaveLength(0);
    expect(within(search).queryByRole("list", { name: "Places with the text" })).toBeNull();
  });
});
