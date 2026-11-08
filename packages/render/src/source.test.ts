import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RenderError } from "./errors.ts";
import { assertSourceSize, decodeSource, MAX_SOURCE_BYTES, utf8ByteLength } from "./source.ts";

function reason(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof RenderError) return error.reason;
    throw error;
  }
  return undefined;
}

describe("utf8ByteLength", () => {
  it("counts each encoding width", () => {
    expect(utf8ByteLength("")).toBe(0);
    expect(utf8ByteLength("a")).toBe(1);
    expect(utf8ByteLength("ñ")).toBe(2);
    expect(utf8ByteLength("€")).toBe(3);
    expect(utf8ByteLength("😀")).toBe(4);
  });

  it("counts lone surrogates as the 3-byte replacement character", () => {
    expect(utf8ByteLength("\ud800")).toBe(3);
    expect(utf8ByteLength("\udc00a")).toBe(4);
    expect(utf8ByteLength("\ud800\ud800")).toBe(6);
  });

  it("matches TextEncoder for any string", () => {
    const encoder = new TextEncoder();
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (value) => {
        expect(utf8ByteLength(value)).toBe(encoder.encode(value).byteLength);
      }),
    );
  });
});

describe("assertSourceSize", () => {
  it("is the 5 MB document limit from the contracts", () => {
    expect(MAX_SOURCE_BYTES).toBe(5_000_000);
  });

  it("accepts a source exactly at the limit and rejects one byte more", () => {
    expect(reason(() => assertSourceSize("a".repeat(MAX_SOURCE_BYTES)))).toBeUndefined();
    expect(reason(() => assertSourceSize("a".repeat(MAX_SOURCE_BYTES + 1)))).toBe("too_large");
  });

  it("measures bytes, not characters", () => {
    const atLimit = "a".repeat(2_000_000) + "€".repeat(1_000_000);
    expect(utf8ByteLength(atLimit)).toBe(MAX_SOURCE_BYTES);
    expect(reason(() => assertSourceSize(atLimit))).toBeUndefined();
    expect(reason(() => assertSourceSize(`${atLimit}a`))).toBe("too_large");
    const over = "€".repeat(Math.floor(MAX_SOURCE_BYTES / 3) + 1);
    expect(over.length).toBeLessThan(MAX_SOURCE_BYTES);
    expect(reason(() => assertSourceSize(over))).toBe("too_large");
  });

  it("maps every rejection to the invalid_input error code", () => {
    try {
      assertSourceSize("a".repeat(MAX_SOURCE_BYTES + 1));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RenderError);
      expect((error as RenderError).code).toBe("invalid_input");
      expect((error as RenderError).message).toContain("5000000");
    }
  });
});

describe("decodeSource", () => {
  const encode = (text: string) => new TextEncoder().encode(text);

  it("decodes valid UTF-8 exactly", () => {
    expect(decodeSource(encode("héllo\r\n<b>😀</b>"))).toBe("héllo\r\n<b>😀</b>");
  });

  it("drops a leading byte order mark", () => {
    expect(decodeSource(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe("a");
  });

  it("rejects invalid UTF-8", () => {
    expect(reason(() => decodeSource(new Uint8Array([0x61, 0xff, 0x62])))).toBe("invalid_utf8");
    expect(reason(() => decodeSource(new Uint8Array([0xc3])))).toBe("invalid_utf8");
    expect(reason(() => decodeSource(new Uint8Array([0xed, 0xa0, 0x80])))).toBe("invalid_utf8");
  });

  it("rejects binary data with a NUL byte", () => {
    expect(reason(() => decodeSource(new Uint8Array([0x61, 0x00, 0x62])))).toBe("binary");
  });

  it("accepts exactly the limit in bytes and rejects one byte more", () => {
    expect(decodeSource(new Uint8Array(MAX_SOURCE_BYTES).fill(0x61))).toHaveLength(
      MAX_SOURCE_BYTES,
    );
    expect(reason(() => decodeSource(new Uint8Array(MAX_SOURCE_BYTES + 1).fill(0x61)))).toBe(
      "too_large",
    );
  });
});
