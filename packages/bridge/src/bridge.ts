// The review bridge: runs inside the artifact (review mode only) and talks to the trusted viewer
// in the parent window. It turns the reader's text selection or picked element into an
// annotation target with `packages/anchors`, highlights the threads the viewer sends (layered,
// so text several threads cover is darker) and reports which threads cover the point the reader
// clicks. It never posts a comment: the viewer offers one and the reader writes and confirms it
// there. It holds no credential and never receives thread bodies, emails or tokens. It reads no
// form values, cookies or storage.
import {
  AnchorDocument,
  type AnchorElement,
  type AnchorNode,
  contentHash,
  type DomRange,
  IGNORE_ATTRIBUTE,
} from "@portifact/anchors";
import { ANCHOR_SCHEMA_VERSION, type Anchor, AnnotationTarget } from "@portifact/contracts";
import { bridgeEnvelope, readViewerMessage } from "./channel.ts";
import { frameRect } from "./geometry.ts";
import {
  type Box,
  createOverlay,
  type HighlightState,
  type HitArea,
  threadsAt,
} from "./overlay.ts";
import {
  BRIDGE_CAPABILITIES,
  type BridgeBody,
  BridgePage,
  type EditKind,
  type Highlight,
  type HighlightResolution,
  REVIEW_CHANNEL,
  REVIEW_PROTOCOL,
  REVIEW_PROTOCOL_EDIT,
  type RefusalReason,
  type ReviewProtocol,
} from "./protocol.ts";

export interface BridgeConfig {
  /** Exact origin of the viewer, the only one messages are sent to and accepted from. */
  appOrigin: string;
  /** The file of the version this page is, as served (for example `index.html`). */
  path: string;
  /** Renderer of a Portifact document page, for example `portifact-render@1`. */
  renderer?: string | undefined;
  /** Tag of the review session this page was served in, echoed in `ready`. */
  sessionTag: string;
}

export interface BridgeTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}

export interface Bridge {
  /** The overlay's closed shadow root, for tests; page scripts cannot reach this handle. */
  readonly overlay: ShadowRoot;
  stop(): void;
}

/** How long the bridge waits for a selection to settle before reporting it. */
export const SELECTION_SETTLE_MS = 250;
/** How often the bridge checks the SPA route. */
export const ROUTE_POLL_MS = 500;
/** How long after the page changes the bridge redraws highlights. */
export const REDRAW_SETTLE_MS = 300;
/** How often, at most, the bridge reports that the offered selection moved. */
export const RECT_THROTTLE_MS = 50;

/** The page's SPA route, when it is a route the contracts accept. */
export function currentRoute(location: Pick<Location, "pathname" | "hash">): string | undefined {
  const page = BridgePage.safeParse({ path: "x", route: `${location.pathname}${location.hash}` });
  return page.success ? page.data.route : undefined;
}

/**
 * Starts the bridge in `window`, talking to `parent` (the viewer's window). Returns a handle to
 * stop it, which removes everything it added.
 */
export type BridgeWindow = Window & typeof globalThis;

