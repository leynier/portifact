// IPv4 and IPv6 addresses and CIDR ranges for a workspace's network allowlists (decision 0020).
// Pure: parsing, normalizing and matching. The parser is strict on purpose, because an allowlist
// that reads an ambiguous entry differently from its admin admits the wrong network:
// - IPv4 is four decimal parts from 0 to 255 without leading zeros (`010` could mean octal).
// - IPv6 is RFC 4291 text (hex groups, one `::`, an IPv4 tail), without a zone ID (`%eth0`
//   names an interface on one machine, never a network).
// - A range's prefix is a decimal length without leading zeros; `/0` (every address) is refused.
// - An IPv4-mapped IPv6 address (`::ffff:192.0.2.1`) is the IPv4 address it maps: a client that
//   arrives with one is matched as IPv4, and a range written that way is refused with a hint to
//   write it as IPv4, so one network never has two spellings in a list.
import { fail, ok, type Result } from "./result.ts";

/** An address: 4 bytes for IPv4, 16 for IPv6. */
export type IpBytes = Uint8Array;

/** A range: the network address (host bits zero) and the prefix length. */
export interface IpRange {
  bytes: IpBytes;
  prefix: number;
}

const V4_PART = /^(0|[1-9][0-9]{0,2})$/;
const V6_GROUP = /^[0-9a-fA-F]{1,4}$/;
const PREFIX = /^(0|[1-9][0-9]{0,2})$/;

function parseV4(text: string): IpBytes | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (const [i, part] of parts.entries()) {
    if (!V4_PART.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes[i] = value;
  }
  return bytes;
}

/** The 16-bit groups of one side of an address; only the address's last part may be IPv4. */
function groupsOf(text: string, v4Tail: boolean): number[] | null {
  if (text === "") return [];
  const groups: number[] = [];
  const parts = text.split(":");
  for (const [i, part] of parts.entries()) {
    if (v4Tail && i === parts.length - 1 && part.includes(".")) {
      const v4 = parseV4(part);
      if (!v4) return null;
      groups.push(((v4[0] as number) << 8) | (v4[1] as number));
      groups.push(((v4[2] as number) << 8) | (v4[3] as number));
      continue;
    }
    if (!V6_GROUP.test(part)) return null;
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
}

function parseV6(text: string): IpBytes | null {
  if (text.includes("%")) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  let groups: number[];
  if (halves.length === 2) {
    const head = groupsOf(halves[0] as string, false);
    const tail = groupsOf(halves[1] as string, true);
    if (!head || !tail) return null;
    // `::` stands for at least one group of zeros.
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  } else {
    const all = groupsOf(text, true);
    if (!all || all.length !== 8) return null;
    groups = all;
  }
  const bytes = new Uint8Array(16);
  for (const [i, group] of groups.entries()) {
    bytes[i * 2] = group >> 8;
    bytes[i * 2 + 1] = group & 0xff;
  }
  return bytes;
}

/** Whether a 16-byte address is IPv4-mapped (`::ffff:0:0/96`). */
function isMapped(bytes: IpBytes): boolean {
  if (bytes.length !== 16) return false;
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return false;
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

/** Parses one address as written, IPv4 or IPv6; null for anything else. Mapped stays IPv6. */
export function parseIp(text: string): IpBytes | null {
  if (text.length === 0 || text.length > 45) return null;
  return text.includes(":") ? parseV6(text) : parseV4(text);
}

/**
 * A client's address, as the allowlists match it: an IPv4-mapped IPv6 address becomes its IPv4
 * address. Null for anything that is not an address (including a zone ID).
 */
export function clientIp(text: string | null): IpBytes | null {
  if (text === null) return null;
  const bytes = parseIp(text.trim());
  if (!bytes) return null;
  return isMapped(bytes) ? bytes.slice(12) : bytes;
}

function masked(bytes: IpBytes, prefix: number): IpBytes {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const bits = Math.max(0, Math.min(8, prefix - i * 8));
    out[i] = (bytes[i] as number) & ((0xff << (8 - bits)) & 0xff);
  }
  return out;
}

/** Parses one range (`192.0.2.0/24`, `2001:db8::/32`, or one address as /32 or /128). */
export function parseIpRange(written: string): Result<IpRange> {
  const text = written.trim();
  const bad = () =>
    fail<never>(
      "invalid_input",
      `${written} is not an IP address or range. Write it like 192.0.2.0/24 or 2001:db8::/32.`,
    );
  const slash = text.indexOf("/");
  const address = slash === -1 ? text : text.slice(0, slash);
  const bytes = parseIp(address);
  if (!bytes) return bad();
  if (isMapped(bytes)) {
    return fail(
      "invalid_input",
      `${written} is an IPv4 address written as IPv6. Write it as IPv4, like 192.0.2.0/24.`,
    );
  }
  const bits = bytes.length * 8;
  let prefix = bits;
  if (slash !== -1) {
    const length = text.slice(slash + 1);
    if (!PREFIX.test(length)) return bad();
    prefix = Number(length);
    if (prefix > bits) return bad();
  }
  if (prefix === 0) {
    return fail("invalid_input", `${written} admits every address. Name your own networks.`);
  }
  return ok({ bytes: masked(bytes, prefix), prefix });
}

function v6Text(bytes: IpBytes): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2)
    groups.push(((bytes[i] as number) << 8) | (bytes[i + 1] as number));
  // RFC 5952: the longest run of two or more zero groups becomes `::`, the first on a tie.
  let best = -1;
  let bestLength = 1;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLength) {
      best = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = (list: number[]) => list.map((group) => group.toString(16)).join(":");
  if (best === -1) return hex(groups);
  return `${hex(groups.slice(0, best))}::${hex(groups.slice(best + bestLength))}`;
}

