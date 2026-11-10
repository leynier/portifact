import { WORKSPACE_DOMAINS } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  CONSUMER_MAIL_DOMAINS,
  checkEmailDomainAllowed,
  checksBeforeRemoval,
  DOMAIN_MESSAGES,
  displayDomain,
  domainClaimExpiry,
  domainRecord,
  emailDomainOf,
  normalizeEmailDomain,
  type PublicSuffixLookup,
  recheckDueBefore,
  recheckOutcome,
  recordHolds,
} from "./email-domains.ts";

/** A tiny stand-in for the Public Suffix List, enough for the rules. */
const SUFFIXES: Record<string, { icann: boolean; private: boolean }> = {
  com: { icann: true, private: false },
  example: { icann: true, private: false },
  "co.uk": { icann: true, private: false },
  uk: { icann: true, private: false },
  "github.io": { icann: false, private: true },
  "xn--p1ai": { icann: true, private: false },
};
const psl: PublicSuffixLookup = (domain) => {
  const labels = domain.split(".");
  for (let i = 0; i < labels.length; i++) {
    const suffix = labels.slice(i).join(".");
    const info = SUFFIXES[suffix];
    if (info) return { suffix, ...info };
  }
  return { suffix: labels.at(-1) ?? "", icann: false, private: false };
};

describe("normalizeEmailDomain", () => {
  it("lowercases, trims and converts internationalized names to their A-label", () => {
    expect(normalizeEmailDomain("  Acme.Example ")).toEqual({ ok: true, value: "acme.example" });
    expect(normalizeEmailDomain("BÜCHER.example")).toEqual({
      ok: true,
      value: "xn--bcher-kva.example",
    });
    expect(normalizeEmailDomain("xn--bcher-kva.example")).toEqual({
      ok: true,
      value: "xn--bcher-kva.example",
    });
  });

  const M = DOMAIN_MESSAGES;
  const refusals: [string, string][] = [
    ["", M.onlyDomain],
    [" ", M.onlyDomain],
    ["acme.example.", M.finalDot],
    [".acme.example", M.invalid],
    ["localhost", M.twoLabels],
    ["Localhost", M.twoLabels],
    ["1.2.3.4", M.address],
    ["0x7f.1", M.address],
    ["127.1", M.address],
    ["acme.123", M.invalid],
    ["[::1]", M.onlyDomain],
    ["*.acme.example", M.onlyDomain],
    ["a@acme.example", M.onlyDomain],
    ["https://acme.example", M.onlyDomain],
    ["acme.example/path", M.onlyDomain],
    ["acme example", M.onlyDomain],
    ["acme.example:443", M.onlyDomain],
    ["ac%6de.example", M.onlyDomain],
    ["a\\b.example", M.onlyDomain],
    ["a?b.example", M.onlyDomain],
    ["a#b.example", M.onlyDomain],
    ["-acme.example", M.invalid],
    ["acme-.example", M.invalid],
    ["a..example", M.invalid],
    ["a_b.example", M.invalid],
    [`${"a".repeat(64)}.example`, M.invalid],
    [`${"a.".repeat(126)}ab`, M.invalid],
    // Short as typed, longer than 253 once each label becomes its A-label.
    [Array.from({ length: 6 }, () => "ü".repeat(40)).join("."), M.invalid],
  ];
  for (const [bad, message] of refusals) {
    it(`refuses ${JSON.stringify(bad.slice(0, 30))} saying why`, () => {
      expect(normalizeEmailDomain(bad)).toEqual({ ok: false, code: "invalid_input", message });
    });
  }

  it("accepts the longest labels and names", () => {
    const longest = `${"a".repeat(63)}.example`;
    expect(normalizeEmailDomain(longest)).toEqual({ ok: true, value: longest });
    const name = `${"a.".repeat(125)}abc`;
    expect(name).toHaveLength(253);
    expect(normalizeEmailDomain(name)).toEqual({ ok: true, value: name });
    expect(normalizeEmailDomain("a.b")).toEqual({ ok: true, value: "a.b" });
    expect(normalizeEmailDomain("a1-b.c2")).toEqual({ ok: true, value: "a1-b.c2" });
  });
});

describe("displayDomain", () => {
  it("keeps the Unicode form the admin typed, only when it differs", () => {
    expect(displayDomain("Bücher.example", "xn--bcher-kva.example")).toBe("bücher.example");
    expect(displayDomain("acme.example", "acme.example")).toBeNull();
    expect(displayDomain("xn--bcher-kva.example", "xn--bcher-kva.example")).toBeNull();
    expect(displayDomain("not a domain", "acme.example")).toBeNull();
    expect(displayDomain("  Bu\u0308cher.example ", "xn--bcher-kva.example")).toBe(
      "bücher.example",
    );
  });
});

describe("emailDomainOf", () => {
  it("takes the normalized text after the last @", () => {
    expect(emailDomainOf("Ana@ACME.example")).toBe("acme.example");
    expect(emailDomainOf('"a@b"@acme.example')).toBe("acme.example");
    expect(emailDomainOf("ida@xn--bcher-kva.example")).toBe("xn--bcher-kva.example");
  });

  it("matches only a domain written in plain ASCII, so no other spelling maps onto it", () => {
    // The host parser folds all of these to `acme.com`. A mailbox was proven for the address as
    // written, not for the domain it folds to, so none of them counts as an address at acme.com.
    for (const spelled of [
      "a@\uFF41\uFF43\uFF4D\uFF45.com",
      "a@acme\u3002com",
      "a@ac\u00ADme.com",
      "a@acme\u200B.com",
      "a@ACME.\u217Dom",
      "ida@b\u00FCcher.example",
    ]) {
      expect(emailDomainOf(spelled), spelled).toBeNull();
    }
  });

  it("is null for addresses without a usable domain", () => {
    for (const bad of [
      "acme.example",
      "@acme.example",
      "ana@",
      "ana@acme.example.",
      "ana@[1.2.3.4]",
    ]) {
      expect(emailDomainOf(bad), bad).toBeNull();
    }
  });
});

