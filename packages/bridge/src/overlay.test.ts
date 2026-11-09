import { describe, expect, it } from "vitest";
import { threadsAt } from "./overlay.ts";

describe("hit-testing highlights", () => {
  const line = (x: number, width: number, y = 100) => ({ x, y, width, height: 20 });

  it("finds every thread that covers the point, innermost first", () => {
    const drawn = [
      { id: "paragraph", boxes: [line(40, 400), line(40, 400, 120)] },
      { id: "sentence", boxes: [line(100, 200)] },
      { id: "word", boxes: [line(150, 40)] },
    ];
    expect(threadsAt({ x: 160, y: 110 }, drawn)).toEqual(["word", "sentence", "paragraph"]);
    expect(threadsAt({ x: 110, y: 110 }, drawn)).toEqual(["sentence", "paragraph"]);
    // The second line of a quote counts too.
    expect(threadsAt({ x: 60, y: 130 }, drawn)).toEqual(["paragraph"]);
    expect(threadsAt({ x: 10, y: 110 }, drawn)).toEqual([]);
    expect(threadsAt({ x: 160, y: 110 }, [])).toEqual([]);
  });

  it("puts the most recent first between threads with the same area, and counts edges as inside", () => {
    const drawn = [
      { id: "older", boxes: [line(100, 50)] },
      { id: "newer", boxes: [line(100, 50)] },
    ];
    expect(threadsAt({ x: 100, y: 100 }, drawn)).toEqual(["newer", "older"]);
    expect(threadsAt({ x: 150, y: 120 }, drawn)).toEqual(["newer", "older"]);
    expect(threadsAt({ x: 151, y: 120 }, drawn)).toEqual([]);
  });
});
