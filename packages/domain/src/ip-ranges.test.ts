import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  clientIp,
  compileIpRanges,
  ipAllowed,
  ipText,
  normalizeIpRanges,
  parseIp,
  parseIpRange,
  rangeContains,
  rangesCovered,
  rangeText,
} from "./ip-ranges.ts";

const text = (written: string) => {
  const range = parseIpRange(written);
  return range.ok ? rangeText(range.value) : range.code;
};

describe("parsing an address", () => {
  it.each([
    ["192.0.2.1", "192.0.2.1"],
    ["0.0.0.0", "0.0.0.0"],
    ["255.255.255.255", "255.255.255.255"],
    ["2001:db8::1", "2001:db8::1"],
    ["2001:DB8:0:0:0:0:0:1", "2001:db8::1"],
    ["2001:0db8::0001", "2001:db8::1"],
    ["::", "::"],
    ["::1", "::1"],
    ["1::", "1::"],
    ["1:0:0:2:0:0:0:3", "1:0:0:2::3"],
    ["1:0:0:2:0:0:3:4", "1::2:0:0:3:4"],
    ["1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7:8"],
    ["1:2:3:4:5:6:0:8", "1:2:3:4:5:6:0:8"],
    ["64:ff9b::192.0.2.33", "64:ff9b::c000:221"],
    ["::ffff:192.0.2.1", "::ffff:c000:201"],
  ])("reads %s as %s", (written, canonical) => {
    const bytes = parseIp(written);
    expect(bytes && ipText(bytes)).toBe(canonical);
  });

  it.each([
    "",
    "192.0.2",
    "192.0.2.1.5",
    "192.0.2.256",
    "192.0.2.01",
    "010.0.0.1",
    "192.0.2.-1",
    " 192.0.2.1",
    "192.0.2.1/24",
    "1:2:3:4:5:6:7",
    "1:2:3:4:5:6:7:8:9",
    "1::2::3",
    "1:2:3:4:5:6:7::8",
    "12345::",
    "g::1",
    ":1",
    "1:",
    "fe80::1%eth0",
    "1.2.3.4::",
    "::1.2.3",
    "a".repeat(46),
  ])("refuses %j", (written) => {
    expect(parseIp(written)).toBeNull();
  });
});

describe("a client's address", () => {
  it("matches an IPv4-mapped address as IPv4, and nothing else as anything", () => {
    expect(clientIp("::ffff:192.0.2.1")?.length).toBe(4);
    expect(ipText(clientIp("::ffff:192.0.2.1") as Uint8Array)).toBe("192.0.2.1");
    expect(clientIp(" 192.0.2.1 ")?.length).toBe(4);
    expect(clientIp(null)).toBeNull();
    expect(clientIp("unknown")).toBeNull();
    expect(clientIp("fe80::1%eth0")).toBeNull();
  });
});

describe("parsing a range", () => {
  it.each([
    ["192.0.2.0/24", "192.0.2.0/24"],
    ["192.0.2.7", "192.0.2.7/32"],
    ["192.0.2.7/32", "192.0.2.7/32"],
    ["192.0.2.77/24", "192.0.2.0/24"],
    ["10.1.2.3/8", "10.0.0.0/8"],
    ["  198.51.100.0/22 ", "198.51.100.0/22"],
    ["2001:db8::/32", "2001:db8::/32"],
    ["2001:db8:1234::5/48", "2001:db8:1234::/48"],
    ["2001:db8::1", "2001:db8::1/128"],
    ["0.0.0.0/1", "0.0.0.0/1"],
    ["128.0.0.0/1", "128.0.0.0/1"],
    ["::/1", "::/1"],
  ])("normalizes %j to %s", (written, canonical) => {
    expect(text(written)).toBe(canonical);
  });

  it.each([
    "0.0.0.0/0",
    "::/0",
    "192.0.2.0/33",
    "2001:db8::/129",
    "192.0.2.0/024",
    "192.0.2.0/",
    "192.0.2.0/x",
    "192.0.2.0/24/1",
    "fe80::/10%eth0",
    "::ffff:192.0.2.0/120",
    "example.com",
  ])("refuses %j", (written) => {
    const range = parseIpRange(written);
    expect(range.ok).toBe(false);
    if (!range.ok) {
      expect(range.code).toBe("invalid_input");
      expect(range.message).toContain(written);
    }
  });

  it("explains /0 and IPv4 written as IPv6", () => {
    expect(parseIpRange("0.0.0.0/0")).toMatchObject({ message: expect.stringContaining("every") });
    expect(parseIpRange("::ffff:192.0.2.1")).toMatchObject({
      message: expect.stringContaining("Write it as IPv4"),
    });
  });
});

