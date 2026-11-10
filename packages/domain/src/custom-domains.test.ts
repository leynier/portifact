import { CUSTOM_DOMAINS, PLANS } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  canonicalLocation,
  checkDomainCount,
  checkProvenDomain,
  claimExpiry,
  classifyHost,
  devHost,
  domainLimit,
  domainLimitAt,
  domainNotice,
  domainsOverLimit,
  HOSTNAME_MESSAGES,
  handoffHost,
  holdsTxt,
  hostnameRefusal,
  isBlockedHostname,
  normalizeBlockName,
  normalizeHostname,
  provisioningExpired,
  recheckDue,
  viewerFrameOrigin,
} from "./custom-domains.ts";
import { entitlements } from "./plans.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 10, 12);

describe("normalizeHostname", () => {
  const accepted: [string, string][] = [
    ["docs.example.com", "docs.example.com"],
    ["  Docs.Example.COM  ", "docs.example.com"],
    ["docs.example.com.", "docs.example.com"],
    ["a.b.c.example.co.uk", "a.b.c.example.co.uk"],
    ["xn--bcher-kva.example.com", "xn--bcher-kva.example.com"],
    ["docs.bücher.example", "docs.xn--bcher-kva.example"],
    ["DOCS.ÉXAMPLE.com", "docs.xn--xample-9ua.com"],
    ["my-docs.example.com", "my-docs.example.com"],
    ["1docs.example.com", "1docs.example.com"],
    [`${"a".repeat(63)}.example.com`, `${"a".repeat(63)}.example.com`],
    // 253 characters: four labels of 63 and a final label of 1 (with the dots).
    [
      `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`,
      `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`,
    ],
  ];
  it.each(accepted)("accepts %j as %j", (input, expected) => {
    expect(normalizeHostname(input)).toEqual({ ok: true, value: expected });
  });

  const refused: [string, keyof typeof HOSTNAME_MESSAGES][] = [
    // Apex domains need apex proxying (an Enterprise add-on); single labels are internal names.
    ["example.com", "apex"],
    ["example.com.", "apex"],
    ["localhost", "apex"],
    ["intranet", "apex"],
    ["bücher.de", "apex"],
    // Wildcards in any form.
    ["*.example.com", "wildcard"],
    ["*example.com", "wildcard"],
    ["docs.*.example.com", "invalid"],
    // IP literals in the forms the URL parser turns into dotted digits.
    ["127.0.0.1", "ip_literal"],
    ["10.0.0.1.", "ip_literal"],
    ["0x7f.0.0.1", "ip_literal"],
    ["2130706433", "ip_literal"],
    ["1.2.3.4.5", "ip_literal"],
    ["[::1]", "ip_literal"],
    ["[2001:db8::1]", "ip_literal"],
    ["docs.example.123", "ip_literal"],
    // Portifact's own domains and anything under them, and lookalikes.
    ["portifact.com", "reserved"],
    ["app.portifact.com", "reserved"],
    ["abcdefghij.portifact.dev", "reserved"],
    ["domains.portifact.dev", "reserved"],
    ["x.portifact.test", "reserved"],
    ["APP.PORTIFACT.COM.", "reserved"],
    ["portifact.example.com", "lookalike"],
    ["login-portifact.example.com", "lookalike"],
    ["docs.myportifact.io", "lookalike"],
    // Not a bare hostname.
    ["", "invalid"],
    [".", "invalid"],
    ["https://docs.example.com", "invalid"],
    ["docs.example.com/path", "invalid"],
    ["docs.example.com:8443", "invalid"],
    ["user@docs.example.com", "invalid"],
    ["docs.example.com?x", "invalid"],
    ["docs.example.com#x", "invalid"],
    ["docs example.com", "invalid"],
    ["docs\\example.com", "invalid"],
    ["docs%2eexample.com", "invalid"],
    ["docs..example.com", "invalid"],
    ["-docs.example.com", "invalid"],
    ["docs-.example.com", "invalid"],
    ["docs_x.example.com", "invalid"],
    ["docs.example.com..", "invalid"],
    [`${"a".repeat(64)}.example.com`, "invalid"],
    [`${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}`, "too_long"],
  ];
  it.each(refused)("refuses %j (%s)", (input, error) => {
    expect(normalizeHostname(input)).toEqual({
      ok: false,
      code: "invalid_input",
      message: HOSTNAME_MESSAGES[error],
    });
  });

  it("reserves the deployment's content domain too", () => {
    expect(normalizeHostname("docs.staging-content.example", "staging-content.example")).toEqual({
      ok: false,
      code: "invalid_input",
      message: HOSTNAME_MESSAGES.reserved,
    });
    expect(normalizeHostname("docs.staging-content.example").ok).toBe(true);
  });
});

