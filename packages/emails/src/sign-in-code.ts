// The sign-in code email. The code is the whole point, so it comes first, large and in one
// piece; the expiry and the "you can ignore this" line follow. The code never goes in the subject
// or the preview text, which lock screens and notifications show. It is written in the language
// of the sign-in page that asked for it; the texts are typed by the locale list, so a new
// language fails the typecheck until it is here.
import { DEFAULT_LOCALE, type LocaleCode } from "@portifact/contracts/locales";
import { renderEmail } from "./layout.ts";
import type { EmailContent } from "./message.ts";
import { pluralForm } from "./plural.ts";

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
  "pt-BR": {
    subject: "Seu código de login do Portifact",
    heading: "Seu código de login",
    codeLabel: "Código de login",
    intro: ["Digite este código na página de login para continuar como ", "."],
    expiry: (minutes) =>
      `Ele expira em ${minutes} minuto${minutes === 1 ? "" : "s"} e funciona uma vez.`,
    share: "Nunca compartilhe este código. O Portifact nunca vai pedi-lo a você.",
    ignore:
      "Se você não tentou entrar, pode ignorar este e-mail. Ninguém consegue entrar sem o código.",
    reason:
      "Você recebeu este e-mail porque alguém pediu para entrar no Portifact com este endereço.",
    preheader: (expiry) => `Digite-o na página de login. ${expiry}`,
    signature: "Portifact, https://portifact.com",
  },
  fr: {
    subject: "Votre code de connexion Portifact",
    heading: "Votre code de connexion",
    codeLabel: "Code de connexion",
    intro: ["Saisissez ce code sur la page de connexion pour continuer en tant que ", "."],
    expiry: (minutes) =>
      `Il expire dans ${minutes} minute${minutes < 2 ? "" : "s"} et ne fonctionne qu’une fois.`,
    share: "Ne partagez jamais ce code. Portifact ne vous le demandera jamais.",
    ignore:
      "Si vous n’avez pas essayé de vous connecter, vous pouvez ignorer cet e-mail. Personne ne peut se connecter sans le code.",
    reason:
      "Vous avez reçu cet e-mail, car quelqu’un a demandé à se connecter à Portifact avec cette adresse.",
    preheader: (expiry) => `Saisissez-le sur la page de connexion. ${expiry}`,
    signature: "Portifact, https://portifact.com",
  },
  de: {
    subject: "Dein Anmeldecode für Portifact",
    heading: "Dein Anmeldecode",
    codeLabel: "Anmeldecode",
    intro: ["Gib diesen Code auf der Anmeldeseite ein, um fortzufahren als ", "."] as [
      before: string,
      after: string,
    ],
    expiry: (minutes) =>
      `Er läuft in ${minutes} Minute${minutes === 1 ? "" : "n"} ab und funktioniert einmal.`,
    share: "Teile diesen Code niemals. Portifact wird dich nie danach fragen.",
    ignore:
      "Wenn du nicht versucht hast, dich anzumelden, kannst du diese E-Mail ignorieren. Ohne den Code kann sich niemand anmelden.",
    reason:
      "Du hast diese E-Mail erhalten, weil jemand mit dieser Adresse eine Anmeldung bei Portifact angefordert hat.",
    preheader: (expiry) => `Gib ihn auf der Anmeldeseite ein. ${expiry}`,
    signature: "Portifact, https://portifact.com",
  },
  ru: {
    subject: "Ваш код для входа в Portifact",
    heading: "Ваш код для входа",
    codeLabel: "Код для входа",
    intro: ["Введите этот код на странице входа, чтобы продолжить как ", "."],
    // Accusative after "действует": 1 минуту, 2 минуты, 5 минут.
    expiry: (minutes) =>
      `Код действует ${minutes} ${pluralForm("ru", minutes, { one: "минуту", few: "минуты", many: "минут", other: "минуты" })} и только один раз.`,
    share: "Никому не сообщайте этот код. Portifact никогда не попросит его у вас.",
    ignore:
      "Если вы не пытались войти, просто проигнорируйте это письмо. Без кода войти никто не сможет.",
    reason: "Вы получили это письмо, потому что кто-то запросил вход в Portifact с этим адресом.",
    preheader: (expiry) => `Введите его на странице входа. ${expiry}`,
    signature: "Portifact, https://portifact.com",
  },
  ja: {
    subject: "Portifactのサインインコード",
    heading: "サインインコード",
    codeLabel: "サインインコード",
    intro: ["", "として続行するには、サインインページでこのコードを入力してください。"],
    expiry: (minutes) => `有効期限は${minutes}分で、1回だけ使用できます。`,
    share: "このコードは誰にも教えないでください。Portifactがコードを尋ねることはありません。",
    ignore:
      "サインインしようとしていない場合は、このメールを無視してください。コードがなければ誰もサインインできません。",
    reason:
      "このアドレスでPortifactへのサインインがリクエストされたため、このメールをお送りしています。",
    preheader: (expiry) => `サインインページで入力してください。${expiry}`,
    signature: "Portifact, https://portifact.com",
  },
  "zh-CN": {
    subject: "你的 Portifact 登录验证码",
    heading: "你的登录验证码",
    codeLabel: "登录验证码",
    intro: ["在登录页面输入此验证码，以 ", " 的身份继续。"],
    expiry: (minutes) => `验证码将在 ${minutes} 分钟后过期，且只能使用一次。`,
    share: "切勿分享此验证码。Portifact 绝不会向你索要它。",
    ignore: "如果你没有尝试登录，可以忽略这封邮件。没有验证码，任何人都无法登录。",
    reason: "你收到这封邮件，是因为有人请求使用此地址登录 Portifact。",
    preheader: (expiry) => `请在登录页面输入。${expiry}`,
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
