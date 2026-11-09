import { LOCALE_CODES } from "@portifact/contracts/locales";
import { type DefaultTreeAdapterMap, parse } from "parse5";
import { describe, expect, it } from "vitest";
import { budgetAlertEmail } from "./budget-alert.ts";
import { EXPIRY_TEXT, expiryNoticeEmail, formatExpiry } from "./expiry-notice.ts";
import { escapeHtml, renderEmail } from "./layout.ts";
import { previews } from "./previews.ts";
import { signInCodeEmail } from "./sign-in-code.ts";
import { DARK, FONT_SANS, fontSans, LIGHT } from "./theme.ts";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

/** Every element of the document a mail client's HTML parser would build. */
function elements(html: string): Element[] {
  const found: Element[] = [];
  const stack: Node[] = [parse(html)];
  while (stack.length > 0) {
    const node = stack.pop() as Node;
    if ("tagName" in node) found.push(node);
    if ("childNodes" in node) stack.push(...[...node.childNodes].reverse());
    if ("content" in node) stack.push(node.content as Node);
  }
  return found;
}

function textOf(node: Node): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  return "childNodes" in node ? node.childNodes.map(textOf).join("") : "";
}

const attr = (element: Element, name: string) => element.attrs.find((a) => a.name === name)?.value;

/** The visible text of the body: everything but the hidden preheader and the style block. */
function bodyText(html: string): string {
  const body = elements(html).find((e) => e.tagName === "body") as Element;
  const preheader = body.childNodes.find(
    (node) => "tagName" in node && node.tagName === "div",
  ) as Element;
  return textOf(body).replace(textOf(preheader), "").replace(/\s+/g, " ");
}

const code = signInCodeEmail({ email: "ada@example.com", code: "482913", expiresInMinutes: 5 });

describe("sign-in code email", () => {
  it("has a subject without the code, so notifications do not show it", () => {
    expect(code.subject).toBe("Your Portifact sign-in code");
    expect(code.subject).not.toContain("482913");
  });

  it("shows the code in one piece, the expiry and that it can be ignored", () => {
    const visible = bodyText(code.html);
    const codeCell = elements(code.html).find((e) => e.tagName === "p" && textOf(e) === "482913");
    expect(codeCell).toBeDefined();
    expect(attr(codeCell as Element, "style")).toContain("font-size: 36px");
    expect(visible).toContain("It expires in 5 minutes and works once.");
    expect(visible).toContain("If you did not try to sign in, you can ignore this email.");
    expect(visible).toContain("continue as ada@example.com.");
  });

  it("keeps the code out of the hidden preview text", () => {
    const preheader = elements(code.html).find(
      (e) => e.tagName === "div" && attr(e, "style")?.includes("display: none"),
    ) as Element;
    expect(textOf(preheader)).toContain("expires in 5 minutes");
    expect(textOf(preheader)).not.toContain("482913");
  });

  it("has a plain-text alternative with the same facts", () => {
    const lines = code.text.split("\n");
    expect(lines).toContain("482913");
    expect(code.text).toContain("It expires in 5 minutes and works once.");
    expect(code.text).toContain("you can ignore this email");
    expect(code.text).toContain("ada@example.com");
    expect(code.text).not.toMatch(/<[a-z]/i);
  });

  it("says minute in the singular for a one-minute code", () => {
    const short = signInCodeEmail({ email: "a@b.test", code: "111111", expiresInMinutes: 1 });
    expect(short.text).toContain("It expires in 1 minute and works once.");
  });

  it("escapes the address, so an odd one cannot inject markup", () => {
    const hostile = signInCodeEmail({
      email: '"<img src=x onerror=alert(1)>"@example.com',
      code: "123456",
      expiresInMinutes: 5,
    });
    const tags = elements(hostile.html).map((e) => e.tagName);
    // The layout's own images are the two hosted wordmarks; nothing else.
    expect(tags.filter((tag) => tag === "img")).toHaveLength(2);
    expect(elements(hostile.html).some((e) => attr(e, "onerror") !== undefined)).toBe(false);
    expect(bodyText(hostile.html)).toContain('"<img src=x onerror=alert(1)>"@example.com');
  });
});