describe("classifyHost", () => {
  it("tells artifact hosts, custom hosts and nothing apart", () => {
    expect(classifyHost("abcdefghij.portifact.dev", "portifact.dev")).toEqual({
      kind: "artifact",
      artifactId: "abcdefghij",
    });
    expect(classifyHost("docs.example.com", "portifact.dev")).toEqual({
      kind: "custom",
      hostname: "docs.example.com",
    });
    for (const host of [
      "portifact.dev",
      "domains.portifact.dev",
      "a.abcdefghij.portifact.dev",
      "ABCDEFGHIJ.portifact.dev",
      "abcdefghi1.portifact.dev",
      "Docs.example.com",
      "docs.example.com.",
      "example.com",
      "127.0.0.1",
      "app.portifact.com",
    ]) {
      expect(classifyHost(host, "portifact.dev"), host).toEqual({ kind: "none" });
    }
  });
});

describe("plan limits", () => {
  it("allows the plan's count only with the feature", () => {
    expect(domainLimit(entitlements(null, NOW))).toBe(0);
    const pro = { plan: "pro" as const, seats: 1, validUntil: null, overrides: null };
    expect(domainLimit(entitlements(pro, NOW))).toBe(PLANS.pro.limits.customDomains);
    expect(domainLimit(entitlements({ ...pro, plan: "team" }, NOW))).toBe(5);
    // A count without the feature allows nothing.
    const counted = entitlements(
      { ...pro, plan: "free", overrides: { limits: { customDomains: 3 } } },
      NOW,
    );
    expect(counted.limits.customDomains).toBe(3);
    expect(domainLimit(counted)).toBe(0);
  });

  it("keeps an expired plan's domains for the grace period only", () => {
    const expired = {
      plan: "pro" as const,
      seats: 1,
      validUntil: NOW - 6 * DAY,
      overrides: null,
    };
    expect(domainLimit(entitlements(expired, domainLimitAt(NOW)))).toBe(1);
    expect(
      domainLimit(entitlements({ ...expired, validUntil: NOW - 7 * DAY }, domainLimitAt(NOW))),
    ).toBe(0);
    expect(domainLimitAt(NOW)).toBe(NOW - CUSTOM_DOMAINS.downgradeGraceDays * DAY);
  });

  it("checks the count", () => {
    expect(checkDomainCount(0, 1)).toEqual({ ok: true, value: null });
    expect(checkDomainCount(4, 5)).toEqual({ ok: true, value: null });
    expect(checkDomainCount(1, 1)).toEqual({
      ok: false,
      code: "quota_exceeded",
      message: "Your plan includes 1 custom domain. Remove one before adding another.",
    });
    expect(checkDomainCount(5, 5)).toMatchObject({
      message: "Your plan includes 5 custom domains. Remove one before adding another.",
    });
    expect(checkDomainCount(0, 0)).toMatchObject({ code: "quota_exceeded" });
  });

  it("detaches the newest domains past the limit", () => {
    const domains = [
      { hostname: "c.example.com", verifiedAt: 3 },
      { hostname: "a.example.com", verifiedAt: 1 },
      { hostname: "z.example.com", verifiedAt: 2 },
      { hostname: "b.example.com", verifiedAt: 2 },
    ];
    expect(domainsOverLimit(domains, 1)).toEqual([
      "b.example.com",
      "z.example.com",
      "c.example.com",
    ]);
    expect(domainsOverLimit(domains, 3)).toEqual(["c.example.com"]);
    expect(domainsOverLimit(domains, 4)).toEqual([]);
    expect(domainsOverLimit(domains, 0)).toHaveLength(4);
    expect(domainsOverLimit(domains, -1)).toHaveLength(4);
    // The input is not reordered.
    expect(domains[0]?.hostname).toBe("c.example.com");
  });
});

