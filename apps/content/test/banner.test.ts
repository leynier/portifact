// The review tab's banner in every language: picked from the browser's languages, marked with its
// own `lang`, escaped, and following the writing style.
import { LOCALE_CODES, localeInfo } from "@portifact/contracts/locales";
import { describe, expect, it } from "vitest";
import { BANNER_TEXT, bannerLocale, REVIEW_END_HREF, reviewBanner } from "../src/inject.ts";

describe("bannerLocale", () => {
  it("takes the browser's first supported language, then English", () => {
    expect(bannerLocale("ja-JP,ja;q=0.9,en;q=0.8")).toBe("ja");
    expect(bannerLocale("pt;q=0.9,xx")).toBe("pt-BR");
    expect(bannerLocale("zh-CN")).toBe("zh-CN");
    expect(bannerLocale("ru;q=0,de;q=0.5")).toBe("de");
    expect(bannerLocale("zh-TW")).toBe("en");
    expect(bannerLocale("xx")).toBe("en");
    expect(bannerLocale(null)).toBe("en");
  });
});

describe.each(LOCALE_CODES)("the banner in %s", (locale) => {
  const text = BANNER_TEXT[locale];
  const html = reviewBanner(15, locale);

  it("carries its language and direction, and the end link in that language", () => {
    expect(html).toContain(`lang="${locale}" dir="${localeInfo(locale).dir}"`);
    expect(html).toContain(`<a href="${REVIEW_END_HREF}">${text.end}</a>`);
    expect(html).toContain(`aria-label="${text.region}"`);
    expect(html).toContain("15");
  });

  it("is translated and follows the writing style", () => {
    for (const value of [text.region, text.lead, text.body(15), text.end]) {
      expect(value.trim()).not.toBe("");
      expect(value).not.toMatch(/[—–<>"&]/);
    }
    expect(text.end).not.toMatch(/[.。]$/);
    if (locale !== "en") expect(text.body(15)).not.toBe(BANNER_TEXT.en.body(15));
  });

  it("leaves no space after a full-width full stop", () => {
    expect(html).not.toMatch(/。 /);
  });
});
