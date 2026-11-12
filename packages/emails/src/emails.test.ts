import { createHash } from "node:crypto";
import { LOCALE_CODES } from "@portifact/contracts/locales";
import { type DefaultTreeAdapterMap, parse } from "parse5";
import { describe, expect, it } from "vitest";
import { budgetAlertEmail } from "./budget-alert.ts";
import { commentNoticeEmail } from "./comment-notice.ts";
import { EXPIRY_TEXT, expiryNoticeEmail, formatExpiry } from "./expiry-notice.ts";
import { INVITATION_TEXT, invitationEmail } from "./invitation.ts";
import { escapeHtml, renderEmail } from "./layout.ts";
import { previews } from "./previews.ts";
import { reviewNoticeEmail } from "./review-notice.ts";
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

describe("invitation email", () => {
  const AT = Date.UTC(2026, 10, 17, 12, 0);
  const input = {
    email: "grace@example.com",
    inviterName: "Ada Lovelace",
    workspaceName: "Analytical Engines",
    role: "editor" as const,
    acceptUrl: "https://app.portifact.com/invitations?token=abc",
    expiresAt: AT,
  };
  const email = invitationEmail(input);

  it("keeps names out of the subject and the preview text", () => {
    expect(email.subject).toBe("You are invited to a workspace on Portifact");
    for (const locale of LOCALE_CODES) {
      const localized = invitationEmail({ ...input, locale });
      expect(localized.subject).toBe(INVITATION_TEXT[locale].subject);
      expect(localized.subject).not.toContain("Ada");
      expect(localized.html).toContain(`lang="${locale}"`);
      expect(localized.html).toContain("Analytical Engines");
      expect(localized.text).toContain(input.acceptUrl);
      expect(localized.text).not.toMatch(/[—–]/);
    }
  });

  it("says who invited whom to what, links the acceptance and says when it expires", () => {
    const visible = bodyText(email.html);
    expect(visible).toContain(
      "Ada Lovelace invited you to the workspace Analytical Engines as an editor.",
    );
    expect(visible).toContain("Sign in with grace@example.com to accept it.");
    expect(visible).toContain(
      "The invitation expires Tue, Nov 17, 2026, 12:00 UTC and works once.",
    );
    expect(visible).toContain("If you did not expect it, ignore this email.");
    const links = elements(email.html)
      .filter((e) => e.tagName === "a")
      .map((e) => [textOf(e), attr(e, "href")]);
    expect(links).toContainEqual(["Accept the invitation", input.acceptUrl]);
    expect(email.text).toContain(`Accept the invitation: ${input.acceptUrl}`);
  });

  it("escapes names and keeps them on one line", () => {
    const hostile = invitationEmail({
      ...input,
      inviterName: "<img src=x>\nFake line",
      workspaceName: "<b>Team</b>",
    });
    expect(hostile.html).not.toContain("<img src=x>");
    expect(hostile.html).toContain("&lt;b&gt;Team&lt;/b&gt;");
    expect(hostile.text).toContain("<img src=x> Fake line invited you");
    const nameless = invitationEmail({ ...input, inviterName: "  " });
    expect(bodyText(nameless.html)).toContain("An admin invited you");
  });

  it("names each role in every language", () => {
    for (const locale of LOCALE_CODES) {
      const roles = INVITATION_TEXT[locale].roles;
      expect(new Set(Object.values(roles)).size).toBe(3);
      for (const role of ["admin", "editor", "member"] as const) {
        expect(bodyText(invitationEmail({ ...input, role, locale }).html)).toContain(roles[role]);
      }
    }
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

  it("leaves names and the list out for an EU owner, with the count, the date and the list link", () => {
    const listUrl = "https://app.portifact.com/?workspace=engines&expiring=soon";
    const eu = (artifacts: ReturnType<typeof artifact>[]) =>
      expiryNoticeEmail({ ...base, names: false, listUrl, artifacts });
    const euOne = eu([artifact("k7d2qm4xab", "Plan")]);
    const euThree = eu([
      artifact("k7d2qm4xab", "Plan"),
      artifact("p4n8rt2vcd", "Notes", AT + 86_400_000),
      artifact("z9w3hj6mef", "Draft", AT + 2 * 86_400_000),
    ]);
    const text = EXPIRY_TEXT[locale];
    const first = formatExpiry(AT, locale);
    for (const [email, count] of [
      [euOne, 1],
      [euThree, 3],
    ] as const) {
      for (const part of [email.subject, email.text, email.html]) {
        for (const name of ["Plan", "Notes", "Draft", "portifact.dev", "/artifacts/"]) {
          expect(part).not.toContain(name);
        }
      }
      const links = elements(email.html)
        .filter((e) => e.tagName === "a")
        .map((e) => [textOf(e), attr(e, "href")]);
      expect(links).toContainEqual([text.list(count), listUrl]);
      expect(bodyText(email.html)).toContain(text.due(count, first));
      expect(email.text).toContain(text.due(count, first));
      expect(email.text).toContain(`${text.list(count)}: ${listUrl}`);
      expect(elements(email.html).some((e) => e.tagName === "li")).toBe(false);
    }
    // The subject is the named one's: it never carried names.
    expect(euThree.subject).toBe(three.subject);
    expect(euOne.subject).toBe(one.subject);
    expect(text.due(3, first)).not.toBe(text.due(1, first));
    if (locale !== "en") {
      expect(text.due(1, first)).not.toBe(EXPIRY_TEXT.en.due(1, first));
      expect(text.list(3)).not.toBe(EXPIRY_TEXT.en.list(3));
    }
  });

  it("names nothing and nobody in an EU owner's comment and review notices", () => {
    const secret = "Confidential merger plan";
    const links = {
      settingsUrl: "https://app.portifact.com/settings",
      unsubscribeUrl: "https://app.portifact.com/unsubscribe?token=t",
    };
    const emails = [
      commentNoticeEmail({
        ...links,
        names: false,
        more: 1,
        locale,
        artifacts: [
          {
            name: secret,
            url: "https://app.portifact.com/view/k7d2qm4xab",
            newThreads: 1,
            newReplies: 2,
            resolvedThreads: 1,
          },
        ],
      }),
      ...(["requested", "approved", "changes_requested"] as const).map((kind) =>
        reviewNoticeEmail({
          ...links,
          names: false,
          kind,
          name: secret,
          version: 3,
          url: "https://app.portifact.com/view/k7d2qm4xab",
          locale,
        }),
      ),
    ];
    for (const email of emails) {
      for (const part of [email.subject, email.text, email.html]) {
        expect(part).not.toContain(secret);
        // No address at all: the recipient's is only in the envelope, nobody else's anywhere.
        expect(part).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
      }
    }
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
  it("show an EU workspace's expiring artifacts as a count and a link, never names (decision 0005)", () => {
    const named = previews().find((p) => p.name === "expiry-notice")?.email;
    const nameless = previews().filter((p) => p.name.startsWith("expiry-notice-without-names"));
    expect(named?.text).toContain("Q3 launch plan");
    expect(nameless).toHaveLength(LOCALE_CODES.length + 1);
    for (const { email } of nameless) {
      for (const part of [email.subject, email.text, email.html]) {
        expect(part).not.toContain("Q3 launch plan");
        expect(part).not.toContain("Design review notes");
        expect(part).not.toContain("k7d2qm4xab");
      }
      expect(email.text).toContain("expiring=soon");
    }
    const review = previews().find((p) => p.name === "review-requested-without-names")?.email;
    expect(`${review?.subject}${review?.text}${review?.html}`).not.toContain("Q3 launch plan");
  });

  it("keep the default region's expiry notice byte for byte (pinned before the EU variant)", () => {
    // Re-pinned when every email gained the Privacy Policy link in its footer (docs/legal.md).
    const pinned: Record<string, string> = {
      "expiry-notice": "3766b0ebedf8ab1dcf5834796a2088700f9bea97387dbdcdd9c9f21abbf46775",
      "expiry-notice-one": "7e5c37f66516d3ec7271e30695634d09f905bdd1bf06616c00e0afa4caecb6e3",
      "expiry-notice-es": "5213debeff83edce063cfbccf8cd53b97f193025cf5560cbd83bfc22cb6eb785",
      "expiry-notice-pt-br": "5e45d9e73188bc3aaf15e1ad53ad60f816958fb44c87d820879eb271846d746a",
      "expiry-notice-fr": "3c759caec870501abe6a4430ce204fdd41107990cfd48dd0eb6cd04b6df80fbf",
      "expiry-notice-de": "3a21ed03f5c4711a2aac683d77d62829397e6f3599e8d54f059d5650db45dd47",
      "expiry-notice-ru": "049576dd5f00d34d1628ee37bcf6c3223848f328ab04c03c7eb5fc86ee5e1e22",
      "expiry-notice-ja": "b77e76c2ceb9dcf1df9dea5b483bf9d2309eeccb38bc780e4631e1899a2d3c72",
      "expiry-notice-zh-cn": "f7a2210a6916f6232690cd8265af57317982c49dbc86370fd619ce784cdef2c2",
    };
    const hashes = Object.fromEntries(
      previews()
        .filter((p) => p.name in pinned)
        .map((p) => [
          p.name,
          createHash("sha256")
            .update(`${p.email.subject}\n${p.email.text}\n${p.email.html}`)
            .digest("hex"),
        ]),
    );
    expect(hashes).toEqual(pinned);
  });

  it("link the Privacy Policy from every email, HTML and text, in its language", () => {
    for (const { name, email } of previews()) {
      expect(email.html, name).toContain('href="https://portifact.com/privacy"');
      // The budget alert goes only to the operator, so its text needs no link.
      if (!name.startsWith("budget-alert")) {
        expect(email.text, name).toMatch(/: https:\/\/portifact\.com\/privacy$/m);
      }
    }
    const spanish = previews().find((p) => p.name === "invitation-es");
    expect(spanish?.email.text).toContain("Privacidad: https://portifact.com/privacy");
  });

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
      "expiry-notice-without-names",
      "expiry-notice-without-names-one",
      "comment-notice",
      "comment-notice-one",
      "comment-notice-without-names",
      ...translated.map((code) => `comment-notice-${code}`),
      "domain-notice",
      ...translated.map((code) => `domain-notice-${code}`),
      "retention-notice",
      ...translated.map((code) => `retention-notice-${code}`),
      "comment-retention-set",
      "comment-retention-soon",
      ...translated.map((code) => `comment-retention-set-${code}`),
      "directory-notice",
      ...translated.map((code) => `directory-notice-${code}`),
      ...translated.map((code) => `expiry-notice-${code}`),
      ...translated.map((code) => `expiry-notice-without-names-${code}`),
      "invitation",
      ...translated.map((code) => `invitation-${code}`),
      "grace-notice-start",
      "grace-notice-two-weeks",
      "grace-notice-three-days",
      "grace-notice-personal",
      "grace-notice-without-names",
      ...translated.map((code) => `grace-notice-${code}`),
      ...translated.map((code) => `grace-notice-without-names-${code}`),
      "review-requested",
      "review-approved",
      "review-changes-requested",
      "review-requested-without-names",
      ...translated.map((code) => `review-requested-${code}`),
      "moderation-artifact-suspended",
      "moderation-artifact-suspended-without-names",
      "moderation-account-suspended",
      "moderation-brand-suspended",
      "moderation-artifact-reinstated",
      ...translated.map((code) => `moderation-artifact-suspended-${code}`),
      "report-outcome-actioned",
      "report-outcome-dismissed",
      ...translated.map((code) => `report-outcome-${code}`),
    ]);
    for (const { email } of previews()) {
      expect(email.html.startsWith("<!doctype html>")).toBe(true);
      expect(email.text.length).toBeGreaterThan(0);
      expect(email.html).not.toMatch(/[—–]/);
      expect(email.text).not.toMatch(/[—–]/);
    }
  });
});
