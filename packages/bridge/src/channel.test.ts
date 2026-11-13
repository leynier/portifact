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
import {
  BRIDGE_LIMITS,
  REVIEW_CHANNEL,
  REVIEW_PROTOCOL,
  REVIEW_PROTOCOL_EDIT,
} from "./protocol.ts";

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

describe("protocol 3 (edit suggestions)", () => {
  const bridgeExpects = (nonce: string | null = NONCE) => ({
    origin: VIEWER,
    source: parent,
    nonce,
  });
  const fromViewer = (data: unknown) => ({ data, origin: VIEWER, source: parent });

  it("reads a version 3 ready with its capabilities, and refuses unknown capabilities", () => {
    const ready = {
      channel: REVIEW_CHANNEL,
      v: REVIEW_PROTOCOL_EDIT,
      type: "ready",
      page: { path: "index.html" },
      sessionTag: "Ses5ionTag_0123456789-",
      capabilities: ["edit"],
    };
    expect(readBridgeMessage(fromFrame(ready), viewerExpects(null))).toEqual(ready);
    expect(
      readBridgeMessage(fromFrame({ ...ready, capabilities: ["typing"] }), viewerExpects(null)),
    ).toBeNull();
    // Version 2 keeps its schema: no capabilities, and no version 3 fields.
    expect(
      readBridgeMessage(fromFrame({ ...ready, v: REVIEW_PROTOCOL }), viewerExpects(null)),
    ).toBeNull();
    expect(readBridgeMessage(fromFrame({ ...ready, v: 4 }), viewerExpects(null))).toBeNull();
  });

  it("carries an epoch on selections only in version 3, within its bounds", () => {
    const v3 = bridgeEnvelope(NONCE, { type: "selection", target, epoch: 3 }, REVIEW_PROTOCOL_EDIT);
    expect(readBridgeMessage(fromFrame(v3), viewerExpects())).toMatchObject({ v: 3, epoch: 3 });
    const v2 = bridgeEnvelope(NONCE, { type: "selection", target, epoch: 3 });
    expect(readBridgeMessage(fromFrame(v2), viewerExpects())).toBeNull();
    for (const epoch of [0, 1.5, BRIDGE_LIMITS.epochMax + 1]) {
      const bad = bridgeEnvelope(NONCE, { type: "selection", target, epoch }, REVIEW_PROTOCOL_EDIT);
      expect(readBridgeMessage(fromFrame(bad), viewerExpects())).toBeNull();
    }
  });

  it("lets the bridge read edit mode only in version 3, and never with typed text", () => {
    const body = {
      type: "edit-mode" as const,
      epoch: 2,
      active: true,
      kind: "text" as const,
      hint: "Select the text",
    };
    const v3 = viewerEnvelope(NONCE, body, REVIEW_PROTOCOL_EDIT);
    expect(readViewerMessage(fromViewer(v3), bridgeExpects())).toEqual(v3);
    expect(readViewerMessage(fromViewer(viewerEnvelope(NONCE, body)), bridgeExpects())).toBeNull();
    expect(
      readViewerMessage(fromViewer({ ...v3, after: "typed text" }), bridgeExpects()),
    ).toBeNull();
    expect(readViewerMessage(fromViewer({ ...v3, kind: "script" }), bridgeExpects())).toBeNull();
    // Before the handshake only init counts, in either version.
    const init = viewerEnvelope(NONCE, { type: "init" }, REVIEW_PROTOCOL_EDIT);
    expect(readViewerMessage(fromViewer(init), bridgeExpects(null))).toEqual(init);
    expect(readViewerMessage(fromViewer(v3), bridgeExpects(null))).toBeNull();
  });
});

describe("protocol 3 is held to the same checks as version 2 (pf268)", () => {
  const ready3 = {
    channel: REVIEW_CHANNEL,
    v: REVIEW_PROTOCOL_EDIT,
    type: "ready",
    page: { path: "index.html" },
    sessionTag: "Ses5ionTag_0123456789-",
    capabilities: ["edit"],
  };
  const selection3 = bridgeEnvelope(
    NONCE,
    { type: "selection", target, epoch: 1 },
    REVIEW_PROTOCOL_EDIT,
  );

  it("refuses wrong origins, windows and nonces", () => {
    expect(
      readBridgeMessage(
        fromFrame(ready3, { origin: "https://p3n5wq7yzc.portifact.dev" }),
        viewerExpects(null),
      ),
    ).toBeNull();
    expect(readBridgeMessage(fromFrame(ready3, { source: {} }), viewerExpects(null))).toBeNull();
    expect(readBridgeMessage(fromFrame(selection3), viewerExpects("x".repeat(22)))).toBeNull();
    expect(readBridgeMessage(fromFrame(selection3), viewerExpects(null))).toBeNull();
    expect(readBridgeMessage(fromFrame(selection3), viewerExpects())).not.toBeNull();
  });

  it("refuses unknown fields, oversized messages and edit mode from the bridge", () => {
    expect(readBridgeMessage(fromFrame({ ...ready3, extra: 1 }), viewerExpects(null))).toBeNull();
    expect(
      readBridgeMessage(fromFrame({ ...selection3, after: "typed" }), viewerExpects()),
    ).toBeNull();
    const big = {
      ...selection3,
      target: { ...target, path: "a".repeat(BRIDGE_LIMITS.bridgeMessageMaxBytes) },
    };
    expect(readBridgeMessage(fromFrame(big), viewerExpects())).toBeNull();
    const forged = {
      ...selection3,
      type: "edit-mode",
      epoch: 1,
      active: true,
      kind: "text",
      hint: "x",
    };
    expect(readBridgeMessage(fromFrame(forged), viewerExpects())).toBeNull();
  });
});