/** An address in its canonical text: dotted IPv4, or RFC 5952 IPv6. */
export function ipText(bytes: IpBytes): string {
  return bytes.length === 4 ? [...bytes].join(".") : v6Text(bytes);
}

/** A range in its canonical text, always with its prefix (`192.0.2.7/32`). */
export function rangeText(range: IpRange): string {
  return `${ipText(range.bytes)}/${range.prefix}`;
}

/** Whether `ip` (as `clientIp` returns it) is inside `range`. */
export function rangeContains(range: IpRange, ip: IpBytes): boolean {
  if (ip.length !== range.bytes.length) return false;
  const net = masked(ip, range.prefix);
  return net.every((byte, i) => byte === range.bytes[i]);
}

/** Whether `inner` lies entirely inside `outer`. */
export function rangeCovers(outer: IpRange, inner: IpRange): boolean {
  return (
    outer.bytes.length === inner.bytes.length &&
    outer.prefix <= inner.prefix &&
    rangeContains(outer, inner.bytes)
  );
}

function compareRanges(a: IpRange, b: IpRange): number {
  if (a.bytes.length !== b.bytes.length) return a.bytes.length - b.bytes.length;
  for (let i = 0; i < a.bytes.length; i++) {
    const diff = (a.bytes[i] as number) - (b.bytes[i] as number);
    if (diff !== 0) return diff;
  }
  return a.prefix - b.prefix;
}

/**
 * An allowlist as an admin wrote it, normalized: each range parsed with its host bits cleared,
 * ranges inside another one dropped (CIDR ranges either nest or do not overlap), and the rest
 * sorted, IPv4 first. The first entry that does not parse is named in the error.
 */
export function normalizeIpRanges(written: readonly string[]): Result<string[]> {
  const ranges: IpRange[] = [];
  for (const entry of written) {
    const range = parseIpRange(entry);
    if (!range.ok) return range;
    ranges.push(range.value);
  }
  ranges.sort(compareRanges);
  const kept: IpRange[] = [];
  for (const range of ranges) {
    if (!kept.some((outer) => rangeCovers(outer, range))) kept.push(range);
  }
  return ok(kept.map(rangeText));
}

/** Stored (normalized) ranges, parsed once for matching; throws on one that does not parse. */
export function compileIpRanges(stored: readonly string[]): IpRange[] {
  const ranges = readIpRanges(stored);
  if (!ranges) throw new Error("A stored IP range does not parse");
  return ranges;
}

/**
 * Stored ranges parsed for matching, or null when any of them does not parse. Enforcement uses
 * this, never `compileIpRanges`: a list that a corrupted row or a hand-edited restore put in the
 * database must refuse (fail closed), never throw (decision 0020).
 */
export function readIpRanges(stored: readonly string[]): IpRange[] | null {
  const ranges: IpRange[] = [];
  for (const text of stored) {
    if (typeof text !== "string") return null;
    const range = parseIpRange(text);
    if (!range.ok) return null;
    ranges.push(range.value);
  }
  return ranges;
}

/** What an allowlist says about an address: admitted, refused, or unreadable (refused too). */
export type NetworkVerdict = "allowed" | "refused" | "unreadable";

export function networkVerdict(stored: readonly string[], ip: string | null): NetworkVerdict {
  const ranges = readIpRanges(stored);
  if (!ranges) return "unreadable";
  return ipAllowed(ip, ranges) ? "allowed" : "refused";
}

export type IpFamily = "ipv4" | "ipv6";

/**
 * The one address family a list covers, or null when it names both. A list of only IPv4 (or
 * only IPv6) ranges refuses everyone whose network also speaks the other family as soon as a
 * request arrives over it, which on a dual-stack network the browser decides per connection.
 */
export function singleFamily(stored: readonly string[]): IpFamily | null {
  const ranges = readIpRanges(stored);
  if (!ranges || ranges.length === 0) return null;
  const v4 = ranges.some((range) => range.bytes.length === 4);
  const v6 = ranges.some((range) => range.bytes.length === 16);
  if (v4 && v6) return null;
  return v4 ? "ipv4" : "ipv6";
}

/** Whether a client's address is in an allowlist. No address (or an unreadable one) never is. */
export function ipAllowed(ip: string | null, ranges: readonly IpRange[]): boolean {
  const bytes = clientIp(ip);
  return bytes !== null && ranges.some((range) => rangeContains(range, bytes));
}

/**
 * Whether every range of `narrower` lies inside some range of `wider`. An unreadable `narrower`
 * admitted nobody, so anything covers it; an unreadable `wider` covers nothing.
 */
export function rangesCovered(narrower: readonly string[], wider: readonly string[]): boolean {
  const inner = readIpRanges(narrower);
  if (!inner) return true;
  const outer = readIpRanges(wider);
  if (!outer) return false;
  return inner.every((range) => outer.some((o) => rangeCovers(o, range)));
}