describe("sign-in code email in Spanish", () => {
  const es = signInCodeEmail({
    email: "ada@example.com",
    code: "482913",
    expiresInMinutes: 5,
    locale: "es",
  });

  it("is written in Spanish, marked as Spanish, with the code kept out of the subject", () => {
    expect(es.subject).toBe("Tu código para iniciar sesión en Portifact");
    expect(es.subject).not.toContain("482913");
    expect(es.html).toContain('<html lang="es" dir="ltr">');
    expect(bodyText(es.html)).toContain("Vence en 5 minutos y funciona una sola vez.");
    expect(bodyText(es.html)).toContain("continuar como ada@example.com.");
  });

  it("has a Spanish plain-text alternative with the same facts", () => {
    expect(es.text.split("\n")).toContain("482913");
    expect(es.text).toContain("ada@example.com");
    expect(es.text).toContain("puedes ignorar este correo");
    expect(es.text).not.toMatch(/<[a-z]/i);
  });

  it("says minuto in the singular for a one-minute code", () => {
    const short = signInCodeEmail({
      email: "a@b.test",
      code: "111111",
      expiresInMinutes: 1,
      locale: "es",
    });
    expect(short.text).toContain("Vence en 1 minuto y funciona una sola vez.");
  });

  it("stays English without a language", () => {
    expect(code.html).toContain('<html lang="en" dir="ltr">');
  });
});

