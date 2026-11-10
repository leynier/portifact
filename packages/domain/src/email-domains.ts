// Verified email domains of a workspace (premium plan T2, decision 0010): which names may be
// claimed, how they and the addresses matched against them are normalized, the TXT record that
// proves a claim and what a re-check does. Pure; the Public Suffix List lookup is injected by the
// services so this package stays free of it.
import { WORKSPACE_DOMAINS } from "@portifact/contracts";
import { fail, ok, type Result } from "./result.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Well-known consumer mail domains, matched exactly and as a parent. A denylist, so never
 * complete: it catches the obvious mistakes, and the TXT proof stays the boundary (only a
 * domain's DNS operator can publish the record).
 */
export const CONSUMER_MAIL_DOMAINS: readonly string[] = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.co.uk",
  "hotmail.fr",
  "hotmail.es",
  "hotmail.it",
  "hotmail.de",
  "live.com",
  "live.co.uk",
  "live.fr",
  "msn.com",
  "passport.com",
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.co.jp",
  "yahoo.fr",
  "yahoo.es",
  "yahoo.de",
  "yahoo.it",
  "yahoo.com.br",
  "yahoo.com.mx",
  "yahoo.com.ar",
  "ymail.com",
  "rocketmail.com",
  "aol.com",
  "aim.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "protonmail.ch",
  "pm.me",
  "tutanota.com",
  "tutanota.de",
  "tuta.io",
  "tuta.com",
  "gmx.com",
  "gmx.net",
  "gmx.de",
  "gmx.at",
  "gmx.ch",
  "web.de",
  "mail.com",
  "email.com",
  "zoho.com",
  "zohomail.com",
  "yandex.com",
  "yandex.ru",
  "ya.ru",
  "mail.ru",
  "inbox.ru",
  "list.ru",
  "bk.ru",
  "rambler.ru",
  "qq.com",
  "foxmail.com",
  "163.com",
  "126.com",
  "yeah.net",
  "sina.com",
  "sohu.com",
  "aliyun.com",
  "naver.com",
  "daum.net",
  "hanmail.net",
  "fastmail.com",
  "fastmail.fm",
  "hey.com",
  "duck.com",
  "mailbox.org",
  "posteo.de",
  "posteo.net",
  "hushmail.com",
  "orange.fr",
  "wanadoo.fr",
  "free.fr",
  "laposte.net",
  "sfr.fr",
  "libero.it",
  "virgilio.it",
  "tiscali.it",
  "t-online.de",
  "freenet.de",
  "seznam.cz",
  "wp.pl",
  "o2.pl",
  "onet.pl",
  "interia.pl",
  "terra.com.br",
  "uol.com.br",
  "bol.com.br",
  "rediffmail.com",
  "comcast.net",
  "verizon.net",
  "att.net",
  "sbcglobal.net",
  "bellsouth.net",
  "cox.net",
  "charter.net",
  "earthlink.net",
  "btinternet.com",
  "sky.com",
  "virginmedia.com",
  "ntlworld.com",
  "bigpond.com",
  "optusnet.com.au",
  "shaw.ca",
  "rogers.com",
  "sympatico.ca",
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "temp-mail.org",
];

/** Suffixes that never name an organization's public mail. */
const RESERVED_SUFFIXES: readonly string[] = [
  "local",
  "localhost",
  "internal",
  "test",
  "example",
  "invalid",
  "arpa",
  "onion",
  "home.arpa",
  "localdomain",
];

/** Portifact's own domains; the deployment adds its app and content domains. */
export const PORTIFACT_DOMAINS: readonly string[] = [
  "portifact.com",
  "portifact.dev",
  "portifact.test",
];

/** Where a domain sits in the Public Suffix List, as `tldts` reports it. */
export interface PublicSuffixInfo {
  /** The longest public suffix of the domain (`co.uk`, `github.io`, `com`). */
  suffix: string;
  /** The suffix is in the list's ICANN section. */
  icann: boolean;
  /** The suffix is in the list's private section: a platform hands out names under it. */
  private: boolean;
}

export type PublicSuffixLookup = (domain: string) => PublicSuffixInfo | null;