describe("checkEmailDomainAllowed", () => {
  const allowed = (domain: string, own: string[] = []) => {
    const result = checkEmailDomainAllowed(domain, psl, own);
    if (result.ok) expect(result).toEqual({ ok: true, value: true });
    return result.ok;
  };

  it("accepts an organization's own domain and its subdomains", () => {
    expect(allowed("acme.com")).toBe(true);
    expect(allowed("eng.acme.com")).toBe(true);
    expect(allowed("acme.co.uk")).toBe(true);
    expect(allowed("xn--80ak6aa92e.xn--p1ai")).toBe(true);
  });

  const refused: [string, string][] = [
    ["gmail.com", "Public email providers"],
    ["mail.gmail.com", "Public email providers"],
    ["GMAIL.com".toLowerCase(), "Public email providers"],
    ["outlook.com", "Public email providers"],
    ["proton.me", "Public email providers"],
    ["co.uk", "Shared suffixes"],
    ["github.io", "Shared suffixes"],
    ["someone.github.io", "Shared suffixes"],
    ["com", "Shared suffixes"],
    ["acme.corp", "not under a known public suffix"],
    ["portifact.com", "Portifact's own"],
    ["team.portifact.dev", "Portifact's own"],
    ["portifact.test", "Portifact's own"],
    ["acme.local", "Reserved"],
    ["printer.home.arpa", "Reserved"],
    ["acme.localhost", "Reserved"],
    ["acme.test", "Reserved"],
    ["acme.invalid", "Reserved"],
    ["acme.internal", "Reserved"],
    ["hidden.onion", "Reserved"],
    ["acme.example", "Reserved"],
    ["host.arpa", "Reserved"],
    ["box.localdomain", "Reserved"],
  ];
  for (const [domain, message] of refused) {
    it(`refuses ${domain}`, () => {
      const result = checkEmailDomainAllowed(domain, psl, []);
      expect(result).toMatchObject({ ok: false, code: "invalid_input" });
      expect(result.ok ? "" : result.message).toContain(message);
    });
  }

  it("refuses every listed consumer domain, which is never a suffix of another entry by mistake", () => {
    for (const provider of CONSUMER_MAIL_DOMAINS) {
      expect(normalizeEmailDomain(provider)).toEqual({ ok: true, value: provider });
      expect(allowed(provider), provider).toBe(false);
    }
    expect(new Set(CONSUMER_MAIL_DOMAINS).size).toBe(CONSUMER_MAIL_DOMAINS.length);
  });

  it("refuses the deployment's own hosts, matched as a parent only", () => {
    expect(allowed("docs.staging.com", ["staging.com"])).toBe(false);
    expect(allowed("staging.com", ["Staging.Com"])).toBe(false);
    expect(allowed("notstaging.com", ["staging.com"])).toBe(true);
  });

  it("does not take a look-alike for a provider", () => {
    expect(allowed("gmail.com.acme.com")).toBe(true);
    expect(allowed("xgmail.com")).toBe(true);
  });

  it("refuses a domain the suffix list cannot place", () => {
    expect(checkEmailDomainAllowed("acme.com", () => null, [])).toMatchObject({ ok: false });
    expect(checkEmailDomainAllowed("acme.com", psl, [])).toEqual({ ok: true, value: true });
  });
});

describe("the TXT proof", () => {
  const token = "0123456789abcdef0123456789abcdef";

  it("names its own record, apart from custom domains' _portifact", () => {
    expect(domainRecord("acme.example", token)).toEqual({
      name: "_portifact-email.acme.example",
      value: `portifact-email-verify=${token}`,
    });
  });

  it("holds only for this claim's exact token", () => {
    expect(recordHolds([`portifact-email-verify=${token}`], token)).toBe(true);
    expect(recordHolds(["v=spf1 -all", ` portifact-email-verify=${token} `], token)).toBe(true);
    expect(recordHolds([`portifact-email-verify=${token}x`], token)).toBe(false);
    expect(recordHolds([`portifact-verify=${token}`], token)).toBe(false);
    expect(recordHolds([token], token)).toBe(false);
    expect(recordHolds([], token)).toBe(false);
  });

  it("gives a claim seven days", () => {
    expect(domainClaimExpiry(1_000)).toBe(1_000 + WORKSPACE_DOMAINS.claimTtlDays * 86_400_000);
    expect(recheckDueBefore(100 * 3_600_000)).toBe(76 * 3_600_000);
  });
});

describe("re-checks", () => {
  it("resets on a found record and removes at the third miss in a row", () => {
    expect(recheckOutcome(2, true)).toEqual({ kind: "ok" });
    expect(recheckOutcome(0, false)).toEqual({ kind: "missed", failedChecks: 1 });
    expect(recheckOutcome(1, false)).toEqual({ kind: "missed", failedChecks: 2 });
    expect(recheckOutcome(2, false)).toEqual({ kind: "remove" });
    expect(checksBeforeRemoval(0)).toBe(3);
    expect(checksBeforeRemoval(2)).toBe(1);
    expect(checksBeforeRemoval(5)).toBe(0);
  });
});
