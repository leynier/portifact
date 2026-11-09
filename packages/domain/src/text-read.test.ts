import { describe, expect, it } from "vitest";
import { isTextContentType, utf8BoundaryEnd } from "./text-read.ts";

const encode = (text: string) => new TextEncoder().encode(text);

describe("text content types", () => {
  it("accepts text, JSON, XML, scripts and SVG, with or without parameters", () => {
    for (const type of [
      "text/markdown; charset=utf-8",
      "text/plain",
      "TEXT/HTML; charset=UTF-8",
      "text/csv; charset=utf-8",
      "application/json",
      "application/manifest+json",
      "application/ld+json; charset=utf-8",
      "application/xml",
      "application/atom+xml",
      "application/javascript",
      "application/yaml",
      "image/svg+xml",
    ]) {
      expect(isTextContentType(type), type).toBe(true);
    }
  });

  it("refuses binary types and look-alikes", () => {
    for (const type of [
      "application/octet-stream",
      "image/png",
      "application/pdf",
      "font/woff2",
      "application/wasm",
      "application/jsonx",
      "application/+json",
      "image/svg",
      "",
      ";text/plain",
    ]) {
      expect(isTextContentType(type), type).toBe(false);
    }
  });
});

describe("UTF-8 page boundaries", () => {
  it("keeps a chunk that ends after a whole character", () => {
    expect(utf8BoundaryEnd(encode("abc"))).toBe(3);
    expect(utf8BoundaryEnd(encode("añ"))).toBe(3);
    expect(utf8BoundaryEnd(encode("a€"))).toBe(4);
    expect(utf8BoundaryEnd(encode("a😀"))).toBe(5);
    expect(utf8BoundaryEnd(new Uint8Array())).toBe(0);
  });

  it("drops an incomplete character at the end, of any length", () => {
    const two = encode("añ");
    expect(utf8BoundaryEnd(two.slice(0, 2))).toBe(1);
    const three = encode("a€");
    expect(utf8BoundaryEnd(three.slice(0, 2))).toBe(1);
    expect(utf8BoundaryEnd(three.slice(0, 3))).toBe(1);
    const four = encode("a😀");
    for (const cut of [2, 3, 4]) expect(utf8BoundaryEnd(four.slice(0, cut)), `${cut}`).toBe(1);
  });

  it("cuts every split of a mixed text into pages that decode back to it", () => {
    const text = "a ñ € 😀 b".repeat(5);
    const bytes = encode(text);
    for (let size = 4; size <= 9; size++) {
      let offset = 0;
      let out = "";
      while (offset < bytes.length) {
        const chunk = bytes.slice(offset, offset + size);
        const last = offset + chunk.length >= bytes.length;
        const end = last ? chunk.length : utf8BoundaryEnd(chunk);
        expect(end, `size ${size} at ${offset}`).toBeGreaterThan(0);
        out += new TextDecoder("utf-8", { fatal: true }).decode(chunk.slice(0, end));
        offset += end;
      }
      expect(out).toBe(text);
    }
  });

  it("leaves stray continuation bytes to the decoder", () => {
    expect(utf8BoundaryEnd(new Uint8Array([0x80, 0x80, 0x80, 0x80]))).toBe(4);
  });
});