export function startBridge(
  window: BridgeWindow,
  parent: BridgeTarget,
  config: BridgeConfig,
): Bridge {
  const { document } = window;
  let nonce: string | null = null;
  /** The protocol version the viewer's `init` used; every message after it uses the same. */
  let version: ReviewProtocol = REVIEW_PROTOCOL;
  /** Edit mode (protocol 3): the epoch to echo and what the person chooses, while it is on. */
  let editing: { epoch: number; kind: EditKind } | null = null;
  let highlights: Highlight[] = [];
  let selected: string[] = [];
  /** What is drawn now, for hit-testing clicks. */
  let areas: HitArea[] = [];
  let picking: { hint: string } | null = null;
  let snapshot: AnchorDocument | null = null;
  let route = currentRoute(window.location);
  let selectionTimer: ReturnType<typeof setTimeout> | undefined;
  let redrawTimer: ReturnType<typeof setTimeout> | undefined;
  let reportedSelection = false;
  /** What the viewer was last told the reader offers to comment on, to follow it as it moves. */
  let offered: Range | Element | null = null;
  let rectTimer: ReturnType<typeof setTimeout> | undefined;
  /** The first box of each drawn highlight, to scroll to. */
  const drawn = new Map<string, HTMLElement>();

  const page = () => ({ path: config.path, ...(route === undefined ? {} : { route }) });
  const send = (body: BridgeBody) => {
    if (nonce !== null) parent.postMessage(bridgeEnvelope(nonce, body, version), config.appOrigin);
  };
  /** The edit epoch an offer was made in, echoed only on a protocol 3 handshake. */
  const epoch = () =>
    version === REVIEW_PROTOCOL_EDIT && editing !== null ? { epoch: editing.epoch } : {};

  const overlay = createOverlay(document);

  /** The text model of the page now; rebuilt after the page changes. */
  const anchors = (): AnchorDocument => {
    snapshot ??= new AnchorDocument(document.body as unknown as AnchorElement);
    return snapshot;
  };

  /**
   * Catches up with a route change the poll has not seen yet: a client-side router can move
   * between polls, and a target or highlight must use the route the page is on now. Returns whether
   * the route changed.
   */
  const syncRoute = (): boolean => {
    const next = currentRoute(window.location);
    if (next === route) return false;
    route = next;
    send({ type: "location", page: page() });
    return true;
  };

  const targetFor = async (doc: AnchorDocument, anchor: Anchor) => {
    syncRoute();
    const parsed = AnnotationTarget.safeParse({
      schema: ANCHOR_SCHEMA_VERSION,
      ...page(),
      contentHash: await contentHash(doc.text.value),
      ...(config.renderer ? { renderer: config.renderer } : {}),
      anchor,
    });
    return parsed.success ? parsed.data : null;
  };

  const refuse = (reason: RefusalReason) => send({ type: "refused", reason });

  // Selection

  const reportSelection = async () => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      if (reportedSelection) send({ type: "selection", target: null });
      reportedSelection = false;
      if (!(offered instanceof window.Element)) offered = null;
      return;
    }
    const range = selection.getRangeAt(0);
    if (overlay.host.contains(range.commonAncestorContainer)) return;
    const doc = anchors();
    const created = doc.createTextAnchor(domRange(range));
    if (!created.ok) {
      if (created.reason !== "empty_selection") refuse(created.reason);
      return;
    }
    const target = await targetFor(doc, created.value);
    if (!target) return refuse("too_large");
    reportedSelection = true;
    offered = range.cloneRange();
    const rect = frameRect(range.getBoundingClientRect());
    send({ type: "selection", target, ...(rect ? { rect } : {}), ...epoch() });
  };

  // Where the offered selection or element is drawn, so the viewer's "Comment" control follows
  // it while the page scrolls or resizes.

  const reportRect = () => {
    rectTimer = undefined;
    if (nonce === null || !offered) return;
    const connected =
      offered instanceof window.Element
        ? offered.isConnected
        : offered.startContainer.isConnected && offered.endContainer.isConnected;
    send({
      type: "selection-rect",
      rect: connected ? frameRect(offered.getBoundingClientRect()) : null,
    });
  };

  const onMove = () => {
    if (!offered || rectTimer !== undefined) return;
    rectTimer = setTimeout(reportRect, RECT_THROTTLE_MS);
  };

  const onSelectionChange = () => {
    if (nonce === null || picking) return;
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => void reportSelection(), SELECTION_SETTLE_MS);
  };

  // Element mode

  const pickable = (node: EventTarget | null): Element | null => {
    if (!node || !(node instanceof window.Element)) return null;
    if (node === overlay.host || node.closest(`[${IGNORE_ATTRIBUTE}]`)) return null;
    if (node === document.documentElement || node === document.body) return null;
    return node;
  };

  const endPick = () => {
    picking = null;
    overlay.pick(null, null);
  };

  const pickElement = async (element: Element) => {
    const doc = anchors();
    const box = pageBox(window, element.getBoundingClientRect());
    const created = doc.createElementAnchor(element as unknown as AnchorElement, {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
    });
    endPick();
    // The element (or the refusal) goes first: the viewer accepts an element only while it
    // waits for a pick, and `pick-ended` ends that wait.
    if (!created.ok) refuse(created.reason);
    else {
      const target = await targetFor(doc, created.value);
      if (target) {
        offered = element;
        const rect = frameRect(element.getBoundingClientRect());
        send({ type: "element", target, ...(rect ? { rect } : {}), ...epoch() });
      } else refuse("too_large");
    }
    send({ type: "pick-ended" });
  };

  const onPointerMove = (event: Event) => {
    if (!picking) return;
    const element = pickable(event.target);
    overlay.pick(element ? pageBox(window, element.getBoundingClientRect()) : null, picking.hint);
  };

  const onClick = (event: Event) => {
    if (!picking) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const element = pickable(event.target);
    if (element) void pickElement(element);
  };

  // Clicks on highlighted text: the page keeps them (links still work), and the bridge, listening
  // before the page's handlers can stop them, reports which
  // threads cover the point. Keyboard activations (`detail` 0) and the end of a text selection
  // are not clicks on a place.
  const onPageClick = (event: Event) => {
    if (nonce === null || picking || !(event instanceof window.MouseEvent)) return;
    if (event.detail === 0) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    const point = { x: event.clientX + window.scrollX, y: event.clientY + window.scrollY };
    const ids = threadsAt(point, areas);
    // A click outside every highlight clears a selection, and is otherwise not worth a message.
    if (ids.length > 0 || selected.length > 0) send({ type: "select", ids });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!picking) return;
    if (event.key === "Escape") {
      event.preventDefault();
      endPick();
      send({ type: "pick-ended" });
      return;
    }
    if (event.key === "Enter") {
      const element = pickable(document.activeElement);
      if (!element) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void pickElement(element);
    }
  };

  // Highlights

  const stateOf = (id: string): HighlightState => {
    if (selected[0] === id) return "primary";
    return selected.includes(id) ? "selected" : null;
  };

  const draw = () => {
    syncRoute();
    overlay.clearHighlights();
    drawn.clear();
    areas = [];
    const doc = anchors();
    const results: HighlightResolution[] = [];
    for (const highlight of highlights) {
      if (highlight.target.path !== config.path) continue;
      const resolution = doc.resolve(highlight.target, route === undefined ? {} : { route });
      if (resolution.confidence === "orphaned") {
        results.push({ id: highlight.id, confidence: "orphaned", reason: resolution.reason });
        continue;
      }
      results.push({ id: highlight.id, confidence: resolution.confidence });
      if (resolution.kind === "document") continue;
      const boxes =
        resolution.kind === "text"
          ? rangeBoxes(window, resolution.range)
          : [pageBox(window, (resolution.element as unknown as Element).getBoundingClientRect())];
      const first = overlay.highlight({
        id: highlight.id,
        kind: resolution.kind,
        boxes,
        state: stateOf(highlight.id),
      });
      areas.push({ id: highlight.id, boxes });
      if (first) drawn.set(highlight.id, first);
    }
    send({ type: "resolved", results });
  };

  const scheduleRedraw = () => {
    snapshot = null;
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(() => {
      if (nonce !== null && highlights.length > 0) draw();
    }, REDRAW_SETTLE_MS);
  };

  // Nothing in the overlay takes focus: the sidebar's "Show in the artifact" is the keyboard path,
  // and it only scrolls the page to the highlight.
  const focus = (id: string) => {
    drawn.get(id)?.scrollIntoView({ block: "center" });
  };

  // Messages from the viewer

  const onMessage = (event: MessageEvent) => {
    const message = readViewerMessage(event, {
      origin: config.appOrigin,
      source: parent,
      nonce,
    });
    if (!message) return;
    // After the handshake only messages of its version count.
    if (message.type !== "init" && message.v !== version) return;
    switch (message.type) {
      case "init":
        nonce = message.nonce;
        version = message.v;
        send({ type: "location", page: page() });
        return;
      case "highlights":
        highlights = message.highlights;
        selected = message.selected;
        draw();
        return;
      case "hover":
        overlay.hover(message.id);
        return;
      case "pick":
        if (message.active) {
          picking = { hint: message.hint };
          overlay.pick(null, message.hint);
        } else {
          endPick();
        }
        return;
      case "focus":
        focus(message.id);
        return;
      case "clear-selection":
        window.getSelection()?.removeAllRanges();
        reportedSelection = false;
        offered = null;
        return;
      case "ping":
        send({ type: "pong" });
        return;
      case "edit-mode":
        setEditMode(message.active ? message : null);
        return;
    }
  };

  // Edit mode (decision 0027): the bridge only shows the hint and echoes the epoch on what it
  // reports; choosing an element for style or structure is element mode. It never receives what
  // the person types.
  const setEditMode = (next: { epoch: number; kind: EditKind; hint: string } | null) => {
    editing = next ? { epoch: next.epoch, kind: next.kind } : null;
    if (next && next.kind !== "text") {
      picking = { hint: next.hint };
      overlay.pick(null, next.hint);
    } else if (next) {
      picking = null;
      overlay.pick(null, next.hint);
    } else {
      endPick();
    }
  };

  const observer = new window.MutationObserver(scheduleRedraw);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  const routeTimer = setInterval(() => {
    if (syncRoute()) scheduleRedraw();
  }, ROUTE_POLL_MS);

  window.addEventListener("message", onMessage);
  document.addEventListener("selectionchange", onSelectionChange);
  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("click", onClick, true);
  window.addEventListener("click", onPageClick, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("resize", scheduleRedraw);
  window.addEventListener("resize", onMove);
  // Capturing, so scrolling inside any scrollable element of the page counts too.
  window.addEventListener("scroll", onMove, true);

  // Both versions are announced, the newer first: a viewer that reads protocol 3 answers the
  // first and ignores the second; an older viewer drops the first and answers the second.
  for (const v of [REVIEW_PROTOCOL_EDIT, REVIEW_PROTOCOL]) {
    parent.postMessage(
      {
        channel: REVIEW_CHANNEL,
        v,
        type: "ready",
        page: page(),
        sessionTag: config.sessionTag,
        ...(v === REVIEW_PROTOCOL_EDIT ? { capabilities: [...BRIDGE_CAPABILITIES] } : {}),
      },
      config.appOrigin,
    );
  }

  return {
    overlay: overlay.root,
    stop() {
      clearTimeout(selectionTimer);
      clearTimeout(redrawTimer);
      clearTimeout(rectTimer);
      clearInterval(routeTimer);
      observer.disconnect();
      window.removeEventListener("message", onMessage);
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("click", onPageClick, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", scheduleRedraw);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
      overlay.remove();
    },
  };
}

function domRange(range: Range): DomRange {
  return {
    start: { node: range.startContainer as unknown as AnchorNode, offset: range.startOffset },
    end: { node: range.endContainer as unknown as AnchorNode, offset: range.endOffset },
  };
}

/** A viewport rectangle in page coordinates, rounded to whole pixels. */
export function pageBox(window: Window, rect: DOMRectReadOnly): Box {
  return {
    x: Math.round(rect.left + window.scrollX),
    y: Math.round(rect.top + window.scrollY),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

/** The boxes of each line of a resolved text range. */
function rangeBoxes(window: Window, range: DomRange): Box[] {
  const live = window.document.createRange();
  live.setStart(range.start.node as unknown as Node, range.start.offset);
  live.setEnd(range.end.node as unknown as Node, range.end.offset);
  const rects = Array.from(live.getClientRects()).filter((r) => r.width > 0 || r.height > 0);
  if (rects.length > 0) return rects.map((rect) => pageBox(window, rect));
  return [pageBox(window, live.getBoundingClientRect())];
}
