// The branded email layout: one centered card on a quiet page, built with tables and inline
// styles so it renders the same in Gmail, Outlook and Apple Mail. Every value that reaches the
// markup goes through `escapeHtml`; callers pass text, never HTML.
import { DARK, FONT_MONO, FONT_SANS, LIGHT, WORDMARK } from "./theme.ts";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Text made safe for HTML content and double- or single-quoted attributes. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

/** A run of text: plain, strong or a link. */
export type Inline = string | { strong: string } | { href: string; text: string };

/** One block of the card's body. */
export type Block =
  | { kind: "paragraph"; content: Inline[]; muted?: boolean }
  | { kind: "code"; label: string; value: string }
  | { kind: "command"; value: string }
  | { kind: "facts"; rows: { label: string; value: string }[] }
  | { kind: "list"; items: string[] }
  | { kind: "divider" };

export interface EmailLayout {
  /** The document title, usually the subject. */
  title: string;
  /** Inbox preview text, hidden in the body. Never put a secret here. */
  preheader: string;
  heading: string;
  blocks: Block[];
  /** Small print under the card, such as why the email was sent. */
  footer: string;
  /** The language of the text, a BCP 47 tag; English when absent. */
  lang?: string;
}

const text = `color: ${LIGHT.text}`;
const muted = `color: ${LIGHT.muted}`;
const paragraph = `margin: 0 0 16px; font-family: ${FONT_SANS}; font-size: 15px; line-height: 24px`;

function inline(content: Inline[]): string {
  return content
    .map((part) => {
      if (typeof part === "string") return escapeHtml(part);
      if ("strong" in part) return `<strong>${escapeHtml(part.strong)}</strong>`;
      return `<a href="${escapeHtml(part.href)}" class="pf-text" style="${text}; text-decoration: underline">${escapeHtml(part.text)}</a>`;
    })
    .join("");
}

function block(item: Block): string {
  switch (item.kind) {
    case "paragraph":
      return item.muted
        ? `<p class="pf-muted" style="${paragraph}; ${muted}">${inline(item.content)}</p>`
        : `<p class="pf-text" style="${paragraph}; ${text}">${inline(item.content)}</p>`;
    case "code":
      // One unbroken string, so a double click or a long press copies exactly the code; the
      // spacing between digits is letter-spacing, which copies as nothing.
      return [
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 8px 0 24px">`,
        `<tr><td class="pf-panel" align="center" style="padding: 20px 16px; background-color: ${LIGHT.panel}; border: 1px solid ${LIGHT.panelBorder}; border-radius: 10px">`,
        `<p class="pf-muted" style="margin: 0 0 8px; font-family: ${FONT_SANS}; font-size: 12px; line-height: 16px; letter-spacing: 1px; text-transform: uppercase; ${muted}">${escapeHtml(item.label)}</p>`,
        `<p class="pf-text" style="margin: 0; font-family: ${FONT_MONO}; font-size: 36px; line-height: 44px; font-weight: 700; letter-spacing: 8px; ${text}">${escapeHtml(item.value)}</p>`,
        "</td></tr></table>",
      ].join("");
    case "command":
      return [
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 16px">`,
        `<tr><td class="pf-panel" style="padding: 12px 16px; background-color: ${LIGHT.panel}; border: 1px solid ${LIGHT.panelBorder}; border-radius: 6px">`,
        `<code class="pf-text" style="font-family: ${FONT_MONO}; font-size: 13px; line-height: 20px; ${text}">${escapeHtml(item.value)}</code>`,
        "</td></tr></table>",
      ].join("");
    case "facts":
      return [
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 16px; border-collapse: collapse">`,
        ...item.rows.map(
          (row) =>
            `<tr><td class="pf-muted pf-rule" style="padding: 8px 12px 8px 0; border-bottom: 1px solid ${LIGHT.border}; font-family: ${FONT_SANS}; font-size: 14px; line-height: 20px; ${muted}; white-space: nowrap; vertical-align: top">${escapeHtml(row.label)}</td>` +
            `<td class="pf-text pf-rule" style="padding: 8px 0; border-bottom: 1px solid ${LIGHT.border}; font-family: ${FONT_SANS}; font-size: 14px; line-height: 20px; font-weight: 600; ${text}">${escapeHtml(row.value)}</td></tr>`,
        ),
        "</table>",
      ].join("");
    case "list":
      return [
        `<ul class="pf-text" style="margin: 0 0 16px; padding: 0 0 0 20px; font-family: ${FONT_SANS}; font-size: 14px; line-height: 22px; ${text}">`,
        ...item.items.map((entry) => `<li style="margin: 0 0 4px">${escapeHtml(entry)}</li>`),
        "</ul>",
      ].join("");
    case "divider":
      return `<hr class="pf-rule" style="margin: 8px 0 24px; border: 0; border-top: 1px solid ${LIGHT.border}">`;
  }
}