describe("the daily check", () => {
  it("resets misses when the record holds and counts them when it does not", () => {
    expect(checkProvenDomain({ missedChecks: 2, txt: "held", cloudflare: "active" })).toEqual({
      action: "keep",
      missedChecks: 0,
    });
    expect(checkProvenDomain({ missedChecks: 0, txt: "missing", cloudflare: "active" })).toEqual({
      action: "keep",
      missedChecks: 1,
    });
    expect(checkProvenDomain({ missedChecks: 1, txt: "missing", cloudflare: "pending" })).toEqual({
      action: "keep",
      missedChecks: 2,
    });
    expect(checkProvenDomain({ missedChecks: 2, txt: "missing", cloudflare: "active" })).toEqual({
      action: "detach",
      reason: "txt_lost",
    });
  });

  it("neither counts nor resets a check that could not reach DNS or Cloudflare", () => {
    expect(checkProvenDomain({ missedChecks: 2, txt: "unknown", cloudflare: "active" })).toEqual({
      action: "keep",
      missedChecks: 2,
    });
    expect(checkProvenDomain({ missedChecks: 1, txt: "held", cloudflare: "unknown" })).toEqual({
      action: "keep",
      missedChecks: 0,
    });
  });

  it.each(["moved", "deleted", "blocked", "missing"] as const)(
    "detaches a hostname Cloudflare reports %s",
    (cloudflare) => {
      expect(checkProvenDomain({ missedChecks: 0, txt: "held", cloudflare })).toEqual({
        action: "detach",
        reason: "cloudflare_gone",
      });
    },
  );

  it("is due once a day and gives provisioning a week", () => {
    expect(recheckDue(NOW - 24 * HOUR, NOW)).toBe(true);
    expect(recheckDue(NOW - 24 * HOUR + 1, NOW)).toBe(false);
    expect(provisioningExpired(NOW - 2 * DAY, NOW)).toBe(true);
    expect(provisioningExpired(NOW - 2 * DAY + 1, NOW)).toBe(false);
    expect(claimExpiry(NOW)).toBe(NOW + 7 * DAY);
  });

  it("matches the TXT value exactly", () => {
    expect(holdsTxt(["other", " portifact-verify=abc "], "portifact-verify=abc")).toBe(true);
    expect(holdsTxt(["portifact-verify=abcd"], "portifact-verify=abc")).toBe(false);
    expect(holdsTxt(["portifact-verify=ab"], "portifact-verify=abc")).toBe(false);
    expect(holdsTxt([], "portifact-verify=abc")).toBe(false);
  });
});

describe("the block list", () => {
  it("blocks a name and every name under it, never a lookalike suffix", () => {
    const blocked = ["evil.example", "bad.co.uk"];
    expect(isBlockedHostname("evil.example", blocked)).toBe(true);
    expect(isBlockedHostname("login.evil.example", blocked)).toBe(true);
    expect(isBlockedHostname("a.b.bad.co.uk", blocked)).toBe(true);
    expect(isBlockedHostname("notevil.example", blocked)).toBe(false);
    expect(isBlockedHostname("evil.example.org", blocked)).toBe(false);
    expect(isBlockedHostname("docs.example.com", [])).toBe(false);
    expect(hostnameRefusal("blocked")).toEqual({
      ok: false,
      code: "invalid_input",
      message: HOSTNAME_MESSAGES.blocked,
    });
    expect(hostnameRefusal("zone_apex")).toMatchObject({ message: HOSTNAME_MESSAGES.zone_apex });
  });

  it("normalizes names to block, apex domains included", () => {
    expect(normalizeBlockName(" Evil.Example. ")).toBe("evil.example");
    expect(normalizeBlockName("bücher.example")).toBe("xn--bcher-kva.example");
    expect(normalizeBlockName("a.b.c.example.co.uk")).toBe("a.b.c.example.co.uk");
    // A last label with digits is a name unless it is only digits.
    expect(normalizeBlockName("example.a1")).toBe("example.a1");
    expect(normalizeBlockName("example.1a")).toBe("example.1a");
    for (const bad of [
      "",
      "localhost",
      "https://x.example",
      "x.example/path",
      "1.2.3.4",
      "[::1]",
      "a..b",
      "-a.example",
      "*.example.com",
    ]) {
      expect(normalizeBlockName(bad), bad).toBeNull();
    }
  });
});

