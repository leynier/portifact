import { describe, expect, it } from "vitest";
import {
  DataError,
  documentBody,
  MAX_DEPTH,
  readScope,
  uniqueValue,
  writeScope,
} from "../src/model.ts";
import { encodeRows, encodeValue, exportValue, RESULT_ROWS, VALUE_BYTES } from "../src/wire.ts";

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

describe("the wire encoding", () => {
  it("gives every SQL type one form and flags what was cut or inexact", () => {
    expect(encodeValue(null).wire).toBeNull();
    expect(encodeValue(BigInt("9007199254740993")).wire).toEqual({ $inexact: "9007199254740993" });
    expect(encodeValue(9007199254740992)).toEqual({
      wire: { $inexact: "9007199254740992" },
      cut: false,
      inexact: true,
    });
    expect(encodeValue(Number.POSITIVE_INFINITY).wire).toBeNull();
    expect(encodeValue("x".repeat(VALUE_BYTES + 1))).toEqual({
      wire: { $omitted: VALUE_BYTES + 1 },
      cut: true,
      inexact: false,
    });
    expect(encodeValue(new Uint8Array([1, 2])).wire).toEqual({ $blob: "AQI=" });
    expect(() => encodeValue({})).toThrow();
  });

  it("counts the whole response, column names included, in UTF-8", () => {
    const columns = Array.from({ length: 100 }, (_, index) => `${"€".repeat(4_000)}${index}`);
    const result = encodeRows(columns, [[1]]);
    expect(result.truncated).toBe(true);
    expect(result.columns).toEqual([]);
    const small = encodeRows(["é"], [["€"]]);
    expect(small.bytes).toBe(
      new TextEncoder().encode(
        JSON.stringify({ columns: ["é"], rows: [], truncated: false, inexact: false }),
      ).length +
        new TextEncoder().encode(JSON.stringify(["€"])).length +
        1,
    );
  });

  it("exports values exactly", () => {
    expect(exportValue("integer", "9223372036854775807")).toEqual({
      t: "integer",
      v: "9223372036854775807",
    });
    expect(exportValue("null", null)).toEqual({ t: "null" });
    expect(() => exportValue("weird", "x")).toThrow();
  });

  it("stops at the row cap", () => {
    const rows = Array.from({ length: RESULT_ROWS + 5 }, (_, index) => [index]);
    const result = encodeRows(["n"], rows);
    expect(result.rows).toHaveLength(RESULT_ROWS);
    expect(result.truncated).toBe(true);
  });
});
