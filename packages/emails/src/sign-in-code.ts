// The sign-in code email. The code is the whole point, so it comes first, large and in one
// piece; the expiry and the "you can ignore this" line follow. The code never goes in the subject
// or the preview text, which lock screens and notifications show. It is written in the language
// of the sign-in page that asked for it; the texts are typed by the locale list, so a new
// language fails the typecheck until it is here.
import { DEFAULT_LOCALE, type LocaleCode } from "@portifact/contracts/locales";
import { renderEmail } from "./layout.ts";
import type { EmailContent } from "./message.ts";

export interface SignInCodeInput {
  /** The address the code was requested for, shown so the reader knows which account. */
  email: string;
  code: string;
  expiresInMinutes: number;
  /** The language of the email; English when absent. */
  locale?: LocaleCode | undefined;
}

interface SignInText {
  subject: string;
  heading: string;
  codeLabel: string;
  /** "Enter this code ... as" and what follows the address. */
  intro: [before: string, after: string];
  expiry(minutes: number): string;
  share: string;
  ignore: string;
  reason: string;
  preheader(expiry: string): string;
  signature: string;
}

const TEXT: { readonly [code in LocaleCode]: SignInText } = {
  en: {
    subject: "Your Portifact sign-in code",
    heading: "Your sign-in code",
    codeLabel: "Sign-in code",
    intro: ["Enter this code on the sign-in page to continue as ", "."],
    expiry: (minutes) =>
      `It expires in ${minutes} minute${minutes === 1 ? "" : "s"} and works once.`,
    share: "Never share this code. Portifact will never ask you for it.",
    ignore:
      "If you did not try to sign in, you can ignore this email. Nobody can sign in without the code.",
    reason:
      "You received this email because someone asked to sign in to Portifact with this address.",
    preheader: (expiry) => `Enter it on the sign-in page. ${expiry}`,
    signature: "Portifact, https://portifact.com",
  },
  es: {
    subject: "Tu código para iniciar sesión en Portifact",
    heading: "Tu código de inicio de sesión",
    codeLabel: "Código de inicio de sesión",
    intro: ["Ingresa este código en la página de inicio de sesión para continuar como ", "."],
    expiry: (minutes) =>
      `Vence en ${minutes} minuto${minutes === 1 ? "" : "s"} y funciona una sola vez.`,
    share: "Nunca compartas este código. Portifact nunca te lo va a pedir.",
    ignore:
      "Si no intentaste iniciar sesión, puedes ignorar este correo. Nadie puede iniciar sesión sin el código.",
    reason:
      "Recibiste este correo porque alguien pidió iniciar sesión en Portifact con esta dirección.",
    preheader: (expiry) => `Ingrésalo en la página de inicio de sesión. ${expiry}`,
    signature: "Portifact, https://portifact.com",
  },
};

/** The English subject, kept for callers that match on it. */
export const SIGN_IN_SUBJECT = TEXT.en.subject;

export function signInCodeEmail(input: SignInCodeInput): EmailContent {
  const locale = input.locale ?? DEFAULT_LOCALE;
  const text = TEXT[locale];
  const expiry = text.expiry(input.expiresInMinutes);
  const [before, after] = text.intro;

  const html = renderEmail({
    title: text.subject,
    preheader: text.preheader(expiry),
    heading: text.heading,
    blocks: [
      { kind: "paragraph", content: [before, { strong: input.email }, after] },
      { kind: "code", label: text.codeLabel, value: input.code },
      { kind: "paragraph", content: [`${expiry} ${text.share}`] },
      { kind: "divider" },
      { kind: "paragraph", content: [text.ignore], muted: true },
    ],
    footer: text.reason,
    lang: locale,
  });

  const plain = [
    text.subject,
    "",
    input.code,
    "",
    `${before}${input.email}${after}`,
    `${expiry} ${text.share}`,
    "",
    text.ignore,
    "",
    text.reason,
    text.signature,
  ].join("\n");

  return { subject: text.subject, text: plain, html };
}
