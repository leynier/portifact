import { describe, expect, it } from "vitest";
import {
  bridgeEnvelope,
  messageSize,
  newInstanceNonce,
  readBridgeMessage,
  readViewerMessage,
  viewerEnvelope,
} from "./channel.ts";
import { BRIDGE_LIMITS, REVIEW_CHANNEL } from "./protocol.ts";

const VIEWER = "https://app.portifact.com";
const ARTIFACT = "https://k7d2qm4xab.portifact.dev";
const NONCE = "n".repeat(22);
const frame = { name: "frame" };
const parent = { name: "parent" };

const target = {
  schema: 1,
  path: "index.html",
  anchor: {
    kind: "text",
    quote: { exact: "Hello", prefix: "", suffix: " world" },
    position: { start: 0, end: 5 },
  },
};

const fromFrame = (
  data: unknown,
  overrides: Partial<{ origin: string; source: unknown }> = {},
) => ({
  data,
  origin: ARTIFACT,
  source: frame,
  ...overrides,
});

const viewerExpects = (nonce: string | null = NONCE) => ({
  origin: ARTIFACT,
  source: frame,
  nonce,
});

describe("bridge messages, as the viewer reads them", () => {
  it("accepts a ready message without a nonce, only from the frame's exact origin and window", () => {
    const ready = { channel: REVIEW_CHANNEL, v: 1, type: "ready", page: { path: "index.html" } };
    expect(readBridgeMessage(fromFrame(ready), viewerExpects(null))).toEqual(ready);
    expect(
      readBridgeMessage(
        fromFrame(ready, { origin: "https://p3n5wq7yzc.portifact.dev" }),
        viewerExpects(null),
      ),
    ).toBeNull();
    expect(
      readBridgeMessage(fromFrame(ready, { origin: `${ARTIFACT}:443` }), viewerExpects(null)),
    ).toBeNull();
    expect(readBridgeMessage(fromFrame(ready, { source: {} }), viewerExpects(null))).toBeNull();
    expect(
      readBridgeMessage(fromFrame(ready, { source: null }), {
        origin: ARTIFACT,
        source: null,
        nonce: null,
      }),
    ).toBeNull();
  });

  it("accepts a selection only with the nonce of the current handshake", () => {
    const selection = bridgeEnvelope(NONCE, { type: "selection", target } as never);
    expect(readBridgeMessage(fromFrame(selection), viewerExpects())).toMatchObject({
      type: "selection",
      target: { path: "index.html" },
    });
    expect(readBridgeMessage(fromFrame(selection), viewerExpects(null))).toBeNull();
    expect(readBridgeMessage(fromFrame(selection), viewerExpects("o".repeat(22)))).toBeNull();
  });

  it("refuses forged shapes: unknown keys, wrong channel, unsafe targets and bad types", () => {
    const base = bridgeEnvelope(NONCE, { type: "activate", id: "t1" });
    for (const forged of [
      { ...base, extra: true },
      { ...base, channel: "other" },
      { ...base, v: 2 },
      { ...base, id: "../x" },
      { ...base, type: "post-comment", body: "hi" },
      bridgeEnvelope(NONCE, {
        type: "selection",
        target: { ...target, anchor: { ...target.anchor, domHint: "a{color:red}" } },
      } as never),
      bridgeEnvelope(NONCE, {
        type: "element",
        target: { ...target, path: "../secret" },
      } as never),
      "string",
      null,
    ]) {
      expect(readBridgeMessage(fromFrame(forged), viewerExpects())).toBeNull();
    }
  });

  it("refuses messages over the size limit and data that is not plain JSON", () => {
    const results = Array.from({ length: BRIDGE_LIMITS.markersMax }, (_, i) => ({
      id: `${"t".repeat(60)}${String(i).padStart(4, "0")}`,
      confidence: "orphaned",
      reason: "not_found",
    }));
    const large = bridgeEnvelope(NONCE, { type: "resolved", results } as never);
    expect(messageSize(large)).toBeGreaterThan(BRIDGE_LIMITS.bridgeMessageMaxBytes);
    expect(readBridgeMessage(fromFrame(large), viewerExpects())).toBeNull();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(messageSize(cyclic)).toBeNull();
    expect(messageSize(undefined)).toBeNull();
    expect(readBridgeMessage(fromFrame(cyclic), viewerExpects())).toBeNull();
    expect(readBridgeMessage(fromFrame(10n), viewerExpects())).toBeNull();
  });
});

describe("viewer messages, as the bridge reads them", () => {
  const fromViewer = (data: unknown, origin = VIEWER, source: unknown = parent) => ({
    data,
    origin,
    source,
  });
  const bridgeExpects = (nonce: string | null) => ({ origin: VIEWER, source: parent, nonce });

  it("accepts only init before the handshake", () => {
    const init = viewerEnvelope(NONCE, { type: "init" });
    expect(readViewerMessage(fromViewer(init), bridgeExpects(null))).toEqual(init);
    const focus = viewerEnvelope(NONCE, { type: "focus", id: "t1" });
    expect(readViewerMessage(fromViewer(focus), bridgeExpects(null))).toBeNull();
  });

  it("accepts later messages only with the nonce it was given, from the viewer itself", () => {
    const focus = viewerEnvelope(NONCE, { type: "focus", id: "t1" });
    expect(readViewerMessage(fromViewer(focus), bridgeExpects(NONCE))).toEqual(focus);
    const other = viewerEnvelope("o".repeat(22), { type: "focus", id: "t1" });
    expect(readViewerMessage(fromViewer(other), bridgeExpects(NONCE))).toBeNull();
    expect(
      readViewerMessage(fromViewer(focus, "https://evil.example"), bridgeExpects(NONCE)),
    ).toBeNull();
    expect(readViewerMessage(fromViewer(focus, VIEWER, frame), bridgeExpects(NONCE))).toBeNull();
  });

  it("refuses markers beyond the limit", () => {
    const markers = Array.from({ length: BRIDGE_LIMITS.markersMax + 1 }, (_, i) => ({
      id: `t${i}`,
      label: String(i),
      name: `Thread ${i}`,
      target,
    }));
    const message = viewerEnvelope(NONCE, { type: "markers", markers, active: null } as never);
    expect(readViewerMessage(fromViewer(message), bridgeExpects(NONCE))).toBeNull();
    const fits = viewerEnvelope(NONCE, {
      type: "markers",
      markers: markers.slice(0, 3),
      active: "t1",
    } as never);
    expect(readViewerMessage(fromViewer(fits), bridgeExpects(NONCE))).toMatchObject({
      type: "markers",
    });
  });
});

describe("instance nonces", () => {
  it("are random base64url values the schema accepts", () => {
    const a = newInstanceNonce();
    const b = newInstanceNonce();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a).not.toBe(b);
    const init = viewerEnvelope(a, { type: "init" });
    expect(
      readViewerMessage(
        { data: init, origin: VIEWER, source: parent },
        {
          origin: VIEWER,
          source: parent,
          nonce: null,
        },
      ),
    ).toEqual(init);
  });
});
