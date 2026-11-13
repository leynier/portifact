// The viewer's side of the bridge channel. Messages are accepted only from the artifact frame's
// window and exact origin, within size limits, matching the schema and, after the handshake,
// carrying the nonce this viewer gave that page load. Everything in them is untrusted: a
// selection or a picked element only fills in a comment the reader still has to write and
// confirm here. The frame receives targets and short labels, never bodies, emails or tokens.
//
// The page's own scripts share the bridge's window, so they can send whatever the bridge can.
// Its messages are hints for the frame's part of the screen: results and selections count
// only for threads this viewer highlighted on that page, a `status` makes the screen ask the API instead of
// trusting it, and the threads, their state and the ability to comment always come from the API.
import {
  type BridgeCapability,
  type BridgePage,
  type FrameRect,
  type HighlightResolution,
  newInstanceNonce,
  REVIEW_PROTOCOL,
  REVIEW_PROTOCOL_EDIT,
  type RefusalReason,
  type ReviewProtocol,
  readBridgeMessage,
  type ViewerBody,
  viewerEnvelope,
} from "@portifact/bridge";
import type { AnnotationTarget } from "@portifact/contracts";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

/** How long a page load may take to answer before the viewer stops waiting for the bridge. */
export const BRIDGE_TIMEOUT_MS = 5_000;

export type BridgeState =
  | "connecting"
  | "connected"
  /** The frame runs a review session this viewer did not start, for example a planted one. */
  | "foreign"
  /** The frame stopped answering from the artifact's origin after a page load. */
  | "lost"
  /** The page loaded but the bridge never answered, for example blocked by the page's CSP. */
  | "silent"
  /** The browser did not keep the review cookie in the frame. */
  | "unavailable"
  | "ended"
  | "failed";

export interface BridgeEvents {
  /**
   * `rect` is where the selection is drawn in the frame: an untrusted placement hint. `epoch` is
   * the edit epoch the bridge echoed (protocol 3), or null.
   */
  onSelection(target: AnnotationTarget | null, rect: FrameRect | null, epoch: number | null): void;
  onElement(target: AnnotationTarget, rect: FrameRect | null, epoch: number | null): void;
  /** The offered selection or element moved in the frame, or is no longer drawn (`null`). */
  onSelectionRect(rect: FrameRect | null): void;
  onRefused(reason: RefusalReason): void;
  onPickEnded(): void;
  /**
   * The reader clicked the page: the threads highlighted there, innermost first, or none. Only
   * IDs this viewer sent to the page get through.
   */
  onSelect(ids: string[]): void;
  /** The frame's page reported a status; the screen should check the API's state. */
  onStatus(): void;
  /**
   * The frame shows another page, another route, or its session changed (`ready`, `location`,
   * `status`): a pending edit and its confirmation end (decision 0027, rule 9).
   */
  onPageChange?(): void;
}

export interface BridgeConnection {
  state: BridgeState;
  page: BridgePage | null;
  resolutions: ReadonlyMap<string, HighlightResolution>;
  /**
   * What the connected bridge announced it can do (protocol 3), empty for a version 2 bridge.
   * The page can forge it: it only decides what the viewer offers, never what is saved.
   */
  capabilities: readonly BridgeCapability[];
  /** Sends to the current page load; dropped while not connected, and edit mode on version 2. */
  send(body: ViewerBody): void;
  /** Call from the frame's `load` event: a new page load starts a new handshake. */
  onFrameLoad(): void;
}