describe("normalizing an allowlist", () => {
  it("drops duplicates and ranges inside another, and sorts IPv4 first", () => {
    expect(
      normalizeIpRanges([
        "2001:db8::/32",
        "192.0.2.7",
        "192.0.2.0/24",
        "192.0.2.0/24",
        "2001:db8:1::/48",
        "10.0.0.0/8",
        "198.51.100.1",
      ]),
    ).toEqual({
      ok: true,
      value: ["10.0.0.0/8", "192.0.2.0/24", "198.51.100.1/32", "2001:db8::/32"],
    });
  });

  it("names the first entry that does not parse", () => {
    expect(normalizeIpRanges(["192.0.2.0/24", "nope", "0.0.0.0/0"])).toMatchObject({
      ok: false,
      message: expect.stringContaining("nope"),
    });
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(fc.array(rangeArbitrary(), { minLength: 1, maxLength: 20 }), (written) => {
        const once = normalizeIpRanges(written);
        if (!once.ok) return;
        expect(normalizeIpRanges(once.value)).toEqual(once);
      }),
    );
  });
});

describe("matching", () => {
  const ranges = compileIpRanges(["192.0.2.0/24", "2001:db8::/32"]);

  it.each([
    ["192.0.2.0", true],
    ["192.0.2.255", true],
    ["192.0.3.0", false],
    ["::ffff:192.0.2.9", true],
    ["2001:db8:ffff::1", true],
    ["2001:db9::1", false],
    ["::192.0.2.1", false],
    [null, false],
    ["unknown", false],
  ] as const)("%s is allowed: %s", (ip, allowed) => {
    expect(ipAllowed(ip, ranges)).toBe(allowed);
  });

  it("admits every address of a range and none just outside it", () => {
    fc.assert(
      fc.property(fc.ipV4(), fc.integer({ min: 1, max: 32 }), (address, prefix) => {
        const range = parseIpRange(`${address}/${prefix}`);
        if (!range.ok) throw new Error("a generated range parses");
        const [network] = compileIpRanges([rangeText(range.value)]);
        if (!network) throw new Error("one range");
        expect(rangeContains(network, clientIp(address) as Uint8Array)).toBe(true);
        // The address after the range's last one is outside it (unless the range ends the space).
        const last = [...range.value.bytes];
        let value = last.reduce((sum, byte) => sum * 256 + byte, 0);
        value += 2 ** (32 - prefix);
        if (value < 2 ** 32) {
          const after = [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256);
          expect(ipAllowed(after.join("."), [network])).toBe(false);
        }
      }),
    );
  });

  it("matches IPv6 ranges the same way", () => {
    fc.assert(
      fc.property(fc.ipV6(), fc.integer({ min: 1, max: 128 }), (address, prefix) => {
        const range = parseIpRange(`${address}/${prefix}`);
        // Mapped IPv4 is written as IPv4 instead.
        if (!range.ok) return;
        const bytes = parseIp(address) as Uint8Array;
        expect(rangeContains(range.value, bytes)).toBe(true);
      }),
    );
  });
});

describe("whether one allowlist covers another", () => {
  it.each([
    [["192.0.2.0/25"], ["192.0.2.0/24"], true],
    [["192.0.2.0/24"], ["192.0.2.0/25"], false],
    [["192.0.2.0/24", "2001:db8::/48"], ["192.0.0.0/16", "2001:db8::/32"], true],
    [["192.0.2.0/24"], ["2001:db8::/32"], false],
  ])("%j inside %j: %s", (narrower, wider, covered) => {
    expect(rangesCovered(narrower, wider)).toBe(covered);
  });

  it("refuses a stored range that does not parse", () => {
    expect(() => compileIpRanges(["nope"])).toThrow();
  });
});

function rangeArbitrary(): fc.Arbitrary<string> {
  return fc.oneof(
    fc.tuple(fc.ipV4(), fc.integer({ min: 1, max: 32 })).map(([ip, p]) => `${ip}/${p}`),
    fc.tuple(fc.ipV6(), fc.integer({ min: 1, max: 128 })).map(([ip, p]) => `${ip}/${p}`),
    fc.ipV4(),
  );
}
