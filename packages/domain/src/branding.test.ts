import { BRAND_LIMITS } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  brandShown,
  inspectLogo,
  normalizeBrandLink,
  normalizeBrandName,
  PORTIFACT_HOSTS,
} from "./branding.ts";
import { entitlements } from "./plans.ts";
import { jpeg, png, text, webp, webpChunk, webpRaw } from "./testing/images.ts";

describe("normalizeBrandName", () => {
  it.each([
    ["Acme", "Acme"],
    ["  Acme   Labs  ", "Acme Labs"],
    ["Acme\tLabs\nInc", "Acme Labs Inc"],
    ["Café Ñandú", "Café Ñandú"],
    // NFC: a decomposed e and accent become one code point.
    ["Café", "Café"],
    ["株式会社アクメ", "株式会社アクメ"],
    ["a".repeat(BRAND_LIMITS.nameMaxLength), "a".repeat(BRAND_LIMITS.nameMaxLength)],
    // Code points, not UTF-16 units: 60 emoji are 120 units.
    ["😀".repeat(BRAND_LIMITS.nameMaxLength), "😀".repeat(BRAND_LIMITS.nameMaxLength)],
    // Markup is kept as text: the viewer renders it as text, never as markup.
    ["<b>Acme</b>", "<b>Acme</b>"],
    ["Port", "Port"],
    ["Artifactory", "Artifactory"],
    // A line separator is white space: it collapses like a newline.
    ["Acme\u2028Labs", "Acme Labs"],
    // 3 reads as e, so this is another word.
    ["P3rtifact", "P3rtifact"],
  ])("accepts %j as %j", (raw, expected) => {
    expect(normalizeBrandName(raw)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ["", "name: Enter the name to show."],
    ["   \n\t ", "name: Enter the name to show."],
    [
      "a".repeat(BRAND_LIMITS.nameMaxLength + 1),
      `name: Use at most ${BRAND_LIMITS.nameMaxLength} characters.`,
    ],
    // Bidi override, which can reverse how a name reads.
    ["Acme\u202eemca", "name: Remove control and invisible characters."],
    ["Acme\u200bLabs", "name: Remove control and invisible characters."],
    ["Acme\u0000", "name: Remove control and invisible characters."],
    ["Acme\ue000", "name: Remove control and invisible characters."],
    ["Portifact", "name: The name cannot read as Portifact."],
    ["portifact support", "name: The name cannot read as Portifact."],
    ["P O R T I F A C T", "name: The name cannot read as Portifact."],
    ["P0rt1fact", "name: The name cannot read as Portifact."],
    ["Port-i-fact.com", "name: The name cannot read as Portifact."],
    // Full-width letters fold to ASCII under NFKD.
    ["ＰＯＲＴＩＦＡＣＴ", "name: The name cannot read as Portifact."],
    ["Pórtifact", "name: The name cannot read as Portifact."],
    ["PORT1F4C7", "name: The name cannot read as Portifact."],
  ])("refuses %j", (raw, message) => {
    expect(normalizeBrandName(raw)).toEqual({ ok: false, code: "invalid_input", message });
  });
});

describe("normalizeBrandLink", () => {
  const own = ["app.portifact.test", "portifact-content.test"];

  it.each([
    ["https://acme.example.com", "https://acme.example.com/"],
    ["  https://acme.co/about?x=1#team ", "https://acme.co/about?x=1#team"],
    ["https://ACME.co/", "https://acme.co/"],
    ["https://xn--caf-dma.fr/", "https://xn--caf-dma.fr/"],
    ["https://café.fr", "https://xn--caf-dma.fr/"],
    ["https://acme.co:443/", "https://acme.co/"],
    ["https://notportifact.com/", "https://notportifact.com/"],
    ["https://portifact.com.evil.co/", "https://portifact.com.evil.co/"],
  ])("accepts %j", (raw, expected) => {
    expect(normalizeBrandLink(raw, own)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ["http://acme.co", "link: Use an address that starts with https://."],
    ["javascript:alert(1)", "link: Use an address that starts with https://."],
    ["data:text/html,<script>alert(1)</script>", "link: Use an address that starts with https://."],
    ["ftp://acme.co", "link: Use an address that starts with https://."],
    ["//acme.co", "link: Enter a full address that starts with https://."],
    ["acme.co", "link: Enter a full address that starts with https://."],
    ["https://acme .co", "link: Enter a full address that starts with https://."],
    ["https://acme.co/\u0000", "link: Enter a full address that starts with https://."],
    ["https://user:pass@acme.co", "link: Remove the user name and password from the address."],
    ["https://user@acme.co", "link: Remove the user name and password from the address."],
    ["https://acme.co:8443/", "link: Remove the port from the address."],
    ["https://127.0.0.1/", "link: Use a domain name, not an IP address."],
    ["https://0x7f.1/", "link: Use a domain name, not an IP address."],
    ["https://2130706433/", "link: Use a domain name, not an IP address."],
    ["https://[::1]/", "link: Use a domain name, not an IP address."],
    ["https://[2001:db8::1]/", "link: Use a domain name, not an IP address."],
    ["https://localhost/", "link: Use a public domain name."],
    ["https://intranet/", "link: Use a public domain name."],
    ["https://printer.local/", "link: Use a public domain name."],
    ["https://app.localhost/", "link: Use a public domain name."],
    ["https://portifact.com/", "link: Link to your own site, not to Portifact."],
    ["https://app.portifact.com/login", "link: Link to your own site, not to Portifact."],
    ["https://abc.portifact.dev/", "link: Link to your own site, not to Portifact."],
    ["https://PORTIFACT.COM./", "link: Link to your own site, not to Portifact."],
    ["https://x.portifact-content.cloud/", "link: Link to your own site, not to Portifact."],
    [
      `https://acme.co/${"a".repeat(BRAND_LIMITS.linkMaxLength)}`,
      `link: Use at most ${BRAND_LIMITS.linkMaxLength} characters.`,
    ],
  ])("refuses %j", (raw, message) => {
    const blocked = raw.includes("portifact-content.cloud") ? ["portifact-content.cloud"] : own;
    expect(normalizeBrandLink(raw, blocked)).toEqual({ ok: false, code: "invalid_input", message });
  });

  it("refuses the deployment's own domains", () => {
    expect(normalizeBrandLink("https://app.portifact.test/x", own).ok).toBe(false);
    expect(normalizeBrandLink("https://a1.portifact-content.test/", own).ok).toBe(false);
    expect(PORTIFACT_HOSTS).toEqual(["portifact.com", "portifact.dev"]);
  });

  it("refuses an address that grows past the cap once the parser encodes it", () => {
    const raw = `https://acme.co/${"é".repeat(1100)}`;
    expect(raw.length).toBeLessThanOrEqual(BRAND_LIMITS.linkMaxLength);
    expect(normalizeBrandLink(raw, [])).toEqual({
      ok: false,
      code: "invalid_input",
      message: `link: Use at most ${BRAND_LIMITS.linkMaxLength} characters.`,
    });
  });
});

const refused = (message: string) => ({
  ok: false,
  code: "invalid_input",
  message: `logo: ${message}`,
});
const NOT_IMAGE = refused("Use a PNG, JPEG or WebP image.");
const CUT = refused("The file is cut short.");
const DAMAGED = refused("The file is damaged.");
const ANIMATED = refused("Use an image without animation.");
const TRAILING = refused("Remove the data after the end of the image.");
const MARKUP = refused("Remove the text or markup stored in the image.");
const tEXt = (value: string) => ({
  type: "tEXt",
  data: [...new TextEncoder().encode(`Comment\0${value}`)],
});

describe("inspectLogo", () => {
  it.each([
    ["a PNG", png({ width: 64, height: 32 }), "image/png", 64, 32],
    ["a PNG at the smallest size", png({ width: 16, height: 16 }), "image/png", 16, 16],
    ["a PNG at the largest size", png({ width: 1024, height: 1024 }), "image/png", 1024, 1024],
    ["a PNG with harmless text", png({ extra: [tEXt("Made with a tool")] }), "image/png", 64, 32],
    ["a JPEG", jpeg({ width: 300, height: 120 }), "image/jpeg", 300, 120],
    ["a JPEG with a comment", jpeg({ comment: "Acme logo" }), "image/jpeg", 64, 32],
    ["a lossless WebP", webp({ width: 200, height: 50 }), "image/webp", 200, 50],
    ["a lossy WebP", webp({ kind: "lossy", width: 120, height: 40 }), "image/webp", 120, 40],
    [
      "an extended WebP",
      webp({ kind: "extended", width: 1000, height: 300 }),
      "image/webp",
      1000,
      300,
    ],
  ])("accepts %s", (_name, bytes, type, width, height) => {
    expect(inspectLogo(bytes)).toEqual({ ok: true, value: { type, width, height } });
  });

  it.each([
    ["an empty file", new Uint8Array(), NOT_IMAGE],
    ["a GIF", text("GIF89a\u0001\u0000\u0001\u0000"), NOT_IMAGE],
    [
      "an SVG",
      text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      NOT_IMAGE,
    ],
    ["an SVG with an XML declaration", text('<?xml version="1.0"?><svg/>'), NOT_IMAGE],
    ["HTML", text("<!doctype html><html><script>alert(1)</script></html>"), NOT_IMAGE],
    ["a BMP", text("BM6\u0000\u0000\u0000"), NOT_IMAGE],
    ["a PNG signature alone", png().slice(0, 8), CUT],
    ["a RIFF that is not WebP", text("RIFF\u0004\u0000\u0000\u0000WAVE"), NOT_IMAGE],
    [
      "a wrong PNG signature",
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x00, ...png().slice(8)]),
      NOT_IMAGE,
    ],
    ["a PNG cut in its data", png({ truncateTo: 60 }), CUT],
    ["a PNG without its end", png().slice(0, png().length - 12), CUT],
    ["a PNG with a bad checksum", png({ badCrc: true }), DAMAGED],
    [
      "a PNG followed by HTML",
      png({ trailing: [...text("<html><script>alert(1)</script>")] }),
      TRAILING,
    ],
    ["a PNG followed by one byte", png({ trailing: [0] }), TRAILING],
    [
      "a PNG holding HTML in a text chunk",
      png({ extra: [tEXt("<script>alert(1)</script>")] }),
      MARKUP,
    ],
    ["a PNG holding SVG in a text chunk", png({ extra: [tEXt("<svg onload=alert(1)>")] }), MARKUP],
    ["a PNG holding a javascript: URL", png({ extra: [tEXt("JavaScript:alert(1)")] }), MARKUP],
    [
      "an animated PNG",
      png({ extra: [{ type: "acTL", data: [0, 0, 0, 2, 0, 0, 0, 0] }] }),
      ANIMATED,
    ],
    [
      "a PNG with a second header",
      png({ extra: [{ type: "IHDR", data: [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0] }] }),
      DAMAGED,
    ],
    [
      "a PNG whose first chunk is not the header",
      Uint8Array.from([...png().slice(0, 8), ...png({ extra: [] }).slice(33)]),
      DAMAGED,
    ],
    [
      "a PNG too wide",
      png({ width: 1025, height: 16 }),
      refused("Use an image of at most 1024 by 1024 pixels."),
    ],
    [
      "a PNG too tall",
      png({ width: 16, height: 1025 }),
      refused("Use an image of at most 1024 by 1024 pixels."),
    ],
    [
      "a PNG too small",
      png({ width: 15, height: 64 }),
      refused("Use an image of at least 16 pixels on each side."),
    ],
    [
      "a one pixel PNG",
      png({ width: 1, height: 1 }),
      refused("Use an image of at least 16 pixels on each side."),
    ],
    ["a JPEG with HTML in a comment", jpeg({ comment: "<html><body onload=alert(1)>" }), MARKUP],
    ["a JPEG followed by HTML", jpeg({ trailing: [...text("<script>")] }), TRAILING],
    ["a JPEG cut short", jpeg({ truncateTo: 30 }), CUT],
    ["a JPEG cut in its data", jpeg().slice(0, jpeg().length - 2), CUT],
    ["a JPEG without a frame", jpeg({ noFrame: true }), DAMAGED],
    [
      "a JPEG too large",
      jpeg({ width: 2000, height: 100 }),
      refused("Use an image of at most 1024 by 1024 pixels."),
    ],
    [
      "a WebP whose size is wrong",
      webp({ badSize: true }),
      refused("The file is cut short or has extra data."),
    ],
    [
      "a WebP followed by data",
      webp({ trailing: [...text("<svg>")] }),
      refused("The file is cut short or has extra data."),
    ],
    [
      "a WebP cut short",
      webp({ truncateTo: 20 }),
      refused("The file is cut short or has extra data."),
    ],
    ["an animated WebP (flag)", webp({ kind: "extended", animated: "flag" }), ANIMATED],
    ["an animated WebP (chunk)", webp({ kind: "extended", animated: "chunk" }), ANIMATED],
    [
      "a WebP too large",
      webp({ kind: "extended", width: 4000, height: 10 }),
      refused("Use an image of at most 1024 by 1024 pixels."),
    ],
  ])("refuses %s", (_name, bytes, expected) => {
    expect(inspectLogo(bytes)).toEqual(expected);
  });

  const SOI = [0xff, 0xd8];
  const SOF = [0xff, 0xc0, 0, 11, 8, 0, 32, 0, 64, 1, 1, 0x11, 0];
  const SOS = [0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0];
  const EOI = [0xff, 0xd9];
  const VP8L = webpChunk("VP8L", [0x2f, 0x3f, 0xc0, 0x07, 0, 0]);
  const VP8 = webpChunk("VP8 ", [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 64, 0, 32, 0]);
  const VP8X = webpChunk("VP8X", [0, 0, 0, 0, 63, 0, 0, 31, 0, 0]);

  it.each([
    [
      "a PNG without image data",
      Uint8Array.from([...png().slice(0, 33), ...png().slice(-12)]),
      DAMAGED,
    ],
    [
      "a JPEG with a stray byte between segments",
      Uint8Array.from([...SOI, ...SOF, 0x00, ...SOS, 1, ...EOI]),
      DAMAGED,
    ],
    ["a JPEG ending in a lone marker byte", Uint8Array.from([...SOI, 0xff]), CUT],
    ["a JPEG ending after a marker", Uint8Array.from([...SOI, 0xff, 0xe0]), CUT],
    ["a JPEG whose segment runs past the end", Uint8Array.from([...SOI, 0xff, 0xe0, 0x10, 0]), CUT],
    [
      "a JPEG with a short frame header",
      Uint8Array.from([...SOI, 0xff, 0xc0, 0, 4, 8, 0, ...SOS, 1, ...EOI]),
      DAMAGED,
    ],
    [
      "a JPEG whose data ends on a marker byte",
      Uint8Array.from([...SOI, ...SOF, ...SOS, 1, 0xff]),
      CUT,
    ],
    ["a JPEG whose data never ends", Uint8Array.from([...SOI, ...SOF, ...SOS, 1, 2, 3]), CUT],
    ["a JPEG that ends before its frame", Uint8Array.from([...SOI, ...SOS, 1, ...EOI]), DAMAGED],
    ["a WebP with half a chunk header", webpRaw([...VP8L, 0x41, 0x42]), CUT],
    [
      "a WebP whose chunk runs past the end",
      webpRaw(webpChunk("VP8L", [0x2f, 1, 2, 3, 4], 40)),
      CUT,
    ],
    ["a WebP with its extended header later", webpRaw([...VP8L, ...VP8X]), DAMAGED],
    [
      "a WebP with a short extended header",
      webpRaw([...webpChunk("VP8X", [0, 0, 0, 0]), ...VP8L]),
      DAMAGED,
    ],
    ["a WebP with two lossy images", webpRaw([...VP8, ...VP8]), DAMAGED],
    [
      "a WebP with a bad lossy start code",
      webpRaw(webpChunk("VP8 ", [0, 0, 0, 1, 2, 3, 64, 0, 32, 0])),
      DAMAGED,
    ],
    ["a WebP with a short lossy header", webpRaw(webpChunk("VP8 ", [0, 0, 0, 0x9d])), DAMAGED],
    ["a WebP with two lossless images", webpRaw([...VP8L, ...VP8L]), DAMAGED],
    [
      "a WebP with a bad lossless signature",
      webpRaw(webpChunk("VP8L", [0x2e, 0x3f, 0xc0, 0x07, 0])),
      DAMAGED,
    ],
    ["a WebP with a short lossless header", webpRaw(webpChunk("VP8L", [0x2f, 0])), DAMAGED],
    ["a WebP without an image", webpRaw([...VP8X, ...webpChunk("EXIF", [1, 2])]), DAMAGED],
  ])("refuses %s", (_name, bytes, expected) => {
    expect(inspectLogo(bytes)).toEqual(expected);
  });

  it.each([
    [
      "a JPEG with a restart marker between segments",
      Uint8Array.from([...SOI, 0xff, 0xd0, ...SOF, ...SOS, 1, ...EOI]),
      "image/jpeg",
    ],
    [
      "a JPEG with fill bytes before a marker",
      Uint8Array.from([...SOI, 0xff, 0xff, ...SOF.slice(1), ...SOS, 1, ...EOI]),
      "image/jpeg",
    ],
    [
      "a WebP with metadata before its image",
      webpRaw([...VP8X, ...webpChunk("EXIF", [1, 2, 3]), ...VP8L]),
      "image/webp",
    ],
  ])("accepts %s", (_name, bytes, type) => {
    expect(inspectLogo(bytes)).toEqual({ ok: true, value: { type, width: 64, height: 32 } });
  });

  it("refuses more bytes than the cap before reading them, and accepts the cap", () => {
    const filler = { type: "zzZz", data: Array.from({ length: 0 }, () => 0) };
    const base = png({ extra: [filler] });
    const pad = BRAND_LIMITS.logoMaxBytes - base.length;
    const exact = png({ extra: [{ type: "zzZz", data: Array.from({ length: pad }, () => 0x41) }] });
    expect(exact.length).toBe(BRAND_LIMITS.logoMaxBytes);
    expect(inspectLogo(exact).ok).toBe(true);
    const over = png({
      extra: [{ type: "zzZz", data: Array.from({ length: pad + 1 }, () => 0x41) }],
    });
    expect(inspectLogo(over)).toEqual(refused("Use an image of at most 100 KB."));
  });

  it("judges the bytes, never a name or a type", () => {
    // An SVG renamed .png is still text starting with `<`.
    expect(inspectLogo(text("<svg/>"))).toEqual(NOT_IMAGE);
    // A PNG is a PNG whatever it was called.
    expect(inspectLogo(png()).ok).toBe(true);
  });
});

describe("brandShown", () => {
  const now = Date.parse("2026-11-10T00:00:00Z");
  const free = entitlements(null, now);
  const pro = entitlements({ plan: "pro", seats: 1, validUntil: null, overrides: null }, now);
  const lapsed = entitlements({ plan: "pro", seats: 1, validUntil: now - 1, overrides: null }, now);
  const withoutIt = entitlements(
    { plan: "pro", seats: 1, validUntil: null, overrides: { features: { branding: false } } },
    now,
  );

  it.each([
    ["no brand", null, pro, false],
    ["a brand on pro", { suspendedAt: null }, pro, true],
    ["a brand on free", { suspendedAt: null }, free, false],
    ["a brand after the plan lapsed", { suspendedAt: null }, lapsed, false],
    ["a brand the overrides take away", { suspendedAt: null }, withoutIt, false],
    ["a suspended brand on pro", { suspendedAt: now }, pro, false],
  ])("%s: %s", (_name, brand, owner, shown) => {
    expect(brandShown(brand, owner)).toBe(shown);
  });
});