export function useBridge(
  frame: RefObject<HTMLIFrameElement | null>,
  origin: string | null,
  sessionTag: string,
  events: BridgeEvents,
): BridgeConnection {
  const [state, setState] = useState<BridgeState>("connecting");
  const [page, setPage] = useState<BridgePage | null>(null);
  const [resolutions, setResolutions] = useState<ReadonlyMap<string, HighlightResolution>>(
    () => new Map(),
  );
  const nonce = useRef<string | null>(null);
  /** The protocol of the current handshake. */
  const protocol = useRef<ReviewProtocol>(REVIEW_PROTOCOL);
  const [capabilities, setCapabilities] = useState<readonly BridgeCapability[]>([]);
  const handlers = useRef(events);
  handlers.current = events;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Whether the frame answered (`ready` or `pong`) since its last load. */
  const answered = useRef(false);
  /** IDs of the threads last highlighted: results and selections for others are ignored. */
  const marked = useRef(new Set<string>());

  const send = useCallback(
    (body: ViewerBody) => {
      const target = frame.current?.contentWindow;
      if (!origin || !target || nonce.current === null) return;
      if (body.type === "edit-mode" && protocol.current !== REVIEW_PROTOCOL_EDIT) return;
      if (body.type === "highlights") {
        marked.current = new Set(body.highlights.map((highlight) => highlight.id));
      }
      target.postMessage(viewerEnvelope(nonce.current, body, protocol.current), origin);
    },
    [frame, origin],
  );

  useEffect(() => {
    if (!origin) return;
    const onMessage = (event: MessageEvent) => {
      const source = frame.current?.contentWindow ?? null;
      const message = readBridgeMessage(event, { origin, source, nonce: nonce.current });
      if (!message) return;
      switch (message.type) {
        case "ready": {
          // A bridge of protocol 3 announces itself in both versions, the newer first: the
          // version 2 announcement that follows a version 3 handshake is the same page's.
          if (
            message.v === REVIEW_PROTOCOL &&
            protocol.current === REVIEW_PROTOCOL_EDIT &&
            nonce.current !== null
          ) {
            return;
          }
          clearTimeout(timer.current);
          handlers.current.onPageChange?.();
          if (message.sessionTag !== sessionTag) {
            nonce.current = null;
            setState("foreign");
            return;
          }
          answered.current = true;
          const fresh = newInstanceNonce();
          nonce.current = fresh;
          protocol.current = message.v;
          marked.current = new Set();
          source?.postMessage(viewerEnvelope(fresh, { type: "init" }, message.v), origin);
          setCapabilities("capabilities" in message ? message.capabilities : []);
          setPage(message.page);
          setResolutions(new Map());
          setState("connected");
          return;
        }
        case "status":
          nonce.current = null;
          protocol.current = REVIEW_PROTOCOL;
          clearTimeout(timer.current);
          setState(message.status);
          handlers.current.onPageChange?.();
          handlers.current.onStatus();
          return;
        case "location":
          if (message.v !== protocol.current) return;
          handlers.current.onPageChange?.();
          setPage(message.page);
          return;
        case "selection":
          if (message.v !== protocol.current) return;
          handlers.current.onSelection(
            message.target,
            message.rect ?? null,
            "epoch" in message ? (message.epoch ?? null) : null,
          );
          return;
        case "element":
          if (message.v !== protocol.current) return;
          handlers.current.onElement(
            message.target,
            message.rect ?? null,
            "epoch" in message ? (message.epoch ?? null) : null,
          );
          return;
        case "selection-rect":
          handlers.current.onSelectionRect(message.rect);
          return;
        case "refused":
          handlers.current.onRefused(message.reason);
          return;
        case "pick-ended":
          handlers.current.onPickEnded();
          return;
        case "resolved":
          setResolutions(
            new Map(
              message.results
                .filter((result) => marked.current.has(result.id))
                .map((result) => [result.id, result]),
            ),
          );
          return;
        case "select":
          handlers.current.onSelect(message.ids.filter((id) => marked.current.has(id)));
          return;
        case "pong":
          answered.current = true;
          return;
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer.current);
      nonce.current = null;
    };
  }, [frame, origin, sessionTag]);

  const onFrameLoad = useCallback(() => {
    // Every load must be answered from the artifact's origin: by a `ready` of the new page, or,
    // when that came before the load event, by a `pong` to this check. A frame that navigated
    // elsewhere (another site, or another artifact) never answers, because the check goes only
    // to the artifact's origin and answers from other origins are dropped.
    clearTimeout(timer.current);
    answered.current = false;
    const target = frame.current?.contentWindow;
    if (origin && target && nonce.current !== null) {
      target.postMessage(viewerEnvelope(nonce.current, { type: "ping" }, protocol.current), origin);
    }
    timer.current = setTimeout(() => {
      if (answered.current) return;
      nonce.current = null;
      protocol.current = REVIEW_PROTOCOL;
      handlers.current.onPageChange?.();
      setState((current) => {
        if (current === "connecting") return "silent";
        if (current === "connected") return "lost";
        return current;
      });
    }, BRIDGE_TIMEOUT_MS);
  }, [frame, origin]);

  return { state, page, resolutions, capabilities, send, onFrameLoad };
}