/**
 * Dark mode for the clients that support it (Apple Mail, iOS Mail, Outlook for Mac and the new
 * Outlook). Gmail and Outlook for Windows ignore it and adjust the light version themselves,
 * which the light palette survives because it is only black, white and grays.
 */
const DARK_STYLES = `
:root { color-scheme: light dark; supported-color-schemes: light dark; }
@media (prefers-color-scheme: dark) {
  .pf-page { background-color: ${DARK.page} !important; }
  .pf-card { background-color: ${DARK.card} !important; border-color: ${DARK.border} !important; }
  .pf-panel { background-color: ${DARK.panel} !important; border-color: ${DARK.panelBorder} !important; }
  .pf-rule { border-color: ${DARK.border} !important; }
  .pf-text { color: ${DARK.text} !important; }
  .pf-muted { color: ${DARK.muted} !important; }
  .pf-logo-light { display: none !important; }
  .pf-logo-dark { display: block !important; max-height: none !important; overflow: visible !important; }
}
@media (max-width: 520px) {
  .pf-card { padding: 24px 20px !important; }
}`;

function logo(): string {
  const image = (src: string, cls: string, hidden: boolean) =>
    `<img src="${src}" width="${WORDMARK.width}" height="${WORDMARK.height}" alt="Portifact" class="${cls} pf-text" style="${hidden ? "display: none; max-height: 0; overflow: hidden; mso-hide: all; " : "display: block; "}border: 0; outline: none; text-decoration: none; font-family: ${FONT_SANS}; font-size: 18px; font-weight: 700; ${text}">`;
  // The dark wordmark stays hidden (also from Outlook for Windows) unless dark mode shows it.
  return image(WORDMARK.light, "pf-logo-light", false) + image(WORDMARK.dark, "pf-logo-dark", true);
}

/** The full HTML document of an email. */
export function renderEmail(layout: EmailLayout): string {
  return [
    "<!doctype html>",
    `<html lang="${escapeHtml(layout.lang ?? "en")}" dir="ltr">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="x-apple-disable-message-reformatting">',
    '<meta name="color-scheme" content="light dark">',
    '<meta name="supported-color-schemes" content="light dark">',
    `<title>${escapeHtml(layout.title)}</title>`,
    `<style>${DARK_STYLES}\n</style>`,
    "</head>",
    `<body class="pf-page" style="margin: 0; padding: 0; width: 100%; background-color: ${LIGHT.page}; -webkit-text-size-adjust: 100%">`,
    `<div style="display: none; max-height: 0; overflow: hidden; mso-hide: all; font-size: 1px; line-height: 1px; opacity: 0">${escapeHtml(layout.preheader)}</div>`,
    `<table role="presentation" class="pf-page" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: ${LIGHT.page}">`,
    '<tr><td align="center" style="padding: 32px 16px">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 520px">',
    `<tr><td style="padding: 0 4px 20px">${logo()}</td></tr>`,
    `<tr><td class="pf-card" style="padding: 32px; background-color: ${LIGHT.card}; border: 1px solid ${LIGHT.border}; border-radius: 16px">`,
    `<h1 class="pf-text" style="margin: 0 0 16px; font-family: ${FONT_SANS}; font-size: 22px; line-height: 30px; font-weight: 700; ${text}">${escapeHtml(layout.heading)}</h1>`,
    ...layout.blocks.map(block),
    "</td></tr>",
    `<tr><td style="padding: 20px 4px 0">`,
    `<p class="pf-muted" style="margin: 0 0 8px; font-family: ${FONT_SANS}; font-size: 12px; line-height: 18px; ${muted}">${escapeHtml(layout.footer)}</p>`,
    `<p class="pf-muted" style="margin: 0; font-family: ${FONT_SANS}; font-size: 12px; line-height: 18px; ${muted}">Portifact, <a href="https://portifact.com" class="pf-muted" style="${muted}; text-decoration: underline">portifact.com</a></p>`,
    "</td></tr>",
    "</table>",
    "</td></tr>",
    "</table>",
    "</body>",
    "</html>",
  ].join("\n");
}
