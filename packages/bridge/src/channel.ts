// Accepting a postMessage event, on either side. A message counts only when it comes from the
// exact expected origin and window, fits the size limit, matches the schema and, after the
// handshake, carries this instance's nonce. Anything else is dropped without an answer, so a
// sibling frame or another window learns nothing by probing.
import type { z } from "zod";
import {
  BRIDGE_LIMITS,
  type BridgeBody,
  BridgeMessage,
  REVIEW_CHANNEL,
  REVIEW_PROTOCOL,
  type ViewerBody,
  ViewerMessage,
} from "./protocol.ts";

/** The parts of a MessageEvent that decide whether to trust it. */
export interface IncomingEvent {
  readonly data: unknown;
  readonly origin: string;
  readonly source: unknown;
}

export interface Expectation {
  /** Exact origin of the other side. */
  origin: string;
  /** The other side's window: the iframe's `contentWindow`, or the bridge's `parent`. */
  source: unknown;
  /** This instance's nonce, once the handshake gave one. */
  nonce: string | null;
}

const encoder = new TextEncoder();

/** UTF-8 size of the message as JSON, or null when it is not plain JSON data. */
export function messageSize(data: unknown): number | null {
  try {
    const json = JSON.stringify(data);
    return typeof json === "string" ? encoder.encode(json).length : null;
  } catch {
    return null;
  }
}

function accept<T extends { type: string; nonce?: string }>(
  schema: z.ZodType<T>,
  maxBytes: number,
  event: IncomingEvent,
  expected: Expectation,
): T | null {
  if (event.origin !== expected.origin || event.source !== expected.source) return null;
  if (event.source === null || event.source === undefined) return null;
  const size = messageSize(event.data);
  if (size === null || size > maxBytes) return null;
  const parsed = schema.safeParse(event.data);
  if (!parsed.success) return null;
  return parsed.data;
}

/**
 * A bridge message the viewer may act on. `ready` and `status` have no nonce: `ready` starts a
 * handshake, which the viewer answers with a fresh nonce, and `status` comes from the content
 * Worker's own pages. Every other message must carry the nonce of the current handshake.
 */
export function readBridgeMessage(
  event: IncomingEvent,
  expected: Expectation,
): BridgeMessage | null {
  const message = accept(BridgeMessage, BRIDGE_LIMITS.bridgeMessageMaxBytes, event, expected);
  if (!message) return null;
  if (message.type === "ready" || message.type === "status") return message;
  return expected.nonce !== null && message.nonce === expected.nonce ? message : null;
}

/**
 * A viewer message the bridge may act on. Before the handshake only `init` is accepted, and
 * afterwards only messages with the nonce it gave.
 */
export function readViewerMessage(
  event: IncomingEvent,
  expected: Expectation,
): ViewerMessage | null {
  const message = accept(ViewerMessage, BRIDGE_LIMITS.viewerMessageMaxBytes, event, expected);
  if (!message) return null;
  if (expected.nonce === null) return message.type === "init" ? message : null;
  return message.nonce === expected.nonce ? message : null;
}

/** Wraps a bridge message body in the envelope with the instance nonce. */
export function bridgeEnvelope(nonce: string, body: BridgeBody): BridgeMessage {
  return { channel: REVIEW_CHANNEL, v: REVIEW_PROTOCOL, nonce, ...body } as BridgeMessage;
}

/** Wraps a viewer message body in the envelope with the instance nonce. */
export function viewerEnvelope(nonce: string, body: ViewerBody): ViewerMessage {
  return { channel: REVIEW_CHANNEL, v: REVIEW_PROTOCOL, nonce, ...body } as ViewerMessage;
}

/** A fresh instance nonce: 16 random bytes in base64url. */
export function newInstanceNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