describe("where codes and frames may go", () => {
  const base = { artifactId: "abcdefghij", contentDomain: "portifact.dev" };

  it("sends a code to the `.dev` host or exactly the active custom host", () => {
    expect(devHost("abcdefghij", "portifact.dev")).toBe("abcdefghij.portifact.dev");
    expect(handoffHost({ ...base, requested: null, activeHost: "docs.example.com" })).toBe(
      "abcdefghij.portifact.dev",
    );
    expect(
      handoffHost({ ...base, requested: "docs.example.com", activeHost: "docs.example.com" }),
    ).toBe("docs.example.com");
    for (const requested of [
      "evil.example.com",
      "abcdefghij.portifact.dev",
      "DOCS.example.com",
      "",
    ]) {
      expect(
        handoffHost({ ...base, requested, activeHost: "docs.example.com" }),
        requested,
      ).toBeNull();
    }
    expect(handoffHost({ ...base, requested: "docs.example.com", activeHost: null })).toBeNull();
  });

  it("frames the custom host only for a visitor who may read", () => {
    expect(viewerFrameOrigin({ ...base, readable: true, activeHost: "docs.example.com" })).toBe(
      "https://docs.example.com",
    );
    expect(viewerFrameOrigin({ ...base, readable: false, activeHost: "docs.example.com" })).toBe(
      "https://abcdefghij.portifact.dev",
    );
    expect(viewerFrameOrigin({ ...base, readable: true, activeHost: null })).toBe(
      "https://abcdefghij.portifact.dev",
    );
  });
});

describe("the canonical redirect", () => {
  const visit = {
    onDevHost: true,
    customHost: "docs.example.com",
    bar: false,
    topLevelPage: true,
    review: false,
    link: false,
    pathAndQuery: "/guide/?x=1",
  };

  it("sends an old `.dev` page visit to the same path on the custom host", () => {
    expect(canonicalLocation(visit)).toBe("https://docs.example.com/guide/?x=1");
  });

  it.each([
    ["the custom host itself", { onDevHost: false }],
    ["no custom host", { customHost: null }],
    ["the bar on: the viewer wins", { bar: true }],
    ["frames, subresources and files", { topLevelPage: false }],
    ["review mode", { review: true }],
    ["a share link's session", { link: true }],
  ])("never for %s", (_label, change) => {
    expect(canonicalLocation({ ...visit, ...change })).toBeNull();
  });
});

describe("the downgrade notice", () => {
  const domains = [
    { hostname: "a.example.com", verifiedAt: 1, noticeFor: null },
    { hostname: "b.example.com", verifiedAt: 2, noticeFor: null },
  ];
  const ended = NOW - DAY;

  it("names the domains the end of the grace will detach, and when", () => {
    expect(domainNotice({ domains, limitNow: 1, limitInGrace: 5, validUntil: ended })).toEqual({
      hostnames: ["b.example.com"],
      detachAt: ended + 7 * DAY,
    });
    expect(domainNotice({ domains, limitNow: 0, limitInGrace: 2, validUntil: ended })).toEqual({
      hostnames: ["a.example.com", "b.example.com"],
      detachAt: ended + 7 * DAY,
    });
  });

  it("says nothing when nothing is at risk, outside the grace or once told", () => {
    expect(domainNotice({ domains, limitNow: 2, limitInGrace: 5, validUntil: ended })).toBeNull();
    expect(domainNotice({ domains, limitNow: 1, limitInGrace: 1, validUntil: ended })).toBeNull();
    expect(domainNotice({ domains, limitNow: 1, limitInGrace: 5, validUntil: null })).toBeNull();
    const told = domains.map((d) => ({ ...d, noticeFor: ended + 7 * DAY }));
    expect(
      domainNotice({ domains: told, limitNow: 1, limitInGrace: 5, validUntil: ended }),
    ).toBeNull();
    // A notice about another detach time does not count.
    const earlier = domains.map((d) => ({ ...d, noticeFor: ended }));
    expect(
      domainNotice({ domains: earlier, limitNow: 1, limitInGrace: 5, validUntil: ended }),
    ).not.toBeNull();
  });
});

describe("hostname messages", () => {
  it("say something different for every refusal", () => {
    const messages = Object.values(HOSTNAME_MESSAGES);
    expect(messages.every((message) => message.length > 20)).toBe(true);
    expect(new Set(messages).size).toBe(messages.length);
  });
});
