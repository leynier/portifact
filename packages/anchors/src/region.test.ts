import { IMAGE_REGION_LIMITS, ImageRegionRequest } from "@portifact/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  INITIAL_REGION,
  imagePath,
  moveRegion,
  normalizeRegion,
  REGION_STEP,
  type RegionRect,
  regionBox,
  regionFromDrag,
  regionKey,
  regionPercent,
  resizeRegion,
} from "./region.ts";

const valid = (region: RegionRect) =>
  ImageRegionRequest.safeParse({ ...region, image: { path: "mock.png" } }).success;

const anyNumber = fc.oneof(
  fc.double({ noNaN: false }),
  fc.double({ min: -2, max: 3, noNaN: true }),
  fc.constantFrom(0, 1, 0.5, -0, Number.POSITIVE_INFINITY, Number.NaN),
);
const anyRect = fc.record({ x: anyNumber, y: anyNumber, width: anyNumber, height: anyNumber });
const fractionArb = fc.double({ min: 0, max: 1, noNaN: true });
const region = anyRect.map(normalizeRegion);
const box = fc.record({
  x: fc.double({ min: -5000, max: 5000, noNaN: true }),
  y: fc.double({ min: -5000, max: 5000, noNaN: true }),
  width: fc.double({ min: 1, max: 5000, noNaN: true }),
  height: fc.double({ min: 1, max: 5000, noNaN: true }),
});
const point = fc.record({
  x: fc.double({ min: -10000, max: 10000, noNaN: true }),
  y: fc.double({ min: -10000, max: 10000, noNaN: true }),
});
const close = (a: number, b: number, tolerance = 1e-9) => Math.abs(a - b) <= tolerance;

describe("normalizeRegion", () => {
  it("always gives a region the contract accepts", () => {
    fc.assert(fc.property(anyRect, (rect) => valid(normalizeRegion(rect))));
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(anyRect, (rect) => {
        const once = normalizeRegion(rect);
        expect(normalizeRegion(once)).toEqual(once);
      }),
    );
  });

  it("keeps a region that already fits", () => {
    expect(normalizeRegion(INITIAL_REGION)).toEqual(INITIAL_REGION);
    expect(normalizeRegion({ x: 0, y: 0, width: 1, height: 1 })).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });

  it("moves a corner in rather than cutting the size", () => {
    expect(normalizeRegion({ x: 0.9, y: 0.95, width: 0.3, height: 0.2 })).toEqual({
      x: 0.7,
      y: 0.8,
      width: 0.3,
      height: 0.2,
    });
  });

  it("grows sides below the minimum and cuts sides beyond the image", () => {
    const min = IMAGE_REGION_LIMITS.minExtent;
    expect(normalizeRegion({ x: 0.5, y: 0.5, width: 0, height: 0.001 })).toEqual({
      x: 0.5,
      y: 0.5,
      width: min,
      height: min,
    });
    expect(normalizeRegion({ x: -1, y: -1, width: 4, height: 2 })).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });
});

describe("regionFromDrag", () => {
  it("gives a valid region inside the image for any drag", () => {
    fc.assert(
      fc.property(point, point, box, (from, to, b) => {
        const result = regionFromDrag(from, to, b);
        expect(result).not.toBeNull();
        expect(valid(result as RegionRect)).toBe(true);
      }),
    );
  });

  it("does not depend on the direction of the drag", () => {
    fc.assert(
      fc.property(point, point, box, (from, to, b) => {
        expect(regionFromDrag(from, to, b)).toEqual(regionFromDrag(to, from, b));
      }),
    );
  });

  it("round-trips through regionBox within the grid of four decimals", () => {
    fc.assert(
      fc.property(region, box, (r, b) => {
        const drawn = regionBox(r, b);
        const back = regionFromDrag(
          { x: drawn.x, y: drawn.y },
          { x: drawn.x + drawn.width, y: drawn.y + drawn.height },
          b,
        ) as RegionRect;
        const grid = 2 / 10 ** IMAGE_REGION_LIMITS.decimals;
        expect(close(back.x, r.x, grid)).toBe(true);
        expect(close(back.y, r.y, grid)).toBe(true);
        expect(close(back.width, r.width, grid)).toBe(true);
        expect(close(back.height, r.height, grid)).toBe(true);
      }),
    );
  });

  it("maps a drag over a known box to its fractions", () => {
    const b = { x: 100, y: 50, width: 400, height: 200 };
    expect(regionFromDrag({ x: 300, y: 150 }, { x: 200, y: 100 }, b)).toEqual({
      x: 0.25,
      y: 0.25,
      width: 0.25,
      height: 0.25,
    });
    // Beyond the image: clamped to its edges.
    expect(regionFromDrag({ x: 0, y: 0 }, { x: 900, y: 900 }, b)).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });

  it("refuses a box without area or values that are not finite", () => {
    const p = { x: 1, y: 1 };
    expect(regionFromDrag(p, p, { x: 0, y: 0, width: 0, height: 10 })).toBeNull();
    expect(regionFromDrag(p, p, { x: 0, y: 0, width: 10, height: -1 })).toBeNull();
    expect(regionFromDrag({ x: Number.NaN, y: 1 }, p, { x: 0, y: 0, width: 1, height: 1 })).toBe(
      null,
    );
    expect(
      regionFromDrag(p, p, { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 1 }),
    ).toBeNull();
  });
});