describe("email layout", () => {
  it("is table-based with inline styles and loads only the hosted wordmarks", () => {
    const all = elements(code.html);
    expect(all.filter((e) => e.tagName === "table").length).toBeGreaterThanOrEqual(3);
    for (const table of all.filter((e) => e.tagName === "table")) {
      expect(attr(table, "role")).toBe("presentation");
    }
    const sources = all.filter((e) => attr(e, "src") !== undefined).map((e) => attr(e, "src"));
    expect(sources).toEqual([
      "https://portifact.com/brand/wordmark.png",
      "https://portifact.com/brand/wordmark-dark.png",
    ]);
    for (const image of all.filter((e) => e.tagName === "img")) {
      expect(attr(image, "alt")).toBe("Portifact");
    }
    expect(all.some((e) => e.tagName === "link" || e.tagName === "script")).toBe(false);
  });

  it("declares light and dark support and repaints with the dark tokens", () => {
    expect(code.html).toContain('<meta name="color-scheme" content="light dark">');
    const style = textOf(elements(code.html).find((e) => e.tagName === "style") as Element);
    expect(style).toContain("@media (prefers-color-scheme: dark)");
    expect(style).toContain(`.pf-text { color: ${DARK.text} !important; }`);
    expect(style).toContain(`.pf-card { background-color: ${DARK.card} !important;`);
    expect(code.html).toContain(`background-color: ${LIGHT.page}`);
  });

  it("uses only neutral colors from the tokens", () => {
    for (const value of [...Object.values(LIGHT), ...Object.values(DARK)]) {
      expect(value).toMatch(/^#([0-9a-f]{2})\1\1$/);
    }
    const colors = new Set(code.html.match(/#[0-9a-f]{6}\b/gi) ?? []);
    const allowed = new Set([...Object.values(LIGHT), ...Object.values(DARK)]);
    for (const color of colors) expect(allowed.has(color.toLowerCase())).toBe(true);
  });

  it("escapes every kind of block", () => {
    const html = renderEmail({
      title: "<t>",
      preheader: "<p>",
      heading: "<h>",
      footer: "<f>",
      blocks: [
        { kind: "paragraph", content: ["<a>", { strong: "<b>" }, { href: 'x" y', text: "<c>" }] },
        { kind: "code", label: "<l>", value: "<v>" },
        { kind: "command", value: "<cmd>" },
        { kind: "facts", rows: [{ label: "<k>", value: "<w>" }] },
        { kind: "list", items: ["<i>", ["<j>", { strong: "<m>" }, { href: "u'v", text: "<n>" }]] },
      ],
    });
    const tags = new Set(elements(html).map((e) => e.tagName));
    // None of the injected tags became an element (the layout itself uses none of them).
    for (const injected of [
      "t",
      "h",
      "f",
      "b",
      "c",
      "l",
      "v",
      "cmd",
      "k",
      "w",
      "i",
      "j",
      "m",
      "n",
    ]) {
      expect(tags.has(injected)).toBe(false);
    }
    expect(bodyText(html)).toContain("<a><b><c>");
    expect(html).toContain("&lt;cmd&gt;");
    expect(html).toContain('href="x&quot; y"');
    expect(html).toContain('href="u&#39;v"');
    expect(bodyText(html)).toContain("<j><m><n>");
    const link = elements(html).find((e) => e.tagName === "a" && textOf(e) === "<c>");
    expect(attr(link as Element, "href")).toBe('x" y');
  });

  it("escapes the five HTML characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("budget alert email", () => {
  const sample = {
    alerts: [{ kind: "alert50", projectedUsd: 52.4, createdAt: Date.UTC(2026, 10, 8) }],
    projectedUsd: 52.4,
    level: "alert50",
    actions: ["new publishes paused"],
  };

  it("states the projection, level, protection and alerts in both versions", () => {
    const email = budgetAlertEmail(sample);
    expect(email.subject).toBe("Portifact budget: projected US$52.40 this cycle (alert50)");
    expect(email.text).toContain("Protection in effect: new publishes paused.");
    expect(email.text).toContain("- alert50 at US$52.40 (2026-11-08T00:00:00.000Z)");
    expect(email.text).toContain("bun run --cwd apps/jobs operator budget");
    const visible = bodyText(email.html);
    expect(visible).toContain("Projected spend: US$52.40");
    expect(visible).toContain("new publishes paused");
    expect(visible).toContain("alert50 at US$52.40 (2026-11-08T00:00:00.000Z)");
    expect(visible).toContain("bun run --cwd apps/jobs operator budget");
  });

  it("says none when no protection applies and lists no alerts when there are none", () => {
    const email = budgetAlertEmail({ ...sample, alerts: [], actions: [] });
    expect(email.text).toContain("Protection in effect: none.");
    expect(bodyText(email.html)).not.toContain("New alerts");
    expect(elements(email.html).some((e) => e.tagName === "ul")).toBe(false);
  });

  it("escapes values it did not write", () => {
    const email = budgetAlertEmail({ ...sample, level: "<script>x</script>" });
    expect(elements(email.html).some((e) => e.tagName === "script")).toBe(false);
  });
});

describe("expiry notice email", () => {
  const AT = Date.UTC(2026, 10, 11, 9, 5);
  const artifact = (id: string, name: string, expiresAt = AT) => ({
    name,
    url: `https://${id}.portifact.dev/`,
    renewUrl: `https://app.portifact.com/artifacts/${id}`,
    expiresAt,
  });
  const base = {
    settingsUrl: "https://app.portifact.com/settings",
    activeDays: 30,
    archiveMonths: 6,
  };
  const two = expiryNoticeEmail({
    ...base,
    artifacts: [artifact("k7d2qm4xab", "Plan"), artifact("p4n8rt2vcd", "Notes", AT + 86_400_000)],
  });

  it("formats expiries in UTC with the weekday and a 24-hour clock", () => {
    expect(formatExpiry(AT)).toBe("Wed, Nov 11, 2026, 09:05 UTC");
    expect(formatExpiry(Date.UTC(2026, 10, 11, 23, 59))).toBe("Wed, Nov 11, 2026, 23:59 UTC");
  });

  it("counts the artifacts in the subject and heading, never naming them there", () => {
    expect(two.subject).toBe("2 of your Portifact artifacts expire soon");
    expect(two.subject).not.toContain("Plan");
    const one = expiryNoticeEmail({ ...base, artifacts: [artifact("k7d2qm4xab", "Plan")] });
    expect(one.subject).toBe("Your Portifact artifact expires soon");
    expect(bodyText(one.html)).toContain("An artifact expires soon");
    expect(bodyText(two.html)).toContain("2 artifacts expire soon");
  });

  it("lists each artifact with its expiry, its address and a renew link", () => {
    const visible = bodyText(two.html);
    expect(visible).toContain("Plan expires Wed, Nov 11, 2026, 09:05 UTC.");
    expect(visible).toContain("Notes expires Thu, Nov 12, 2026, 09:05 UTC.");
    expect(visible).toContain("k7d2qm4xab.portifact.dev");
    const links = elements(two.html)
      .filter((e) => e.tagName === "a")
      .map((e) => [textOf(e), attr(e, "href")]);
    expect(links).toContainEqual(["k7d2qm4xab.portifact.dev", "https://k7d2qm4xab.portifact.dev/"]);
    expect(links).toContainEqual(["Renew", "https://app.portifact.com/artifacts/p4n8rt2vcd"]);
    expect(links).toContainEqual(["Settings", "https://app.portifact.com/settings"]);
    expect(visible).toContain("another 30 days");
    expect(visible).toContain("restore it from the dashboard for 6 months");
  });

  it("puts the soonest expiry in the preview text", () => {
    const preheader = elements(two.html).find(
      (e) => e.tagName === "div" && attr(e, "style")?.includes("display: none"),
    ) as Element;
    expect(textOf(preheader)).toBe(
      "Renew before Wed, Nov 11, 2026, 09:05 UTC to keep them online.",
    );
  });

  it("has a plain-text alternative with every artifact and the opt-out", () => {
    expect(two.text).toContain(
      "- Plan\n  Expires Wed, Nov 11, 2026, 09:05 UTC\n  https://k7d2qm4xab.portifact.dev/\n  Renew: https://app.portifact.com/artifacts/k7d2qm4xab",
    );
    expect(two.text).toContain("- Notes");
    expect(two.text).toContain(
      "Turn off expiry notices in your settings: https://app.portifact.com/settings",
    );
    expect(two.text).not.toMatch(/<[a-z]/i);
  });

  it("escapes names and keeps each on one line", () => {
    const hostile = expiryNoticeEmail({
      ...base,
      artifacts: [
        artifact("k7d2qm4xab", "<script>x</script>\n- Fake\r\n  Renew: https://evil.test"),
      ],
    });
    expect(elements(hostile.html).some((e) => e.tagName === "script")).toBe(false);
    expect(bodyText(hostile.html)).toContain("<script>x</script> - Fake Renew: https://evil.test");
    const lines = hostile.text.split("\n");
    expect(lines.filter((line) => line.startsWith("- "))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith("  Renew: "))).toEqual([
      "  Renew: https://app.portifact.com/artifacts/k7d2qm4xab",
    ]);
  });
});

describe.each(LOCALE_CODES)("user-facing emails in %s", (locale) => {
  const AT = Date.UTC(2026, 10, 11, 9, 5);
  const artifact = (id: string, name: string, expiresAt = AT) => ({
    name,
    url: `https://${id}.portifact.dev/`,
    renewUrl: `https://app.portifact.com/artifacts/${id}`,
    expiresAt,
  });
  const base = {
    settingsUrl: "https://app.portifact.com/settings",
    activeDays: 30,
    archiveMonths: 6,
    locale,
  };
  const one = expiryNoticeEmail({ ...base, artifacts: [artifact("k7d2qm4xab", "Plan")] });
  const three = expiryNoticeEmail({
    ...base,
    artifacts: [
      artifact("k7d2qm4xab", "Plan"),
      artifact("p4n8rt2vcd", "Notes", AT + 86_400_000),
      artifact("z9w3hj6mef", "Draft", AT + 2 * 86_400_000),
    ],
  });
  const signIn = signInCodeEmail({
    email: "ada@example.com",
    code: "482913",
    expiresInMinutes: 5,
    locale,
  });
  const all = [one, three, signIn];

  it("marks the language on the document", () => {
    for (const email of all) expect(email.html).toContain(`<html lang="${locale}" dir="ltr">`);
  });

  it("formats expiries in the language, always in UTC and saying so", () => {
    const expected = `${new Intl.DateTimeFormat(locale === "en" ? "en-US" : locale, {
      timeZone: "UTC",
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(AT))} UTC`;
    expect(formatExpiry(AT, locale)).toBe(expected);
    expect(expected).toContain("09:05");
    expect(bodyText(three.html)).toContain(expected);
    expect(three.text).toContain(expected);
  });

  it("counts the artifacts in the subject without naming them", () => {
    expect(one.subject).not.toBe(three.subject);
    expect(three.subject).toContain("3");
    expect(bodyText(three.html)).toContain("3");
    for (const email of [one, three]) {
      expect(email.subject).not.toContain("Plan");
      expect(email.subject).toContain("Portifact");
    }
  });

  it("links every artifact, its renewal and the settings in the language", () => {
    const links = elements(three.html)
      .filter((e) => e.tagName === "a")
      .map((e) => [textOf(e), attr(e, "href")]);
    const text = EXPIRY_TEXT[locale];
    expect(links).toContainEqual(["k7d2qm4xab.portifact.dev", "https://k7d2qm4xab.portifact.dev/"]);
    expect(links).toContainEqual([text.renew, "https://app.portifact.com/artifacts/z9w3hj6mef"]);
    expect(links).toContainEqual([text.settings, "https://app.portifact.com/settings"]);
    expect(three.text).toContain(`${text.renew}: https://app.portifact.com/artifacts/p4n8rt2vcd`);
    expect(three.text).toContain("https://app.portifact.com/settings");
    expect(bodyText(three.html)).toContain("30");
    expect(bodyText(three.html)).toContain("6");
  });

  it("keeps the code out of the subject and in the text version", () => {
    expect(signIn.subject).not.toContain("482913");
    expect(signIn.text.split("\n")).toContain("482913");
    expect(signIn.text).toContain("ada@example.com");
  });

  it("follows the writing style: no dashes, no markup in the text version", () => {
    for (const email of all) {
      expect(`${email.subject}${email.html}${email.text}`).not.toMatch(/[—–]/);
      expect(email.text).not.toMatch(/<[a-z]/i);
    }
  });

  it("is translated, except in English", () => {
    const english = EXPIRY_TEXT.en;
    const own = EXPIRY_TEXT[locale];
    if (locale === "en") return;
    expect(own.subject(1)).not.toBe(english.subject(1));
    expect(own.intro(30)).not.toBe(english.intro(30));
    expect(own.renew).not.toBe(english.renew);
    expect(signIn.subject).not.toBe(code.subject);
  });

  it("draws Chinese and Japanese with their own system fonts", () => {
    const stack = fontSans(locale);
    if (locale === "ja") expect(stack).toContain("Hiragino Sans");
    else if (locale === "zh-CN") expect(stack).toContain("PingFang SC");
    else expect(stack).toBe(FONT_SANS);
    expect(stack.endsWith("sans-serif")).toBe(true);
    expect(three.html).toContain(`font-family: ${stack};`);
  });
});

describe("emails in languages with more plural forms", () => {
  it("say Russian minutes with the right form for 1, 3 and 5", () => {
    const minutes = (n: number) =>
      signInCodeEmail({ email: "a@b.test", code: "111111", expiresInMinutes: n, locale: "ru" })
        .text;
    expect(minutes(1)).toContain("1 минуту");
    expect(minutes(3)).toContain("3 минуты");
    expect(minutes(5)).toContain("5 минут");
  });

  it("leave no space after full-width punctuation before a link in Chinese and Japanese", () => {
    for (const locale of ["ja", "zh-CN"] as const) {
      const email = expiryNoticeEmail({
        settingsUrl: "https://app.portifact.com/settings",
        activeDays: 30,
        archiveMonths: 6,
        locale,
        artifacts: [
          {
            name: "Plan",
            url: "https://k7d2qm4xab.portifact.dev/",
            renewUrl: "https://app.portifact.com/artifacts/k7d2qm4xab",
            expiresAt: Date.UTC(2026, 10, 11),
          },
        ],
      });
      const lines = elements(email.html)
        .filter((e) => e.tagName === "li" || e.tagName === "p")
        .map(textOf);
      expect(lines.some((line) => line.includes("：設定") || line.includes("：设置"))).toBe(true);
      for (const line of lines) expect(line).not.toMatch(/[。：] /);
    }
  });
});

describe("previews", () => {
  it("cover every email with HTML and text", () => {
    const names = previews().map((p) => p.name);
    const translated = ["es", "pt-br", "fr", "de", "ru", "ja", "zh-cn"];
    expect(names).toEqual([
      "sign-in-code",
      ...translated.map((code) => `sign-in-code-${code}`),
      "budget-alert",
      "budget-alert-no-protection",
      "expiry-notice",
      "expiry-notice-one",
      ...translated.map((code) => `expiry-notice-${code}`),
    ]);
    for (const { email } of previews()) {
      expect(email.html.startsWith("<!doctype html>")).toBe(true);
      expect(email.text.length).toBeGreaterThan(0);
      expect(email.html).not.toMatch(/[—–]/);
      expect(email.text).not.toMatch(/[—–]/);
    }
  });
});
