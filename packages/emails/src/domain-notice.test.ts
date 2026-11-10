import { LOCALE_CODES } from "@portifact/contracts/locales";
import { describe, expect, it } from "vitest";
import { DOMAIN_NOTICE_TEXT, domainNoticeEmail } from "./domain-notice.ts";

const DETACH = Date.UTC(2026, 10, 17, 12, 0, 0);
const USAGE = "https://app.portifact.com/usage";

describe("the downgrade notice for custom domains", () => {
  it("lists the hostnames, when they stop and where to see the plan", () => {
    const email = domainNoticeEmail({
      hostnames: ["docs.example.com", "handbook.example.com"],
      detachAt: DETACH,
      limit: 1,
      usageUrl: USAGE,
    });
    expect(email.subject).toBe("2 of your custom domains will stop soon");
    expect(email.text).toContain(
      "the plan you have now includes 1 custom domain. Unless the plan is renewed, these stop serving your artifacts on Tue, Nov 17, 2026, 12:00 UTC:",
    );
    expect(email.text).toContain("- docs.example.com\n- handbook.example.com");
    expect(email.text).toContain(`See your plan: ${USAGE}`);
    expect(email.text).toContain("Your artifacts keep their Portifact addresses");
    expect(email.html).toContain(`href="${USAGE}"`);
    expect(email.html).toContain("<strong");
    expect(email.html).toContain("handbook.example.com");
  });

  it("says one domain in the singular and zero domains in the plural", () => {
    const email = domainNoticeEmail({
      hostnames: ["docs.example.com"],
      detachAt: DETACH,
      limit: 0,
      usageUrl: USAGE,
    });
    expect(email.subject).toBe("Your custom domain will stop soon");
    expect(email.text.startsWith("A custom domain will stop soon\n")).toBe(true);
    expect(email.text).toContain("includes 0 custom domains");
  });

  it("escapes what it shows and keeps the subject free of hostnames", () => {
    const email = domainNoticeEmail({
      hostnames: ["<b>docs</b>.example.com"],
      detachAt: DETACH,
      limit: 0,
      usageUrl: USAGE,
    });
    expect(email.html).not.toContain("<b>docs</b>");
    expect(email.subject).not.toContain("docs");
  });

  it.each(LOCALE_CODES)("is written in %s", (locale) => {
    const email = domainNoticeEmail({
      hostnames: ["docs.example.com"],
      detachAt: DETACH,
      limit: 0,
      usageUrl: USAGE,
      locale,
    });
    const t = DOMAIN_NOTICE_TEXT[locale];
    expect(email.subject).toBe(t.subject(1));
    expect(email.html).toContain(`lang="${locale}"`);
    expect(email.text).toContain(t.keep);
    expect(email.text).toContain("docs.example.com");
    expect(email.subject).not.toMatch(/—/);
    expect(t.subject(3)).not.toBe(t.subject(1));
  });
});
