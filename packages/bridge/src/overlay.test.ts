import { describe, expect, it } from "vitest";
import { type Box, MARKER_GAP, markerPosition } from "./overlay.ts";

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe("marker position", () => {
  const size = { width: 24, height: 24 };

  it("sits in the margin before the quote's first line, centred on it", () => {
    const first = { x: 200, y: 100, width: 160, height: 20 };
    const at = markerPosition([first], size);
    expect(at).toEqual({ x: 200 - 24 - MARKER_GAP, y: 98 });
    expect(overlaps({ ...at, ...size }, first)).toBe(false);
  });

  it("moves above the quote when there is no room before it, and below at the very top", () => {
    const atEdge = { x: 10, y: 100, width: 160, height: 20 };
    expect(markerPosition([atEdge], size)).toEqual({ x: 10, y: 100 - 24 - MARKER_GAP });
    const atTop = { x: 10, y: 4, width: 160, height: 20 };
    expect(markerPosition([atTop], size)).toEqual({ x: 10, y: 4 + 20 + MARKER_GAP });
  });

  it("never covers any line of a quote that spans several lines", () => {
    const boxes = [
      { x: 300, y: 100, width: 200, height: 20 },
      { x: 40, y: 120, width: 460, height: 20 },
      { x: 40, y: 140, width: 120, height: 20 },
    ];
    for (const width of [24, 40]) {
      const at = markerPosition(boxes, { width, height: 24 });
      for (const box of boxes) expect(overlaps({ ...at, width, height: 24 }, box)).toBe(false);
    }
    const tight = [
      { x: 12, y: 30, width: 200, height: 20 },
      { x: 12, y: 50, width: 200, height: 20 },
    ];
    const at = markerPosition(tight, size);
    for (const box of tight) expect(overlaps({ ...at, ...size }, box)).toBe(false);
  });
});
