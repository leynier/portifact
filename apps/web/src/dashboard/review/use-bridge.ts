// The viewer's side of the bridge channel. Messages are accepted only from the artifact frame's
// window and exact origin, within size limits, matching the schema and, after the handshake,
// carrying the nonce this viewer gave that page load. Everything in them is untrusted: a
// selection or a picked element only fills in a comment the reader still has to write and
// confirm here. The frame receives targets and short labels, never bodies, emails or tokens.
//
// The page's own scripts share the bridge's window, so they can send whatever the bridge can.
// Its messages are hints for the frame's part of the screen: results and activations count
// only for markers this viewer sent, a `status` makes the screen ask the API instead of
// trusting it, and the threads, their state and the ability to comment always come from the API.
import {
  type BridgePage,
  type FrameRect,
  type MarkerResolution,
  newInstanceNonce,
  type RefusalReason,
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
  /** `rect` is where the selection is drawn in the frame: an untrusted placement hint. */
  onSelection(target: AnnotationTarget | null, rect: FrameRect | null): void;
  onElement(target: AnnotationTarget, rect: FrameRect | null): void;
  /** The offered selection or element moved in the frame, or is no longer drawn (`null`). */
  onSelectionRect(rect: FrameRect | null): void;
  onRefused(reason: RefusalReason): void;
  onPickEnded(): void;
  onActivate(id: string): void;
  /** The frame's page reported a status; the screen should check the API's state. */
  onStatus(): void;
}

export interface BridgeConnection {
  state: BridgeState;
  page: BridgePage | null;
  resolutions: ReadonlyMap<string, MarkerResolution>;
  /** Sends to the current page load; dropped while not connected. */
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
  const [resolutions, setResolutions] = useState<ReadonlyMap<string, MarkerResolution>>(
    () => new Map(),
  );
  const nonce = useRef<string | null>(null);
  const handlers = useRef(events);
  handlers.current = events;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Whether the frame answered (`ready` or `pong`) since its last load. */
  const answered = useRef(false);
  /** IDs of the markers last sent: results and activations for others are ignored. */
  const marked = useRef(new Set<string>());

  const send = useCallback(
    (body: ViewerBody) => {
      const target = frame.current?.contentWindow;
      if (!origin || !target || nonce.current === null) return;
      if (body.type === "markers") marked.current = new Set(body.markers.map((m) => m.id));
      target.postMessage(viewerEnvelope(nonce.current, body), origin);
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
          clearTimeout(timer.current);
          if (message.sessionTag !== sessionTag) {
            nonce.current = null;
            setState("foreign");
            return;
          }
          answered.current = true;
          const fresh = newInstanceNonce();
          nonce.current = fresh;
          marked.current = new Set();
          source?.postMessage(viewerEnvelope(fresh, { type: "init" }), origin);
          setPage(message.page);
          setResolutions(new Map());
          setState("connected");
          return;
        }
        case "status":
          nonce.current = null;
          clearTimeout(timer.current);
          setState(message.status);
          handlers.current.onStatus();
          return;
        case "location":
          setPage(message.page);
          return;
        case "selection":
          handlers.current.onSelection(message.target, message.rect ?? null);
          return;
        case "element":
          handlers.current.onElement(message.target, message.rect ?? null);
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
        case "activate":
          if (marked.current.has(message.id)) handlers.current.onActivate(message.id);
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
      target.postMessage(viewerEnvelope(nonce.current, { type: "ping" }), origin);
    }
    timer.current = setTimeout(() => {
      if (answered.current) return;
      nonce.current = null;
      setState((current) => {
        if (current === "connecting") return "silent";
        if (current === "connected") return "lost";
        return current;
      });
    }, BRIDGE_TIMEOUT_MS);
  }, [frame, origin]);

  return { state, page, resolutions, send, onFrameLoad };
}