describe("regionBox", () => {
  it("stays inside the image's box", () => {
    fc.assert(
      fc.property(region, box, (r, b) => {
        const drawn = regionBox(r, b);
        const slack = 1e-6 * Math.max(1, Math.abs(b.x) + b.width, Math.abs(b.y) + b.height);
        expect(drawn.x >= b.x - slack).toBe(true);
        expect(drawn.y >= b.y - slack).toBe(true);
        expect(drawn.x + drawn.width <= b.x + b.width + slack).toBe(true);
        expect(drawn.y + drawn.height <= b.y + b.height + slack).toBe(true);
      }),
    );
  });

  it("scales a region by the box", () => {
    expect(regionBox(INITIAL_REGION, { x: 10, y: 20, width: 200, height: 100 })).toEqual({
      x: 60,
      y: 45,
      width: 100,
      height: 50,
    });
  });
});

describe("moving and resizing", () => {
  it("keeps the size while moving, and stays valid", () => {
    fc.assert(
      fc.property(region, fractionArb, fractionArb, (r, dx, dy) => {
        for (const [sx, sy] of [
          [1, 1],
          [-1, -1],
        ] as const) {
          const moved = moveRegion(r, sx * dx, sy * dy);
          expect(valid(moved)).toBe(true);
          expect(moved.width).toBe(r.width);
          expect(moved.height).toBe(r.height);
        }
      }),
    );
  });

  it("keeps the top left corner while resizing, and stays valid", () => {
    fc.assert(
      fc.property(region, fractionArb, fractionArb, (r, dw, dh) => {
        for (const sign of [1, -1]) {
          const resized = resizeRegion(r, sign * dw, sign * dh);
          expect(valid(resized)).toBe(true);
          expect(resized.x).toBe(r.x);
          expect(resized.y).toBe(r.y);
        }
      }),
    );
  });

  it("stops at the edges and the minimum size", () => {
    const corner = { x: 0, y: 0, width: 0.1, height: 0.1 };
    expect(moveRegion(corner, -0.5, -0.5)).toEqual(corner);
    expect(moveRegion(corner, 2, 2)).toEqual({ x: 0.9, y: 0.9, width: 0.1, height: 0.1 });
    expect(resizeRegion(corner, -1, -1)).toEqual({ x: 0, y: 0, width: 0.01, height: 0.01 });
    expect(resizeRegion({ ...corner, x: 0.6 }, 1, 0)).toEqual({
      x: 0.6,
      y: 0,
      width: 0.4,
      height: 0.1,
    });
  });
});

describe("regionKey", () => {
  it("moves with arrows and resizes with Shift", () => {
    expect(regionKey(INITIAL_REGION, "ArrowRight", false)).toEqual({
      ...INITIAL_REGION,
      x: 0.25 + REGION_STEP,
    });
    expect(regionKey(INITIAL_REGION, "ArrowUp", false)).toEqual({
      ...INITIAL_REGION,
      y: 0.25 - REGION_STEP,
    });
    expect(regionKey(INITIAL_REGION, "ArrowDown", true)).toEqual({
      ...INITIAL_REGION,
      height: 0.5 + REGION_STEP,
    });
    expect(regionKey(INITIAL_REGION, "ArrowLeft", true)).toEqual({
      ...INITIAL_REGION,
      width: 0.5 - REGION_STEP,
    });
  });

  it("leaves other keys alone", () => {
    for (const key of ["Enter", "Escape", "a", " ", "Tab"]) {
      expect(regionKey(INITIAL_REGION, key, false)).toBeNull();
    }
  });

  it("always gives a valid region", () => {
    const keys = fc.constantFrom("ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown");
    fc.assert(
      fc.property(
        region,
        fc.array(fc.tuple(keys, fc.boolean()), { maxLength: 80 }),
        (r, presses) => {
          let current = r;
          for (const [key, shift] of presses) {
            current = regionKey(current, key, shift) as RegionRect;
            expect(valid(current)).toBe(true);
          }
        },
      ),
    );
  });
});

describe("regionPercent", () => {
  it("gives the edges in whole percentages", () => {
    expect(regionPercent({ x: 0.1234, y: 0.5, width: 0.3, height: 0.25 })).toEqual({
      left: 12,
      top: 50,
      right: 42,
      bottom: 75,
    });
  });
});

describe("imagePath", () => {
  const origin = "https://k7d2qm4xab.portifact.dev";

  it("maps a same-origin URL to its file, decoded", () => {
    expect(imagePath(`${origin}/images/mock.png`, origin)).toBe("images/mock.png");
    expect(imagePath(`${origin}/a%20b/%C3%A9.png?v=2#x`, origin)).toBe("a b/é.png");
  });

  it("refuses other origins, data and blob URLs, the root and invalid paths", () => {
    expect(imagePath("https://other.portifact.dev/mock.png", origin)).toBeNull();
    expect(imagePath("data:image/png;base64,AAAA", origin)).toBeNull();
    expect(imagePath(`blob:${origin}/9f3c`, origin)).toBeNull();
    expect(imagePath(`${origin}/`, origin)).toBeNull();
    expect(imagePath(`${origin}/a//b.png`, origin)).toBeNull();
    expect(imagePath(`${origin}/%E0%A4%A.png`, origin)).toBeNull();
    expect(imagePath("not a url", origin)).toBeNull();
  });

  it("never gives a path with empty, dot or dot-dot segments", () => {
    fc.assert(
      fc.property(fc.webPath(), (path) => {
        const result = imagePath(`${origin}${path.startsWith("/") ? path : `/${path}`}`, origin);
        if (result === null) return;
        expect(result.split("/").every((s) => s !== "" && s !== "." && s !== "..")).toBe(true);
      }),
    );
  });
});
