import { describe, expect, it } from "vitest";
import {
  DataError,
  documentBody,
  MAX_DEPTH,
  readScope,
  uniqueValue,
  writeScope,
} from "../src/model.ts";

describe("the document rules", () => {
  it("decide reads and writes from the mode and the caller only", () => {
    const writer = { kind: "visitor", author: "v", canWrite: true } as const;
    expect(readScope("own", writer)).toBe("own");
    expect(readScope("own", { kind: "reader" })).toBe("none");
    expect(readScope("append", { kind: "reader" })).toBe("all");
    expect(writeScope("shared", writer)).toBe("all");
    expect(writeScope("append", writer)).toBe("own");
    expect(writeScope("read", writer)).toBe("none");
    expect(writeScope("own", { ...writer, canWrite: false })).toBe("none");
    expect(writeScope("read", { kind: "owner" })).toBe("all");
  });

  it("validates bodies and unique values", () => {
    expect(() => documentBody([], 100)).toThrow(DataError);
    let nested: unknown = 1;
    for (let index = 0; index <= MAX_DEPTH; index++) nested = { nested };
    expect(() => documentBody({ nested }, 10_000)).toThrow("too deep");
    expect(documentBody({ é: "ü" }, 100).size).toBe(11);
    expect(uniqueValue({ k: 1 }, "k")).toBe("1");
    expect(uniqueValue({ k: "1" }, "k")).toBe('"1"');
    expect(uniqueValue({ k: true }, "k")).toBe("true");
    expect(() => uniqueValue({ k: Number.NaN }, "k")).toThrow();
    expect(() => uniqueValue({ k: [1] }, "k")).toThrow();
  });
});

describe("the synchronous SHA-256", () => {
  it("matches crypto.subtle for empty, short, multi-block and non-ASCII input", async () => {
    const { sha256Hex } = await import("../src/hash.ts");
    for (const text of ["", "abc", "x".repeat(55), "y".repeat(56), "z".repeat(1_000), "é€😀"]) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      const expected = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      expect(sha256Hex(text)).toBe(expected);
    }
  });
});
