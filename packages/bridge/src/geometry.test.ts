import { describe, expect, it } from "vitest";
import { frameRect, placeNear, visibleRect } from "./geometry.ts";

const FRAME = { width: 800, height: 600 };
const PILL = { width: 110, height: 32 };

describe("visibleRect", () => {
  it("keeps a rectangle inside the frame as it is", () => {
    const rect = { x: 10, y: 20, width: 100, height: 18 };
    expect(visibleRect(rect, FRAME)).toEqual(rect);
  });

  it("clips what lies outside the frame's visible box", () => {
    expect(visibleRect({ x: -50, y: 590, width: 100, height: 40 }, FRAME)).toEqual({
      x: 0,
      y: 590,
      width: 50,
      height: 10,
    });
    expect(visibleRect({ x: 700, y: -10, width: 500, height: 2_000 }, FRAME)).toEqual({
      x: 700,
      y: 0,
      width: 100,
      height: 600,
    });
  });

  it("drops a rectangle wholly outside the frame, such as a selection scrolled away", () => {
    expect(visibleRect({ x: 10, y: -100, width: 50, height: 20 }, FRAME)).toBeNull();
    expect(visibleRect({ x: 10, y: 601, width: 50, height: 20 }, FRAME)).toBeNull();
    expect(visibleRect({ x: 801, y: 10, width: 50, height: 20 }, FRAME)).toBeNull();
    expect(visibleRect({ x: -51, y: 10, width: 50, height: 20 }, FRAME)).toBeNull();
  });

  it("refuses hostile values: not finite, negative sizes, or a frame with no size", () => {
    for (const rect of [
      { x: Number.NaN, y: 0, width: 1, height: 1 },
      { x: 0, y: Number.POSITIVE_INFINITY, width: 1, height: 1 },
      { x: 0, y: 0, width: Number.NEGATIVE_INFINITY, height: 1 },
      { x: 0, y: 0, width: -5, height: 1 },
      { x: 0, y: 0, width: 1, height: -5 },
    ]) {
      expect(visibleRect(rect, FRAME), JSON.stringify(rect)).toBeNull();
    }
    expect(visibleRect({ x: 0, y: 0, width: 1, height: 1 }, { width: 0, height: 600 })).toBeNull();
    expect(visibleRect({ x: 0, y: 0, width: 1, height: 1 }, { width: 800, height: 0 })).toBeNull();
    expect(
      visibleRect({ x: 0, y: 0, width: 1, height: 1 }, { width: Number.NaN, height: 600 }),
    ).toBeNull();
  });
});

describe("placeNear", () => {
  it("places the box below the anchor, aligned with its left edge", () => {
    expect(placeNear({ x: 40, y: 100, width: 200, height: 20 }, PILL, FRAME)).toEqual({
      x: 40,
      y: 128,
    });
  });

  it("goes above when there is no room below, and as close as fits when neither has room", () => {
    expect(placeNear({ x: 40, y: 570, width: 200, height: 20 }, PILL, FRAME)).toEqual({
      x: 40,
      y: 530,
    });
    expect(
      placeNear({ x: 0, y: 0, width: 800, height: 600 }, { width: 300, height: 200 }, FRAME),
    ).toEqual({ x: 0, y: 400 });
  });

  it("never lets the box leave the frame on the right", () => {
    expect(placeNear({ x: 780, y: 10, width: 20, height: 20 }, PILL, FRAME)).toEqual({
      x: 690,
      y: 38,
    });
  });

  it("clamps an anchor outside the frame before placing, and gives up when nothing is visible", () => {
    expect(placeNear({ x: -500, y: -500, width: 600, height: 520 }, PILL, FRAME)).toEqual({
      x: 0,
      y: 28,
    });
    expect(placeNear({ x: 0, y: 5_000, width: 10, height: 10 }, PILL, FRAME)).toBeNull();
  });

  it("gives up when the box is bigger than the frame or a size is not finite", () => {
    const anchor = { x: 0, y: 0, width: 10, height: 10 };
    expect(placeNear(anchor, { width: 900, height: 10 }, FRAME)).toBeNull();
    expect(placeNear(anchor, { width: 10, height: 700 }, FRAME)).toBeNull();
    expect(placeNear(anchor, { width: Number.NaN, height: 10 }, FRAME)).toBeNull();
    expect(placeNear(anchor, PILL, FRAME, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("keeps every placement inside the frame for any anchor", () => {
    const values = [-1e6, -300, -1, 0, 1, 37.5, 299, 599, 600, 799, 800, 1e6];
    for (const x of values) {
      for (const y of values) {
        for (const size of [0, 1, 50, 1e6]) {
          const placed = placeNear({ x, y, width: size, height: size }, PILL, FRAME);
          if (!placed) continue;
          expect(placed.x).toBeGreaterThanOrEqual(0);
          expect(placed.y).toBeGreaterThanOrEqual(0);
          expect(placed.x + PILL.width).toBeLessThanOrEqual(FRAME.width);
          expect(placed.y + PILL.height).toBeLessThanOrEqual(FRAME.height);
        }
      }
    }
  });
});

describe("frameRect", () => {
  it("rounds to whole pixels and clamps to the protocol's bounds", () => {
    expect(frameRect({ left: 1.4, top: 2.6, width: 3.5, height: 0.2 })).toEqual({
      x: 1,
      y: 3,
      width: 4,
      height: 0,
    });
    expect(frameRect({ left: -2e9, top: 2e9, width: 2e9, height: -3 })).toEqual({
      x: -1_000_000,
      y: 1_000_000,
      width: 1_000_000,
      height: 0,
    });
  });

  it("has no rectangle for values that are not finite", () => {
    expect(frameRect({ left: Number.NaN, top: 0, width: 1, height: 1 })).toBeNull();
    expect(frameRect({ left: 0, top: 0, width: Number.POSITIVE_INFINITY, height: 1 })).toBeNull();
  });
});
