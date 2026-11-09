import type { AnnotationTarget } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  bridgeEnvelope,
  messageSize,
  newInstanceNonce,
  readBridgeMessage,
  readViewerMessage,
  viewerEnvelope,
} from "./channel.ts";
import { BRIDGE_LIMITS, REVIEW_CHANNEL, REVIEW_PROTOCOL } from "./protocol.ts";

const VIEWER = "https://app.portifact.com";
const ARTIFACT = "https://k7d2qm4xab.portifact.dev";
const NONCE = "n".repeat(22);
const frame = { name: "frame" };
const parent = { name: "parent" };

const target: AnnotationTarget = {
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
    const ready = {
      channel: REVIEW_CHANNEL,
      v: REVIEW_PROTOCOL,
      type: "ready",
      page: { path: "index.html" },
      sessionTag: "Ses5ionTag_0123456789-",
    };
    expect(readBridgeMessage(fromFrame(ready), viewerExpects(null))).toEqual(ready);
    // Without the tag of the review session it runs in, a ready message is not one.
    const { sessionTag: _, ...untagged } = ready;
    expect(readBridgeMessage(fromFrame(untagged), viewerExpects(null))).toBeNull();
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
    const base = bridgeEnvelope(NONCE, { type: "select", ids: ["t1"] });
    for (const forged of [
      { ...base, extra: true },
      { ...base, channel: "other" },
      { ...base, v: 1 },
      { ...base, ids: ["../x"] },
      { ...base, ids: "t1" },
      { ...base, ids: Array.from({ length: BRIDGE_LIMITS.highlightsMax + 1 }, (_, i) => `t${i}`) },
      { ...base, type: "activate", id: "t1" },
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

  it("accepts frame rectangles only as bounded, finite numbers with nothing else", () => {
    const rect = { x: 10, y: -20, width: 100, height: 18 };
    const accepted = (body: Record<string, unknown>) =>
      readBridgeMessage(fromFrame(bridgeEnvelope(NONCE, body as never)), viewerExpects());
    expect(accepted({ type: "selection", target, rect })).toMatchObject({ rect });
    expect(accepted({ type: "element", target, rect })).toMatchObject({ rect });
    expect(accepted({ type: "selection-rect", rect })).toMatchObject({ rect });
    expect(accepted({ type: "selection-rect", rect: null })).toMatchObject({ rect: null });
    // A selection without a rectangle still offers a comment, placed by the viewer's fallback.
    expect(accepted({ type: "selection", target })).not.toBeNull();
    const limit = BRIDGE_LIMITS.rectMaxPixels;
    for (const hostile of [
      { ...rect, x: Number.NaN },
      { ...rect, y: Number.POSITIVE_INFINITY },
      { ...rect, width: Number.NEGATIVE_INFINITY },
      { ...rect, width: -1 },
      { ...rect, height: -0.5 },
      { ...rect, x: limit + 1 },
      { ...rect, y: -limit - 1 },
      { ...rect, width: limit + 1 },
      { ...rect, x: "10" },
      { ...rect, extra: 1 },
      { x: 1, y: 1, width: 1 },
      [1, 2, 3, 4],
      "0,0,10,10",
    ]) {
      expect(
        accepted({ type: "selection-rect", rect: hostile }),
        JSON.stringify(hostile),
      ).toBeNull();
      expect(accepted({ type: "selection", target, rect: hostile })).toBeNull();
      expect(accepted({ type: "element", target, rect: hostile })).toBeNull();
    }
    // A rectangle never travels without the nonce of the current handshake.
    const unbound = { channel: REVIEW_CHANNEL, v: REVIEW_PROTOCOL, type: "selection-rect", rect };
    expect(readBridgeMessage(fromFrame(unbound), viewerExpects())).toBeNull();
  });

  it("refuses messages over the size limit and data that is not plain JSON", () => {
    const results = Array.from({ length: BRIDGE_LIMITS.highlightsMax }, (_, i) => ({
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

  it("refuses highlights beyond the limit and the old marker shape", () => {
    const highlights = Array.from({ length: BRIDGE_LIMITS.highlightsMax + 1 }, (_, i) => ({
      id: `t${i}`,
      target,
    }));
    const message = viewerEnvelope(NONCE, { type: "highlights", highlights, selected: [] });
    expect(readViewerMessage(fromViewer(message), bridgeExpects(NONCE))).toBeNull();
    const fits = viewerEnvelope(NONCE, {
      type: "highlights",
      highlights: highlights.slice(0, 3),
      selected: ["t1", "t2"],
    });
    expect(readViewerMessage(fromViewer(fits), bridgeExpects(NONCE))).toEqual(fits);
    const labelled = viewerEnvelope(NONCE, {
      type: "highlights",
      highlights: [{ id: "t1", label: "1", target }],
      selected: [],
    } as never);
    expect(readViewerMessage(fromViewer(labelled), bridgeExpects(NONCE))).toBeNull();
    const hover = viewerEnvelope(NONCE, { type: "hover", id: null });
    expect(readViewerMessage(fromViewer(hover), bridgeExpects(NONCE))).toEqual(hover);
    const badHover = viewerEnvelope(NONCE, { type: "hover", id: "../x" } as never);
    expect(readViewerMessage(fromViewer(badHover), bridgeExpects(NONCE))).toBeNull();
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
