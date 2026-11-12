import { describe, expect, it } from "vitest";
import { elementOperation, textOperation } from "../testing/suggestions/harness.ts";
import { canonicalJson, sha256Hex } from "./digest.ts";
import { destination, omitted } from "./display.ts";
import { changedRegion, occurrences, textEditOf, validAfter } from "./edit.ts";
import { applyPatches, onlyApprovedBytes } from "./planned.ts";

describe("suggestion helpers", () => {
  it("hash canonical JSON whatever the key order", async () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: null }] })).toBe('{"a":[{"c":null,"d":2}],"b":1}');
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("bound destinations and say when one cannot be resolved", () => {
    expect(destination("http://[", "https://x.example/")).toMatchObject({
      effective: "",
      authored: "http://[",
    });
    const long = destination(`/${"a".repeat(600)}`, "https://x.example/");
    expect(long.authored).toHaveLength(512);
    expect(long.authoredOmitted).toBe(89);
    expect(long.effectiveOmitted).toBeGreaterThan(0);
    expect(omitted(0)).toBe("");
    expect(omitted(3)).toBe("⟦3 characters omitted⟧");
  });

  it("read text operations only, and find bounded occurrences", () => {
    const op = textOperation({ start: 1, end: 3, before: "bc", after: "x" });
    expect(textEditOf(op)).toEqual({ start: 1, end: 3, before: "bc", after: "x" });
    expect(textEditOf(elementOperation("remove"))).toBeNull();
    const mismatched = { ...op, target: elementOperation("remove").target } as typeof op;
    expect(textEditOf(mismatched)).toBeNull();
    expect(occurrences("aaaa", "aa")).toEqual([0, 1, 2]);
    expect(occurrences("abc", "")).toEqual([]);
    expect(validAfter({ start: 0, end: 1, before: "a", after: "x".repeat(1_025) })).toBe(false);
    expect(changedRegion({ start: 4, end: 7, before: "cat", after: "cut" })).toEqual({
      from: 5,
      to: 6,
      deleted: "a",
      inserted: "u",
    });
  });

  it("apply patches from the end and check bytes outside approved ranges", () => {
    const ranges = [
      { start: 4, end: 5, replacement: "X" },
      { start: 0, end: 1, replacement: "YY" },
    ];
    const next = applyPatches("abcdef", ranges);
    expect(next).toBe("YYbcdXf");
    expect(onlyApprovedBytes("abcdef", next, ranges)).toBe(true);
    expect(onlyApprovedBytes("abcdef", "YYbcdXg", ranges)).toBe(false);
    expect(onlyApprovedBytes("abcdef", "YYbzdXf", ranges)).toBe(false);
    expect(onlyApprovedBytes("abcdef", "ZZbcdXf", ranges)).toBe(false);
    expect(
      onlyApprovedBytes("abcdef", next, [...ranges, { start: 4, end: 6, replacement: "" }]),
    ).toBe(false);
  });
});