const invalid = (message: string) => fail<never>("invalid_input", message);

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** One run of characters a host name may have before the URL parser reads it. */
const HOST_TEXT = /^[^\s@/\\:?#*[\]%]+$/;

export const DOMAIN_MESSAGES = {
  finalDot: "Enter the domain without a final dot.",
  onlyDomain: "Enter only the domain, like example.com.",
  invalid: "That is not a valid domain.",
  address: "Enter a domain name, not an IP address.",
  twoLabels: "Enter a domain with a dot, like example.com.",
} as const;

/**
 * A domain as it is stored and matched: lowercase A-label (`xn--…` for internationalized names,
 * by the WHATWG URL host parser, UTS 46), at least two labels of at most 63 characters, at most
 * 253 characters, no trailing dot, no IP literal and no wildcard.
 */
export function normalizeEmailDomain(input: string): Result<string> {
  const text = input.trim();
  if (text.endsWith(".")) return invalid(DOMAIN_MESSAGES.finalDot);
  if (!HOST_TEXT.test(text)) return invalid(DOMAIN_MESSAGES.onlyDomain);
  let host: string;
  try {
    host = new URL(`http://${text}/`).hostname;
  } catch {
    return invalid(DOMAIN_MESSAGES.invalid);
  }
  const labels = host.split(".");
  // The parser turns every IPv4 spelling (`0x7f.1`, `127.1`) into dotted digits.
  if (/^[0-9]+$/.test(labels.at(-1) ?? "")) return invalid(DOMAIN_MESSAGES.address);
  if (labels.length < 2) return invalid(DOMAIN_MESSAGES.twoLabels);
  if (host.length > 253 || !labels.every((label) => LABEL.test(label))) {
    return invalid(DOMAIN_MESSAGES.invalid);
  }
  return ok(host);
}

/**
 * The Unicode form to show next to a stored A-label, from what the admin typed: their input when
 * it normalizes to the same domain and differs from it, null otherwise.
 */
export function displayDomain(input: string, domain: string): string | null {
  const typed = input.trim().toLowerCase().normalize("NFC");
  return typed !== domain && normalizeEmailDomain(typed).ok ? typed : null;
}

const ASCII_DOMAIN = /^[A-Za-z0-9.-]+$/;

/**
 * The domain of an email address, for matching a workspace's verified domains, or null. Only a
 * domain written in plain ASCII counts, compared without case: the host parser also folds other
 * spellings (full-width letters, an ideographic full stop, a soft hyphen) onto the same name, but
 * the mailbox was proven for the address as written, not for the name it folds to. An address at
 * an internationalized domain therefore matches only in its ASCII (`xn--`) form.
 */
export function emailDomainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0) return null;
  const written = email.slice(at + 1);
  if (!ASCII_DOMAIN.test(written)) return null;
  const domain = normalizeEmailDomain(written);
  return domain.ok && domain.value === written.toLowerCase() ? domain.value : null;
}

function isOrUnder(domain: string, parent: string): boolean {
  return domain === parent || domain.endsWith(`.${parent}`);
}

/**
 * Whether a normalized domain may be claimed. Refused: Portifact's own domains and `ownHosts` and
 * their subdomains, reserved suffixes, consumer mail domains and their subdomains, a public suffix
 * itself, anything under a private-section suffix (shared hosting), and a suffix the list does not
 * know.
 */
export function checkEmailDomainAllowed(
  domain: string,
  publicSuffix: PublicSuffixLookup,
  ownHosts: readonly string[],
): Result<true> {
  if ([...PORTIFACT_DOMAINS, ...ownHosts].some((own) => isOrUnder(domain, own.toLowerCase()))) {
    return invalid("Portifact's own domains cannot be verified.");
  }
  if (RESERVED_SUFFIXES.some((suffix) => isOrUnder(domain, suffix))) {
    return invalid("Reserved and internal domains cannot be verified.");
  }
  if (CONSUMER_MAIL_DOMAINS.some((provider) => isOrUnder(domain, provider))) {
    return invalid(
      "Public email providers cannot be verified: anyone can get an address there. Use your organization's own domain.",
    );
  }
  const info = publicSuffix(domain);
  if (!info || (!info.icann && !info.private)) {
    return invalid("That domain is not under a known public suffix.");
  }
  if (info.suffix === domain || info.private) {
    return invalid(
      "Shared suffixes cannot be verified: names under them belong to many different people. Use your organization's own domain.",
    );
  }
  return ok(true);
}

/** The TXT record that proves a claim: its name and exact value. */
export function domainRecord(domain: string, token: string): { name: string; value: string } {
  return {
    name: `${WORKSPACE_DOMAINS.recordLabel}.${domain}`,
    value: `${WORKSPACE_DOMAINS.recordPrefix}${token}`,
  };
}

/** Whether the TXT values hold this token's record, exactly. */
export function recordHolds(values: readonly string[], token: string): boolean {
  const expected = `${WORKSPACE_DOMAINS.recordPrefix}${token}`;
  return values.some((value) => value.trim() === expected);
}

/** When a claim made at `now` is dropped. */
export function domainClaimExpiry(now: number): number {
  return now + WORKSPACE_DOMAINS.claimTtlDays * DAY_MS;
}

/** Verified domains last checked before this are due for a re-check. */
export function recheckDueBefore(now: number): number {
  return now - WORKSPACE_DOMAINS.recheckHours * HOUR_MS;
}

export type RecheckOutcome =
  | { kind: "ok" }
  | { kind: "missed"; failedChecks: number }
  | { kind: "remove" };

/** What a re-check does: a found record resets the count, the last allowed miss removes it. */
export function recheckOutcome(failedChecks: number, found: boolean): RecheckOutcome {
  if (found) return { kind: "ok" };
  const next = failedChecks + 1;
  if (next >= WORKSPACE_DOMAINS.maxFailedChecks) return { kind: "remove" };
  return { kind: "missed", failedChecks: next };
}

/** Misses left before a failing domain is removed. */
export function checksBeforeRemoval(failedChecks: number): number {
  return Math.max(0, WORKSPACE_DOMAINS.maxFailedChecks - failedChecks);
}
