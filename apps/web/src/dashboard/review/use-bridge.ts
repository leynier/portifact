// The viewer's side of the bridge channel. Messages are accepted only from the artifact frame's
// window and exact origin, within size limits, matching the schema and, after the handshake,
// carrying the nonce this viewer gave that page load. Everything in them is untrusted: a
// selection or a picked element only fills in a comment the reader still has to write and
// confirm here. The frame receives targets and short labels, never bodies, emails or tokens.
import {
  type BridgePage,
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
  /** The page loaded but the bridge never answered, for example blocked by the page's CSP. */
  | "silent"
  /** The browser did not keep the review cookie in the frame. */
  | "unavailable"
  | "ended"
  | "failed";

export interface BridgeEvents {
  onSelection(target: AnnotationTarget | null): void;
  onElement(target: AnnotationTarget): void;
  onRefused(reason: RefusalReason): void;
  onPickEnded(): void;
  onActivate(id: string): void;
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

  const send = useCallback(
    (body: ViewerBody) => {
      const target = frame.current?.contentWindow;
      if (!origin || !target || nonce.current === null) return;
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
          const fresh = newInstanceNonce();
          nonce.current = fresh;
          clearTimeout(timer.current);
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
          return;
        case "location":
          setPage(message.page);
          return;
        case "selection":
          handlers.current.onSelection(message.target);
          return;
        case "element":
          handlers.current.onElement(message.target);
          return;
        case "refused":
          handlers.current.onRefused(message.reason);
          return;
        case "pick-ended":
          handlers.current.onPickEnded();
          return;
        case "resolved":
          setResolutions(new Map(message.results.map((result) => [result.id, result])));
          return;
        case "activate":
          handlers.current.onActivate(message.id);
          return;
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer.current);
      nonce.current = null;
    };
  }, [frame, origin]);

  const onFrameLoad = useCallback(() => {
    // A page that sent `ready` before its load event finished keeps its handshake.
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setState((current) => (current === "connecting" ? "silent" : current));
    }, BRIDGE_TIMEOUT_MS);
  }, []);

  return { state, page, resolutions, send, onFrameLoad };
}
