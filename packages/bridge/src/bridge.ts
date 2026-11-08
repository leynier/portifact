// The review bridge: runs inside the artifact (review mode only) and talks to the trusted viewer
// in the parent window. It turns the reader's text selection or picked element into an
// annotation target with `packages/anchors`, and draws markers for the targets the viewer
// sends. It never posts a comment: the viewer offers one and the reader writes and confirms it
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
import { type Box, createOverlay } from "./overlay.ts";
import {
  type BridgeBody,
  BridgePage,
  type Marker,
  type MarkerResolution,
  REVIEW_CHANNEL,
  REVIEW_PROTOCOL,
  type RefusalReason,
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
/** How long after the page changes the bridge redraws markers. */
export const REDRAW_SETTLE_MS = 300;

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
  let markers: Marker[] = [];
  let active: string | null = null;
  let picking: { hint: string } | null = null;
  let snapshot: AnchorDocument | null = null;
  let route = currentRoute(window.location);
  let selectionTimer: ReturnType<typeof setTimeout> | undefined;
  let redrawTimer: ReturnType<typeof setTimeout> | undefined;
  let reportedSelection = false;
  const drawn = new Map<string, HTMLElement>();

  const page = () => ({ path: config.path, ...(route === undefined ? {} : { route }) });
  const send = (body: BridgeBody) => {
    if (nonce !== null) parent.postMessage(bridgeEnvelope(nonce, body), config.appOrigin);
  };

  const overlay = createOverlay(document, (id) => send({ type: "activate", id }));

  /** The text model of the page now; rebuilt after the page changes. */
  const anchors = (): AnchorDocument => {
    snapshot ??= new AnchorDocument(document.body as unknown as AnchorElement);
    return snapshot;
  };

  /**
   * Catches up with a route change the poll has not seen yet: a client-side router can move
   * between polls, and a target or marker must use the route the page is on now. Returns whether
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
    send({ type: "selection", target });
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
      if (target) send({ type: "element", target });
      else refuse("too_large");
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

  // Markers

  const draw = () => {
    syncRoute();
    overlay.clearMarkers();
    drawn.clear();
    const doc = anchors();
    const results: MarkerResolution[] = [];
    for (const marker of markers) {
      if (marker.target.path !== config.path) continue;
      const resolution = doc.resolve(marker.target, route === undefined ? {} : { route });
      if (resolution.confidence === "orphaned") {
        results.push({ id: marker.id, confidence: "orphaned", reason: resolution.reason });
        continue;
      }
      results.push({ id: marker.id, confidence: resolution.confidence });
      if (resolution.kind === "document") continue;
      const boxes =
        resolution.kind === "text"
          ? rangeBoxes(window, resolution.range)
          : [pageBox(window, (resolution.element as unknown as Element).getBoundingClientRect())];
      const button = overlay.mark({
        id: marker.id,
        label: marker.label,
        name: marker.name,
        kind: resolution.kind,
        boxes,
        active: marker.id === active,
      });
      if (button) drawn.set(marker.id, button);
    }
    send({ type: "resolved", results });
  };

  const scheduleRedraw = () => {
    snapshot = null;
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(() => {
      if (nonce !== null && markers.length > 0) draw();
    }, REDRAW_SETTLE_MS);
  };

  const focus = (id: string) => {
    active = id;
    draw();
    const button = drawn.get(id);
    if (button) {
      button.scrollIntoView({ block: "center" });
      button.focus({ preventScroll: true });
    }
  };

  // Messages from the viewer

  const onMessage = (event: MessageEvent) => {
    const message = readViewerMessage(event, {
      origin: config.appOrigin,
      source: parent,
      nonce,
    });
    if (!message) return;
    switch (message.type) {
      case "init":
        nonce = message.nonce;
        send({ type: "location", page: page() });
        return;
      case "markers":
        markers = message.markers;
        active = message.active;
        draw();
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
        return;
      case "ping":
        send({ type: "pong" });
        return;
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
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("resize", scheduleRedraw);

  parent.postMessage(
    {
      channel: REVIEW_CHANNEL,
      v: REVIEW_PROTOCOL,
      type: "ready",
      page: page(),
      sessionTag: config.sessionTag,
    },
    config.appOrigin,
  );

  return {
    overlay: overlay.root,
    stop() {
      clearTimeout(selectionTimer);
      clearTimeout(redrawTimer);
      clearInterval(routeTimer);
      observer.disconnect();
      window.removeEventListener("message", onMessage);
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", scheduleRedraw);
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
