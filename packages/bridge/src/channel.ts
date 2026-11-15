// Accepting a postMessage event, on either side. A message counts only when it comes from the
// exact expected origin and window, fits the size limit, matches the schema and, after the
// handshake, carries this instance's nonce. Anything else is dropped without an answer, so a
// sibling frame or another window learns nothing by probing.
import { z } from "zod";
import {
  type AnyBridgeMessage,
  type AnyViewerMessage,
  BRIDGE_LIMITS,
  type BridgeBody,
  BridgeMessage,
  BridgeMessageV3,
  REVIEW_CHANNEL,
  REVIEW_PROTOCOL,
  type ReviewProtocol,
  type ViewerBody,
  ViewerMessage,
  ViewerMessageV3,
} from "./protocol.ts";

/** Either version of each side's messages; a message is read by the schema of its own `v`. */
const AnyBridge = z.union([BridgeMessage, BridgeMessageV3]);
const AnyViewer = z.union([ViewerMessage, ViewerMessageV3]);

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
): AnyBridgeMessage | null {
  const message = accept<AnyBridgeMessage>(
    AnyBridge,
    BRIDGE_LIMITS.bridgeMessageMaxBytes,
    event,
    expected,
  );
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
): AnyViewerMessage | null {
  const message = accept<AnyViewerMessage>(
    AnyViewer,
    BRIDGE_LIMITS.viewerMessageMaxBytes,
    event,
    expected,
  );
  if (!message) return null;
  if (expected.nonce === null) return message.type === "init" ? message : null;
  return message.nonce === expected.nonce ? message : null;
}

/**
 * Wraps a bridge message body in the envelope of `version` with the instance nonce. A body only
 * protocol 3 knows is sent only on a protocol 3 handshake (the other side would drop it anyway).
 */
export function bridgeEnvelope(
  nonce: string,
  body: BridgeBody,
  version: ReviewProtocol = REVIEW_PROTOCOL,
): AnyBridgeMessage {
  return { channel: REVIEW_CHANNEL, v: version, nonce, ...body } as AnyBridgeMessage;
}

/** Wraps a viewer message body in the envelope of `version` with the instance nonce. */
export function viewerEnvelope(
  nonce: string,
  body: ViewerBody,
  version: ReviewProtocol = REVIEW_PROTOCOL,
): AnyViewerMessage {
  return { channel: REVIEW_CHANNEL, v: version, nonce, ...body } as AnyViewerMessage;
}

/** A fresh instance nonce: 16 random bytes in base64url. */
export function newInstanceNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
